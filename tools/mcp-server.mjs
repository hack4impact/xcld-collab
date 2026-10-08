import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { boardFilePath, maxDepthFromEnv, splitBoardPath, validateBoardPath } from "./board-path.mjs";
import { listBoards } from "./board-index.mjs";
import { diffFiles, formatDiff } from "./diff.mjs";
import { checkBoardRules, effectiveRulesBriefing, effectiveSnapshotMode, formatCheckResult } from "./rules.mjs";
import { sceneToMermaid } from "./to-mermaid.mjs";
import { snapshotBoard, snapshotsFor, validateBoardName } from "./snapshot.mjs";
import { openInCanvas } from "./open-in-canvas.mjs";
import { describeMermaidStatus, describeMermaidWrite, describeWrite, mermaidWriteStatus, readBoardVersion, writeBoardBranch, writeMermaid } from "./board-client.mjs";

// Author key for this process's writes: agent:<MCP clientInfo.name>#<id>. The id is new for
// every `xcld mcp` process, so two sessions of the same client never share a branch.
export const PROCESS_ID = randomBytes(3).toString("hex");
export const agentAuthor = (clientName) => {
  const name = String(clientName ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 100) || "mcp";
  return `agent:${name}#${PROCESS_ID}`;
};

const boardsDir = () => path.resolve(process.env.XCLD_BOARDS_DIR || path.resolve("boards"));
const maxDepth = () => maxDepthFromEnv();
const publicUrl = () => (process.env.XCLD_PUBLIC_URL || "http://127.0.0.1:3100").replace(/\/+$/g, "");

const LABEL_NEWLINE_RULE = 'To break a label across lines, put a real newline inside the quoted label (in the JSON argument: A["PUT /api/board\\napi.mjs:362"]); never <br/> or <br>, which the canvas shows as literal text.';

