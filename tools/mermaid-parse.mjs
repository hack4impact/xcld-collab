// Server-side Mermaid parsing with Mermaid's own parser.
//
// Mermaid needs a DOM even to parse (DOMPurify registers hooks at import time), so the
// parser runs in a worker thread that installs jsdom globals in its own isolate; the
// caller's globals stay untouched. The worker is tools/mermaid-parse.bundle.mjs (built by
// `cd app; npm run build`): one esbuild file with jsdom and Mermaid, which starts in about
// a second instead of the 40 s+ it takes to import Mermaid's many files from node_modules.
//
//   warmUp()             start the worker in the background; idempotent; resolves to status()
//   parseFlowchart(text) waits for warm-up, then parses (see the result shape below)
//   status()             { state: cold|warming|ready|failed, warmUpMs, timings, ... }
//   close()              stop the worker
//
// parseFlowchart resolves to one of
//   { ok: true, diagramType, direction, nodes, edges, subgraphs, classDefs }
//   { ok: false, unsupported: true, diagramType }     not a flowchart (a tab still converts it)
//   { ok: false, error: { message, line, column, token, expected } }   Mermaid syntax error
// and rejects only when the worker itself is unavailable (bundle missing, crash, timeout).
//   nodes:     [{ id, label, shape, classes, styles, link, style: { container, label } }]
//   edges:     [{ mermaidId, start, end, label, type, stroke, arrowheads, curve }]   curve: the edge's own (`e1@{ curve: linear }`) or null
//   subgraphs: [{ id, title, nodes, classes, style: { container, label } }]
// `label`/`title` are the text the converter would put on the board (real newlines,
// entities decoded, Markdown stripped). `style` holds the Excalidraw properties the
// browser converter derives from classDef/class/style (mermaid-to-excalidraw's helpers).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

export const DEFAULT_WORKER_URL = new URL("./mermaid-parse.bundle.mjs", import.meta.url);
export const DEFAULT_PARSE_TIMEOUT_MS = 30_000;

export const createMermaidParser = ({ workerUrl = DEFAULT_WORKER_URL, timeoutMs = DEFAULT_PARSE_TIMEOUT_MS } = {}) => {
  let worker = null;
  let readyPromise = null;
  let nextId = 0;
  const pending = new Map();
  const info = {
    state: "cold",
    startedAt: null,
    warmUpMs: null,
    timings: null,
    mermaidVersion: null,
    jsdomVersion: null,
    parses: 0,
    lastParseMs: null,
    error: null,
  };

  // An idle worker must not keep a CLI or test process alive; a busy one must.
  const updateRef = () => {
    if (!worker) return;
    if (pending.size || info.state === "warming") worker.ref();
    else worker.unref();
  };

  const fail = (current, error) => {
    if (worker !== current) return;
    const message = error instanceof Error ? error.message : String(error);
    worker = null;
    readyPromise = null;
    Object.assign(info, { state: "failed", error: message });
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`Mermaid parser unavailable: ${message}`));
    }
    pending.clear();
    current.terminate().catch(() => {});
  };

  const warmUp = () => {
    if (readyPromise) return readyPromise;
    if (!existsSync(fileURLToPath(workerUrl))) {
      Object.assign(info, { state: "failed", error: "Mermaid parser bundle not found. Run \"cd app; npm ci; npm run build\" first." });
      return Promise.resolve(status());
    }
    const started = performance.now();
    Object.assign(info, { state: "warming", startedAt: new Date().toISOString(), error: null, warmUpMs: null, timings: null });
    const current = new Worker(workerUrl);
    worker = current;
    readyPromise = new Promise((resolve) => {
      current.on("message", (message) => {
        if (message?.type === "ready") {
          Object.assign(info, {
            state: "ready",
            warmUpMs: Math.round(performance.now() - started),
            timings: message.timings,
            mermaidVersion: message.mermaidVersion,
            jsdomVersion: message.jsdomVersion,
          });
          updateRef();
          resolve(status());
          return;
        }
        const request = pending.get(message?.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        info.parses += 1;
        info.lastParseMs = Math.round(message.ms * 10) / 10;
        updateRef();
        request.resolve(message.result);
      });
      current.on("error", (error) => { fail(current, error); resolve(status()); });
      current.on("exit", (code) => { fail(current, new Error(`worker exited with code ${code}`)); resolve(status()); });
    });
    updateRef();
    return readyPromise;
  };

  const request = async (payload) => {
    await warmUp();
    const current = worker;
    if (!current || info.state !== "ready") throw new Error(`Mermaid parser unavailable: ${info.error ?? info.state}`);
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        fail(current, new Error(`parse timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      updateRef();
      current.postMessage({ ...payload, id });
    });
  };
  const parseFlowchart = (text) => request({ type: "parse", text: String(text ?? "") });
  // Tests only: replace the worker's site config (mermaid.initialize) for the parses after it.
  const configure = (config = {}) => request({ type: "configure", config });

  const status = () => ({ ...info, pending: pending.size });

  const close = async () => {
    const current = worker;
    worker = null;
    readyPromise = null;
    Object.assign(info, { state: "cold" });
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("Mermaid parser closed"));
    }
    pending.clear();
    if (current) await current.terminate();
  };

  return { warmUp, parseFlowchart, configure, status, close };
};

const defaultParser = createMermaidParser();
export const warmUp = () => defaultParser.warmUp();
export const parseFlowchart = (text) => defaultParser.parseFlowchart(text);
export const parserStatus = () => defaultParser.status();
export const closeParser = () => defaultParser.close();
