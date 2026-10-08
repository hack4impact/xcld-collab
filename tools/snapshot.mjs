import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
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
  return { board: target, mermaid, timestamp };
};

/**
 * `xcld snapshot` and MCP `snapshot`: the `.snapshots/` copy (snapshotBoard, kept for `xcld diff
 * <board>`), then the same version pinned in the server's history under `label` (default: the
 * snapshot's UTC stamp), so `diff --since <label>` finds it. A server that can't be reached leaves
 * the copy only, with `pinWarning`. `version` is the pinned version id.
 */
export const snapshotAndPin = async (name, boardsDir, { label, autoExport, pin } = {}) => {
  if (label !== undefined && label !== null && !/^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,99}$/.test(label)) {
    throw new Error(`Invalid snapshot name: ${label} (a letter or digit, then up to 99 letters, digits, spaces, ".", "_", ":" or "-")`);
  }
  const result = await snapshotBoard(name, boardsDir, autoExport === undefined ? {} : { autoExport });
  const pinLabel = label ?? result.timestamp;
  const pinWith = pin ?? (await import("./board-client.mjs")).pinVersion;
  const pinned = await pinWith(name, pinLabel);
  const copyVersion = createHash("sha256").update(await readFile(result.board)).digest("hex");
  if (pinned.error || !pinned.pinned) {
    return { ...result, name, label: pinLabel, version: copyVersion, pinned: null, pinWarning: pinned.error ? `Not pinned in version history: ${pinned.error}` : "Not pinned in version history: the server has no history entry for this version yet" };
  }
  return {
    ...result,
    name,
    label: pinLabel,
    version: pinned.pinned.version ?? pinned.version,
    pinned: pinned.pinned,
    // A write landed between the copy and the pin: the pin is the newer version.
    ...(copyVersion !== (pinned.pinned.version ?? pinned.version) ? { note: "the board changed between the .snapshots copy and the pin; the pinned version is the newer one" } : {}),
  };
};

/** The lines `xcld snapshot` prints. */
export const formatSnapshot = (result) => [
  result.board,
  result.mermaid,
  result.pinned ? `pinned version ${result.version} as "${result.label}" (xcld diff ${result.name ?? "<board>"} --since "${result.label}")` : result.pinWarning,
  result.note ? `note: ${result.note}` : null,
].filter(Boolean).join("\n");

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