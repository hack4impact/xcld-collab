import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { boardFilePath, maxDepthFromEnv, splitBoardPath, validateBoardPath } from "./board-path.mjs";
import { listBoards } from "./board-index.mjs";
import { diffFiles, formatDiff } from "./diff.mjs";
import { fileToMermaid } from "./to-mermaid.mjs";
import { snapshotBoard, snapshotsFor, validateBoardName } from "./snapshot.mjs";

const boardsDir = () => path.resolve(process.env.XCLD_BOARDS_DIR || path.resolve("boards"));
const maxDepth = () => maxDepthFromEnv();
const publicUrl = () => (process.env.XCLD_PUBLIC_URL || "http://127.0.0.1:3100").replace(/\/+$/g, "");

const conventions = [
  "Conventions: snapshot before human review and diff after.",
  "Never rewrite a board's .mmd before diffing and acting on feedback: the browser import replaces the board.",
  "Draw proposed parts in light blue: classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2.",
  "Use Mermaid flowcharts only; subgraphs are supported (they convert to grouped, editable shapes).",
].join(" ");

const content = (text) => [{ type: "text", text }];
const okText = (text, structuredContent) => ({ content: content(text), ...(structuredContent === undefined ? {} : { structuredContent }) });
const toolError = (message) => ({ content: content(message), isError: true });

const boardPath = (name) => {
  if (!validateBoardName(name)) {
    throw new Error(`Invalid board name: ${name} (use path segments with letters, digits, ".", "_" or "-"; start each segment with a letter or digit)`);
  }
  return path.resolve(boardFilePath(boardsDir(), name, ".excalidraw", { maxDepth: maxDepth() }));
};

const resolveBoardOrFile = (arg) => {
  const file = existsSync(arg) ? path.resolve(arg) : boardPath(arg);
  if (!existsSync(file)) {
    throw new Error(`Board not found: ${arg} (expected ${file}). Open ${boardUrl(arg)} to create it.`);
  }
  return file;
};

const latestSnapshot = async (name) => {
  const segments = splitBoardPath(name);
  const dir = path.join(boardsDir(), ".snapshots", ...segments.slice(0, -1));
  const files = existsSync(dir) ? snapshotsFor(name, await readdir(dir)) : [];
  if (!files.length) {
    throw new Error(`No snapshots found for ${name}. Run "xcld snapshot ${name}" first, then edit, then diff.`);
  }
  return path.join(dir, files.at(-1));
};

const filterList = (data, folder) => {
  if (!folder) return data;
  const prefix = `${folder}/`;
  return {
    boards: data.boards.filter((board) => board.folder === folder || board.name.startsWith(prefix)),
    folders: data.folders.filter((item) => item === folder || item.startsWith(prefix)),
  };
};

const encodeBoardForQuery = (board) => board.split("/").map(encodeURIComponent).join("/");
const boardUrl = (board) => `${publicUrl()}/?board=${encodeBoardForQuery(board)}`;

const formatSnapshotResult = (result) => {
  const paths = { board: result.board, mermaid: result.mermaid };
  return {
    paths,
    reminder: "Snapshot captured. Ask the human to review the board, then run diff before rewriting the board inbox .mmd.",
  };
};

const registerTool = (server, name, config, handler) => {
  server.registerTool(name, config, async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  });
};

