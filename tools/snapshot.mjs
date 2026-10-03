import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boardFilePath, maxDepthFromEnv, splitBoardPath, validateBoardPath } from "./board-path.mjs";
import { autoExportFromEnv, writeMermaidFromBoard } from "./export.mjs";
import { effectiveExportMode } from "./rules.mjs";

export const validateBoardName = (name) => validateBoardPath(name, { maxDepth: maxDepthFromEnv() }).ok;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Snapshots are <name>.<YYYYMMDDTHHMMSS[mmm]>Z.excalidraw. Match the exact name so that
// board "demo" never picks up snapshots of board "demo.v2"; order by time, not by string.
export const snapshotsFor = (name, fileNames) => {
  const leaf = splitBoardPath(name).at(-1);
  const pattern = new RegExp(`^${escapeRegExp(leaf)}\\.(\\d{8}T\\d{6})(\\d{3})?Z\\.excalidraw$`);
  return fileNames
    .map((fileName) => {
      const match = pattern.exec(fileName);
      return match ? { fileName, key: `${match[1]}${match[2] ?? "000"}` } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((entry) => entry.fileName);
};

export const snapshotBoard = async (
  name,
  boardsDir = process.env.XCLD_BOARDS_DIR || path.resolve("boards"),
  { autoExport = autoExportFromEnv() } = {},
) => {
  if (!validateBoardName(name)) {
    throw new Error(`Invalid board name: ${name} (use path segments with letters, digits, ".", "_" or "-"; start each segment with a letter or digit)`);
  }
  const root = path.resolve(boardsDir);
  const source = path.resolve(boardFilePath(root, name, ".excalidraw", { maxDepth: maxDepthFromEnv() }));
  try {
    await stat(source);
  } catch {
    throw new Error(`Board not found: ${name} (expected ${source}). Open http://127.0.0.1:3100/?board=${name} to create it.`);
  }
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
  const segments = splitBoardPath(name);
  const leaf = segments.at(-1);
  const snapshotDir = path.join(root, ".snapshots", ...segments.slice(0, -1));
  const target = path.join(snapshotDir, `${leaf}.${timestamp}.excalidraw`);
  await mkdir(snapshotDir, { recursive: true });
  await copyFile(source, target);
  const effectiveAutoExport = await effectiveExportMode(name, root, autoExport);
  // Returns the snapshot path(s): the board copy, plus its Mermaid unless auto-export is off.
  const mermaid = effectiveAutoExport === "off"
    ? null
    : await writeMermaidFromBoard(target, path.join(snapshotDir, `${leaf}.${timestamp}.mmd`));
  return { board: target, mermaid };
};

export const main = async (argv = process.argv.slice(2)) => {
  const name = argv[0];
  if (!name || !validateBoardName(name)) {
    console.error("Usage: node tools/snapshot.mjs <board-name>");
    process.exitCode = 1;
    return;
  }
  const result = await snapshotBoard(name);
  console.log([result.board, result.mermaid].filter(Boolean).join("\n"));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}