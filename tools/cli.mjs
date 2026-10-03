#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { boardFilePath, maxDepthFromEnv, splitBoardPath, validateBoardPath } from "./board-path.mjs";
import { listBoards } from "./board-index.mjs";
import { diffFiles, formatDiff } from "./diff.mjs";
import { fileToMermaid } from "./to-mermaid.mjs";
import { snapshotBoard, snapshotsFor, validateBoardName } from "./snapshot.mjs";

const boardsDir = () => path.resolve(process.env.XCLD_BOARDS_DIR || path.resolve("boards"));
const helpText = `xcld - local Excalidraw workspace tools

Usage:
  xcld diff <board> [--json]
  xcld diff <a.excalidraw> <b.excalidraw> [--json]
  xcld to-mermaid <board|file>
  xcld snapshot <board>
  xcld list [folder] [--json]
  xcld help
`;
const boardPath = (name) => {
  if (!validateBoardName(name)) throw new Error(`Invalid board name: ${name} (use path segments with letters, digits, ".", "_" or "-"; start each segment with a letter or digit)`);
  return path.resolve(boardFilePath(boardsDir(), name, ".excalidraw", { maxDepth: maxDepthFromEnv() }));
};
const resolveBoardOrFile = (arg) => {
  const file = existsSync(arg) ? path.resolve(arg) : boardPath(arg);
  if (!existsSync(file)) throw new Error(`Board not found: ${arg} (expected ${file}). Open http://127.0.0.1:3100/?board=${arg} to create it.`);
  return file;
};
const latestSnapshot = async (name) => {
  const segments = splitBoardPath(name);
  const dir = path.join(boardsDir(), ".snapshots", ...segments.slice(0, -1));
  const files = existsSync(dir) ? snapshotsFor(name, await readdir(dir)) : [];
  if (!files.length) throw new Error(`No snapshots found for ${name}. Run "xcld snapshot ${name}" first, then edit, then diff.`);
  return path.join(dir, files.at(-1));
};

const formatLocalTime = (iso) => {
  if (!iso) {
    return "unknown";
  }
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const filterList = (data, folder) => {
  if (!folder) {
    return data;
  }
  const prefix = `${folder}/`;
  return {
    boards: data.boards.filter((board) => board.folder === folder || board.name.startsWith(prefix)),
    folders: data.folders.filter((item) => item === folder || item.startsWith(prefix)),
  };
};

const printList = (data) => {
  for (const board of data.boards) {
    const state = board.hasBoard && board.hasMermaid ? "board+mmd" : board.hasBoard ? "board" : "mmd";
    const pending = board.mermaidPending ? " (mermaid pending)" : "";
    console.log(`${board.name}   ${state}${pending}   ${formatLocalTime(board.modified)}`);
  }
  console.log(`${data.boards.length} board${data.boards.length === 1 ? "" : "s"}`);
};

const run = async (argv) => {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(helpText.trimEnd());
    return;
  }
  if (command === "snapshot") {
    if (args.length !== 1) throw new Error("Usage: xcld snapshot <board>");
    const result = await snapshotBoard(args[0], boardsDir());
    console.log([result.board, result.mermaid].filter(Boolean).join("\n"));
    return;
  }
  if (command === "list") {
    const jsonMode = args.includes("--json");
    const names = args.filter((arg) => arg !== "--json");
    if (names.length > 1) throw new Error("Usage: xcld list [folder] [--json]");
    if (names[0] && !validateBoardPath(names[0], { maxDepth: maxDepthFromEnv() }).ok) {
      throw new Error(`Invalid folder: ${names[0]} (use path segments with letters, digits, ".", "_" or "-")`);
    }
    const data = filterList(await listBoards(boardsDir(), { maxDepth: maxDepthFromEnv() }), names[0]);
    if (jsonMode) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      printList(data);
    }
    return;
  }
  if (command === "to-mermaid") {
    if (args.length !== 1) throw new Error("Usage: xcld to-mermaid <board|file>");
    console.log(await fileToMermaid(resolveBoardOrFile(args[0])));
    return;
  }
  if (command === "diff") {
    const jsonMode = args.includes("--json");
    const names = args.filter((arg) => arg !== "--json");
    let oldFile;
    let newFile;
    if (names.length === 1) {
      if (!validateBoardName(names[0])) throw new Error("Single-argument diff expects a board name");
      newFile = resolveBoardOrFile(names[0]);
      oldFile = await latestSnapshot(names[0]);
    } else if (names.length === 2) {
      oldFile = resolveBoardOrFile(names[0]);
      newFile = resolveBoardOrFile(names[1]);
    } else {
      throw new Error("Usage: xcld diff <board> [--json] OR xcld diff <a.excalidraw> <b.excalidraw> [--json]");
    }
    const diff = await diffFiles(oldFile, newFile);
    console.log(jsonMode ? JSON.stringify(diff, null, 2) : formatDiff(diff));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
};

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}