export const createXcldMcpServer = () => {
  const server = new McpServer({ name: "xcld-collab", version: "0.1.0" });

  registerTool(
    server,
    "list_boards",
    {
      description: `List boards and folders, same data as "xcld list --json". Optional folder filters to that subtree. ${conventions}`,
      inputSchema: { folder: z.string().optional().describe("Optional board folder, for example examples or myproject/designs.") },
      annotations: { readOnlyHint: true },
    },
    async ({ folder }) => {
      if (folder && !validateBoardPath(folder, { maxDepth: maxDepth() }).ok) {
        throw new Error(`Invalid folder: ${folder} (use path segments with letters, digits, ".", "_" or "-")`);
      }
      const data = filterList(await listBoards(boardsDir(), { maxDepth: maxDepth() }), folder);
      return okText(JSON.stringify(data, null, 2), data);
    },
  );

  registerTool(
    server,
    "read_board",
    {
      description: `Read a board as Mermaid, raw Excalidraw JSON, or both. ${conventions}`,
      inputSchema: {
        board: z.string().describe("Board path without extension, for example examples/demo."),
        format: z.enum(["mermaid", "json", "both"]).default("mermaid").describe("Output format. Default: mermaid."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ board, format }) => {
      const file = resolveBoardOrFile(board);
      const outputFormat = format ?? "mermaid";
      const result = {};
      if (outputFormat === "mermaid" || outputFormat === "both") result.mermaid = await fileToMermaid(file);
      if (outputFormat === "json" || outputFormat === "both") result.json = JSON.parse(await readFile(file, "utf8"));
      return okText(outputFormat === "json" ? JSON.stringify(result.json, null, 2) : outputFormat === "mermaid" ? result.mermaid : JSON.stringify(result, null, 2), result);
    },
  );

  registerTool(
    server,
    "write_mermaid",
    {
      description: `Write the board inbox boards/<path>.mmd, creating folders. An open browser tab converts it and REPLACES the board. ${conventions}`,
      inputSchema: {
        board: z.string().describe("Board path without extension."),
        mermaid: z.string().describe("Mermaid flowchart source. Use flowchart TD; subgraphs are supported."),
      },
    },
    async ({ board, mermaid }) => {
      if (!validateBoardName(board)) {
        throw new Error(`Invalid board name: ${board} (use path segments with letters, digits, ".", "_" or "-"; start each segment with a letter or digit)`);
      }
      const target = path.resolve(boardFilePath(boardsDir(), board, ".mmd", { maxDepth: maxDepth() }));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${String(mermaid).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n?$/, "\n")}`, "utf8");
      const result = {
        path: target,
        url: boardUrl(board),
        reminder: "Open or keep open the URL so the browser converts this inbox Mermaid and REPLACES the board. Before rewriting .mmd again, run diff and act on feedback.",
      };
      return okText(JSON.stringify(result, null, 2), result);
    },
  );

  registerTool(
    server,
    "snapshot",
    {
      description: `Capture a snapshot of a board, like "xcld snapshot"; respects XCLD_AUTO_EXPORT. ${conventions}`,
      inputSchema: { board: z.string().describe("Board path without extension.") },
      annotations: { readOnlyHint: true },
    },
    async ({ board }) => {
      const result = formatSnapshotResult(await snapshotBoard(board, boardsDir()));
      return okText(JSON.stringify(result, null, 2), result);
    },
  );

  registerTool(
    server,
    "diff",
    {
      description: `Show semantic changes. Pass board to compare latest snapshot to current board, or pass from/to files or board names. ${conventions}`,
      inputSchema: {
        board: z.string().optional().describe("Board path to compare against its latest snapshot."),
        from: z.string().optional().describe("Older board/file. Use with to."),
        to: z.string().optional().describe("Newer board/file. Use with from."),
        format: z.enum(["text", "json"]).default("text").describe("Default: text."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ board, from, to, format }) => {
      const outputFormat = format ?? "text";
      let oldFile;
      let newFile;
      if (board) {
        if (from || to) throw new Error('Use either "board" or "from"+"to", not both.');
        if (!validateBoardName(board)) throw new Error("Single-board diff expects a board name");
        oldFile = await latestSnapshot(board);
        newFile = resolveBoardOrFile(board);
      } else if (from && to) {
        oldFile = resolveBoardOrFile(from);
        newFile = resolveBoardOrFile(to);
      } else {
        throw new Error('Usage: provide "board" OR both "from" and "to".');
      }
      const diff = await diffFiles(oldFile, newFile);
      return okText(outputFormat === "json" ? JSON.stringify(diff, null, 2) : formatDiff(diff), diff);
    },
  );

  registerTool(
    server,
    "board_url",
    {
      description: `Return the browser URL for a board. Uses XCLD_PUBLIC_URL, defaulting to http://127.0.0.1:3100. ${conventions}`,
      inputSchema: { board: z.string().describe("Board path without extension.") },
      annotations: { readOnlyHint: true },
    },
    async ({ board }) => {
      if (!validateBoardName(board)) {
        throw new Error(`Invalid board name: ${board} (use path segments with letters, digits, ".", "_" or "-"; start each segment with a letter or digit)`);
      }
      const result = { url: boardUrl(board) };
      return okText(result.url, result);
    },
  );

  return server;
};

export const startStdioServer = async () => {
  const server = createXcldMcpServer();
  await server.connect(new StdioServerTransport());
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await startStdioServer();
}
