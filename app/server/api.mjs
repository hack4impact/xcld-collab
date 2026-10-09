import { existsSync, mkdirSync, watch } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { boardFilePath, maxDepthFromEnv, validateBoardPath } from "../../tools/board-path.mjs";
import { boardInfoForRelativeFile, listBoards, walkBoardFiles } from "../../tools/board-index.mjs";
import { autoExportFromEnv, exportFilePath, writeMermaidFromBoard } from "../../tools/export.mjs";
import { diffSince, SinceError } from "../../tools/diff-since.mjs";
import { openHistory } from "../../tools/history.mjs";
import { effectiveExportMode } from "../../tools/rules.mjs";
import { mermaidSourceHash } from "../../tools/mermaid-hash.mjs";
import { stateDirFromEnv } from "../../tools/storage.mjs";
import { createMermaidWriter } from "./mermaid-write.mjs";
import { formatDuration, slowIoMessage } from "./slow-io.mjs";
import { contentHash, createVersionStore, parseAuthorKey, parseEntityTags, readSettledJsonText, staleSaveCheck } from "./versions.mjs";

export { contentHash, staleSaveCheck };

const MAX_BODY_BYTES = 20 * 1024 * 1024;
// How long POST /api/branch waits for the commit before answering 202 `queued`.
export const WRITE_WAIT_MS = 5000;

// Tab saves without identity headers (older tabs, scripts) share one human author.
const legacyAuthor = () => {
  const key = `human:${String(process.env.XCLD_AUTHOR_NAME ?? "").trim() || "anonymous"}#legacy`;
  return parseAuthorKey(key) ? key : "human:anonymous#legacy";
};

const headerValue = (value) => (Array.isArray(value) ? value[0] : value);

// A request a web page made (fetch from a tab): browsers send Sec-Fetch-Site/-Dest and, for a PUT
// or POST, Origin. Scripts (curl, Node's fetch, PowerShell) send neither.
export const fromBrowserPage = (headers) => headerValue(headers["sec-fetch-site"]) !== undefined || headerValue(headers["sec-fetch-dest"]) !== undefined || headerValue(headers.origin) !== undefined;

// Upgrade guard (issue #42): a tab that loaded an earlier build's page keeps running its old code.
// It saves without identity headers and replaces the board with its in-memory scene (it also
// re-converted the leftover `.mmd` inbox on every Mermaid event). Such a save is refused with 409
// `reload-required`; the old page shows "Save failed: HTTP 409", and a reload gets the current
// build. Scripts that PUT without headers are not browsers and keep working.
export const legacyTabSave = (headers) => headers["x-xcld-author-name"] === undefined && headers["x-xcld-tab"] === undefined && fromBrowserPage(headers);
export const RELOAD_REQUIRED_MESSAGE = "This tab runs an older xcld-collab build. Reload the page to keep editing; nothing from this tab was saved.";

// A tab identifies itself with X-Xcld-Author-Name (percent-encoded UTF-8) and X-Xcld-Tab.
// Returns null when the request is malformed.
export const tabAuthor = (headers) => {
  const rawName = headerValue(headers["x-xcld-author-name"]);
  const tab = headerValue(headers["x-xcld-tab"]);
  if (rawName === undefined && tab === undefined) {
    return legacyAuthor();
  }
  let name;
  try {
    name = decodeURIComponent(String(rawName ?? "")).trim();
  } catch {
    return null;
  }
  const key = `human:${name}#${String(tab ?? "").trim()}`;
  return parseAuthorKey(key)?.kind === "human" ? key : null;
};

// Responses and SSE leave out the overwritten elements (they are in history).
const overwrittenSummary = (overwritten = []) => overwritten.map(({ loser, ...rest }) => ({ ...rest, loser: { side: loser.side, author: loser.author, writtenAt: loser.writtenAt } }));

const mergedEvent = ({ name, version, author, applied, overwritten, unbound }) => ({
  name,
  version,
  author,
  applied,
  overwritten: overwrittenSummary(overwritten),
  unbound,
});

export function isAllowedHostHeader(hostHeader) {
  if (!hostHeader || Array.isArray(hostHeader)) {
    return false;
  }
  const host = String(hostHeader).trim().toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
    return true;
  }
  if (host.startsWith("[::1]:")) {
    return /^\[::1\]:\d+$/.test(host);
  }
  const match = /^(localhost|127\.0\.0\.1):(\d+)$/.exec(host);
  return Boolean(match);
}

export const validateBoardName = (name) => validateBoardPath(name, { maxDepth: maxDepthFromEnv() }).ok;

// A snapshot (pin) label: `xcld snapshot` uses the snapshot's UTC stamp unless --name is given.
export const isValidPinLabel = (label) => typeof label === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,99}$/.test(label) && !/\s$/.test(label);

const etagFor = (hash) => `"${hash}"`;

const readCurrent = async (filePath) => {
  const text = await readSettledJsonText(filePath);
  return text === null ? { text: null, hash: null } : { text, hash: contentHash(text) };
};

