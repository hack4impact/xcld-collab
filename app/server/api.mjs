import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, watch } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { boardFilePath, maxDepthFromEnv, validateBoardPath } from "../../tools/board-path.mjs";
import { boardKindForExtension, listBoards, walkBoardFiles } from "../../tools/board-index.mjs";
import { autoExportFromEnv, exportFilePath, writeMermaidFromBoard } from "../../tools/export.mjs";

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

const contentHash = (content) => createHash("sha256").update(content).digest("hex");

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
}) {
  const root = path.resolve(boardsDir);
  mkdirSync(root, { recursive: true });
  const clients = new Set();
  let watcher;
  let closed = false;

  // XCLD_AUTO_EXPORT=save keeps boards/.exports/<path>.mmd current (~2 ms per 500 nodes).
  const exportBoard = (name) => {
    if (autoExport !== "save") {
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
  const pendingDeletes = new Map();
  let warnedSlowPoll = false;
  const nameFromRelativeFile = (relativeFile) => {
    const normalized = String(relativeFile).replace(/\\/g, "/").split("/").filter(Boolean).join("/");
    const extension = path.extname(normalized);
    const kind = boardKindForExtension(extension);
    if (!kind) {
      return null;
    }
    if (normalized.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules")) {
      return null;
    }
    const name = normalized.slice(0, -extension.length);
    return validateBoardPath(name, { maxDepth }).ok ? { name, kind, relativeFile: normalized } : null;
  };
  const cancelPendingDelete = (relativeFile) => {
    const timer = pendingDeletes.get(relativeFile);
    if (timer) {
      clearTimeout(timer);
      pendingDeletes.delete(relativeFile);
    }
  };
  const scheduleDeleteIfKnown = (item) => {
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
  const publishIfChanged = async (relativeFile) => {
    const item = nameFromRelativeFile(relativeFile);
    if (!item) {
      return;
    }
    let signature;
    try {
      const stat = await fs.lstat(path.join(root, ...item.relativeFile.split("/")));
      if (!stat.isFile()) {
        scheduleDeleteIfKnown(item);
        return;
      }
      signature = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      scheduleDeleteIfKnown(item);
      return;
    }
    cancelPendingDelete(item.relativeFile);
    if (signatures.get(item.relativeFile) === signature) {
      return;
    }
    signatures.set(item.relativeFile, signature);
    publish({
      name: item.name,
      kind: item.kind,
      timestamp: Date.now(),
    });
    if (item.kind === "board") {
      await exportBoard(item.name);
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
      for (const file of files) {
        await publishIfChanged(file.relativeFile);
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
      const elapsed = performance.now() - start;
      if (elapsed > 250 && !warnedSlowPoll) {
        warnedSlowPoll = true;
        console.warn(`Board poll scan took ${Math.round(elapsed)} ms; consider XCLD_WATCH_POLL_MS or XCLD_MAX_DEPTH.`);
      }
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
          if (!existsSync(filePath)) {
            sendError(res, 404, "board-not-found", { name });
            return true;
          }
          const content = await fs.readFile(filePath, "utf8");
          send(res, 200, "application/json; charset=utf-8", content);
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
          await writeAtomic(filePath, persisted);
          const stat = await fs.stat(filePath);
          signatures.set(`${name}.excalidraw`, `${stat.mtimeMs}:${stat.size}`);
          publish({ name, kind: "board", timestamp: Date.now() });
          await exportBoard(name);
          sendJson(res, 200, { ok: true, hash: contentHash(persisted) });
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
    for (const client of clients) {
      client.end();
    }
    clients.clear();
  };

  return { handle, close, boardsDir: root };
}