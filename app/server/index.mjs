import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBoardApi, isAllowedHostHeader } from "./api.mjs";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(DIRNAME, "..", "dist");
const INDEX_HTML = path.join(DIST_DIR, "index.html");
const HOST = process.env.XCLD_HOST || "127.0.0.1";
const PORT = Number(process.env.XCLD_PORT || 3100);
const BOARDS_DIR = path.resolve(process.env.XCLD_BOARDS_DIR || path.join(process.cwd(), "boards"));

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
]);

const sendJson = (res, status, data) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(`${JSON.stringify(data)}\n`);
};

const resolveStaticPath = (requestPath) => {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const cleanPath = decoded.split("/").filter(Boolean).join(path.sep);
  const candidate = path.resolve(DIST_DIR, cleanPath || "index.html");
  const relative = path.relative(DIST_DIR, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
};

const streamFile = async (res, filePath, cacheControl = "no-store") => {
  const info = await stat(filePath);
  if (!info.isFile()) {
    return false;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream");
  res.setHeader("Content-Length", info.size);
  res.setHeader("Cache-Control", cacheControl);
  await new Promise((resolve, reject) => {
    createReadStream(filePath).on("error", reject).on("end", resolve).pipe(res);
  });
  return true;
};

await mkdir(BOARDS_DIR, { recursive: true });
const api = createBoardApi({ boardsDir: BOARDS_DIR });

const server = createServer(async (req, res) => {
  try {
    if (!isAllowedHostHeader(req.headers.host)) {
      sendJson(res, 403, { error: "forbidden-host" });
      return;
    }

    // The MCP widget renders in a sandboxed iframe (VS Code, Claude Desktop) and fetches
    // Excalidraw fonts from here cross-origin. Only these public, read-only static assets
    // get CORS (incl. Chromium's Private Network Access preflight); boards and the API never do.
    if ((req.url ?? "").startsWith("/excalidraw-assets/")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
        if (req.headers["access-control-request-private-network"] === "true") {
          res.setHeader("Access-Control-Allow-Private-Network", "true");
        }
        res.statusCode = 204;
        res.end();
        return;
      }
    }

    if (await api.handle(req, res)) {
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const filePath = resolveStaticPath(url.pathname);
    if (!filePath) {
      sendJson(res, 400, { error: "invalid-path" });
      return;
    }

    const cacheControl = filePath.includes(`${path.sep}assets${path.sep}`) || filePath.includes(`${path.sep}excalidraw-assets${path.sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-store";

    try {
      if (await streamFile(res, filePath, cacheControl)) {
        return;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw error;
      }
    }

    await streamFile(res, INDEX_HTML, "no-store");
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } else {
      res.destroy(error);
    }
  }
});

const shutdown = (signal) => {
  console.log(`${signal} received; shutting down`);
  api.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, HOST, () => {
  console.log(`xcld-collab listening on http://${HOST}:${PORT}`);
  console.log(`boards: ${BOARDS_DIR}`);
});