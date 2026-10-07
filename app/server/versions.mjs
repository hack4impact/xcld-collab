// Versions and merge, server side: branch store (journal), per-board FIFO queue, the commit
// step (the only writer of master), coalesced history, a base store, journal replay and
// external-write adoption. Rules and layout: docs/DESIGN.md#versions-storage-and-commit-pipeline.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { splitBoardPath } from "../../tools/board-path.mjs";
import { mergeBoard } from "../../tools/merge.mjs";

export const IDLE_CLOSE_MS = 3 * 60 * 1000;
export const BASE_TTL_MS = 24 * 60 * 60 * 1000;
const GC_INTERVAL_MS = 10 * 60 * 1000;
const STATE_SCHEMA = 1;

export const contentHash = (content) => createHash("sha256").update(content).digest("hex");

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

// Author keys (lead, 2026-10-06). Display names are not unique; the suffix after `#` is.
const AUTHOR_FORMS = [
  { kind: "human", pattern: /^human:([^\u0000-\u001f]{1,100})#([A-Za-z0-9_-]{1,64})$/ },
  { kind: "agent", pattern: /^agent:([^\u0000-\u001f]{1,100})#([A-Za-z0-9_.-]{1,64})$/ },
  { kind: "cli", pattern: /^cli:([^\u0000-\u001f]{1,100})$/ },
  { kind: "external", pattern: /^external$/ },
];

export const parseAuthorKey = (key) => {
  if (typeof key !== "string") {
    return null;
  }
  for (const { kind, pattern } of AUTHOR_FORMS) {
    const match = pattern.exec(key);
    if (match) {
      return { kind, name: kind === "external" ? "external" : match[1] };
    }
  }
  return null;
};

export const authorKeySafe = (key) => String(key).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[_.]+|_+$/g, "").slice(0, 64) || "author";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let idCounter = 0;
// Time-sortable id: 10 chars of milliseconds, a per-process counter (keeps arrival order
// within one millisecond), then randomness.
const sortableId = (time) => {
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
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
};

export const writeFileAtomic = async (target, content, { sync = false } = {}) => {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, "w");
  try {
    await handle.writeFile(content, "utf8");
    if (sync) {
      await handle.sync();
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

const serializeScene = (template, { elements, appState, files }) => `${JSON.stringify({
  type: "excalidraw",
  version: typeof template?.version === "number" ? template.version : 2,
  source: typeof template?.source === "string" ? template.source : "xcld-collab",
  elements,
  appState: appState ?? {},
  files: files ?? {},
}, null, 2)}\n`;

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

/**
 * @param {object} options
 * @param {string} options.boardsDir
 * @param {() => number} [options.now]
 * @param {number} [options.idleMs] Close an open human history entry after this much idle time.
 * @param {number} [options.baseTtlMs] Keep a served or pinned base this long after it was last served.
 * @param {(name: string) => Promise<void> | void} [options.onMasterWritten] After the commit step writes master.
 * @param {(event: object) => Promise<void> | void} [options.onCommitted] Post-commit hook (Hook 3), run after the commit, not awaited by the queue.
 * @param {{ onStep?: (step: string, info: object) => Promise<void> | void }} [options.testHooks]
 */
export function createVersionStore({
  boardsDir,
  now = Date.now,
  idleMs = IDLE_CLOSE_MS,
  baseTtlMs = BASE_TTL_MS,
  onMasterWritten = () => {},
  onCommitted = () => {},
  testHooks = {},
}) {
  const root = path.resolve(boardsDir);
  const xcld = path.join(root, ".xcld");
  const boards = new Map();
  const queues = new Map();
  const pendingRefs = new Map();
  const pendingExternal = new Map();
  const idleTimers = new Map();
  const lastGc = new Map();
  let closed = false;
  let started = null;

  // Throws (statusCode 400) on an invalid board path, so no name escapes boardsDir.
  const segments = (name) => splitBoardPath(name);
  const masterPath = (name) => path.join(root, ...segments(name).slice(0, -1), `${segments(name).at(-1)}.excalidraw`);
  const branchDir = (name) => path.join(xcld, "branches", ...segments(name));
  const historyDir = (name) => path.join(xcld, "history", ...segments(name));
  const basePath = (name, version) => path.join(xcld, "bases", ...segments(name), `${version}.excalidraw`);
  const statePath = (name) => path.join(xcld, "state", ...segments(name).slice(0, -1), `${segments(name).at(-1)}.json`);
  const step = async (name, info) => {
    await testHooks.onStep?.(name, info);
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
    const text = await readText(masterPath(name));
    return text === null ? { text: null, hash: null } : { text, hash: contentHash(text) };
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
      lastEntryAt: board.lastEntryAt,
    };
    await writeFileAtomic(statePath(board.name), `${JSON.stringify(state)}\n`, { sync: true });
  };

  const entryFiles = (name, entry) => ({
    content: path.join(historyDir(name), `${entry}.excalidraw`),
    meta: path.join(historyDir(name), `${entry}.meta.json`),
  });

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
          if (meta?.version) {
            index.set(meta.version, file.slice(0, -".meta.json".length));
          }
        } catch {}
      }
      board.index = index;
    }
    return board.index;
  };

  // Resolves a version id (the sha256 of master's bytes, the ETag) to its text: current
  // master, then the base store, then history. Content is verified against the id.
  const versionText = async (board, version) => {
    if (!version) {
      return null;
    }
    const candidates = [];
    if (version === board.version) {
      candidates.push(masterPath(board.name));
    }
    candidates.push(basePath(board.name, version));
    const entry = (await historyIndex(board)).get(version);
    if (entry) {
      candidates.push(entryFiles(board.name, entry).content);
    }
    if (board.last?.entry) {
      candidates.push(entryFiles(board.name, board.last.entry).content);
    }
    for (const file of candidates) {
      const text = await readText(file);
      if (text !== null && contentHash(text) === version) {
        return text;
      }
    }
    return null;
  };

  const saveBase = async (board, version, text) => {
    const file = basePath(board.name, version);
    const stamp = new Date(now());
    try {
      await fs.utimes(file, stamp, stamp);
      return;
    } catch {}
    await writeFileAtomic(file, text);
    await fs.utimes(file, stamp, stamp).catch(() => {});
  };

  const gcBases = async (board, force = false) => {
    if (!force && now() - (lastGc.get(board.name) ?? 0) < GC_INTERVAL_MS) {
      return;
    }
    lastGc.set(board.name, now());
    let files = [];
    try {
      files = await fs.readdir(path.dirname(basePath(board.name, "x")));
    } catch {
      return;
    }
    for (const file of files.filter((item) => item.endsWith(".excalidraw"))) {
      const version = file.slice(0, -".excalidraw".length);
      if (version === board.version || isReferenced(board.name, version)) {
        continue;
      }
      try {
        const stat = await fs.stat(basePath(board.name, version));
        if (now() - stat.mtimeMs > baseTtlMs) {
          await unlinkIfExists(basePath(board.name, version));
        }
      } catch {}
    }
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
        if (!closed && board.open && now() - board.open.lastCommitAt >= idleMs) {
          await closeOpenEntry(board, "idle");
          await writeState(board);
        } else {
          scheduleIdle(board);
        }
      }).catch((error) => console.warn(`closing idle history entry for ${board.name} failed: ${error.message}`));
    }, wait);
    timer.unref?.();
    idleTimers.set(board.name, timer);
  };

  const entryMetaFile = (board, open, closedBy) => ({
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
  });

  // Rewrites the open entry's meta as closed; the caller writes the state afterwards.
  const closeOpenEntry = async (board, reason) => {
    if (!board.open) {
      return false;
    }
    await writeFileAtomic(entryFiles(board.name, board.open.entry).meta, `${JSON.stringify(entryMetaFile(board, board.open, reason), null, 2)}\n`);
    board.open = null;
    clearIdle(board.name);
    return true;
  };

  const loadBoard = async (name) => {
    let board = boards.get(name);
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
      lastEntryAt: state?.lastEntryAt ?? 0,
      index: null,
    };
    // Crash between the state write (the commit point) and the master write: the committed
    // branch's file is still in the journal, so roll master forward. Once the branch file is
    // gone the commit finished, and a different master is an external write.
    if (board.version && board.last?.branchId) {
      const disk = await readMasterFile(name);
      const pending = await fs.stat(branchFile({ board: name, author: board.last.author, id: board.last.branchId })).then(() => true, () => false);
      if (disk.hash !== board.version && pending) {
        const text = await versionText(board, board.version);
        if (text !== null) {
          await writeFileAtomic(masterPath(name), text);
          await onMasterWritten(name);
        }
      }
    }
    boards.set(name, board);
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

  const branchFile = (branch) => path.join(branchDir(branch.board), `${authorKeySafe(branch.author)}.${branch.id}.json`);

  const archiveBranch = async (branch) => {
    await step("before-archive", { branch });
    await unlinkIfExists(branchFile(branch));
    releaseRef(branch.board, branch.base);
    if (branch.author === "external" && branch.rawHash) {
      pendingExternal.get(branch.board)?.delete(branch.rawHash);
    }
  };

  // Hook 0: validate, stamp, persist (the journal). The caller enqueues the commit. The base
  // is referenced before the branch is written, so a coalescing commit keeps it; whether it
  // still resolves is decided in the commit step.
  const ingest = async (name, input) => {
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
    if (input.base !== null && input.base !== undefined && typeof input.base !== "string") {
      return { error: "invalid-base" };
    }
    const receivedAt = now();
    const writtenAt = typeof input.writtenAt === "number" && Number.isFinite(input.writtenAt) ? input.writtenAt : receivedAt;
    const base = input.base ?? null;
    const branch = {
      schema: STATE_SCHEMA,
      id: sortableId(receivedAt),
      board: name,
      author: input.author,
      displayName: typeof input.displayName === "string" && input.displayName ? input.displayName : author.name,
      base,
      writtenAt,
      receivedAt,
      kind,
      elements: input.elements ?? null,
      ...(input.appState !== undefined ? { appState: input.appState } : {}),
      ...(input.files !== undefined ? { files: input.files } : {}),
      ...(input.raw !== undefined ? { raw: input.raw, rawHash: contentHash(input.raw) } : {}),
      ...(input.ops !== undefined ? { ops: input.ops } : {}),
      ...(input.mermaid !== undefined ? { mermaid: input.mermaid } : {}),
      ...(input.legacy !== undefined ? { legacy: input.legacy } : {}),
    };
    addRef(name, base);
    try {
      await writeFileAtomic(branchFile(branch), `${JSON.stringify(branch)}\n`, { sync: true });
    } catch (error) {
      releaseRef(name, base);
      throw error;
    }
    await step("after-ingest", { branch });
    return { branch };
  };

  // Adopts a master file changed outside the commit step as an `external` branch based on the
  // last committed version. Runs inside the board's queue. Returns the master file as read
  // (the commit compares against it, so a write or delete landing later is never undone)
  // and the adoption's commit result, if any.
  const syncExternal = async (board, current = null) => {
    const disk = await readMasterFile(board.name);
    if (disk.hash === board.version) {
      return { disk, result: null };
    }
    if (disk.hash === null) {
      // Board file deleted outside: history stays, the next commit starts a new board.
      await closeOpenEntry(board, "deleted");
      board.version = null;
      await writeState(board);
      return { disk, result: null };
    }
    if ((current?.author === "external" && current.rawHash === disk.hash) || pendingExternal.get(board.name)?.has(disk.hash)) {
      return { disk, result: null };
    }
    const ingested = await ingestExternal(board, disk, board.version);
    if (!ingested) {
      return { disk, result: null };
    }
    const result = await commitBranch(board, ingested.branch, { diskAtStart: disk });
    void postCommit(board.name, result);
    return { disk, result };
  };
  // Journals a master file written outside the commit step as an `external` branch: base is
  // the version it overwrote, write time is the file's mtime.
  const ingestExternal = async (board, disk, base) => {
    let scene;
    try {
      scene = parseScene(disk.text);
    } catch {
      console.warn(`board ${board.name} changed on disk but isn't valid Excalidraw JSON; not adopted`);
      return null;
    }
    if (!validateElements(scene.elements)) {
      console.warn(`board ${board.name} changed on disk with elements lacking ids; not adopted`);
      return null;
    }
    let writtenAt = now();
    try {
      writtenAt = (await fs.stat(masterPath(board.name))).mtimeMs;
    } catch {}
    const ingested = await ingest(board.name, {
      author: "external",
      base,
      writtenAt,
      kind: "json",
      elements: scene.elements,
      appState: scene.appState,
      files: scene.files,
      raw: disk.text,
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
    if (branch.author === "external" && branch.rawHash) {
      const set = pendingExternal.get(branch.board) ?? new Set();
      set.add(branch.rawHash);
      pendingExternal.set(branch.board, set);
    }
  };

  const legacyStale = (legacy, currentHash) => staleSaveCheck({ "if-match": legacy.ifMatch ?? undefined, "if-none-match": legacy.ifNoneMatch ?? undefined }, currentHash) !== null;


  // Hook 2: the commit step, the only writer of master. Order: history entry and state (the
  // commit point), master, then the branch file is removed. A replay is idempotent.
  const commitBranch = async (board, branch, { diskAtStart = null } = {}) => {
    diskAtStart ??= (await syncExternal(board, branch)).disk;
    await step("commit-start", { branch });
    if (board.last?.branchId === branch.id || board.mermaid?.branchId === branch.id) {
      await archiveBranch(branch);
      return { status: "committed", version: board.version, applied: [], overwritten: [], unbound: [], replayed: true, masterChanged: false };
    }
    let base = branch.base;
    if (branch.legacy) {
      if (legacyStale(branch.legacy, board.version)) {
        await archiveBranch(branch);
        return { status: "stale", version: board.version };
      }
      base = board.version;
    }
    const masterText = board.version ? await versionText(board, board.version) : null;
    if (board.version && masterText === null) {
      throw new Error(`current version of ${board.name} is not readable`);
    }
    const masterScene = masterText === null ? null : parseScene(masterText);
    const baseText = base === board.version ? masterText : await versionText(board, base);
    if (base !== null && baseText === null) {
      await archiveBranch(branch);
      return { status: "unknown-base", version: board.version, base };
    }
    const baseScene = baseText === null ? null : parseScene(baseText);

    let text = masterText;
    let result = { elements: masterScene?.elements ?? [], applied: [], overwritten: [], unbound: [], meta: board.meta, fastForward: true };
    if (branch.elements !== null) {
      const branchScene = { elements: branch.elements, appState: branch.appState, files: branch.files };
      result = mergeBoard({
        base: baseScene,
        master: masterScene,
        branch: branchScene,
        branchWrittenAt: branch.writtenAt,
        branchAuthor: branch.author,
        masterMeta: board.meta,
      });
      // A fast-forward keeps the writer's exact bytes when it sent them (tab saves, files).
      text = base === board.version && typeof branch.raw === "string"
        ? branch.raw
        : serializeScene(masterScene ?? baseScene, result);
    }
    const version = text === null ? null : contentHash(text);
    const mermaid = branch.kind === "mermaid" && branch.mermaid
      ? { ...branch.mermaid, author: branch.author, writtenAt: branch.writtenAt, appliedAt: now(), branchId: branch.id, version }
      : board.mermaid;

    if (version === board.version) {
      if (mermaid !== board.mermaid) {
        board.mermaid = mermaid;
        await writeState(board);
      }
      await archiveBranch(branch);
      return { status: "unchanged", version, applied: [], overwritten: result.overwritten, unbound: [], masterChanged: false };
    }

    const authorInfo = parseAuthorKey(branch.author);
    const committedAt = now();
    const coalesce = Boolean(board.open && board.open.author === branch.author && authorInfo.kind === "human");
    if (coalesce) {
      // The open entry's current version is folded away: keep it as a base while another
      // queued branch references it (served copies are already in the base store).
      if ((pendingRefs.get(refKey(board.name, board.version)) ?? 0) > (branch.base === board.version ? 1 : 0)) {
        await saveBase(board, board.version, masterText);
      }
    } else if (board.open) {
      await closeOpenEntry(board, authorInfo.kind === "human" ? "author" : "agent-merge");
    }
    const entry = coalesce ? board.open.entry : `${utcStamp(Math.max(branch.receivedAt, board.lastEntryAt + 1))}-${authorKeySafe(branch.author)}`;
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
        };
    const files = entryFiles(board.name, entry);
    await writeFileAtomic(files.content, text);
    await writeFileAtomic(files.meta, `${JSON.stringify(entryMetaFile(board, open, authorInfo.kind === "human" ? null : "agent-write"), null, 2)}\n`);
    await step("mid-history", { branch, entry });

    const previous = board.version;
    const next = {
      ...board,
      version,
      meta: result.meta,
      last: { branchId: branch.id, author: branch.author, entry, previous, writtenAt: branch.writtenAt, committedAt },
      open: authorInfo.kind === "human" ? open : null,
      mermaid,
      lastEntryAt: coalesce ? board.lastEntryAt : Math.max(branch.receivedAt, board.lastEntryAt + 1),
    };
    await writeState(next);
    const index = await historyIndex(board);
    if (coalesce && index.get(previous) === entry) {
      index.delete(previous);
    }
    index.set(version, entry);
    Object.assign(board, next, { index });
    await step("after-history", { branch, entry });

    const disk = await readMasterFile(board.name);
    // Master already holds this version when the commit adopted the file itself.
    const writeMaster = version !== diskAtStart.hash && disk.hash !== version;
    if (writeMaster && disk.hash !== diskAtStart.hash && disk.hash !== null) {
      // A direct write landed while this commit ran. Journal it as an external branch on the
      // version it overwrote (queued right after this commit), then write master.
      if (previous) {
        await saveBase(board, previous, masterText);
      }
      await adoptRaced(board, disk, previous);
    }
    if (writeMaster) {
      await writeFileAtomic(masterPath(board.name), text);
      await onMasterWritten(board.name);
    }
    const masterChanged = writeMaster;
    await step("after-master", { branch, entry });
    await archiveBranch(branch);
    if (board.open) {
      scheduleIdle(board);
    }
    await gcBases(board);
    return {
      status: "committed",
      version,
      previous,
      entry,
      author: branch.author,
      fastForward: result.fastForward,
      applied: result.applied,
      overwritten: result.overwritten,
      unbound: result.unbound,
      masterChanged,
    };
  };

  const ensureLoaded = (name) => (boards.has(name) ? Promise.resolve(boards.get(name)) : enqueue(name, () => loadBoard(name)));

  const postCommit = (name, result) => {
    if (result?.status !== "committed" || result.replayed) {
      return Promise.resolve();
    }
    return Promise.resolve().then(() => onCommitted({ name, ...result })).catch((error) => {
      console.warn(`post-commit hook failed for ${name}: ${error.message}`);
    });
  };

  // The commit job for an ingested (or ingesting) branch. After close() the branch stays in
  // the journal and is replayed on the next start.
  const commitJob = (name, ingesting) => enqueue(name, async () => {
    const ingested = await ingesting;
    if (ingested.error) {
      return { status: "invalid", error: ingested.error };
    }
    if (closed) {
      return { status: "queued", branchId: ingested.branch.id };
    }
    const board = await loadBoard(name);
    return { ...(await commitBranch(board, ingested.branch)), branchId: ingested.branch.id };
  });

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
      rememberExternal(branch);
      runs.push(commitJob(branch.board, Promise.resolve({ branch })).then(
        (result) => postCommit(branch.board, result),
        (error) => console.warn(`replaying branch ${branch.id} for ${branch.board} failed: ${error.message}`),
      ));
    }
    replayed = Promise.all(runs);
  };

  // Resolves once the journal is queued (not committed), so new submits line up behind it.
  const start = () => {
    started ??= replay();
    return started;
  };

  /**
   * Submit a writer's branch: `{ author, base, writtenAt?, kind?: "json" | "mermaid",
   * elements, appState?, files?, raw?, ops?, mermaid?: { source, hash } }`. Resolves after the
   * commit with `{ status, version, applied, overwritten, unbound, branchId, post }`; status is
   * "committed", "unchanged", "unknown-base", "invalid", or "queued" after close(). `post`
   * resolves when the post-commit hook (SSE, export) has run. `onIngested(branchId)` fires once
   * the branch is in the journal, i.e. it will not be dropped.
   */
  const submitBranch = async (name, input, { onIngested } = {}) => {
    await start();
    const ingesting = ingest(name, input).then((ingested) => {
      if (ingested.branch) {
        onIngested?.(ingested.branch.id);
      }
      return ingested;
    });
    const result = await commitJob(name, ingesting);
    return { ...result, post: postCommit(name, result) };
  };

  const readVersion = (name, version) => enqueue(name, async () => {
    const board = await loadBoard(name);
    const text = await versionText(board, version);
    if (text === null) {
      return null;
    }
    await pin(board, version, text);
    return { version, text, scene: parseScene(text) };
  });

  const readMaster = async (name) => {
    const board = await ensureLoaded(name);
    const disk = await readMasterFile(name);
    if (disk.hash === null) {
      return null;
    }
    await pin(board, disk.hash, disk.text);
    return { version: disk.hash, text: disk.text, scene: parseScene(disk.text) };
  };

  // A version handed to a reader may come back as a base. A version that is a closed history
  // entry stays resolvable anyway; any other (the open entry's, or one not adopted yet) is
  // copied to the base store, which keeps it `baseTtlMs` after the last hand-out.
  const pin = async (board, version, text) => {
    if (!version || text === null || contentHash(text) !== version) {
      return;
    }
    const entry = (await historyIndex(board)).get(version);
    if (entry && entry !== board.open?.entry) {
      return;
    }
    await saveBase(board, version, text);
  };

  // GET hands out the master text with its hash as the ETag.
  const noteServed = async (name, version, text) => {
    await pin(await ensureLoaded(name), version, text);
  };

  const checkpoint = (name) => enqueue(name, async () => {
    const board = await loadBoard(name);
    const entry = board.open?.entry ?? null;
    const closedEntry = await closeOpenEntry(board, "checkpoint");
    if (closedEntry) {
      await writeState(board);
    }
    return { closed: closedEntry, entry, version: board.version };
  });

  // The watcher calls this once a changed master file has settled.
  const adoptExternal = async (name) => {
    await start();
    return enqueue(name, async () => (closed ? null : (await syncExternal(await loadBoard(name))).result));
  };

  const readState = (name) => enqueue(name, async () => {
    const board = await loadBoard(name);
    return {
      version: board.version,
      masterMeta: board.meta,
      last: board.last,
      open: board.open,
      mermaid: board.mermaid,
    };
  });

  const readMermaid = async (name) => (await readState(name)).mermaid;

  const whenIdle = async () => {
    await start();
    await replayed;
    while (queues.size) {
      await Promise.all([...queues.values()]);
    }
  };

  // Stops timers and new commits (their branches stay in the journal); resolves once the
  // commit in flight, if any, has finished.
  const close = async () => {
    closed = true;
    for (const name of [...idleTimers.keys()]) {
      clearIdle(name);
    }
    while (queues.size) {
      await Promise.all([...queues.values()]);
    }
  };

  return { start, submitBranch, readVersion, readMaster, readState, readMermaid, noteServed, checkpoint, adoptExternal, whenIdle, close, parseAuthorKey };
}