const send = (res, status, contentType, body) => {
  if (res.headersSent) {
    res.end(body);
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
};

const sendJson = (res, status, data) => {
  send(res, status, "application/json; charset=utf-8", `${JSON.stringify(data)}\n`);
};

// sendJson that records the response serialization in the commit's timings (XCLD_TIMING=1).
const sendTimedJson = (res, status, data, timings) => {
  const started = performance.now();
  const body = `${JSON.stringify(data)}\n`;
  if (timings?.stages) {
    timings.stages.respond = performance.now() - started;
  }
  send(res, status, "application/json; charset=utf-8", body);
};

const sendError = (res, status, error, extra = {}) => {
  sendJson(res, status, { error, ...extra });
};

const isJsonRequest = (req) => {
  const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json";
};

const readRequestBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  let settled = false;
  const chunks = [];
  const fail = (statusCode, message) => {
    if (!settled) {
      settled = true;
      const error = new Error(message);
      error.statusCode = statusCode;
      reject(error);
    }
  };

  req.on("data", (chunk) => {
    if (settled) {
      return;
    }
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      fail(413, "request-body-too-large");
      req.resume();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (!settled) {
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    }
  });
  req.on("error", (error) => fail(400, error.message));
});

const filePathFor = (boardsDir, name, extension) => {
  const target = path.resolve(boardFilePath(boardsDir, name, extension, { maxDepth: maxDepthFromEnv() }));
  const relative = path.relative(boardsDir, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    const error = new Error("invalid-board-path");
    error.statusCode = 400;
    throw error;
  }
  return target;
};

