#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { boardFilePath, maxDepthFromEnv, splitBoardPath, validateBoardPath } from "./board-path.mjs";
import { listBoards } from "./board-index.mjs";
import { diffFiles, formatDiff } from "./diff.mjs";
import { exportHistory } from "./history.mjs";
import { mermaidSourceHash } from "./mermaid-hash.mjs";
import { checkBoardRules, effectiveRulesBriefing, formatCheckResult, formatRulesCheckDiagnostics, validateApplicableRules } from "./rules.mjs";
import { fileToMermaid } from "./to-mermaid.mjs";
import { snapshotAndPin, snapshotsFor, validateBoardName, formatSnapshot } from "./snapshot.mjs";
import { exportRoot, hostPathOf, stateDirFromEnv } from "./storage.mjs";
import { openInCanvas } from "./open-in-canvas.mjs";
import { describeMermaidStatus, describeMermaidWrite, describeWrite, diffSinceBoard, formatApplyOp, mermaidWriteStatus, readBoardVersion, writeBoardBranch, writeMermaid } from "./board-client.mjs";
import { formatDiffSince } from "./diff-since.mjs";
import { watchBoard } from "./watch.mjs";

const boardsDir = () => path.resolve(process.env.XCLD_BOARDS_DIR || path.resolve("boards"));
// Versions data and the export root, as the server sees them (tools/storage.mjs).
const stateDir = () => stateDirFromEnv(process.env, boardsDir());
const helpText = `xcld - local Excalidraw workspace tools

Usage:
  xcld diff <board> [--json]           (against the latest xcld snapshot copy)
  xcld diff <board> --since <since> [--json]
                                     (master against a point in version history, plus every edit
                                      overwritten since then; <since>: a version id prefix, a time
                                      like 10m, 2h or 2026-10-07T21:00Z, author:<name or key>, or a
                                      snapshot label)
  xcld diff <a.excalidraw> <b.excalidraw> [--json]
  xcld to-mermaid <board|file>
  xcld snapshot <board> [--name <label>]
                                     (a .snapshots copy, and the version pinned in history under
                                      the label, default its UTC stamp)
  xcld watch <board> [--json]        (prints every merge and history entry as it happens)
  xcld check <board>
  xcld rules <board>
  xcld rules check [board]
  xcld list [folder] [--json]
  xcld open-in-canvas <checkpointId> <board> [--overwrite]
  xcld read <board>                  (JSON with the version to pass as --base)
  xcld write <board> <file.excalidraw|-> --base <version|none> [--json]
  xcld write-mermaid <board> <file.mmd|-> [--base <version>] [--source <name>] [--position below|right|near:<id>] [--json]
                                     (the server applies it to the board and merges; no --base: the current board;
                                      --source names the diagram on the board, default main)
  xcld mermaid-status <board> <pendingId> [--wait] [--json]
                                     (a write that waits for a layout: a tab's, or the server's grid after ~2 min)
  xcld history export <board> [--to <dir>] [--full] [--json]
                                     (default --to: <cache>/exports/<board>, the host's ~/.excalidraw/exports/<board>
                                      unless XCLD_CACHE_DIR says otherwise; --full: every version as .excalidraw)
  xcld mermaid-apply --dry-run <board|file> <file.mmd> [--json]
  xcld mcp
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
    const state = [
      board.hasBoard ? "board" : null,
      board.hasMermaid ? "mmd" : null,
      board.hasView ? "view" : null,
    ].filter(Boolean).join("+") || "unknown";
    const pendingItems = [
      board.mermaidPending ? "mermaid pending" : null,
      board.viewPending ? "view pending" : null,
    ].filter(Boolean);
    const pending = pendingItems.length ? ` (${pendingItems.join(", ")})` : "";
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
    const usage = "Usage: xcld snapshot <board> [--name <label>]";
    const nameAt = args.indexOf("--name");
    if (nameAt >= 0 && (args[nameAt + 1] === undefined || args[nameAt + 1].startsWith("--"))) throw new Error(usage);
    const names = args.filter((arg, index) => nameAt < 0 || (index !== nameAt && index !== nameAt + 1));
    if (names.length !== 1) throw new Error(usage);
    const result = await snapshotAndPin(names[0], boardsDir(), { label: nameAt >= 0 ? args[nameAt + 1] : undefined });
    console.log(formatSnapshot(result));
    return;
  }
  if (command === "watch") {
    const jsonMode = args.includes("--json");
    const names = args.filter((arg) => arg !== "--json");
    if (names.length !== 1 || !validateBoardName(names[0])) throw new Error("Usage: xcld watch <board> [--json]");
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    await watchBoard(names[0], { signal: controller.signal, json: jsonMode });
    return;
  }
  if (command === "check") {
    if (args.length !== 1) throw new Error("Usage: xcld check <board>");
    const result = await checkBoardRules(args[0], boardsDir());
    console.log(formatCheckResult(result));
    if (result.open.length || result.diagnostics.some((item) => item.severity === "error")) process.exitCode = 1;
    return;
  }
  if (command === "rules") {
    if (args[0] === "check") {
      const names = args.slice(1);
      if (names.length > 1) throw new Error("Usage: xcld rules check [board]");
      const result = await validateApplicableRules(names[0], boardsDir());
      const output = formatRulesCheckDiagnostics(result.diagnostics);
      if (output) console.log(output);
      const errorCount = result.diagnostics.filter((item) => item.severity === "error").length;
      const warningCount = result.diagnostics.filter((item) => item.severity === "warning").length;
      console.log(errorCount ? `Design rules invalid: ${errorCount} error(s), ${warningCount} warning(s).` : `Design rules valid: ${result.files.length} file(s), ${warningCount} warning(s).`);
      if (errorCount) process.exitCode = 1;
      return;
    }
    if (args.length !== 1) throw new Error("Usage: xcld rules <board> OR xcld rules check [board]");
    console.log((await effectiveRulesBriefing(args[0], boardsDir())).text);
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
  if (command === "open-in-canvas") {
    const overwrite = args.includes("--overwrite");
    const names = args.filter((arg) => arg !== "--overwrite");
    if (names.length !== 2) throw new Error("Usage: xcld open-in-canvas <checkpointId> <board> [--overwrite]");
    const result = await openInCanvas({ checkpointId: names[0], board: names[1], overwrite });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "read") {
    if (args.length !== 1) throw new Error("Usage: xcld read <board>");
    const read = await readBoardVersion(args[0], { file: boardPath(args[0]) });
    if (!read.exists) throw new Error(`Board not found: ${args[0]}${read.warning ? ` (${read.warning})` : ""}`);
    console.log(JSON.stringify({ board: args[0], version: read.version, ...(read.warning ? { warning: read.warning } : {}), scene: read.scene }, null, 2));
    return;
  }
  if (command === "write") {
    const jsonMode = args.includes("--json");
    const baseAt = args.indexOf("--base");
    const base = baseAt >= 0 ? args[baseAt + 1] : undefined;
    const names = args.filter((arg, index) => arg !== "--json" && index !== baseAt && index !== baseAt + 1);
    if (names.length !== 2 || base === undefined) throw new Error("Usage: xcld write <board> <file.excalidraw|-> --base <version|none> [--json]   (get the version from xcld read)");
    if (!validateBoardName(names[0])) throw new Error(`Invalid board name: ${names[0]}`);
    const text = names[1] === "-" ? await new Promise((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { data += chunk; });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    }) : await readFile(names[1], "utf8");
    const parsed = JSON.parse(text);
    const scene = Array.isArray(parsed) ? { elements: parsed } : parsed;
    const author = `cli:${String(process.env.XCLD_AUTHOR ?? "").trim() || "cli"}`;
    const result = await writeBoardBranch(names[0], { author, base: base === "none" ? null : base, elements: scene.elements, appState: scene.appState, files: scene.files });
    console.log(jsonMode ? JSON.stringify(result, null, 2) : describeWrite(names[0], result));
    if (result.status !== "merged" && result.status !== "queued") process.exitCode = 1;
    return;
  }
  if (command === "write-mermaid") {
    const usage = "Usage: xcld write-mermaid <board> <file.mmd|-> [--base <version>] [--source <name>] [--position below|right|near:<id>] [--json]   (without --base: the current board)";
    const jsonMode = args.includes("--json");
    const valued = ["--base", "--source", "--position"];
    const values = {};
    const used = new Set();
    for (const flag of valued) {
      const at = args.indexOf(flag);
      if (at < 0) continue;
      if (args[at + 1] === undefined || args[at + 1].startsWith("--")) throw new Error(usage);
      values[flag] = args[at + 1];
      used.add(at).add(at + 1);
    }
    const base = values["--base"];
    const names = args.filter((arg, index) => arg !== "--json" && !used.has(index));
    if (names.length !== 2) throw new Error(usage);
    if (!validateBoardName(names[0])) throw new Error(`Invalid board name: ${names[0]}`);
    const source = names[1] === "-" ? await new Promise((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { data += chunk; });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    }) : await readFile(names[1], "utf8");
    const author = `cli:${String(process.env.XCLD_AUTHOR ?? "").trim() || "cli"}`;
    const result = await writeMermaid(names[0], { author, base: base === "none" ? undefined : base, mermaid: source, source: values["--source"], position: values["--position"] });
    console.log(jsonMode ? JSON.stringify(result, null, 2) : describeMermaidWrite(names[0], result, { url: `${(process.env.XCLD_PUBLIC_URL || "http://127.0.0.1:3100").replace(/\/+$/g, "")}/?board=${names[0].split("/").map(encodeURIComponent).join("/")}` }));
    if (!["merged", "queued", "needs-tab"].includes(result.status)) process.exitCode = 1;
    return;
  }
  if (command === "mermaid-status") {
    const usage = "Usage: xcld mermaid-status <board> <pendingId> [--wait] [--json]   (--wait: until it has landed, been superseded or needs a tab)";
    const jsonMode = args.includes("--json");
    const wait = args.includes("--wait");
    const names = args.filter((arg) => arg !== "--json" && arg !== "--wait");
    if (names.length !== 2) throw new Error(usage);
    if (!validateBoardName(names[0])) throw new Error(`Invalid board name: ${names[0]}`);
    let result = await mermaidWriteStatus(names[0], names[1]);
    while (wait && result.httpStatus === 200 && (result.status === "pending" || result.status === "landing")) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      result = await mermaidWriteStatus(names[0], names[1]);
    }
    console.log(jsonMode ? JSON.stringify(result, null, 2) : describeMermaidStatus(names[0], { id: names[1], ...result }));
    if (result.httpStatus !== 200) process.exitCode = 1;
    return;
  }
  if (command === "history") {
    const usage = "Usage: xcld history export <board> [--to <dir>] [--full] [--json]";
    const jsonMode = args.includes("--json");
    const full = args.includes("--full");
    const toAt = args.indexOf("--to");
    if (toAt >= 0 && (args[toAt + 1] === undefined || args[toAt + 1].startsWith("--"))) throw new Error(usage);
    const names = args.filter((arg, index) => !["--json", "--full"].includes(arg) && index !== toAt && (toAt < 0 || index !== toAt + 1));
    if (names[0] !== "export" || names.length !== 2) throw new Error(usage);
    const board = names[1];
    if (!validateBoardName(board)) throw new Error(`Invalid board name: ${board}`);
    const to = toAt >= 0 ? path.resolve(args[toAt + 1]) : path.join(exportRoot(), ...splitBoardPath(board));
    const result = await exportHistory({ stateDir: stateDir(), board, to, full });
    // In the container, name the folder as the host sees it too (compose passes the host path).
    const hostPath = hostPathOf(result.to);
    if (jsonMode) {
      console.log(JSON.stringify({ ...result, ...(hostPath ? { hostPath } : {}) }, null, 2));
      return;
    }
    const kinds = full ? `${result.entries} full version${result.entries === 1 ? "" : "s"}` : `${result.checkpoint} checkpoint${result.checkpoint === 1 ? "" : "s"}, ${result.delta} delta${result.delta === 1 ? "" : "s"}`;
    console.log(`Exported ${result.entries} history entr${result.entries === 1 ? "y" : "ies"} of ${board} (${kinds}${result.none ? `, ${result.none} with only overwritten edits` : ""}${result.skipped ? `, ${result.skipped} skipped` : ""}) to ${result.to}${hostPath ? `\nOn the host: ${hostPath}` : ""}`);
    return;
  }
  if (command === "diff") {
    const jsonMode = args.includes("--json");
    const sinceAt = args.indexOf("--since");
    if (sinceAt >= 0 && (args[sinceAt + 1] === undefined || args[sinceAt + 1] === "--json")) throw new Error("Usage: xcld diff <board> --since <version|time|author:<name>|snapshot label> [--json]");
    const names = args.filter((arg, index) => arg !== "--json" && (sinceAt < 0 || (index !== sinceAt && index !== sinceAt + 1)));
    if (sinceAt >= 0) {
      if (names.length !== 1 || !validateBoardName(names[0])) throw new Error("Usage: xcld diff <board> --since <version|time|author:<name>|snapshot label> [--json]");
      const result = await diffSinceBoard(names[0], args[sinceAt + 1], { file: boardPath(names[0]), stateDir: stateDir(), boardsDir: boardsDir() });
      if (result.warning && !jsonMode) console.error(result.warning);
      console.log(jsonMode ? JSON.stringify(result, null, 2) : formatDiffSince(result));
      return;
    }
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
    const diff = await diffFiles(oldFile, newFile, { board: names.length === 1 ? names[0] : undefined, boardsDir: boardsDir() });
    console.log(jsonMode ? JSON.stringify(diff, null, 2) : formatDiff(diff));
    return;
  }
  if (command === "mcp") {
    if (args.length !== 0) throw new Error("Usage: xcld mcp");
    const bundle = new URL("./mcp.bundle.mjs", import.meta.url);
    if (!existsSync(bundle)) {
      throw new Error("MCP bundle not found. Run \"cd app; npm ci; npm run build\" first, then retry \"xcld mcp\".");
    }
    const { startStdioServer } = await import(bundle.href);
    await startStdioServer();
    return;
  }
  if (command === "mermaid-apply") {
    const dryRun = args.includes("--dry-run");
    const jsonMode = args.includes("--json");
    const names = args.filter((arg) => arg !== "--dry-run" && arg !== "--json");
    if (names.length !== 2 || !dryRun) throw new Error("Usage: xcld mermaid-apply --dry-run <board|file> <file.mmd> [--json] (preview only: nothing is written)");
    const target = existsSync(names[0]) ? path.resolve(names[0]) : boardPath(names[0]);
    const master = existsSync(target) ? JSON.parse(await readFile(target, "utf8")) : null;
    const source = await readFile(names[1], "utf8");
    const { closeParser, parseFlowchart } = await import("./mermaid-parse.mjs");
    const { applyMermaid } = await import("./mermaid-apply.mjs");
    try {
      const parsed = await parseFlowchart(source);
      if (!parsed.ok && parsed.error) {
        throw new Error(`Mermaid parse error${parsed.error.line ? ` on line ${parsed.error.line}` : ""}: ${parsed.error.message}`);
      }
      const result = applyMermaid({ master, parsed, hashOfSource: mermaidSourceHash(source) });
      if (jsonMode) {
        console.log(JSON.stringify({ needsTabLayout: result.needsTabLayout, reason: result.reason ?? null, ops: result.ops }, null, 2));
      } else {
        for (const op of result.ops) console.log(formatApplyOp(op));
        console.log(result.needsTabLayout
          ? `Needs a tab: ${result.reason}. Open the board so the canvas lays out the diagram.`
          : `${result.ops.length} change${result.ops.length === 1 ? "" : "s"} (dry run, nothing written).`);
      }
    } finally {
      await closeParser();
    }
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
