// Versions and merge, server side: branch store (journal), per-board FIFO queue, the commit
// step (the only writer of master), coalesced history (checkpoints and deltas), a base store, a
// per-board image file store, journal replay, commit retry and external-write adoption.
// Rules and layout: docs/DESIGN.md#versions-storage-and-commit-pipeline.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { splitBoardPath } from "../../tools/board-path.mjs";
import { applyDelta, CHECKPOINT_EVERY, encodeDelta, gzipText, HISTORY_SCHEMA, historyEntryFiles, readRecordFile } from "../../tools/history.mjs";
import { mergeBoard } from "../../tools/merge.mjs";
import { stampCanvasEdits } from "../../tools/mermaid-origin.mjs";

export const IDLE_CLOSE_MS = 3 * 60 * 1000;
export const BASE_TTL_MS = 24 * 60 * 60 * 1000;
export const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 10_000];
// A tab says how long ago its last edit was (`writtenAgoMs`); older claims are capped.
export const MAX_WRITTEN_AGO_MS = 10 * 60 * 1000;
const GC_INTERVAL_MS = 10 * 60 * 1000;
const STATE_SCHEMA = 1;
// State `records`: 2 = images live in the file store, not in records.
const RECORD_SCHEMA = 2;
const TIMING_LOG_LIMIT = 20_000;
// Slice-2 records embed images; only files this large can hold one worth moving out.
const MIGRATE_MIN_BYTES = 32 * 1024;

export const contentHash = (content) => createHash("sha256").update(content).digest("hex");

// Strong comparison only: W/ tags never match. Bare (unquoted) hashes are accepted for scripts.
export const parseEntityTags = (header) => {
  if (header === undefined || header === null) {
    return null;
  }
  const value = Array.isArray(header) ? header.join(",") : String(header);
  return value.split(",").map((tag) => tag.trim()).filter(Boolean).map((tag) => (
    tag === "*" || tag.startsWith("W/") ? tag : tag.replace(/^"(.*)"$/, "$1")
  ));
};

// Returns null when the save may proceed. Kept for `If-Match: *` (the board must exist).
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

// Author keys (lead, 2026-10-06/07). Display names are not unique; the suffix after `#` is.
// `init` labels the first snapshot of a board that existed before versions.
const AUTHOR_FORMS = [
  { kind: "human", pattern: /^human:([^\u0000-\u001f]{1,100})#([A-Za-z0-9_-]{1,64})$/ },
  { kind: "agent", pattern: /^agent:([^\u0000-\u001f]{1,100})#([A-Za-z0-9_.-]{1,64})$/ },
  { kind: "cli", pattern: /^cli:([^\u0000-\u001f]{1,100})$/ },
  { kind: "external", pattern: /^external$/ },
  { kind: "init", pattern: /^init$/ },
];

export const parseAuthorKey = (key) => {
  if (typeof key !== "string") {
    return null;
  }
  for (const { kind, pattern } of AUTHOR_FORMS) {
    const match = pattern.exec(key);
    if (match) {
      return { kind, name: match[1] ?? kind };
    }
  }
  return null;
};

export const authorKeySafe = (key) => String(key).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[_.]+|_+$/g, "").slice(0, 64) || "author";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let idCounter = 0;
// Time-sortable id: 10 chars of milliseconds, a per-process counter (keeps arrival order
// within one millisecond), then randomness.
export const sortableId = (time) => {
  let encoded = "";
  for (let value = Math.max(0, Math.floor(time)), digit = 0; digit < 10; digit++, value = Math.floor(value / 32)) {
    encoded = CROCKFORD[value % 32] + encoded;
  }
  idCounter = (idCounter + 1) % 32 ** 4;
  let counter = "";
  for (let value = idCounter, digit = 0; digit < 4; digit++, value = Math.floor(value / 32)) {
    counter = CROCKFORD[value % 32] + counter;
  }
  return encoded + counter + [...randomBytes(8)].map((byte) => CROCKFORD[byte % 32]).join("");
};

const utcStamp = (time) => new Date(time).toISOString().replace(/[-:]/g, "");
const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms).unref?.();
});

const readText = async (file) => {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const readJson = async (file) => {
  const text = await readText(file);
  return text === null ? null : JSON.parse(text);
};

// A JSON file read right after it was replaced can come back short on a Docker Desktop bind
// mount (seen under load). Re-read until it parses, a few times, then return what was read.
export const readSettledJsonText = async (file, attempts = 5) => {
  let text = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    text = await readText(file);
    if (text === null) {
      return null;
    }
    try {
      JSON.parse(text);
      return text;
    } catch {
      await delay(20 * (attempt + 1));
    }
  }
  return text;
};

// Windows can refuse a rename while another process (the watcher, an editor) has the target
// open; retry briefly.
const renameWithRetry = async (from, to) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 8 || !["EPERM", "EBUSY", "EACCES"].includes(error?.code)) {
        throw error;
      }
      await delay(10 * (attempt + 1));
    }
  }
};

// Returns the written file's stat when `stat` is set (taken on the open handle: the rename keeps
// inode, mtime and size, and it saves a round trip).
export const writeFileAtomic = async (target, content, { sync = false, mkdir = true, stat = false } = {}) => {
  if (mkdir) {
    await fs.mkdir(path.dirname(target), { recursive: true });
  }
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, "w");
  let written = null;
  try {
    await handle.writeFile(content, "utf8");
    if (sync) {
      await handle.sync();
    }
    if (stat) {
      written = await handle.stat();
    }
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  return written;
};

const unlinkIfExists = async (file) => {
  await fs.rm(file, { force: true });
};

const parseScene = (text) => {
  const scene = JSON.parse(text);
  if (!scene || typeof scene !== "object" || !Array.isArray(scene.elements)) {
    throw new Error("invalid-excalidraw-json");
  }
  return scene;
};

// Master's bytes as the commit step writes them: Excalidraw's own serializeAsJSON layout, so a
// tab's save keeps its exact text and hash.
export const canonicalText = (scene) => `${JSON.stringify(scene, null, 2)}\n`;

const sceneObject = (template, { elements, appState, files }) => ({
  type: "excalidraw",
  version: typeof template?.version === "number" ? template.version : 2,
  source: typeof template?.source === "string" ? template.source : "xcld-collab",
  elements,
  appState: appState ?? {},
  files: files ?? {},
});

// The open entry accumulates applied changes per unit: the first kind sticks ("added" then
// "changed" is still "added"), the latest label wins, and added-then-deleted drops out.
const foldApplied = (previous, next) => {
  const byUnit = new Map(previous.map((item) => [item.unitId, item]));
  for (const item of next) {
    const before = byUnit.get(item.unitId);
    if (before?.kind === "added" && item.kind === "deleted") {
      byUnit.delete(item.unitId);
    } else {
      byUnit.set(item.unitId, before?.kind === "added" ? { ...item, kind: "added" } : item);
    }
  }
  return [...byUnit.values()].sort((left, right) => (left.unitId < right.unitId ? -1 : left.unitId > right.unitId ? 1 : 0));
};

const validateElements = (elements) => Array.isArray(elements) && elements.every((element) => element && typeof element === "object" && typeof element.id === "string" && element.id !== "");
const validateFiles = (files) => files === undefined || files === null || (typeof files === "object" && !Array.isArray(files) && Object.values(files).every((file) => file && typeof file === "object"));

const isRetryable = (error) => typeof error?.code === "string" && /^E[A-Z0-9]+$/.test(error.code);

// Per-stage timings (XCLD_TIMING=1). A stage that runs several times adds up.
const stopwatch = (enabled) => {
  if (!enabled) {
    return { run: (_stage, fn) => fn(), add: () => {}, stages: null };
  }
  const stages = {};
  const add = (stage, ms) => {
    stages[stage] = (stages[stage] ?? 0) + ms;
  };
  const run = async (stage, fn) => {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      add(stage, performance.now() - start);
    }
  };
  return { run, add, stages };
};

