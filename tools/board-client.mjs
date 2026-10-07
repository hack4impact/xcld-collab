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