export function createBoardApi({
  boardsDir,
  pollMs = Number.parseInt(process.env.XCLD_WATCH_POLL_MS ?? "1000", 10),
  maxDepth = maxDepthFromEnv(),
  useFsWatch = true,
  autoExport = autoExportFromEnv(),
  deleteDebounceMs = 300,
  settleMs = Math.min(Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 100, 100),
  writeWaitMs = WRITE_WAIT_MS,
  versionOptions = {},
  mermaidOptions = {},
}) {
  const root = path.resolve(boardsDir);
  mkdirSync(root, { recursive: true });
  const clients = new Set();
  let watcher;
  let closed = false;

  // XCLD_AUTO_EXPORT=save, or a folder export rule, keeps boards/.exports/<path>.mmd current.
  const exportBoard = async (name) => {
    if (await effectiveExportMode(name, root, autoExport) !== "save") {
      return Promise.resolve();
    }
    const source = path.join(root, ...`${name}.excalidraw`.split("/"));
    return writeMermaidFromBoard(source, exportFilePath(root, name)).catch((error) => {
      console.warn(`auto-export failed for ${name}: ${error.message}`);
    });
  };

  const publish = (data, event = "board") => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      client.write(payload);
    }
  };

  // Change detection uses two sources. fs.watch is instant, but inotify events don't
  // cross Docker Desktop bind mounts from Windows/macOS hosts, which is exactly where
  // host-side agents write. A cheap mtime+size poll covers that case; signatures
  // dedupe the two so each change is published once.
  const signatures = new Map();

  // The commit pipeline is the only writer of master. Its writes update the watcher's
  // signature so they aren't re-published or re-adopted as external writes.
  const versions = createVersionStore({
    stateDir: stateDirFromEnv(process.env, root),
    ...versionOptions,
    boardsDir: root,
    onMasterWritten: async (name, written) => {
      try {
        const stat = written ?? await fs.stat(path.join(root, ...`${name}.excalidraw`.split("/")));
        signatures.set(`${name}.excalidraw`, `${stat.mtimeMs}:${stat.size}`);
      } catch {}
    },
    // Hook 3 (post-commit): SSE, then the export and rules hooks.
    onCommitted: async (event) => {
      publish(mergedEvent(event), "merged");
      if (event.masterChanged) {
        publish({ name: event.name, kind: "board", timestamp: Date.now() });
        await exportBoard(event.name);
      }
    },
  });
  versions.start().catch((error) => console.warn(`version journal replay failed: ${error.message}`));
  // Mermaid writes are applied here and committed as branches. A write the server can't apply node
  // by node is a pending record: the `mermaid` event asks an open tab to lay it out, and the server
  // lays a flowchart out itself after the retry schedule (app/server/mermaid-write.mjs).
  const mermaids = createMermaidWriter({
    versions,
    ...mermaidOptions,
    inboxPath: (name) => filePathFor(root, name, ".mmd"),
    onInboxWritten: (name, written) => {
      if (written) {
        signatures.set(`${name}.mmd`, `${written.mtimeMs}:${written.size}`);
      }
    },
    publishInbox: (name, extra = {}) => publish({ name, kind: "mermaid", ...extra, timestamp: Date.now() }),
    // Agents can wait for a pending write on the SSE stream instead of polling its status.
    publishLanded: (name, data) => publish({ name, ...data, timestamp: Date.now() }, "mermaid-write"),
    afterLanded: (name, result) => announceMermaid(name, result),
  });
  // A Mermaid write that changed nothing on the board still clears "Mermaid pending".
  const announceMermaid = (name, result) => {
    if (result?.status === "unchanged") {
      publish({ name, kind: "mermaid-applied", timestamp: Date.now() });
    }
  };
  // Signatures whose JSON content didn't parse (a writer caught mid-write); skipped until
  // the file changes again so a broken file isn't re-read every poll.
  const unparsed = new Map();
  const pendingDeletes = new Map();
  const settleWaits = new Set();
  const settleDelay = () => new Promise((resolve) => {
    if (closed) {
      resolve();
      return;
    }
    const wait = { resolve };
    wait.timer = setTimeout(() => {
      settleWaits.delete(wait);
      resolve();
    }, settleMs);
    wait.timer.unref?.();
    settleWaits.add(wait);
  });
  let warnedSlowPoll = false;
  const nameFromRelativeFile = (relativeFile) => {
    const normalized = String(relativeFile).replace(/\\/g, "/").split("/").filter(Boolean).join("/");
    const info = boardInfoForRelativeFile(normalized);
    if (!info) {
      return null;
    }
    if (normalized.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules")) {
      return null;
    }
    return validateBoardPath(info.name, { maxDepth }).ok ? { name: info.name, kind: info.kind, relativeFile: normalized } : null;
  };
  const cancelPendingDelete = (relativeFile) => {
    const timer = pendingDeletes.get(relativeFile);
    if (timer) {
      clearTimeout(timer);
      pendingDeletes.delete(relativeFile);
    }
  };
  const scheduleDeleteIfKnown = (item) => {
    unparsed.delete(item.relativeFile);
    if (item.kind !== "board" || !signatures.has(item.relativeFile) || pendingDeletes.has(item.relativeFile)) {
      if (item.kind !== "board") {
        signatures.delete(item.relativeFile);
      }
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const stat = await fs.lstat(path.join(root, ...item.relativeFile.split("/")));
        if (stat.isFile()) {
          pendingDeletes.delete(item.relativeFile);
          return;
        }
      } catch {
        signatures.delete(item.relativeFile);
        pendingDeletes.delete(item.relativeFile);
        publish({
          name: item.name,
          kind: "deleted",
          timestamp: Date.now(),
        });
        return;
      }
      signatures.delete(item.relativeFile);
      pendingDeletes.delete(item.relativeFile);
      publish({
        name: item.name,
        kind: "deleted",
        timestamp: Date.now(),
      });
    }, deleteDebounceMs);
    timer.unref?.();
    pendingDeletes.set(item.relativeFile, timer);
  };
  const fileSignature = async (filePath) => {
    const stat = await fs.lstat(filePath);
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : null;
  };
  // Returns a candidate when the file's signature differs from the last published one.
  const observeChange = async (relativeFile) => {
    const item = nameFromRelativeFile(relativeFile);
    if (!item) {
      return null;
    }
    const filePath = path.join(root, ...item.relativeFile.split("/"));
    let signature;
    try {
      signature = await fileSignature(filePath);
    } catch {
      signature = null;
    }
    if (signature === null) {
      scheduleDeleteIfKnown(item);
      return null;
    }
    cancelPendingDelete(item.relativeFile);
    if (signatures.get(item.relativeFile) === signature || unparsed.get(item.relativeFile) === signature) {
      return null;
    }
    return { item, filePath, signature };
  };
  // Editors and agents often write non-atomically (truncate, then write), so a check can
  // land mid-write. Publish only once the signature holds across a settle delay and, for
  // JSON files, the content parses. A file still changing is re-settled a few times, then
  // left to a later observation.
  const publishIfSettled = async ({ item, filePath, signature: observed }) => {
    const isJson = item.kind !== "mermaid";
    let signature = observed;
    let content;
    for (let attempt = 1; ; attempt += 1) {
      await settleDelay();
      if (closed) {
        return;
      }
      let current;
      try {
        content = isJson ? await fs.readFile(filePath, "utf8") : undefined;
        current = await fileSignature(filePath);
      } catch {
        return;
      }
      if (current === signature) {
        break;
      }
      if (current === null || attempt >= 5) {
        return;
      }
      signature = current;
    }
    if (isJson) {
      try {
        JSON.parse(content);
      } catch {
        unparsed.set(item.relativeFile, signature);
        return;
      }
    }
    if (closed || signatures.get(item.relativeFile) === signature) {
      return;
    }
    signatures.set(item.relativeFile, signature);
    unparsed.delete(item.relativeFile);
    if (item.kind === "mermaid") {
      // A direct write to the inbox: applied on the server as the `external` author, with the
      // file's mtime as its write time.
      mermaids.fromFile(item.name).then(
        (result) => announceMermaid(item.name, result),
        (error) => console.warn(`applying a direct write to ${item.name}.mmd failed: ${error.message}`),
      );
      return;
    }
    publish({
      name: item.name,
      kind: item.kind,
      timestamp: Date.now(),
    });
    if (item.kind === "board") {
      await exportBoard(item.name);
      // Adopt the settled file into history (an `external` branch) through the board's queue.
      versions.adoptExternal(item.name).catch((error) => console.warn(`adopting external write to ${item.name} failed: ${error.message}`));
    }
  };
  const publishIfChanged = async (relativeFile) => {
    const candidate = await observeChange(relativeFile);
    if (candidate) {
      await publishIfSettled(candidate);
    }
  };

  try {
    watcher = useFsWatch
      ? watch(root, { persistent: false, recursive: true }, (_event, fileName) => {
          if (fileName) {
            publishIfChanged(fileName.toString()).catch(() => {});
          }
        })
      : undefined;
  } catch {
    try {
      watcher = useFsWatch
        ? watch(root, { persistent: false }, (_event, fileName) => {
            if (fileName) {
              publishIfChanged(fileName.toString()).catch(() => {});
            }
          })
        : undefined;
    } catch {
      watcher = undefined;
    }
  }

  let poller;
  let polling = false;
  const poll = async () => {
    if (polling) {
      return;
    }
    polling = true;
    const start = performance.now();
    try {
      const { files } = await walkBoardFiles(root, { maxDepth });
      const names = new Set(files.map((file) => file.relativeFile));
      const candidates = [];
      for (const file of files) {
        const candidate = await observeChange(file.relativeFile);
        if (candidate) {
          candidates.push(candidate);
        }
      }
      for (const known of [...signatures.keys()]) {
        if (!names.has(known)) {
          const item = nameFromRelativeFile(known);
          if (item) {
            scheduleDeleteIfKnown(item);
          } else {
            signatures.delete(known);
          }
        }
      }
      for (const known of [...unparsed.keys()]) {
        if (!names.has(known)) {
          unparsed.delete(known);
        }
      }
      const elapsed = performance.now() - start;
      if (elapsed > 250 && !warnedSlowPoll) {
        warnedSlowPoll = true;
        console.warn(`Board poll scan took ${Math.round(elapsed)} ms; consider XCLD_WATCH_POLL_MS or XCLD_MAX_DEPTH.`);
      }
      // Changed files settle together, so a batch costs one settle delay, not one per file.
      await Promise.all(candidates.map(publishIfSettled));
    } catch {
      // Boards dir temporarily unavailable; try again next tick.
    } finally {
      polling = false;
    }
  };
  if (Number.isFinite(pollMs) && pollMs > 0) {
    // Seed signatures silently so existing boards don't all fire on startup.
    walkBoardFiles(root, { maxDepth })
      .then(async ({ files }) => {
        for (const file of files) {
          try {
            const stat = await fs.stat(file.path);
            signatures.set(file.relativeFile, `${stat.mtimeMs}:${stat.size}`);
          } catch {}
        }
      })
      .catch(() => {})
      .finally(() => {
        if (closed) {
          return;
        }
        poller = setInterval(() => {
          poll();
        }, pollMs);
        poller.unref?.();
      });
  }

  // POST /api/branch: wait up to writeWaitMs for the commit. A write that is journaled but not
  // committed by then answers 202 `queued`; it is committed later and never dropped.
  const respondToBranchWrite = async (res, name, input, receiveMs, { stages, extra = {}, after } = {}) => {
    const TIMEOUT = Symbol("timeout");
    // Slow file-system operations from here on explain a `queued` answer.
    const slowMark = versions.slowIo.mark();
    let branchId = null;
    let markIngested;
    const ingested = new Promise((resolve) => {
      markIngested = resolve;
    });
    const submitted = versions.submitBranch(name, input, {
      source: "post",
      receiveMs,
      stages,
      onIngested: (id) => {
        branchId = id;
        markIngested();
      },
    });
    after?.(submitted);
    submitted.catch((error) => {
      if (branchId) {
        console.warn(`write ${branchId} to ${name} is journaled but its commit failed (${error.message}); it is replayed on the next start`);
      }
    });
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), writeWaitMs);
    });
    let result;
    try {
      result = await Promise.race([submitted, timeout]);
      if (result === TIMEOUT) {
        // Only promise "queued" once the write is in the journal.
        result = await Promise.race([submitted, ingested.then(() => TIMEOUT)]);
      }
    } catch (error) {
      if (!branchId) {
        throw error;
      }
      result = TIMEOUT;
    } finally {
      clearTimeout(timer);
    }
    if (result === TIMEOUT || result.status === "queued") {
      const slow = versions.slowIo.worstSince(slowMark, name);
      sendJson(res, 202, {
        status: "queued",
        branchId,
        base: input.base ?? null,
        message: slow ? slowIoMessage(slow) : `the commit is taking longer than ${formatDuration(writeWaitMs)}; your write is safe and queued`,
        ...(slow ? { slowIo: slow } : {}),
        ...extra,
      });
      return;
    }
    if (result.status === "invalid") {
      sendError(res, 400, result.error ?? "invalid-branch");
      return;
    }
    if (result.status === "unknown-base") {
      sendJson(res, 409, { error: "unknown-base", base: input.base, currentVersion: result.version ?? null });
      return;
    }
    sendTimedJson(res, 200, {
      status: "merged",
      version: result.version,
      fastForward: result.fastForward,
      ...(result.status === "unchanged" ? { unchanged: true } : {}),
      applied: result.applied,
      overwritten: overwrittenSummary(result.overwritten),
      unbound: result.unbound,
      branchId: result.branchId,
      ...extra,
    }, result.timings);
  };

  const handle = async (req, res) => {
    if (!isAllowedHostHeader(req.headers.host)) {
      sendError(res, 403, "forbidden-host");
      return true;
    }

    const rawPathname = String(req.url ?? "/").split("?", 1)[0];
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/healthz" && req.method === "GET") {
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "keep-alive");
      res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return true;
    }

    if (rawPathname === "/api/boards" && req.method === "GET") {
      // A Mermaid write the server applied without changing the board isn't pending either.
      const appliedMermaidHash = async (name) => (await versions.readMermaid(name).catch(() => null))?.hash ?? null;
      sendJson(res, 200, await listBoards(root, { maxDepth, appliedMermaidHash }));
      return true;
    }

    if (!rawPathname.startsWith("/api/")) {
      return false;
    }

    try {
      const boardPrefix = "/api/board/";
      if (rawPathname.startsWith(boardPrefix)) {
        const rawName = rawPathname.slice(boardPrefix.length);
        const checkpointSuffix = "/checkpoint";
        // POST /api/board/<path>/checkpoint (Ctrl+S in the tab): closes the caller's open history
        // entry. Only POST takes the suffix, so a board named `<path>/checkpoint` stays reachable.
        if (req.method === "POST" && rawName.endsWith(checkpointSuffix)) {
          const name = decodeURIComponent(rawName.slice(0, -checkpointSuffix.length));
          const filePath = filePathFor(root, name, ".excalidraw");
          const identified = req.headers["x-xcld-author-name"] !== undefined || req.headers["x-xcld-tab"] !== undefined;
          const author = identified ? tabAuthor(req.headers) : null;
          if (identified && !author) {
            sendError(res, 400, "invalid-author");
            return true;
          }
          const current = await versions.cachedMaster(name) ?? await readCurrent(filePath);
          if (current.hash === null) {
            sendError(res, 404, "board-not-found", { name });
            return true;
          }
          // An optional JSON body `{ "pin": "<label>" }` (xcld snapshot) also pins the current
          // version: its entry becomes a full checkpoint with that label (snapshots as pinned versions).
          let pinLabel = null;
          if (isJsonRequest(req)) {
            let parsed;
            try {
              const body = await readRequestBody(req);
              parsed = body.trim() ? JSON.parse(body) : {};
            } catch {
              sendError(res, 400, "invalid-json");
              return true;
            }
            if (parsed?.pin !== undefined && parsed?.pin !== null) {
              if (!isValidPinLabel(parsed.pin)) {
                sendError(res, 400, "invalid-pin", { hint: "a letter or digit, then up to 99 letters, digits, spaces, \".\", \"_\", \":\" or \"-\"" });
                return true;
              }
              pinLabel = parsed.pin;
            }
          }
          const result = await versions.checkpoint(name, { author, pin: pinLabel });
          sendJson(res, 200, {
            ok: true,
            closed: result.closed,
            entry: result.closed ? result.entry : null,
            version: result.version,
            ...(pinLabel ? { pinned: result.pinned ? { label: result.pinned.label, entry: result.pinned.entry, version: result.version, pinnedAt: result.pinned.pinnedAt } : null } : {}),
          });
          return true;
        }
        const name = decodeURIComponent(rawName);
        const filePath = filePathFor(root, name, ".excalidraw");

        if (req.method === "GET") {
          const current = await versions.cachedMaster(name) ?? await readCurrent(filePath);
          if (current.hash === null) {
            sendError(res, 404, "board-not-found", { name });
            return true;
          }
          const version = current.version ?? current.hash;
          // The ETag may come back as a base; keep that version resolvable.
          await versions.noteServed(name, version, current.text).catch((error) => {
            console.warn(`pinning served version of ${name} failed: ${error.message}`);
          });
          res.setHeader("ETag", etagFor(version));
          send(res, 200, "application/json; charset=utf-8", current.text);
          return true;
        }

        if (req.method === "PUT") {
          if (!isJsonRequest(req)) {
            sendError(res, 415, "content-type-must-be-application-json");
            return true;
          }
          const receiveStart = performance.now();
          const body = await readRequestBody(req);
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            sendError(res, 400, "invalid-json");
            return true;
          }
          const receiveMs = performance.now() - receiveStart;
          if (parsed?.type !== "excalidraw" || !Array.isArray(parsed.elements)) {
            sendError(res, 400, "invalid-excalidraw-json");
            return true;
          }
          // Goes through the commit pipeline as the tab's branch. `If-Match` names the version
          // the tab started from: current means a fast-forward, an older known version merges
          // (200, merged master in the body), an unknown one is 409. `If-None-Match: *` starts
          // from an empty board and merges into one that appeared meanwhile. No header is an
          // unguarded write over whatever master is (kept for scripts). A tab of an earlier build
          // (a browser page saving without identity headers) gets 409 reload-required.
          if (legacyTabSave(req.headers)) {
            sendJson(res, 409, { error: "reload-required", message: RELOAD_REQUIRED_MESSAGE });
            return true;
          }
          const author = tabAuthor(req.headers);
          if (!author) {
            sendError(res, 400, "invalid-author", { hint: "X-Xcld-Author-Name (percent-encoded) and X-Xcld-Tab ([A-Za-z0-9_-]) go together" });
            return true;
          }
          const ifMatch = parseEntityTags(req.headers["if-match"]);
          const ifNoneMatch = parseEntityTags(req.headers["if-none-match"]);
          const input = {
            author,
            kind: "json",
            elements: parsed.elements,
            appState: parsed.appState,
            files: parsed.files,
            template: parsed,
          };
          // X-Xcld-Edit-Age: ms since the tab's last edit, so its write time is when the human
          // edited, not when the (debounced) save arrived.
          const editAge = Number(headerValue(req.headers["x-xcld-edit-age"]));
          if (Number.isFinite(editAge) && editAge > 0) {
            input.writtenAgoMs = editAge;
          }
          if (ifMatch?.includes("*")) {
            Object.assign(input, { base: null, legacy: { ifMatch: "*" } });
          } else if (ifMatch) {
            const strong = ifMatch.filter((tag) => !tag.startsWith("W/"));
            if (!strong.length) {
              sendError(res, 409, "unknown-base");
              return true;
            }
            input.base = strong[0];
          } else if (ifNoneMatch?.includes("*")) {
            input.base = null;
          } else {
            Object.assign(input, { base: null, legacy: {} });
          }
          const result = await versions.submitBranch(name, input, { source: "put", receiveMs });
          if (result.status === "stale" || result.status === "unknown-base") {
            if (result.version) {
              res.setHeader("ETag", etagFor(result.version));
            }
            sendJson(res, 409, { error: result.status === "stale" ? "stale-save" : "unknown-base", currentHash: result.version ?? null });
            return true;
          }
          if (result.status === "invalid") {
            sendError(res, 400, "invalid-excalidraw-json", { reason: result.error });
            return true;
          }
          if (result.status !== "committed" && result.status !== "unchanged") {
            sendError(res, 503, "not-committed", { status: result.status });
            return true;
          }
          // Master, SSE, export and rules follow the answer (the commit is already durable).
          const merged = !result.fastForward;
          res.setHeader("ETag", etagFor(result.version));
          sendTimedJson(res, 200, {
            ok: true,
            hash: result.version,
            version: result.version,
            merged,
            applied: result.applied,
            overwritten: overwrittenSummary(result.overwritten),
            unbound: result.unbound,
            ...(merged ? { master: result.scene } : {}),
          }, result.timings);
          return true;
        }

        sendError(res, 405, "method-not-allowed");
        return true;
      }

      const branchPrefix = "/api/branch/";
      if (rawPathname.startsWith(branchPrefix)) {
        if (req.method !== "POST") {
          sendError(res, 405, "method-not-allowed");
          return true;
        }
        const name = decodeURIComponent(rawPathname.slice(branchPrefix.length));
        filePathFor(root, name, ".excalidraw");
        if (!isJsonRequest(req)) {
          sendError(res, 415, "content-type-must-be-application-json");
          return true;
        }
        const receiveStart = performance.now();
        let parsed;
        try {
          parsed = JSON.parse(await readRequestBody(req));
        } catch {
          sendError(res, 400, "invalid-json");
          return true;
        }
        const receiveMs = performance.now() - receiveStart;
        if (!parsed || typeof parsed !== "object" || !("base" in parsed)) {
          sendError(res, 400, "base-required", { hint: "send the version you read (ETag / read_board version), or null for a new board" });
          return true;
        }
        if ((parsed.kind ?? "json") !== "json") {
          sendError(res, 400, "invalid-kind");
          return true;
        }
        const input = {
          author: parsed.author ?? "cli:api",
          displayName: parsed.displayName,
          base: parsed.base,
          writtenAt: parsed.writtenAt,
          kind: "json",
          elements: parsed.elements,
          appState: parsed.appState,
          files: parsed.files,
        };
        await respondToBranchWrite(res, name, input, receiveMs);
        return true;
      }

      // GET /api/diff/<path>?since=<spec>: master against a point in the board's history, with
      // the edits overwritten since then (tools/diff-since.mjs; `xcld diff --since`, MCP diff).
      const diffPrefix = "/api/diff/";
      if (rawPathname.startsWith(diffPrefix) && req.method === "GET") {
        const name = decodeURIComponent(rawPathname.slice(diffPrefix.length));
        filePathFor(root, name, ".excalidraw");
        const since = url.searchParams.get("since");
        if (!since) {
          sendError(res, 400, "since-required", { hint: "?since=<version prefix | time (10m, 2h, ISO) | author:<name> | snapshot label>" });
          return true;
        }
        const master = await versions.readMaster(name);
        if (!master) {
          sendError(res, 404, "board-not-found", { name });
          return true;
        }
        try {
          const history = await openHistory({ stateDir: versions.stateDir, board: name });
          const result = await diffSince({
            history,
            master,
            since,
            resolveVersion: async (version) => {
              const found = await versions.readVersion(name, version);
              return found ? { scene: found.scene, at: await versions.baseKeptAt(name, version) } : null;
            },
            diffOptions: { board: name, boardsDir: root },
          });
          sendJson(res, 200, result);
        } catch (error) {
          if (error instanceof SinceError) {
            sendError(res, error.code === "since-not-found" ? 404 : 400, error.code, { message: error.message });
            return true;
          }
          throw error;
        }
        return true;
      }

      // GET /api/history/<path>: the board's history entries (turns), oldest first, without the
      // losers' elements (`xcld watch`; `xcld history export` has everything).
      const historyPrefix = "/api/history/";
      if (rawPathname.startsWith(historyPrefix) && req.method === "GET") {
        const name = decodeURIComponent(rawPathname.slice(historyPrefix.length));
        filePathFor(root, name, ".excalidraw");
        const history = await openHistory({ stateDir: versions.stateDir, board: name });
        sendJson(res, 200, {
          name,
          version: history.state?.version ?? null,
          entries: history.entries.map(({ entry, meta, open }) => ({
            entry,
            version: meta.record === "none" ? null : meta.version,
            author: meta.author,
            displayName: meta.displayName ?? null,
            kind: meta.kind ?? null,
            record: meta.record ?? null,
            openedAt: meta.openedAt ?? null,
            lastCommitAt: meta.lastCommitAt ?? null,
            closedBy: open ? null : meta.closedBy ?? null,
            coalescedCount: meta.coalescedCount ?? 1,
            applied: (meta.applied ?? []).map(({ unitId, label, kind, styled }) => ({ unitId, label, kind, ...(styled?.length ? { styled } : {}) })),
            overwritten: overwrittenSummary(meta.overwritten ?? []),
            ...(open ? { open: true } : {}),
            ...(meta.pinned ? { pinned: meta.pinned, pins: (meta.pins ?? [{ label: meta.pinned }]).map((pin) => pin.label) } : {}),
          })),
        });
        return true;
      }

      if (rawPathname === "/api/config" && req.method === "GET") {
        sendJson(res, 200, { authorName: String(process.env.XCLD_AUTHOR_NAME ?? "").trim() || null, writeWaitMs, timing: versions.timingEnabled });
        return true;
      }

      if (rawPathname === "/api/status" && req.method === "GET") {
        sendJson(res, 200, versions.status());
        return true;
      }

      if (rawPathname === "/api/timings" && req.method === "GET") {
        if (!versions.timingEnabled) {
          sendError(res, 404, "timing-disabled", { hint: "start the server with XCLD_TIMING=1" });
          return true;
        }
        sendJson(res, 200, { timings: versions.timings({ clear: url.searchParams.get("clear") === "1" }) });
        return true;
      }

      const mermaidPrefix = "/api/mermaid/";
      if (rawPathname.startsWith(mermaidPrefix) && req.method === "POST") {
        const name = decodeURIComponent(rawPathname.slice(mermaidPrefix.length));
        filePathFor(root, name, ".mmd");
        if (!isJsonRequest(req)) {
          sendError(res, 415, "content-type-must-be-application-json");
          return true;
        }
        const receiveStart = performance.now();
        let parsed;
        try {
          parsed = JSON.parse(await readRequestBody(req));
        } catch {
          sendError(res, 400, "invalid-json");
          return true;
        }
        const receiveMs = performance.now() - receiveStart;
        if (!parsed || typeof parsed !== "object") {
          sendError(res, 400, "invalid-json");
          return true;
        }
        // ?layout=<pendingId>: a tab's in-memory conversion of a pending write. The shapes join
        // the board as a group, written by the agent that wrote the Mermaid, at its write time.
        const layoutId = url.searchParams.get("layout");
        if (layoutId !== null) {
          const landing = await mermaids.prepareTabLanding(name, layoutId, { hash: parsed.hash, elements: parsed.elements, files: parsed.files });
          if (landing.error) {
            sendJson(res, landing.error === "invalid-elements" ? 400 : 409, { error: landing.error, status: landing.status });
            return true;
          }
          await respondToBranchWrite(res, name, landing.input, receiveMs, {
            stages: landing.stages,
            extra: { ops: landing.ops, hash: landing.record.hash, source: landing.record.source, pendingId: landing.record.id, placement: landing.placement?.placement ?? null, via: landing.via },
            after: (submitted) => mermaids.settleLanding(landing.record, submitted, landing.via, landing).catch((error) => console.warn(`landing ${landing.record.id} on ${name} failed: ${error.message}`)),
          });
          return true;
        }
        const sourceName = parsed.source ?? undefined;
        const prepared = await mermaids.prepare(name, {
          author: parsed.author ?? "cli:api",
          displayName: parsed.displayName,
          base: parsed.base,
          writtenAt: parsed.writtenAt,
          source: parsed.mermaid,
          sourceName,
          position: parsed.position,
        });
        if (prepared.status === "invalid") {
          sendError(res, 400, prepared.error);
          return true;
        }
        if (prepared.status === "syntax-error") {
          const { message, line, column } = prepared.error;
          sendError(res, 400, "mermaid-syntax-error", { message, line: line ?? null, column: column ?? null });
          return true;
        }
        if (prepared.status === "unknown-base") {
          sendJson(res, 409, { error: "unknown-base", base: prepared.base, currentVersion: prepared.currentVersion ?? null });
          return true;
        }
        if (prepared.status === "parser-unavailable") {
          sendError(res, 503, "mermaid-parser-unavailable", { message: prepared.error });
          return true;
        }
        if (prepared.status === "noop") {
          sendJson(res, 200, { status: "merged", unchanged: true, noop: true, version: prepared.version, hash: prepared.hash, source: prepared.source, applied: [], overwritten: [], unbound: [], ops: [] });
          return true;
        }
        if (prepared.status === "needs-tab") {
          sendJson(res, 202, {
            status: "needs-tab",
            reason: prepared.reason,
            hash: prepared.hash,
            source: prepared.pending.source,
            pendingId: prepared.pending.id,
            pending: prepared.pending,
            retryScheduleMs: mermaids.schedule,
          });
          return true;
        }
        await respondToBranchWrite(res, name, prepared.input, receiveMs, {
          stages: prepared.stages,
          extra: { ops: prepared.ops, hash: prepared.hash, source: prepared.source, ...(prepared.hint ? { hint: prepared.hint } : {}), ...(prepared.previousKnown ? {} : { deletesSkipped: true }) },
          // The inbox file follows the commit (queued writes too), in commit order.
          after: (submitted) => submitted.then(
            async (result) => {
              announceMermaid(name, result);
              await mermaids.syncInbox(name);
            },
            () => {},
          ).catch((error) => console.warn(`updating ${name}.mmd failed: ${error.message}`)),
        });
        return true;
      }

      if (rawPathname.startsWith(mermaidPrefix) && req.method === "GET") {
        const rawName = rawPathname.slice(mermaidPrefix.length);
        const name = decodeURIComponent(rawName);
        const filePath = filePathFor(root, name, ".mmd");
        // ?pending: the writes waiting for a layout (an open tab converts them).
        if (url.searchParams.has("pending")) {
          sendJson(res, 200, { name, pending: await mermaids.listPending(name), retryScheduleMs: mermaids.schedule });
          return true;
        }
        // ?id=<pendingId>: where a pending write is (pending, landing, landed, superseded).
        const pendingId = url.searchParams.get("id");
        if (pendingId !== null) {
          const found = await mermaids.statusOf(name, pendingId);
          if (!found) {
            sendError(res, 404, "pending-write-not-found", { name, id: pendingId });
            return true;
          }
          sendJson(res, 200, found);
          return true;
        }
        if (!existsSync(filePath)) {
          sendError(res, 404, "mermaid-not-found", { name });
          return true;
        }
        const content = await fs.readFile(filePath, "utf8");
        // Already applied to the board by the server: a tab must not convert it again.
        const state = await versions.readState(name).catch(() => null);
        if (state?.version && state.mermaid?.hash === mermaidSourceHash(content)) {
          res.setHeader("X-Xcld-Mermaid-Applied", "1");
        }
        send(res, 200, "text/plain; charset=utf-8", content);
        return true;
      }

      const viewPrefix = "/api/view/";
      if (rawPathname.startsWith(viewPrefix) && req.method === "GET") {
        const rawName = rawPathname.slice(viewPrefix.length);
        const name = decodeURIComponent(rawName);
        const filePath = filePathFor(root, name, ".view.json");
        if (!existsSync(filePath)) {
          sendError(res, 404, "view-not-found", { name });
          return true;
        }
        const content = await fs.readFile(filePath, "utf8");
        send(res, 200, "application/json; charset=utf-8", content);
        return true;
      }

      sendError(res, 404, "api-not-found");
      return true;
    } catch (error) {
      const status = error instanceof URIError ? 400 : Number(error.statusCode ?? 500);
      sendError(res, status, error.message || "internal-error");
      return true;
    }
  };

  const close = () => {
    closed = true;
    mermaids.close();
    const drained = versions.close();
    watcher?.close();
    if (poller) {
      clearInterval(poller);
    }
    for (const timer of pendingDeletes.values()) {
      clearTimeout(timer);
    }
    pendingDeletes.clear();
    for (const wait of settleWaits) {
      clearTimeout(wait.timer);
      wait.resolve();
    }
    settleWaits.clear();
    for (const client of clients) {
      client.end();
    }
    clients.clear();
    // Resolves when the commit in flight has finished; callers that delete the boards
    // folder afterwards should await it.
    return drained;
  };

  return { handle, close, boardsDir: root, versions, mermaids };
}