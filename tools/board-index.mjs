import { promises as fs } from "node:fs";
import path from "node:path";
import { maxDepthFromEnv, splitBoardPath, validateBoardPath } from "./board-path.mjs";

const WATCHED_EXTENSIONS = new Set([".excalidraw", ".mmd"]);

export const boardKindForExtension = (extension) => {
  if (extension === ".excalidraw") {
    return "board";
  }
  if (extension === ".mmd") {
    return "mermaid";
  }
  return null;
};

export const isSkippedDirectory = (name) => name.startsWith(".") || name === "node_modules";

export const boardFolderAndLeaf = (name) => {
  const segments = splitBoardPath(name);
  const leaf = segments.at(-1);
  const folder = segments.slice(0, -1).join("/");
  return { folder, leaf };
};

const toBoardName = (relativeFile) => {
  const extension = path.extname(relativeFile);
  if (!WATCHED_EXTENSIONS.has(extension)) {
    return null;
  }
  return relativeFile.slice(0, -extension.length).split(path.sep).join("/");
};

export const walkBoardFiles = async (root, options = {}) => {
  const maxDepth = options.maxDepth === undefined ? maxDepthFromEnv() : options.maxDepth;
  const files = [];
  const folders = new Set();
  const rootPath = path.resolve(root);

  const visit = async (folder, relativeFolder, depth) => {
    let entries;
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const childRelative = relativeFolder ? path.join(relativeFolder, entry.name) : entry.name;
      const childPath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (isSkippedDirectory(entry.name)) {
          continue;
        }
        const boardFolder = childRelative.split(path.sep).join("/");
        const validation = validateBoardPath(boardFolder, { maxDepth });
        if (validation.ok) {
          folders.add(boardFolder);
        }
        if (maxDepth === undefined || depth < maxDepth) {
          await visit(childPath, childRelative, depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const boardName = toBoardName(childRelative);
      if (!boardName || !validateBoardPath(boardName, { maxDepth }).ok) {
        continue;
      }
      const extension = path.extname(entry.name);
      files.push({
        path: childPath,
        relativeFile: childRelative.split(path.sep).join("/"),
        name: boardName,
        kind: boardKindForExtension(extension),
      });
    }
  };

  await visit(rootPath, "", 0);
  files.sort((left, right) => left.relativeFile.localeCompare(right.relativeFile));
  return { files, folders: [...folders].sort((left, right) => left.localeCompare(right)) };
};

export const listBoards = async (root, options = {}) => {
  const { files, folders } = await walkBoardFiles(root, options);
  const byName = new Map();
  for (const file of files) {
    const stat = await fs.stat(file.path);
    const entry = byName.get(file.name) ?? {
      name: file.name,
      folder: boardFolderAndLeaf(file.name).folder,
      leaf: boardFolderAndLeaf(file.name).leaf,
      hasBoard: false,
      hasMermaid: false,
      mermaidPending: false,
      modified: null,
      _boardMtimeMs: 0,
      _mermaidMtimeMs: 0,
      _modifiedMs: 0,
    };
    if (file.kind === "board") {
      entry.hasBoard = true;
      entry._boardMtimeMs = stat.mtimeMs;
    } else if (file.kind === "mermaid") {
      entry.hasMermaid = true;
      entry._mermaidMtimeMs = stat.mtimeMs;
    }
    if (stat.mtimeMs >= entry._modifiedMs) {
      entry._modifiedMs = stat.mtimeMs;
      entry.modified = stat.mtime.toISOString();
    }
    byName.set(file.name, entry);
  }
  const boards = [...byName.values()]
    .map((entry) => {
      entry.mermaidPending = entry.hasMermaid && (!entry.hasBoard || entry._mermaidMtimeMs > entry._boardMtimeMs);
      delete entry._boardMtimeMs;
      delete entry._mermaidMtimeMs;
      delete entry._modifiedMs;
      return entry;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return { boards, folders };
};
