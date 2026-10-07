import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, watch } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { boardFilePath, maxDepthFromEnv, validateBoardPath } from "../../tools/board-path.mjs";
import { boardInfoForRelativeFile, listBoards, walkBoardFiles } from "../../tools/board-index.mjs";
import { autoExportFromEnv, exportFilePath, writeMermaidFromBoard } from "../../tools/export.mjs";
import { effectiveExportMode } from "../../tools/rules.mjs";

const MAX_BODY_BYTES = 20 * 1024 * 1024;

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

export const contentHash = (content) => createHash("sha256").update(content).digest("hex");

const etagFor = (hash) => `"${hash}"`;

// Strong comparison only: W/ tags never match. Bare (unquoted) hashes are accepted for scripts.
const parseEntityTags = (header) => {
  if (header === undefined) {
    return null;
  }
  const value = Array.isArray(header) ? header.join(",") : String(header);
  return value.split(",").map((tag) => tag.trim()).filter(Boolean).map((tag) => (
    tag === "*" || tag.startsWith("W/") ? tag : tag.replace(/^"(.*)"$/, "$1")
  ));
};

// Returns null when the save may proceed. No If-Match/If-None-Match header means an
// unguarded write (last write wins), kept for scripts.
export const staleSaveCheck = (headers, currentHash) => {
  const ifMatch = parseEntityTags(headers["if-match"]);
  const ifNoneMatch = parseEntityTags(headers["if-none-match"]);
  if (ifMatch) {
    const ok = currentHash !== null && ifMatch.some((tag) => tag === "*" || tag === currentHash);
    if (!ok) {
      return { error: "stale-save", currentHash };
    }
  }
  if (ifNoneMatch?.includes("*") && currentHash !== null) {
    return { error: "stale-save", currentHash };
  }
  return null;
};

const readCurrent = async (filePath) => {
  try {
    const content = await fs.readFile(filePath);
    return { content, hash: contentHash(content) };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { content: null, hash: null };
    }
    throw error;
  }
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

const writeAtomic = async (targetPath, content) => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, targetPath);
};

export function createBoardApi({
  boardsDir,
  pollMs = Number.parseInt(process.env.XCLD_WATCH_POLL_MS ?? "1000", 10),
  maxDepth = maxDepthFromEnv(),
  useFsWatch = true,
  autoExport = autoExportFromEnv(),
  deleteDebounceMs = 300,
  settleMs = Math.min(Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 100, 100),
}) {
  const root = path.resolve(boardsDir);
  mkdirSync(root, { recursive: true });
  const clients = new Set();
  let watcher;
  let closed = false;

  // Serializes check-then-write per board so two tabs can't both pass the same If-Match.
  const boardLocks = new Map();
  const withBoardLock = (key, fn) => {
    const previous = boardLocks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.catch(() => {});
    boardLocks.set(key, settled);
    settled.then(() => {
      if (boardLocks.get(key) === settled) {
        boardLocks.delete(key);
      }
    });
    return run;
  };

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

  const publish = (data) => {
    const payload = `event: board\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      client.write(payload);
    }
  };

  // Change detection uses two sources. fs.watch is instant, but inotify events don't
  // cross Docker Desktop bind mounts from Windows/macOS hosts, which is exactly where
  // host-side agents write. A cheap mtime+size poll covers that case; signatures
  // dedupe the two so each change is published once.
  const signatures = new Map();
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
    publish({
      name: item.name,
      kind: item.kind,
      timestamp: Date.now(),
    });
    if (item.kind === "board") {
      await exportBoard(item.name);
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
      sendJson(res, 200, await listBoards(root, { maxDepth }));
      return true;
    }

    if (!rawPathname.startsWith("/api/")) {
      return false;
    }

    try {
      const boardPrefix = "/api/board/";
      if (rawPathname.startsWith(boardPrefix)) {
        const rawName = rawPathname.slice(boardPrefix.length);
        const name = decodeURIComponent(rawName);
        const filePath = filePathFor(root, name, ".excalidraw");

        if (req.method === "GET") {
          const current = await readCurrent(filePath);
          if (current.hash === null) {
            sendError(res, 404, "board-not-found", { name });
            return true;
          }
          res.setHeader("ETag", etagFor(current.hash));
          send(res, 200, "application/json; charset=utf-8", current.content);
          return true;
        }

        if (req.method === "PUT") {
          if (!isJsonRequest(req)) {
            sendError(res, 415, "content-type-must-be-application-json");
            return true;
          }
          const body = await readRequestBody(req);
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            sendError(res, 400, "invalid-json");
            return true;
          }
          if (parsed?.type !== "excalidraw" || !Array.isArray(parsed.elements)) {
            sendError(res, 400, "invalid-excalidraw-json");
            return true;
          }
          const persisted = body.endsWith("\n") ? body : `${body}\n`;
          // Hash what is on disk now, not what this server last wrote, so direct on-disk
          // agent writes are detected too.
          const result = await withBoardLock(filePath, async () => {
            const current = await readCurrent(filePath);
            const stale = staleSaveCheck(req.headers, current.hash);
            if (stale) {
              return { stale };
            }
            await writeAtomic(filePath, persisted);
            const stat = await fs.stat(filePath);
            signatures.set(`${name}.excalidraw`, `${stat.mtimeMs}:${stat.size}`);
            return { hash: contentHash(persisted) };
          });
          if (result.stale) {
            if (result.stale.currentHash) {
              res.setHeader("ETag", etagFor(result.stale.currentHash));
            }
            sendJson(res, 409, result.stale);
            return true;
          }
          publish({ name, kind: "board", timestamp: Date.now() });
          await exportBoard(name);
          res.setHeader("ETag", etagFor(result.hash));
          sendJson(res, 200, { ok: true, hash: result.hash });
          return true;
        }

        sendError(res, 405, "method-not-allowed");
        return true;
      }

      const mermaidPrefix = "/api/mermaid/";
      if (rawPathname.startsWith(mermaidPrefix) && req.method === "GET") {
        const rawName = rawPathname.slice(mermaidPrefix.length);
        const name = decodeURIComponent(rawName);
        const filePath = filePathFor(root, name, ".mmd");
        if (!existsSync(filePath)) {
          sendError(res, 404, "mermaid-not-found", { name });
          return true;
        }
        const content = await fs.readFile(filePath, "utf8");
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
  };

  return { handle, close, boardsDir: root };
}