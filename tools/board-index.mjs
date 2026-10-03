import { promises as fs } from "node:fs";
import path from "node:path";
import { maxDepthFromEnv, splitBoardPath, validateBoardPath } from "./board-path.mjs";

export const VIEW_INBOX_SUFFIX = ".view.json";

const WATCHED_SUFFIXES = [
  { suffix: ".excalidraw", kind: "board" },
  { suffix: ".mmd", kind: "mermaid" },
  { suffix: VIEW_INBOX_SUFFIX, kind: "view" },
];

export const boardKindForExtension = (extension) => {
  if (extension === ".excalidraw") {
    return "board";
  }
  if (extension === ".mmd") {
    return "mermaid";
  }
  if (extension === VIEW_INBOX_SUFFIX) {
    return "view";
  }
  return null;
};

export const boardInfoForRelativeFile = (relativeFile) => {
  const normalized = String(relativeFile).replace(/\\/g, "/");
  for (const item of WATCHED_SUFFIXES) {
    if (normalized.endsWith(item.suffix)) {
      return {
        name: normalized.slice(0, -item.suffix.length).split(path.sep).join("/"),
        kind: item.kind,
        suffix: item.suffix,
      };
    }
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

const toBoardFile = (relativeFile) => {
  const info = boardInfoForRelativeFile(relativeFile);
  if (!info) {
    return null;
  }
  return {
    name: info.name.split(path.sep).join("/"),
    kind: info.kind,
  };
};

const hasLiveElements = async (filePath) => {
  try {
    const data = JSON.parse(await fs.readFile(filePath, "utf8"));
    return Array.isArray(data.elements) && data.elements.some((element) => !element?.isDeleted);
  } catch {
    return true;
  }
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
      const boardFile = toBoardFile(childRelative);
      if (!boardFile || !validateBoardPath(boardFile.name, { maxDepth }).ok) {
        continue;
      }
      files.push({
        path: childPath,
        relativeFile: childRelative.split(path.sep).join("/"),
        name: boardFile.name,
        kind: boardFile.kind,
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
      hasView: false,
      mermaidPending: false,
      viewPending: false,
      modified: null,
      _boardPath: null,
      _boardHasLiveElements: true,
      _boardMtimeMs: 0,
      _mermaidMtimeMs: 0,
      _viewMtimeMs: 0,
      _modifiedMs: 0,
    };
    if (file.kind === "board") {
      entry.hasBoard = true;
      entry._boardPath = file.path;
      entry._boardMtimeMs = stat.mtimeMs;
    } else if (file.kind === "mermaid") {
      entry.hasMermaid = true;
      entry._mermaidMtimeMs = stat.mtimeMs;
    } else if (file.kind === "view") {
      entry.hasView = true;
      entry._viewMtimeMs = stat.mtimeMs;
    }
    if (stat.mtimeMs >= entry._modifiedMs) {
      entry._modifiedMs = stat.mtimeMs;
      entry.modified = stat.mtime.toISOString();
    }
    byName.set(file.name, entry);
  }
  for (const entry of byName.values()) {
    if (entry.hasBoard && (entry.hasMermaid || entry.hasView)) {
      entry._boardHasLiveElements = await hasLiveElements(entry._boardPath);
    }
  }
  const boards = [...byName.values()]
    .map((entry) => {
      entry.mermaidPending = entry.hasMermaid && (!entry.hasBoard || !entry._boardHasLiveElements || entry._mermaidMtimeMs > entry._boardMtimeMs);
      entry.viewPending = entry.hasView && (!entry.hasBoard || !entry._boardHasLiveElements || entry._viewMtimeMs > entry._boardMtimeMs);
      delete entry._boardPath;
      delete entry._boardHasLiveElements;
      delete entry._boardMtimeMs;
      delete entry._mermaidMtimeMs;
      delete entry._viewMtimeMs;
      delete entry._modifiedMs;
      return entry;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return { boards, folders };
};