const conventions = [
  "Conventions: snapshot before human review and diff after.",
  "Read the board first (read_board) and pass its version as base when you write: the server merges your write with the human's and other agents' edits.",
  "Draw proposed parts in light blue: classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2.",
  "Read the board's design-rules briefing; folder design-rules.csv files can replace local defaults.",
  "Use Mermaid flowcharts only; subgraphs are supported (they convert to grouped, editable shapes). Several diagrams can share a board as named Mermaid sources (write_mermaid source).",
  LABEL_NEWLINE_RULE,
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

const briefingFor = async (board) => (await effectiveRulesBriefing(board, boardsDir())).text;

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
      description: `Read a board as Mermaid, raw Excalidraw JSON, or both, through the board server. Returns "version": pass it as "base" to write_board or write_mermaid, so the server merges your write with anything written since. ${conventions}`,
      inputSchema: {
        board: z.string().describe("Board path without extension, for example examples/demo."),
        format: z.enum(["mermaid", "json", "both"]).default("mermaid").describe("Output format. Default: mermaid."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ board, format }) => {
      if (!validateBoardName(board)) {
        throw new Error(`Invalid board name: ${board} (use path segments with letters, digits, ".", "_" or "-"; start each segment with a letter or digit)`);
      }
      const read = await readBoardVersion(board, { file: boardPath(board) });
      if (!read.exists) {
        throw new Error(`Board not found: ${board}. Open ${boardUrl(board)} to create it, or call write_board with base null.${read.warning ? ` ${read.warning}` : ""}`);
      }
      const outputFormat = format ?? "mermaid";
      const result = { board, version: read.version };
      if (outputFormat === "mermaid" || outputFormat === "both") result.mermaid = sceneToMermaid(read.scene);
      if (outputFormat === "json" || outputFormat === "both") result.json = read.scene;
      if (read.warning) result.warning = read.warning;
      result.briefing = await briefingFor(board);
      const versionLine = `version: ${read.version} (pass it as base to write_board or write_mermaid)${read.warning ? `\nwarning: ${read.warning}` : ""}`;
      return okText(outputFormat === "mermaid" ? `${result.mermaid}\n\n${versionLine}\n\n${result.briefing}` : JSON.stringify(result, null, 2), result);
    },
  );

  registerTool(
    server,
    "write_board",
    {
      description: `Write Excalidraw elements to a board through the board server, which merges them with edits made since your base (the human's tab, other agents). Send the whole board as you want it: elements you leave out are deleted. Pass base = the "version" from read_board (null only for a new board). A unit (a shape and its label) changed on both sides goes to the later write; the result lists what was applied and overwritten. If the merge takes longer than 5 s the write is queued: it is safe and will land. ${conventions}`,
      inputSchema: {
        board: z.string().describe("Board path without extension."),
        base: z.string().nullable().describe('The "version" read_board returned for this board; null for a new board.'),
        elements: z.array(z.object({ id: z.string() }).passthrough()).describe("Excalidraw elements: the full board you want. Keep element ids stable; keep bound text with its container (containerId) and arrows bound by startBinding/endBinding."),
        appState: z.record(z.string(), z.any()).optional().describe("Optional Excalidraw appState (e.g. viewBackgroundColor)."),
        files: z.record(z.string(), z.any()).optional().describe("Optional image files keyed by fileId, as in an .excalidraw file."),
      },
    },
    async ({ board, base, elements, appState, files }) => {
      if (!validateBoardName(board)) {
        throw new Error(`Invalid board name: ${board} (use path segments with letters, digits, ".", "_" or "-"; start each segment with a letter or digit)`);
      }
      const result = await writeBoardBranch(board, { author: agentAuthor(server.server.getClientVersion()?.name), base, elements, appState, files });
      const message = describeWrite(board, result);
      if (result.status !== "merged" && result.status !== "queued") {
        return toolError(message);
      }
      return okText(message, { ...result, url: boardUrl(board) });
    },
  );

  registerTool(
    server,
    "write_mermaid",
    {
      description: `Write a Mermaid flowchart to a board. The board server applies it to the board and merges it with edits made since your base, like write_board: existing shapes keep their place and the human's notes and drawings stay; relabels, restyles, new nodes and edges and removed Mermaid nodes are applied; a shape changed on both sides goes to the later write. A node the human edited on the canvas keeps the human's version until your Mermaid changes that node. Call read_board first and pass its "version" as base (without base: the board as it is now). Several agents can write Mermaid to the same board in parallel. Name the diagram with "source" to keep several diagrams on one board (default "main"): each source only ever changes and deletes its own shapes, and writing the same Mermaid again is a no-op. A diagram that isn't on the board yet is added as a group next to the existing drawing (below for TD, right of it for LR; "position" can say below, right or near:<id>); a browser tab lays it out, or the server does in a simple grid after about 2 minutes: the result is then "needs-tab" with a pendingId for mermaid_status. If the merge takes longer than 5 s the write is queued: it is safe and will land. ${conventions}`,
      inputSchema: {
        board: z.string().describe("Board path without extension."),
        mermaid: z.string().describe("Mermaid flowchart source. Use flowchart TD; subgraphs are supported. Break labels with a real newline inside the quotes, never <br/>. Keep node ids stable: a node id is the shape's id on the board."),
        base: z.string().optional().describe('The "version" read_board returned for this board. Omit it to apply to the board as it is now.'),
        source: z.string().optional().describe('Name of this diagram on the board (default "main"). Use a new name for a separate diagram on the same board; reuse the name to edit that diagram. A letter, then letters, digits, "_" or "-".'),
        position: z.string().optional().describe('Where a new diagram goes on a board that already has a drawing: "below", "right" or "near:<element or node id>". Default: follow the diagram direction (TD below, LR right).'),
      },
    },
    async ({ board, mermaid, base, source, position }) => {
      if (!validateBoardName(board)) {
        throw new Error(`Invalid board name: ${board} (use path segments with letters, digits, ".", "_" or "-"; start each segment with a letter or digit)`);
      }
      let preWriteSnapshot = null;
      if (await effectiveSnapshotMode(board, boardsDir()) === "on") {
        const existingBoard = boardPath(board);
        if (existsSync(existingBoard)) {
          preWriteSnapshot = formatSnapshotResult(await snapshotBoard(board, boardsDir()));
        }
      }
      const written = await writeMermaid(board, { author: agentAuthor(server.server.getClientVersion()?.name), base, mermaid, source, position });
      const url = boardUrl(board);
      const message = describeMermaidWrite(board, written, { url });
      if (!["merged", "queued", "needs-tab"].includes(written.status)) {
        return toolError(message);
      }
      const result = {
        status: written.status,
        ...(written.version ? { version: written.version } : {}),
        ...(written.branchId ? { branchId: written.branchId } : {}),
        ...(written.reason ? { reason: written.reason } : {}),
        ...(written.source ? { source: written.source } : {}),
        ...(written.pendingId ? { pendingId: written.pendingId, pending: written.pending } : {}),
        ...(written.noop ? { noop: true } : {}),
        ...(written.hint ? { hint: written.hint } : {}),
        applied: written.applied ?? [],
        overwritten: written.overwritten ?? [],
        ops: written.ops ?? [],
        ...(written.deletesSkipped ? { deletesSkipped: true } : {}),
        url,
        preWriteSnapshot,
        message,
        briefing: await briefingFor(board),
      };
      return okText(`${message}\n\n${result.briefing}`, result);
    },
  );

  registerTool(
    server,
    "mermaid_status",
    {
      description: `Where a pending Mermaid write is (write_mermaid answered "needs-tab" with a pendingId): pending (waiting for a tab; the server lays a flowchart out itself at layoutAt), landing, landed (via a tab, the server's grid, or node by node, with the board version), superseded by a newer write of the same source, or waiting-for-tab (a non-flowchart). ${conventions}`,
      inputSchema: {
        board: z.string().describe("Board path without extension."),
        pendingId: z.string().describe("The pendingId write_mermaid returned."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ board, pendingId }) => {
      if (!validateBoardName(board)) {
        throw new Error(`Invalid board name: ${board} (use path segments with letters, digits, ".", "_" or "-"; start each segment with a letter or digit)`);
      }
      const found = await mermaidWriteStatus(board, pendingId);
      const message = describeMermaidStatus(board, { id: pendingId, ...found });
      if (found.httpStatus !== 200) {
        return toolError(message);
      }
      return okText(message, { ...found, message });
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
      const diff = await diffFiles(oldFile, newFile, { board, boardsDir: boardsDir() });
      return okText(outputFormat === "json" ? JSON.stringify(diff, null, 2) : formatDiff(diff), diff);
    },
  );

  registerTool(
    server,
    "check_board",
    {
      description: `List open design-rule check items for a board, and warn about labels that contain a literal <br>. ${conventions}`,
      inputSchema: { board: z.string().describe("Board path without extension.") },
      annotations: { readOnlyHint: true },
    },
    async ({ board }) => {
      const result = await checkBoardRules(board, boardsDir());
      return okText(formatCheckResult(result), result);
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

  registerTool(
    server,
    "open_in_canvas",
    {
      description: `Bridge a drawing from the Excalidraw MCP Apps chat widget into the persistent localhost canvas when the user wants to edit it there, or when VS Code cannot open the widget editor. Reads a checkpoint id from the widget, writes boards/<path>.view.json, and returns the canvas URL. Refuses to overwrite an existing board unless overwrite=true; snapshot first. ${conventions}`,
      inputSchema: {
        checkpointId: z.string().describe("Checkpoint id shown by the widget hint or returned in create_view structuredContent."),
        board: z.string().describe("Destination board path without extension."),
        overwrite: z.boolean().optional().default(false).describe("Allow writing a view inbox when boards/<path>.excalidraw already exists. Snapshot first."),
      },
    },
    async ({ checkpointId, board, overwrite }) => {
      const result = await openInCanvas({ checkpointId, board, overwrite: Boolean(overwrite), boardsDir: boardsDir(), publicUrl: publicUrl() });
      return okText(JSON.stringify(result, null, 2), result);
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
