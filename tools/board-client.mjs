// Client side of the board server's read and write API, shared by `xcld mcp` and the CLI.
// Agents read through the server (so the version they base a write on is retained) and write
// through POST /api/branch (so the server merges instead of the file being overwritten).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const apiUrl = () => (process.env.XCLD_API_URL || "http://127.0.0.1:3100").replace(/\/+$/g, "");

const encodeBoard = (board) => board.split("/").map(encodeURIComponent).join("/");
const etagValue = (response) => response.headers.get("etag")?.replace(/^"(.*)"$/, "$1") ?? null;

const describeFetchError = (error) => {
  const cause = error?.cause?.code ?? error?.code ?? error?.message ?? String(error);
  return `the board server at ${apiUrl()} is not reachable (${cause}). Start it with "docker compose up -d --wait", or set XCLD_API_URL.`;
};

/**
 * Reads a board through GET /api/board, which keeps the returned version resolvable as a base.
 * Falls back to the file when the server is down; that version is the file's hash but isn't
 * retained by the server, so a later write against it may be refused as an unknown base.
 */
export const readBoardVersion = async (board, { file } = {}) => {
  try {
    const response = await fetch(`${apiUrl()}/api/board/${encodeBoard(board)}`, { signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) {
      return { exists: false, version: null, via: "server" };
    }
    if (!response.ok) {
      throw new Error(`GET /api/board/${board}: HTTP ${response.status}`);
    }
    const text = await response.text();
    return { exists: true, version: etagValue(response), text, scene: JSON.parse(text), via: "server" };
  } catch (error) {
    if (!file || !(error?.cause || error?.name === "TimeoutError" || error?.name === "TypeError")) {
      throw error;
    }
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return { exists: false, version: null, via: "file", warning: describeFetchError(error) };
    }
    return {
      exists: true,
      version: createHash("sha256").update(text).digest("hex"),
      text,
      scene: JSON.parse(text),
      via: "file",
      warning: `Read from the file: ${describeFetchError(error)}`,
    };
  }
};

/**
 * Writes a board through POST /api/branch. Resolves to the server's answer plus `httpStatus`:
 * 200 `{ status: "merged", version, applied, overwritten, unbound }`, 202 `{ status: "queued",
 * branchId }`, 409 `{ error: "unknown-base" }`, 400 `{ error }`.
 */