/**
 * @param {object} options
 * @param {string} options.boardsDir
 * @param {() => number} [options.now]
 * @param {number} [options.idleMs] Close an open human history entry after this much idle time.
 * @param {number} [options.baseTtlMs] Keep a served or pinned base this long after it was last served.
 * @param {number[]} [options.retryDelaysMs] Backoff between attempts of a commit that failed on an I/O error; the last value repeats.
 * @param {number} [options.checkpointEvery] History entries per full checkpoint (the rest are deltas); default 20.
 * @param {boolean} [options.timing] Record per-stage timings (`timings()`); default XCLD_TIMING=1.
 * @param {(name: string) => Promise<void> | void} [options.onMasterWritten] After the commit step writes master.
 * @param {(event: object) => Promise<void> | void} [options.onCommitted] Post-commit hook (Hook 3), run after the commit, not awaited by the queue.
 * @param {{ onStep?: (step: string, info: object) => Promise<void> | void }} [options.testHooks]
 */
export function createVersionStore({
  boardsDir,
  stateDir,
  now = Date.now,
  idleMs = IDLE_CLOSE_MS,
  baseTtlMs = BASE_TTL_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
  checkpointEvery = CHECKPOINT_EVERY,
  timing = process.env.XCLD_TIMING === "1",
  onMasterWritten = () => {},
  onCommitted = () => {},
  testHooks = {},
}) {
  const root = path.resolve(boardsDir);
  const defaultStateDir = path.join(root, ".xcld");
  // A stateDir moves the journal, history and state off the boards folder. Compose picks it with
  // XCLD_HISTORY (tools/storage.mjs): <cache>/history on Linux, a named volume on Docker Desktop,
  // where every file operation on a bind mount is a slow round trip.
  const xcld = stateDir ? path.resolve(stateDir) : defaultStateDir;
  const boards = new Map();
  const queues = new Map();
  const pendingRefs = new Map();
  const pendingExternal = new Map();
  const pendingCount = new Map();
  const failures = new Map();
  const idleTimers = new Map();
  const lastGc = new Map();
  const knownFiles = new Map();
  const timingLog = [];
  const sleepers = new Set();
  let closed = false;
  let started = null;

  // Throws (statusCode 400) on an invalid board path, so no name escapes boardsDir.
  const segments = (name) => splitBoardPath(name);
  const leafPath = (dir, name, extension) => path.join(dir, ...segments(name).slice(0, -1), `${segments(name).at(-1)}${extension}`);
  const masterPath = (name) => leafPath(root, name, ".excalidraw");
  const branchDir = (name) => path.join(xcld, "branches", ...segments(name));
  const historyDir = (name) => path.join(xcld, "history", ...segments(name));
  const basesDir = (name) => path.join(xcld, "bases", ...segments(name));
  const basePath = (name, version) => path.join(basesDir(name), `${version}.excalidraw`);
  const filesDir = (name) => path.join(xcld, "files", ...segments(name));
  const statePath = (name) => leafPath(path.join(xcld, "state"), name, ".json");
  const step = async (name, info) => {
    await testHooks.onStep?.(name, info);
  };

  // Every file operation costs a round trip on a Docker Desktop bind mount, so folders known to
  // exist aren't created again.
  const knownDirs = new Set();
  const writeAtomic = async (target, content, options = {}) => {
    const dir = path.dirname(target);
    if (!knownDirs.has(dir)) {
      await fs.mkdir(dir, { recursive: true });
      knownDirs.add(dir);
    }
    try {
      return await writeFileAtomic(target, content, { ...options, mkdir: false });
    } catch (error) {
      knownDirs.delete(dir);
      throw error;
    }
  };

  // Master's identity without reading it: inode (atomic writes replace it), mtime and size.
  const masterSignature = async (name) => {
    try {
      const stat = await fs.stat(masterPath(name));
      return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  };
  // Master as it is on disk. Skips reading and hashing it while its signature is the one seen
  // with the committed version (the watcher relies on the same signature).
  const diskState = async (board) => {
    const signature = await masterSignature(board.name);
    if (signature !== null && board.version && signature === board.masterSig) {
      return { hash: board.version, text: null, signature };
    }
    const disk = await readMasterFile(board.name);
    if (disk.hash !== null && disk.hash === board.version) {
      board.masterSig = signature;
    }
    return { ...disk, signature };
  };

  // Recently committed or read versions, by id: stale bases are usually among them.
  const RECENT_VERSIONS = 8;
  const remember = (board, version, scene) => {
    if (!version || !scene) {
      return;
    }
    board.recent.delete(version);
    board.recent.set(version, scene);
    while (board.recent.size > RECENT_VERSIONS) {
      board.recent.delete(board.recent.keys().next().value);
    }
  };

  const refKey = (name, version) => `${name}\u0000${version}`;
  const addRef = (name, version) => {
    if (version) {
      pendingRefs.set(refKey(name, version), (pendingRefs.get(refKey(name, version)) ?? 0) + 1);
    }
  };
  const releaseRef = (name, version) => {
    if (version) {
      const count = (pendingRefs.get(refKey(name, version)) ?? 0) - 1;
      if (count > 0) {
        pendingRefs.set(refKey(name, version), count);
      } else {
        pendingRefs.delete(refKey(name, version));
      }
    }
  };
  const isReferenced = (name, version) => pendingRefs.has(refKey(name, version));
  const countPending = (name, delta) => {
    const count = (pendingCount.get(name) ?? 0) + delta;
    if (count > 0) {
      pendingCount.set(name, count);
    } else {
      pendingCount.delete(name);
    }
  };

  // One merge in flight per board; boards run in parallel.
  const enqueue = (name, job) => {
    const previous = queues.get(name) ?? Promise.resolve();
    const run = previous.then(job, job);
    const tail = run.catch(() => {});
    queues.set(name, tail);
    tail.then(() => {
      if (queues.get(name) === tail) {
        queues.delete(name);
      }
    });
    return run;
  };

  const readMasterFile = async (name) => {
    const text = await readSettledJsonText(masterPath(name));
    return text === null ? { text: null, hash: null } : { text, hash: contentHash(text) };
  };

  // Images: stored once per board under files/<path>/<fileId>.<contentHash16>.json; branch,
  // history and base records hold [fileId, key] references.
  const fileKey = (id, file) => `${authorKeySafe(id)}.${contentHash(typeof file.dataURL === "string" ? file.dataURL : JSON.stringify(file)).slice(0, 16)}`;
  const boardFiles = (name) => {
    let known = knownFiles.get(name);
    if (!known) {
      known = new Map();
      knownFiles.set(name, known);
    }
    return known;
  };
  const storeFiles = async (name, files) => {
    const refs = [];
    const known = boardFiles(name);
    for (const [id, file] of Object.entries(files ?? {})) {
      const key = fileKey(id, file);
      refs.push([id, key]);
      if (!known.has(key)) {
        const target = path.join(filesDir(name), `${key}.json`);
        const exists = await fs.stat(target).then(() => true, () => false);
        if (!exists) {
          await writeAtomic(target, JSON.stringify(file), { sync: true });
        }
        known.set(key, file);
      }
    }
    return refs;
  };
  const loadFiles = async (name, refs) => {
    const files = {};
    const known = boardFiles(name);
    for (const [id, key] of refs ?? []) {
      let file = known.get(key);
      if (!file) {
        file = await readJson(path.join(filesDir(name), `${key}.json`));
        if (!file) {
          throw new Error(`image ${id} of ${name} is missing from the file store`);
        }
        known.set(key, file);
      }
      files[id] = file;
    }
    return files;
  };

  // A history or base record: the scene with `files` emptied plus
  // `xcld: { schema, version, files: [[fileId, key]] }`. Slice-2 records are plain master
  // text, checked against their hash. `text` (the scene's canonical text) saves serializing a
  // board without images twice.
  const writeRecord = async (name, target, version, scene, text = null) => {
    const refs = await storeFiles(name, scene.files);
    const xcldInfo = { schema: RECORD_SCHEMA, version, files: refs };
    const record = text !== null && !refs.length && text.endsWith("\n}\n")
      ? `${text.slice(0, -3)},\n  "xcld": ${JSON.stringify(xcldInfo)}\n}\n`
      : canonicalText({ ...scene, files: {}, xcld: xcldInfo });
    await writeAtomic(target, record);
  };
  const readRecord = async (name, file, version) => {
    const text = await readText(file);
    if (text === null) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (parsed?.xcld) {
      if (parsed.xcld.version !== version) {
        return null;
      }
      const { xcld: info, ...scene } = parsed;
      scene.files = await loadFiles(name, info.files);
      return { scene };
    }
    return contentHash(text) === version && Array.isArray(parsed?.elements) ? { scene: parsed, text } : null;
  };

  // History v2 records (tools/history.mjs), gzipped. A checkpoint is a record as above with
  // `record: "checkpoint"`; a delta holds the changes against its parent version.
  const writeCheckpoint = async (name, target, version, scene, text = null) => {
    const refs = await storeFiles(name, scene.files);
    const info = { schema: HISTORY_SCHEMA, record: "checkpoint", version, depth: 0, files: refs };
    const record = text !== null && !refs.length && text.endsWith("\n}\n")
      ? `${text.slice(0, -3)},\n  "xcld": ${JSON.stringify(info)}\n}\n`
      : canonicalText({ ...scene, files: {}, xcld: info });
    await writeAtomic(target, await gzipText(record));
  };
  const writeDelta = async (name, target, { version, parent, depth, parentScene, scene }) => {
    const refs = await storeFiles(name, scene.files);
    const record = { xcld: { schema: HISTORY_SCHEMA, record: "delta", version, parent, depth, files: refs }, ...encodeDelta(parentScene, scene) };
    await writeAtomic(target, await gzipText(JSON.stringify(record)));
  };
  // An entry's version: a delta rebuilt on its parent, a checkpoint, or a full record written
  // before history v2 (still valid as a checkpoint).
  const readEntry = async (board, entry, version, guard) => {
    const files = entryFiles(board.name, entry);
    const delta = await readRecordFile(files.delta);
    if (delta?.data?.xcld?.version === version) {
      const parent = await versionScene(board, delta.data.xcld.parent, { keep: false, guard: guard + 1 });
      if (parent) {
        const scene = applyDelta(parent.scene, delta.data);
        scene.files = await loadFiles(board.name, delta.data.xcld.files);
        return { scene };
      }
      console.warn(`history of ${board.name}: the parent of entry ${entry} is not readable`);
    }
    const checkpoint = await readRecordFile(files.checkpoint);
    if (checkpoint?.data?.xcld?.version === version) {
      const { xcld: info, ...scene } = checkpoint.data;
      scene.files = await loadFiles(board.name, info.files);
      return { scene };
    }
    return readRecord(board.name, files.legacy, version);
  };

  const writeState = async (board) => {
    const state = {
      schema: STATE_SCHEMA,
      board: board.name,
      version: board.version,
      masterMeta: board.meta,
      last: board.last,
      open: board.open,
      mermaid: board.mermaid,
      mermaidSources: board.mermaidSources ?? {},
      lastEntryAt: board.lastEntryAt,
      records: board.records ?? RECORD_SCHEMA,
      // How many deltas lead from the nearest checkpoint to the entry holding `version`.
      depth: board.depth ?? null,
    };
    await writeAtomic(statePath(board.name), `${JSON.stringify(state)}\n`, { sync: true });
  };

  const entryFiles = (name, entry) => {
    const files = historyEntryFiles(historyDir(name), entry);
    return { ...files, content: files.legacy };
  };

  const historyIndex = async (board) => {
    if (!board.index) {
      const index = new Map();
      let names = [];
      try {
        names = await fs.readdir(historyDir(board.name));
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
      for (const file of names.filter((item) => item.endsWith(".meta.json")).sort()) {
        try {
          const meta = await readJson(path.join(historyDir(board.name), file));
          // Meta-only entries (`record: "none"`, losers of a write that changed nothing) have no
          // version of their own.
          if (meta?.version && meta.record !== "none") {
            index.set(meta.version, file.slice(0, -".meta.json".length));
          }
        } catch {}
      }
      // The open entry's meta is written when it closes; until then it lives in the state.
      if (board.open) {
        index.set(board.open.version, board.open.entry);
      }
      board.index = index;
    }
    return board.index;
  };

  // Resolves a version id (the sha256 of master's bytes, the ETag) to its scene: the cached
  // master, master on disk, the base store, then history. `text` is set only when the exact
  // master bytes are known. `keep: false` (a delta's parent) leaves the recent cache alone.
  const versionScene = async (board, version, { keep = true, guard = 0 } = {}) => {
    if (!version) {
      return null;
    }
    if (guard > 4 * Math.max(checkpointEvery, CHECKPOINT_EVERY)) {
      throw new Error(`history of ${board.name}: delta chain too long at ${version}`);
    }
    if (board.cache?.version === version) {
      return { scene: board.cache.scene, text: board.cache.text ?? null };
    }
    if (board.recent.has(version)) {
      return { scene: board.recent.get(version), text: null };
    }
    if (version === board.version) {
      const disk = await readMasterFile(board.name);
      if (disk.hash === version) {
        try {
          return { scene: parseScene(disk.text), text: disk.text };
        } catch {}
      }
    }
    const record = await readRecord(board.name, basePath(board.name, version), version);
    if (record) {
      if (keep) {
        remember(board, version, record.scene);
      }
      return record;
    }
    const entries = [...new Set([(await historyIndex(board)).get(version), board.last?.entry].filter(Boolean))];
    for (const entry of entries) {
      const found = await readEntry(board, entry, version, guard);
      if (found) {
        if (keep) {
          remember(board, version, found.scene);
        }
        return found;
      }
    }
    return null;
  };

  const saveBase = async (board, version, scene) => {
    const file = basePath(board.name, version);
    const stamp = new Date(now());
    board.baseCopies.add(version);
    try {
      await fs.utimes(file, stamp, stamp);
      return;
    } catch {}
    await writeRecord(board.name, file, version, scene);
    await fs.utimes(file, stamp, stamp).catch(() => {});
  };

  // A base copy of a version that is now a closed history entry is redundant: history resolves
  // it. Dropped once the closing state is durable (the GC catches what a restart missed).
  const dropRedundantBases = async (board) => {
    for (const version of board.redundantBases) {
      board.redundantBases.delete(version);
      board.baseCopies.delete(version);
      if (version !== board.open?.version) {
        await unlinkIfExists(basePath(board.name, version)).catch(() => {});
      }
    }
  };

  const gcBases = async (board, force = false) => {
    if (!force && now() - (lastGc.get(board.name) ?? 0) < GC_INTERVAL_MS) {
      return;
    }
    lastGc.set(board.name, now());
    let files = [];
    try {
      files = await fs.readdir(basesDir(board.name));
    } catch {
      return;
    }
    for (const file of files.filter((item) => item.endsWith(".excalidraw"))) {
      const version = file.slice(0, -".excalidraw".length);
      if (version === board.version || isReferenced(board.name, version)) {
        continue;
      }
      try {
        const entry = (await historyIndex(board)).get(version);
        const stat = await fs.stat(basePath(board.name, version));
        if ((entry && entry !== board.open?.entry) || now() - stat.mtimeMs > baseTtlMs) {
          await unlinkIfExists(basePath(board.name, version));
          board.baseCopies.delete(version);
        }
      } catch {}
    }
  };

  // Slice-2 history and base records embed images; move them to the file store. Safe to
  // interrupt: a record is replaced atomically, and both layouts stay readable.
  const migrateRecords = async (board) => {
    const candidates = [];
    const index = await historyIndex(board);
    for (const [version, entry] of index) {
      candidates.push({ file: entryFiles(board.name, entry).content, version });
    }
    try {
      for (const file of await fs.readdir(basesDir(board.name))) {
        if (file.endsWith(".excalidraw")) {
          candidates.push({ file: path.join(basesDir(board.name), file), version: file.slice(0, -".excalidraw".length) });
        }
      }
    } catch {}
    for (const { file, version } of candidates) {
      try {
        const stat = await fs.stat(file);
        if (stat.size < MIGRATE_MIN_BYTES) {
          continue;
        }
        const text = await readText(file);
        const parsed = JSON.parse(text);
        if (parsed.xcld || !parsed.files || !Object.keys(parsed.files).length || contentHash(text) !== version) {
          continue;
        }
        await writeRecord(board.name, file, version, parsed);
        await fs.utimes(file, stat.atime, stat.mtime).catch(() => {});
      } catch (error) {
        console.warn(`migrating ${path.relative(root, file)} failed: ${error.message}`);
      }
    }
    board.records = RECORD_SCHEMA;
    await writeState(board);
  };

  const clearIdle = (name) => {
    const timer = idleTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(name);
    }
  };
  const scheduleIdle = (board) => {
    clearIdle(board.name);
    if (closed || !board.open) {
      return;
    }
    const wait = Math.max(0, board.open.lastCommitAt + idleMs - now());
    const timer = setTimeout(() => {
      idleTimers.delete(board.name);
      enqueue(board.name, async () => {
        const current = boards.get(board.name);
        if (!closed && current?.open && now() - current.open.lastCommitAt >= idleMs) {
          await closeOpenEntry(current, "idle");
          await writeState(current);
          await dropRedundantBases(current);
        } else if (current) {
          scheduleIdle(current);
        }
      }).catch((error) => console.warn(`closing idle history entry for ${board.name} failed: ${error.message}`));
    }, wait);
    timer.unref?.();
    idleTimers.set(board.name, timer);
  };

  const entryMetaFile = (open, closedBy) => ({
    version: open.version,
    author: open.author,
    displayName: open.displayName,
    base: open.base,
    parents: open.parents,
    applied: open.applied,
    overwritten: open.overwritten,
    coalescedCount: open.coalescedCount,
    closedBy,
    openedAt: open.openedAt,
    lastCommitAt: open.lastCommitAt,
    lastBranchId: open.lastBranchId,
    kind: open.kind,
    // History v2: `delta` or `checkpoint`, and the number of deltas back to a checkpoint.
    record: open.record ?? "checkpoint",
    depth: open.depth ?? 0,
  });

  // Rewrites the open entry's meta as closed; the caller writes the state afterwards.
  const closeOpenEntry = async (board, reason) => {
    if (!board.open) {
      return false;
    }
    await writeAtomic(entryFiles(board.name, board.open.entry).meta, `${JSON.stringify(entryMetaFile(board.open, reason), null, 2)}\n`);
    if (board.baseCopies.has(board.open.version)) {
      board.redundantBases.add(board.open.version);
    }
    board.open = null;
    clearIdle(board.name);
    return true;
  };

  const branchFile = (branch) => path.join(branchDir(branch.board), `${authorKeySafe(branch.author)}.${branch.id}.json`);

  const loadBoard = async (name) => {
    let board = boards.get(name);
    if (board) {
      return board;
    }
    // A state dir migration (start) must come first.
    await start();
    board = boards.get(name);
    if (board) {
      return board;
    }
    const state = await readJson(statePath(name)).catch(() => null);
    board = {
      name,
      version: state?.version ?? null,
      meta: state?.masterMeta ?? {},
      last: state?.last ?? null,
      open: state?.open ?? null,
      mermaid: state?.mermaid ?? null,
      // Per named Mermaid source: the last applied source text, hash, author and write time.
      mermaidSources: state?.mermaidSources ?? (state?.mermaid ? { main: state.mermaid } : {}),
      lastEntryAt: state?.lastEntryAt ?? 0,
      records: state ? state.records ?? 1 : RECORD_SCHEMA,
      // Unknown for a state written before history v2: its next entry is a checkpoint.
      depth: Number.isInteger(state?.depth) ? state.depth : null,
      index: null,
      cache: null,
      masterSig: null,
      recent: new Map(),
      // The open entry's parent version and scene (its delta is taken against it).
      chainBase: null,
      baseCopies: new Set(),
      redundantBases: new Set(),
    };
    // Crash between the state write (the commit point) and the master write: the committed
    // branch's file is still in the journal, so roll master forward. Once the branch file is
    // gone the commit finished, and a different master is an external write.
    if (board.version && board.last?.branchId) {
      const disk = await readMasterFile(name);
      const pending = await fs.stat(branchFile({ board: name, author: board.last.author, id: board.last.branchId })).then(() => true, () => false);
      if (disk.hash !== board.version && pending) {
        const found = await versionScene(board, board.version);
        const text = found ? found.text ?? canonicalText(found.scene) : null;
        if (text !== null && contentHash(text) === board.version) {
          await writeAtomic(masterPath(name), text);
          await onMasterWritten(name);
        }
      }
    }
    boards.set(name, board);
    if (board.records < RECORD_SCHEMA) {
      await migrateRecords(board);
    }
    if (board.open) {
      if (now() - board.open.lastCommitAt >= idleMs) {
        await closeOpenEntry(board, "idle");
        await writeState(board);
      } else {
        scheduleIdle(board);
      }
    }
    await gcBases(board, true);
    return board;
  };

  const archiveBranch = async (branch) => {
    await step("before-archive", { branch });
    try {
      await unlinkIfExists(branchFile(branch));
    } finally {
      releaseRef(branch.board, branch.base);
      countPending(branch.board, -1);
      if (branch.rawHash) {
        pendingExternal.get(branch.board)?.delete(branch.rawHash);
      }
    }
  };

  // Hook 0: validate, stamp, persist (the journal). The caller enqueues the commit. The base
  // is referenced before the branch is written, so a coalescing commit keeps it; whether it
  // still resolves is decided in the commit step.
  const ingest = async (name, input, watch = stopwatch(false)) => {
    const started = performance.now();
    segments(name);
    const author = parseAuthorKey(input.author);
    if (!author) {
      return { error: "invalid-author" };
    }
    const kind = input.kind ?? "json";
    if (kind !== "json" && kind !== "mermaid") {
      return { error: "invalid-kind" };
    }
    if (input.elements !== null || kind !== "mermaid") {
      if (!validateElements(input.elements)) {
        return { error: "invalid-elements" };
      }
    }
    if (!validateFiles(input.files)) {
      return { error: "invalid-files" };
    }
    if (input.base !== null && input.base !== undefined && typeof input.base !== "string") {
      return { error: "invalid-base" };
    }
    const receivedAt = now();
    // `writtenAgoMs` (a tab: time since its last edit) needs no clock shared with the writer.
    const ago = typeof input.writtenAgoMs === "number" && Number.isFinite(input.writtenAgoMs) && input.writtenAgoMs > 0 ? Math.min(input.writtenAgoMs, MAX_WRITTEN_AGO_MS) : 0;
    const writtenAt = typeof input.writtenAt === "number" && Number.isFinite(input.writtenAt) ? input.writtenAt : receivedAt - ago;
    const base = input.base ?? null;
    watch.add("validate", performance.now() - started);
    const branch = {
      schema: STATE_SCHEMA,
      id: sortableId(receivedAt),
      board: name,
      author: input.author,
      displayName: typeof input.displayName === "string" && input.displayName ? input.displayName.slice(0, 100) : author.name,
      base,
      writtenAt,
      receivedAt,
      kind,
      elements: input.elements ?? null,
      ...(input.appState !== undefined ? { appState: input.appState } : {}),
      ...(input.template !== undefined ? { template: { version: input.template.version, source: input.template.source } } : {}),
      ...(input.rawHash !== undefined ? { rawHash: input.rawHash } : {}),
      ...(input.ops !== undefined ? { ops: input.ops } : {}),
      ...(input.mermaid !== undefined ? { mermaid: input.mermaid } : {}),
      ...(Array.isArray(input.overwritten) && input.overwritten.length ? { overwritten: input.overwritten } : {}),
      ...(input.legacy !== undefined ? { legacy: input.legacy } : {}),
    };
    addRef(name, base);
    countPending(name, 1);
    try {
      await watch.run("journal", async () => {
        if (input.files !== undefined && input.files !== null) {
          branch.fileRefs = await storeFiles(name, input.files);
        }
        await writeAtomic(branchFile(branch), `${JSON.stringify(branch)}\n`, { sync: true });
      });
    } catch (error) {
      releaseRef(name, base);
      countPending(name, -1);
      throw error;
    }
    await step("after-ingest", { branch });
    return { branch, ingestedAt: performance.now() };
  };

  // Adopts a master file changed outside the commit step as an `external` branch based on the
  // last committed version (`init` for a board that existed before versions). Runs inside the
  // board's queue. Returns the master file as read (the commit compares against it, so a write
  // or delete landing later is never undone) and the adoption's commit result, if any.
  const syncExternal = async (board, current = null, { firstTouch = "init" } = {}) => {
    const disk = await diskState(board);
    if (disk.hash === board.version) {
      return { disk, result: null };
    }
    if (disk.hash === null) {
      // Board file deleted outside: history stays, the next commit starts a new board.
      await closeOpenEntry(board, "deleted");
      board.version = null;
      board.depth = null;
      board.chainBase = null;
      board.cache = null;
      board.masterSig = null;
      await writeState(board);
      return { disk, result: null };
    }
    if ((current?.rawHash && current.rawHash === disk.hash) || pendingExternal.get(board.name)?.has(disk.hash)) {
      return { disk, result: null };
    }
    const ingested = await ingestExternal(board, disk, board.version, board.version === null && !board.last ? firstTouch : "external");
    if (!ingested) {
      return { disk, result: null };
    }
    const { finish, ...result } = await commitBranch(board, ingested.branch, { diskAtStart: disk });
    await finish?.();
    void postCommit(board.name, result);
    return { disk, result };
  };

  // Journals a master file written outside the commit step as a branch: base is the version it
  // overwrote, write time is the file's mtime.
  const ingestExternal = async (board, disk, base, author = "external") => {
    let scene;
    try {
      scene = parseScene(disk.text);
    } catch {
      console.warn(`board ${board.name} changed on disk but isn't valid Excalidraw JSON; not adopted`);
      return null;
    }
    if (!validateElements(scene.elements) || !validateFiles(scene.files)) {
      console.warn(`board ${board.name} changed on disk with elements lacking ids; not adopted`);
      return null;
    }
    let writtenAt = now();
    try {
      writtenAt = (await fs.stat(masterPath(board.name))).mtimeMs;
    } catch {}
    const ingested = await ingest(board.name, {
      author,
      base,
      writtenAt,
      kind: "json",
      elements: scene.elements,
      appState: scene.appState,
      files: scene.files,
      template: scene,
      rawHash: disk.hash,
    });
    if (ingested.error) {
      return null;
    }
    rememberExternal(ingested.branch);
    return ingested;
  };

  // Queued behind the commit that is running now.
  const adoptRaced = async (board, disk, base) => {
    const ingested = await ingestExternal(board, disk, base);
    if (ingested) {
      void commitJob(board.name, Promise.resolve(ingested)).then(
        (result) => postCommit(board.name, result),
        (error) => console.warn(`adopting a direct write to ${board.name} failed: ${error.message}`),
      );
    }
  };

  const rememberExternal = (branch) => {
    if (branch.rawHash) {
      const set = pendingExternal.get(branch.board) ?? new Set();
      set.add(branch.rawHash);
      pendingExternal.set(branch.board, set);
    }
  };

  const legacyStale = (legacy, currentHash) => staleSaveCheck({ "if-match": legacy.ifMatch ?? undefined, "if-none-match": legacy.ifNoneMatch ?? undefined }, currentHash) !== null;

  // A write that left master as it was because every unit it changed lost: its losers fold into
  // the author's open entry, or go into a meta-only entry (`record: "none"`, no version of its
  // own; the history index skips it). The caller writes the state, which also marks the branch
  // committed for a replay.
  const keepUnchangedLosers = async (board, branch, base, overwritten) => {
    const committedAt = now();
    if (board.open && board.open.author === branch.author) {
      board.open = { ...board.open, overwritten: [...board.open.overwritten, ...overwritten], lastCommitAt: committedAt, lastBranchId: branch.id };
      board.last = { ...board.last, branchId: branch.id, writtenAt: branch.writtenAt, committedAt };
      return;
    }
    const stamp = Math.max(branch.receivedAt, board.lastEntryAt + 1);
    const entry = `${utcStamp(stamp)}-${authorKeySafe(branch.author)}`;
    const meta = {
      version: board.version,
      author: branch.author,
      displayName: branch.displayName,
      base,
      parents: board.version ? [board.version] : [],
      applied: [],
      overwritten,
      coalescedCount: 1,
      closedBy: "unchanged",
      openedAt: committedAt,
      lastCommitAt: committedAt,
      lastBranchId: branch.id,
      kind: branch.kind,
      record: "none",
      depth: null,
    };
    await writeAtomic(entryFiles(board.name, entry).meta, `${JSON.stringify(meta, null, 2)}\n`);
    board.lastEntryAt = stamp;
    board.last = { branchId: branch.id, author: branch.author, entry, previous: board.version, writtenAt: branch.writtenAt, committedAt };
  };

  // Hook 2: the commit step, the only writer of master. Order: history entry and state (the
  // commit point), master, then the branch file is removed. A replay is idempotent.
  const commitBranch = async (board, branch, { diskAtStart = null, watch = stopwatch(false) } = {}) => {
    if (!diskAtStart) {
      diskAtStart = (await watch.run("sync", () => syncExternal(board, branch))).disk;
    }
    await step("commit-start", { branch });
    if (board.last?.branchId === branch.id || board.mermaid?.branchId === branch.id || Object.values(board.mermaidSources ?? {}).some((record) => record?.branchId === branch.id)) {
      await watch.run("archive", () => archiveBranch(branch));
      return { status: "committed", version: board.version, applied: [], overwritten: [], unbound: [], replayed: true, masterChanged: false };
    }
    let base = branch.base;
    if (branch.legacy) {
      if (legacyStale(branch.legacy, board.version)) {
        await watch.run("archive", () => archiveBranch(branch));
        return { status: "stale", version: board.version };
      }
      base = board.version;
    } else if (board.version === null && base !== null && board.last) {
      // The board file was deleted since the writer read it: let the writer look again.
      await watch.run("archive", () => archiveBranch(branch));
      return { status: "unknown-base", version: null, base, reason: "board-deleted" };
    }
    const { masterScene, baseScene, branchFiles } = await watch.run("read", async () => {
      const master = board.version ? await versionScene(board, board.version) : null;
      if (board.version && !master) {
        throw new Error(`current version of ${board.name} is not readable`);
      }
      const baseFound = base === board.version ? master : await versionScene(board, base);
      return {
        masterScene: master?.scene ?? null,
        baseScene: baseFound ? baseFound.scene : base === null ? null : undefined,
        branchFiles: branch.files ?? (branch.fileRefs ? await loadFiles(board.name, branch.fileRefs) : undefined),
      };
    });
    if (baseScene === undefined) {
      await watch.run("archive", () => archiveBranch(branch));
      return { status: "unknown-base", version: board.version, base };
    }
    const fastForward = base === board.version;
    let sceneOut = masterScene;
    let version = board.version;
    let result = { applied: [], overwritten: [], unbound: [], meta: board.meta, fastForward: true };
    if (branch.elements !== null) {
      // A non-Mermaid write records its canvas edits in the dual origin of Mermaid shapes
      // (tools/mermaid-origin.mjs). Deterministic from the journal, so a replay matches. A direct
      // file write keeps its exact bytes (rawHash), so it isn't stamped.
      const branchElements = branch.kind === "json" && !branch.rawHash
        ? stampCanvasEdits({ base: baseScene?.elements ?? [], branch: branch.elements, author: branch.author, at: branch.writtenAt })
        : branch.elements;
      result = await watch.run("merge", () => mergeBoard({
        base: baseScene,
        master: masterScene,
        branch: { elements: branchElements, appState: branch.appState, files: branchFiles },
        branchWrittenAt: branch.writtenAt,
        branchAuthor: branch.author,
        masterMeta: board.meta,
      }));
      // A Mermaid write that replaced canvas edits (active `canvas`) reports them as overwritten,
      // for the units it did change (a newer canvas edit may still have won the merge).
      if (Array.isArray(branch.overwritten) && branch.overwritten.length) {
        const appliedUnits = new Set(result.applied.map((item) => item.unitId));
        const reported = new Set(result.overwritten.map((item) => item.unitId));
        const extra = branch.overwritten.filter((item) => appliedUnits.has(item.unitId) && !reported.has(item.unitId));
        if (extra.length) {
          result = { ...result, overwritten: [...result.overwritten, ...extra].sort((left, right) => (left.unitId < right.unitId ? -1 : left.unitId > right.unitId ? 1 : 0)) };
        }
      }
      // A fast-forward keeps the writer's own scene (a tab save keeps its exact text).
      sceneOut = fastForward
        ? sceneObject(branch.template ?? masterScene, {
            elements: branchElements,
            appState: branch.appState === undefined ? result.appState : branch.appState,
            files: branchFiles === undefined ? result.files : branchFiles,
          })
        : sceneObject(masterScene ?? baseScene, result);
      version = null;
    }
    let text = null;
    if (version === null) {
      if (fastForward && branch.rawHash && branch.rawHash === diskAtStart.hash) {
        // Adopting the file on disk: master keeps its bytes and their hash.
        version = branch.rawHash;
      } else {
        text = await watch.run("serialize", () => canonicalText(sceneOut));
        version = contentHash(text);
      }
    }
    const mermaidRecord = branch.kind === "mermaid" && branch.mermaid
      ? { source: branch.mermaid.source, hash: branch.mermaid.hash, ...(branch.mermaid.pendingId ? { pendingId: branch.mermaid.pendingId } : {}), author: branch.author, writtenAt: branch.writtenAt, appliedAt: now(), branchId: branch.id, version }
      : null;
    const sourceName = branch.mermaid?.name ?? "main";
    const mermaid = mermaidRecord && sourceName === "main" ? mermaidRecord : board.mermaid;
    const mermaidSources = mermaidRecord ? { ...(board.mermaidSources ?? {}), [sourceName]: mermaidRecord } : board.mermaidSources ?? {};

    if (version === board.version) {
      // Every unit of this write lost to a newer edit: master stays, and the losing content is
      // still kept in history (decision 2), never dropped with the journal file.
      const lost = result.overwritten.length > 0;
      if (lost) {
        await watch.run("history", () => keepUnchangedLosers(board, branch, base, result.overwritten));
      }
      if (mermaidRecord || lost) {
        board.mermaid = mermaid;
        board.mermaidSources = mermaidSources;
        await watch.run("state", () => writeState(board));
      }
      await watch.run("archive", () => archiveBranch(branch));
      return { status: "unchanged", version, author: branch.author, applied: [], overwritten: result.overwritten, unbound: [], fastForward, masterChanged: false, scene: masterScene };
    }

    const authorInfo = parseAuthorKey(branch.author);
    const human = authorInfo.kind === "human";
    const committedAt = now();
    const coalesce = Boolean(board.open && board.open.author === branch.author && human);
    const entry = coalesce ? board.open.entry : `${utcStamp(Math.max(branch.receivedAt, board.lastEntryAt + 1))}-${authorKeySafe(branch.author)}`;
    // History v2: the entry is a delta against the version it started from, or a full
    // checkpoint (a board's first entry, every `checkpointEvery` entries, an entry from before
    // v2, or when the parent version can't be read).
    let record = "checkpoint";
    let depth = 0;
    let parentScene = null;
    if (coalesce) {
      if (board.open.record === "delta" && Number.isInteger(board.open.depth) && board.open.parents?.[0]) {
        const parentVersion = board.open.parents[0];
        parentScene = board.chainBase?.version === parentVersion
          ? board.chainBase.scene
          : (await watch.run("history", () => versionScene(board, parentVersion, { keep: false })))?.scene ?? null;
        if (parentScene) {
          record = "delta";
          depth = board.open.depth;
        }
      }
    } else if (board.version && masterScene && Number.isInteger(board.depth) && board.depth + 1 < checkpointEvery) {
      record = "delta";
      depth = board.depth + 1;
      parentScene = masterScene;
    }
    const open = coalesce
      ? {
          ...board.open,
          version,
          base,
          applied: foldApplied(board.open.applied, result.applied),
          overwritten: [...board.open.overwritten, ...result.overwritten],
          coalescedCount: board.open.coalescedCount + 1,
          lastCommitAt: committedAt,
          lastBranchId: branch.id,
          record,
          depth,
        }
      : {
          entry,
          version,
          author: branch.author,
          displayName: branch.displayName,
          base,
          parents: board.version ? [board.version] : [],
          applied: foldApplied([], result.applied),
          overwritten: result.overwritten,
          coalescedCount: 1,
          openedAt: committedAt,
          lastCommitAt: committedAt,
          lastBranchId: branch.id,
          kind: branch.kind,
          record,
          depth,
        };
    await watch.run("history", async () => {
      // Independent files: written in parallel, each a round trip on a bind mount.
      const writes = [];
      if (coalesce) {
        // The open entry's current version is folded away: keep it as a base while another
        // queued branch references it (served copies are already in the base store).
        if ((pendingRefs.get(refKey(board.name, board.version)) ?? 0) > (branch.base === board.version ? 1 : 0)) {
          writes.push(saveBase(board, board.version, masterScene));
        }
      } else if (board.open) {
        writes.push(closeOpenEntry(board, human ? "author" : "agent-merge"));
      }
      const files = entryFiles(board.name, entry);
      const target = record === "delta" ? files.delta : files.checkpoint;
      const writeRecordFile = record === "delta"
        ? writeDelta(board.name, target, { version, parent: open.parents[0], depth, parentScene, scene: sceneOut })
        : writeCheckpoint(board.name, target, version, sceneOut, text);
      // An open entry that changes record kind (a pre-v2 entry, an unreadable parent) drops its
      // other file once the new one is written.
      writes.push(coalesce && board.open.record !== record
        ? writeRecordFile.then(() => Promise.all([files.delta, files.checkpoint, files.legacy].filter((file) => file !== target).map(unlinkIfExists)))
        : writeRecordFile);
      // A human entry stays open: its meta lives in the state until it closes.
      if (!human) {
        writes.push(writeAtomic(files.meta, `${JSON.stringify(entryMetaFile(open, authorInfo.kind === "init" ? "init" : "agent-write"), null, 2)}\n`));
      }
      await Promise.all(writes);
    });
    await step("mid-history", { branch, entry });

    const previous = board.version;
    const next = {
      ...board,
      version,
      meta: result.meta,
      last: { branchId: branch.id, author: branch.author, entry, previous, writtenAt: branch.writtenAt, committedAt },
      open: human ? open : null,
      mermaid,
      mermaidSources,
      lastEntryAt: coalesce ? board.lastEntryAt : Math.max(branch.receivedAt, board.lastEntryAt + 1),
      depth,
    };
    await watch.run("state", () => writeState(next));
    const index = await historyIndex(board);
    if (coalesce && index.get(previous) === entry) {
      index.delete(previous);
    }
    index.set(version, entry);
    const previousSig = board.masterSig;
    const chainBase = human && record === "delta" ? { version: open.parents[0], scene: parentScene } : null;
    Object.assign(board, next, { index, cache: { version, scene: sceneOut, text }, chainBase });
    remember(board, version, sceneOut);
    await step("after-history", { branch, entry });

    // The commit is durable here (state is the commit point; a crash before master is written
    // rolls master forward from the history record on start). The answer goes out now; the
    // board's queue still waits for master and the journal file (`finish`).
    const writeMaster = version !== diskAtStart.hash;
    board.masterPending = writeMaster;
    const finish = async () => {
      await watch.run("master", () => retryIo(board.name, branch, async () => {
        // Re-check master by its signature; read it only if it changed during the commit.
        const signature = await masterSignature(board.name);
        const disk = signature === diskAtStart.signature && diskAtStart.signature !== undefined ? diskAtStart : { ...(await readMasterFile(board.name)), signature };
        if (writeMaster && disk.hash !== version && disk.hash !== diskAtStart.hash && disk.hash !== null) {
          // A direct write landed while this commit ran. Journal it as an external branch on
          // the version it overwrote (queued right after this commit), then write master.
          if (previous) {
            await saveBase(board, previous, masterScene);
          }
          await adoptRaced(board, disk, previous);
        }
        if (writeMaster && disk.hash !== version) {
          const written = await writeAtomic(masterPath(board.name), text ?? canonicalText(sceneOut), { stat: true });
          board.masterSig = `${written.ino}:${written.mtimeMs}:${written.size}`;
          await onMasterWritten(board.name, written);
        } else if (disk.hash === version) {
          board.masterSig = disk.signature ?? previousSig;
        }
      }));
      board.masterPending = false;
      await step("after-master", { branch, entry });
      await watch.run("archive", () => archiveBranch(branch));
      if (board.open) {
        scheduleIdle(board);
      }
      await dropRedundantBases(board);
      await gcBases(board);
    };
    return {
      status: "committed",
      version,
      previous,
      entry,
      author: branch.author,
      fastForward,
      applied: result.applied,
      overwritten: result.overwritten,
      unbound: result.unbound,
      masterChanged: writeMaster,
      scene: sceneOut,
      finish,
    };
  };
  const ensureLoaded = (name) => (boards.has(name) ? Promise.resolve(boards.get(name)) : enqueue(name, () => loadBoard(name)));

  const postCommit = (name, result, log = null) => {
    // An unchanged write that lost units is still announced (the banner lists its losers).
    const announce = result?.status === "committed" || (result?.status === "unchanged" && result.overwritten?.length > 0);
    if (!announce || result.replayed) {
      return Promise.resolve();
    }
    let started = performance.now();
    const { scene: _scene, finished, ...event } = result;
    // SSE, export and rules see master on disk, so they run once it is written.
    return Promise.resolve(finished).then(() => {
      started = performance.now();
      return onCommitted({ name, ...event });
    }).catch((error) => {
      console.warn(`post-commit hook failed for ${name}: ${error.message}`);
    }).finally(() => {
      if (log) {
        log.stages.post = performance.now() - started;
      }
    });
  };

  // The commit job for an ingested (or ingesting) branch. A commit that fails on an I/O error
  // stays in the journal and is retried with backoff; this board's queue waits, others go on.
  // After close() the branch stays in the journal and is replayed on the next start.
  const sleepRetry = (wait) => new Promise((resolve) => {
    const sleeper = { resolve };
    sleeper.timer = setTimeout(() => {
      sleepers.delete(sleeper);
      resolve();
    }, wait);
    sleepers.add(sleeper);
  });

  // Master must reach the disk before the board's next commit; an I/O error is retried with
  // the commit backoff (and shown in status) instead of letting the queue run on.
  const retryIo = async (name, branch, fn) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await fn();
        failures.delete(name);
        return value;
      } catch (error) {
        if (!isRetryable(error) || closed) {
          throw error;
        }
        const wait = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];
        failures.set(name, { branchId: branch.id, attempts: attempt + 1, error: `${error.code}: ${error.message}`, retrying: true, nextRetryMs: wait, since: failures.get(name)?.since ?? now(), stage: "master" });
        console.warn(`writing master of ${name} failed (${error.code}: ${error.message}); retry ${attempt + 1} in ${wait} ms`);
        await sleepRetry(wait);
      }
    }
  };

  const runCommitJob = async (name, ingesting, watch) => {
    const jobStart = performance.now();
    const ingested = await ingesting;
    if (ingested.error) {
      return { status: "invalid", error: ingested.error };
    }
    if (ingested.ingestedAt) {
      watch.add("queue", Math.max(0, jobStart - ingested.ingestedAt));
    }
    const { branch } = ingested;
    for (let attempt = 0; ; attempt++) {
      if (closed) {
        return { status: "queued", branchId: branch.id };
      }
      try {
        const board = await loadBoard(name);
        const result = { ...(await commitBranch(board, branch, { watch })), branchId: branch.id };
        if (failures.delete(name)) {
          console.warn(`commit for ${name} succeeded after ${attempt} retr${attempt === 1 ? "y" : "ies"}`);
        }
        return result;
      } catch (error) {
        if (!isRetryable(error)) {
          failures.set(name, { branchId: branch.id, attempts: attempt + 1, error: error.message, retrying: false, since: failures.get(name)?.since ?? now() });
          throw error;
        }
        // Reload from the durable state on the next attempt, as a replay would.
        boards.delete(name);
        const wait = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];
        failures.set(name, { branchId: branch.id, attempts: attempt + 1, error: `${error.code}: ${error.message}`, retrying: true, nextRetryMs: wait, since: failures.get(name)?.since ?? now() });
        console.warn(`commit for ${name} failed (${error.code}: ${error.message}); retry ${attempt + 1} in ${wait} ms, the write stays in the journal`);
        await new Promise((resolve) => {
          const sleeper = { resolve };
          sleeper.timer = setTimeout(() => {
            sleepers.delete(sleeper);
            resolve();
          }, wait);
          sleepers.add(sleeper);
        });
      }
    }
  };

  // Answers as soon as master is written; the board's queue still waits for the journal file
  // removal (`finish`) before the next commit.
  const commitJob = (name, ingesting, watch = stopwatch(false)) => {
    let resolveAnswer;
    let rejectAnswer;
    const answer = new Promise((resolve, reject) => {
      resolveAnswer = resolve;
      rejectAnswer = reject;
    });
    void enqueue(name, async () => {
      let outcome;
      try {
        outcome = await runCommitJob(name, ingesting, watch);
      } catch (error) {
        rejectAnswer(error);
        return;
      }
      const { finish, ...result } = outcome;
      let markFinished;
      result.finished = new Promise((resolve) => {
        markFinished = resolve;
      });
      resolveAnswer(result);
      if (finish) {
        await finish().catch((error) => console.warn(`writing master after a commit to ${name} failed (${error.message}); it is rolled forward on the next start`));
      }
      markFinished();
    });
    return answer;
  };

  // Journal replay: re-queue every unarchived branch, oldest first by writtenAt.
  let replayed = Promise.resolve();
  const replay = async () => {
    const found = [];
    const walk = async (dir) => {
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".tmp")) {
          await unlinkIfExists(full);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          try {
            const branch = await readJson(full);
            if (branch?.id && typeof branch.board === "string" && branchFile(branch) === full) {
              found.push(branch);
            }
          } catch {
            console.warn(`unreadable branch file ${path.relative(root, full)}; left in place`);
          }
        }
      }
    };
    await walk(path.join(xcld, "branches"));
    found.sort((left, right) => left.writtenAt - right.writtenAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const runs = [];
    for (const branch of found) {
      addRef(branch.board, branch.base);
      countPending(branch.board, 1);
      rememberExternal(branch);
      runs.push(commitJob(branch.board, Promise.resolve({ branch })).then(
        (result) => postCommit(branch.board, result),
        (error) => console.warn(`replaying branch ${branch.id} for ${branch.board} failed: ${error.message}`),
      ));
    }
    replayed = Promise.all(runs);
  };

  // Resolves once the journal is queued (not committed), so new submits line up behind it.
  // With a separate state dir, versions data already under boards/.xcld is copied over once.
  const migrateStateDir = async () => {
    if (xcld === defaultStateDir) {
      return;
    }
    const exists = (dir) => fs.stat(dir).then((stat) => stat.isDirectory(), () => false);
    if (await exists(path.join(xcld, "state")) || !(await exists(path.join(defaultStateDir, "state")))) {
      return;
    }
    for (const folder of ["files", "bases", "history", "state", "branches"]) {
      if (await exists(path.join(defaultStateDir, folder))) {
        await fs.cp(path.join(defaultStateDir, folder), path.join(xcld, folder), { recursive: true, force: false, errorOnExist: false });
      }
    }
    console.warn(`copied versions data from ${path.relative(root, defaultStateDir) || ".xcld"} to ${xcld}; the old copy is left in place`);
  };

  const start = () => {
    started ??= migrateStateDir().then(replay);
    return started;
  };

  /**
   * Submit a writer's branch: `{ author, displayName?, base, writtenAt? | writtenAgoMs?, kind?: "json" |
   * "mermaid", elements, appState?, files?, template?, ops?, mermaid?: { source, hash } }`.
   * Resolves after the commit with `{ status, version, applied, overwritten, unbound,
   * fastForward, scene, branchId, post, timings? }`; status is "committed", "unchanged",
   * "unknown-base", "invalid", "stale" (legacy If-Match: *), or "queued" after close().
   * `post` resolves when the post-commit hook (SSE, export) has run. `onIngested(branchId)`
   * fires once the branch is in the journal, i.e. it will not be dropped.
   */
  const submitBranch = async (name, input, { onIngested, source = "api", receiveMs, stages } = {}) => {
    await start();
    const watch = stopwatch(timing);
    if (receiveMs !== undefined) {
      watch.add("receive", receiveMs);
    }
    // Work the caller did before submitting (a Mermaid write's parse and apply).
    for (const [stage, ms] of Object.entries(stages ?? {})) {
      watch.add(stage, ms);
    }
    const ingesting = ingest(name, input, watch).then((ingested) => {
      if (ingested.branch) {
        onIngested?.(ingested.branch.id);
      }
      return ingested;
    });
    const result = await commitJob(name, ingesting, watch);
    let log = null;
    if (watch.stages && result.status !== "invalid") {
      log = {
        board: name,
        branchId: result.branchId,
        author: input.author,
        writer: parseAuthorKey(input.author)?.kind ?? "unknown",
        kind: input.kind ?? "json",
        source,
        elements: Array.isArray(input.elements) ? input.elements.length : 0,
        status: result.status,
        at: now(),
        stages: watch.stages,
      };
      timingLog.push(log);
      if (timingLog.length > TIMING_LOG_LIMIT) {
        timingLog.splice(0, timingLog.length - TIMING_LOG_LIMIT);
      }
    }
    return { ...result, post: postCommit(name, result, log), ...(log ? { timings: log } : {}) };
  };

  const readVersion = (name, version) => enqueue(name, async () => {
    const board = await loadBoard(name);
    const found = await versionScene(board, version);
    if (!found) {
      return null;
    }
    await pin(board, version, found.scene);
    return { version, text: found.text ?? canonicalText(found.scene), scene: found.scene };
  });

  const readMaster = async (name) => {
    await ensureLoaded(name);
    const cached = await cachedMaster(name);
    const disk = cached ? { text: cached.text, hash: cached.version } : await readMasterFile(name);
    if (disk.hash === null) {
      return null;
    }
    await noteServed(name, disk.hash, disk.text);
    return { version: disk.hash, text: disk.text, scene: parseScene(disk.text) };
  };

  // A version handed to a reader may come back as a base. A version that is a closed history
  // entry stays resolvable anyway; any other (the open entry's, or one not adopted yet) is
  // copied to the base store, which keeps it `baseTtlMs` after the last hand-out.
  const needsPin = async (board, version) => {
    const entry = (await historyIndex(board)).get(version);
    return !(entry && entry !== board.open?.entry);
  };
  const pin = async (board, version, scene) => {
    if (version && scene && await needsPin(board, version)) {
      await saveBase(board, version, scene);
    }
  };

  // GET hands out the master text with its hash as the ETag.
  const noteServed = async (name, version, text) => {
    let board = await ensureLoaded(name);
    if (board.version === null && !board.last && !closed) {
      // First touch of a board that existed before versions: snapshot it as `init`.
      board = await enqueue(name, async () => {
        const current = await loadBoard(name);
        if (current.version === null && !current.last) {
          await syncExternal(current);
        }
        return current;
      });
    }
    if (version && contentHash(text) === version && await needsPin(board, version)) {
      await saveBase(board, version, board.cache?.version === version ? board.cache.scene : parseScene(text));
    }
  };

  // Master's exact text from memory when the file still is what the last commit wrote: GET
  // then needs no read (and can't catch a half-replaced file).
  const cachedMaster = async (name) => {
    const board = boards.get(name);
    if (!board?.cache?.text || board.cache.version !== board.version) {
      return null;
    }
    // Committed, master write still on its way: the committed text is the answer.
    if (board.masterPending) {
      return { version: board.version, text: board.cache.text };
    }
    if (!board.masterSig) {
      return null;
    }
    return (await masterSignature(name)) === board.masterSig ? { version: board.version, text: board.cache.text } : null;
  };

  // Ctrl+S: closes the open entry. `pin` (a label) also makes the current version's entry a full
  // checkpoint, so a pinned version never depends on deltas (snapshots as pinned versions).
  // With `author`, only that author's open entry is closed (a tab closes its own turn).
  const checkpoint = (name, { pin = null, author = null } = {}) => enqueue(name, async () => {
    const board = await loadBoard(name);
    const own = !author || board.open?.author === author;
    const entry = own ? board.open?.entry ?? null : null;
    const closedEntry = own ? await closeOpenEntry(board, "checkpoint") : false;
    const pinned = pin && board.version ? await pinHead(board, String(pin)) : null;
    if (closedEntry || pinned) {
      await writeState(board);
    }
    await dropRedundantBases(board);
    return { closed: closedEntry, entry, version: board.version, ...(pinned ? { pinned } : {}) };
  });

  // Rewrites the (closed) entry holding the current version as a checkpoint, if it is a delta,
  // and labels its meta. Order: checkpoint, meta, then the delta file is removed; both files
  // rebuild the same version, so a crash in between is harmless.
  const pinHead = async (board, label) => {
    const entry = (await historyIndex(board)).get(board.version);
    if (!entry || entry === board.open?.entry) {
      return null;
    }
    const files = entryFiles(board.name, entry);
    const meta = await readJson(files.meta);
    if (!meta || meta.version !== board.version) {
      return null;
    }
    const wasDelta = meta.record === "delta";
    if (wasDelta) {
      const found = await versionScene(board, board.version);
      if (!found) {
        throw new Error(`current version of ${board.name} is not readable`);
      }
      await writeCheckpoint(board.name, files.checkpoint, board.version, found.scene, found.text);
    }
    const pinnedAt = now();
    await writeAtomic(files.meta, `${JSON.stringify({ ...meta, record: wasDelta ? "checkpoint" : meta.record ?? "checkpoint", depth: 0, pinned: label, pinnedAt }, null, 2)}\n`);
    if (wasDelta) {
      await unlinkIfExists(files.delta);
    }
    board.depth = 0;
    return { entry, label, pinnedAt };
  };

  // The watcher calls this once a changed master file has settled.
  const adoptExternal = async (name) => {
    await start();
    // A board first seen through a change: the content is that change, not the original.
    return enqueue(name, async () => (closed ? null : (await syncExternal(await loadBoard(name), null, { firstTouch: "external" })).result));
  };

  const readState = (name) => enqueue(name, async () => {
    const board = await loadBoard(name);
    return {
      version: board.version,
      masterMeta: board.meta,
      last: board.last,
      open: board.open,
      mermaid: board.mermaid,
      mermaidSources: board.mermaidSources ?? {},
      depth: board.depth,
    };
  });

  // The last applied Mermaid. A loaded board answers from memory, without waiting for its queue.
  const readMermaid = async (name) => (boards.has(name) ? boards.get(name).mermaid ?? null : (await readState(name)).mermaid);
  // Every named source's last applied Mermaid (`main` included), the same way.
  const readMermaidSources = async (name) => (boards.has(name) ? boards.get(name).mermaidSources ?? {} : (await readState(name)).mermaidSources ?? {});

  // For /api/status: queued writes per board and commits waiting on a retry.
  const status = () => ({
    ok: failures.size === 0,
    pending: Object.fromEntries(pendingCount),
    failing: Object.fromEntries(failures),
  });

  const timings = ({ clear = false } = {}) => {
    const copy = timingLog.slice();
    if (clear) {
      timingLog.length = 0;
    }
    return copy;
  };

  const whenIdle = async () => {
    await start();
    await replayed;
    while (queues.size) {
      await Promise.all([...queues.values()]);
    }
  };

  // Stops timers, retries and new commits (their branches stay in the journal); resolves once
  // the commit in flight, if any, has finished.
  const close = async () => {
    closed = true;
    for (const sleeper of sleepers) {
      clearTimeout(sleeper.timer);
      sleeper.resolve();
    }
    sleepers.clear();
    for (const name of [...idleTimers.keys()]) {
      clearIdle(name);
    }
    while (queues.size) {
      await Promise.all([...queues.values()]);
    }
  };

  return { start, submitBranch, readVersion, readMaster, cachedMaster, readState, readMermaid, readMermaidSources, noteServed, checkpoint, adoptExternal, status, timings, timingEnabled: timing, whenIdle, close, parseAuthorKey, stateDir: xcld };
}
