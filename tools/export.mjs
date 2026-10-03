import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { splitBoardPath } from "./board-path.mjs";
import { sceneToMermaid } from "./to-mermaid.mjs";

// XCLD_AUTO_EXPORT controls automatic Mermaid exports:
//   off      - nothing automatic; use `xcld to-mermaid`.
//   snapshot - (default) `xcld snapshot` also writes <leaf>.<time>.mmd beside the snapshot.
//   save     - snapshot behavior, plus the server keeps boards/.exports/<path>.mmd current
//              on every board change.
// Exports never go to boards/<path>.mmd: that is the Mermaid inbox, and writing it would
// replace the board. Dot-folders (.snapshots, .exports) are skipped by the board walker.
export const AUTO_EXPORT_MODES = ["off", "snapshot", "save"];
export const DEFAULT_AUTO_EXPORT = "snapshot";

export const parseAutoExport = (value) => {
  const mode = String(value ?? DEFAULT_AUTO_EXPORT).trim().toLowerCase() || DEFAULT_AUTO_EXPORT;
  if (!AUTO_EXPORT_MODES.includes(mode)) {
    throw new Error(`Invalid XCLD_AUTO_EXPORT "${value}" (use one of: ${AUTO_EXPORT_MODES.join(", ")})`);
  }
  return mode;
};

export const autoExportFromEnv = () => parseAutoExport(process.env.XCLD_AUTO_EXPORT);

export const exportFilePath = (root, name) => {
  const segments = splitBoardPath(name);
  return path.join(path.resolve(root), ".exports", ...segments.slice(0, -1), `${segments.at(-1)}.mmd`);
};

export const writeMermaidFromBoard = async (boardFile, targetFile) => {
  const scene = JSON.parse(await readFile(boardFile, "utf8"));
  const mermaid = `${sceneToMermaid(scene)}\n`;
  await mkdir(path.dirname(targetFile), { recursive: true });
  const tempFile = `${targetFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempFile, mermaid, "utf8");
  await rename(tempFile, targetFile);
  return targetFile;
};