export const writeBoardBranch = async (board, { author, displayName, base, elements, appState, files, writtenAt = Date.now() }) => {
  let response;
  try {
    response = await fetch(`${apiUrl()}/api/branch/${encodeBoard(board)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author, displayName, base: base ?? null, writtenAt, kind: "json", elements, appState, files }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(`Nothing was written: ${describeFetchError(error)}`);
  }
  const data = await response.json().catch(() => ({}));
  return { httpStatus: response.status, ...data };
};

// One line an agent can act on.
export const describeWrite = (board, result) => {
  if (result.status === "merged") {
    const overwritten = result.overwritten?.length
      ? ` ${result.overwritten.length} unit(s) changed on both sides went to the later write: ${result.overwritten.map((item) => `"${item.label}" (${item.winner.side === "branch" ? "yours kept" : `overwritten by ${item.winner.author}`})`).join(", ")}.`
      : "";
    return `Merged into ${board}: version ${result.version}, ${result.applied?.length ?? 0} change(s) applied.${overwritten} Pass version as base on your next write.`;
  }
  if (result.status === "queued") {
    return `Queued: the server has your write for ${board} safely in its journal (branch ${result.branchId}) and will merge it; nothing is lost. Read the board again before writing on top of it.`;
  }
  if (result.error === "unknown-base") {
    return `Not written: base ${result.base ?? "?"} is unknown to the server (expired or never read through it). Read the board again and resend with its version as base.`;
  }
  return `Not written (HTTP ${result.httpStatus}): ${result.error ?? "unexpected response"}${result.hint ? ` - ${result.hint}` : ""}`;
};

const quoteLabel = (value) => JSON.stringify(String(value ?? ""));
// One line per change a Mermaid apply made (the ops of tools/mermaid-apply.mjs).
export const formatApplyOp = (op) => {
  if (op.op === "relabel") return op.to ? `relabel ${op.kind} ${op.id}: ${quoteLabel(op.from)} -> ${quoteLabel(op.to)}` : `remove ${op.kind} label ${op.id}: ${quoteLabel(op.from)}`;
  if (op.op === "restyle") return `restyle ${op.kind} ${op.id}: ${Object.entries(op.changes).map(([key, change]) => `${key} ${change.from ?? "none"} -> ${change.to ?? "none"}`).join(", ")}`;
  if (op.op === "add-node") return `add node ${op.id} (${op.shape}) ${op.anchor ? `${op.placement} ${op.anchor}` : "beside the drawing"} at ${Math.round(op.x)},${Math.round(op.y)}`;
  if (op.op === "add-edge") return `add edge ${op.id}: ${op.start} -> ${op.end}${op.label ? ` ${quoteLabel(op.label)}` : ""}`;
  if (op.op === "add-subgraph") return `add subgraph ${op.id}: ${op.members.join(", ")}`;
  if (op.op === "delete") return `delete ${op.kind} ${op.id}`;
  if (op.op === "unbind") return `unbind ${op.end} of ${op.id} from deleted ${op.from}`;
  if (op.op === "reshape") return `reshape ${op.id}: ${op.from} -> ${op.to}`;
  if (op.op === "regroup") return `regroup ${op.id}: [${op.from.join(", ")}] -> [${op.to.join(", ")}]`;
  if (op.op === "reconnect") return `reconnect ${op.id}: ${op.start} -> ${op.end}`;
  if (op.op === "resize") return `resize ${op.id}: ${Math.round(op.from.width)}x${Math.round(op.from.height)} -> ${Math.round(op.to.width)}x${Math.round(op.to.height)}`;
  if (op.op === "skip") return `skip ${op.kind} ${op.start} -> ${op.end}: ${op.reason}`;
  return JSON.stringify(op);
};

/**
 * Writes Mermaid through POST /api/mermaid: the server parses it, applies it to the board as of
 * `base` (absent: the current master) and merges the result like any other write. `writtenAt` is
 * this process's clock now: a stale write loses to a newer edit of the same shape. Resolves to the
 * server's answer plus `httpStatus`: 200 `{ status: "merged", version, applied, overwritten, ops }`,
 * 202 `{ status: "queued", branchId, ops }` or `{ status: "needs-tab", reason }`,
 * 400 `{ error: "mermaid-syntax-error", message, line }`, 409 `{ error: "unknown-base" }`.
 */
export const writeMermaid = async (board, { author, displayName, base, mermaid, writtenAt = Date.now() }) => {
  let response;
  try {
    response = await fetch(`${apiUrl()}/api/mermaid/${encodeBoard(board)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author, displayName, ...(base ? { base } : {}), writtenAt, mermaid }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(`Nothing was written: ${describeFetchError(error)}`);
  }
  const data = await response.json().catch(() => ({}));
  return { httpStatus: response.status, ...data };
};

const MAX_LISTED_OPS = 12;
export const describeMermaidWrite = (board, result, { url } = {}) => {
  const ops = (result.ops ?? []).filter((op) => op.op !== "skip");
  const listed = ops.length ? ` Changes: ${ops.slice(0, MAX_LISTED_OPS).map(formatApplyOp).join("; ")}${ops.length > MAX_LISTED_OPS ? `; and ${ops.length - MAX_LISTED_OPS} more` : ""}.` : "";
  const skipped = (result.ops ?? []).filter((op) => op.op === "skip");
  const skips = skipped.length ? ` Skipped: ${skipped.map(formatApplyOp).join("; ")}.` : "";
  const noDeletes = result.deletesSkipped ? " Nothing was deleted: the server doesn't know which Mermaid this board came from yet." : "";
  if (result.status === "merged") {
    if (result.unchanged && !result.overwritten?.length) {
      return `Applied to ${board}: the board already matches this Mermaid (version ${result.version}).${skips}`;
    }
    return `${describeWrite(board, result)}${listed}${skips}${noDeletes}`;
  }
  if (result.status === "queued") {
    return `${describeWrite(board, result)}${listed}${noDeletes}`;
  }
  if (result.status === "needs-tab") {
    return `Saved to the inbox ${board}.mmd, not applied yet (${result.reason}): this board needs a browser tab to lay out the whole diagram. Open ${url ?? "the board_url"} in a browser; the tab converts it once.`;
  }
  if (result.error === "mermaid-syntax-error") {
    return `Not written: Mermaid syntax error${result.line ? ` on line ${result.line}` : ""}: ${result.message ?? "parse failed"}`;
  }
  return describeWrite(board, result);
};