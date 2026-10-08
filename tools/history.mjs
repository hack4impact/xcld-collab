// History v2 records, shared by the server's version store (app/server/versions.mjs) and
// `xcld history export`. Layout and rules: docs/DESIGN.md#versions-storage-and-commit-pipeline.
//
// A history entry is either a checkpoint (the whole board) or a delta against the version of the
// entry before it (the elements added or changed since, deletions as tombstones). A checkpoint is
// written every CHECKPOINT_EVERY entries and for a pinned version, so a version is rebuilt from
// the nearest checkpoint plus at most CHECKPOINT_EVERY - 1 deltas. Both are gzipped JSON.
// Entries written before history v2 are full, uncompressed `.excalidraw` records and stay valid
// as checkpoints.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip, gzipSync } from "node:zlib";
import { splitBoardPath } from "./board-path.mjs";

export const HISTORY_SCHEMA = 3;
export const CHECKPOINT_EVERY = 20;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
// Small buffers compress faster inline than through the thread pool.
const INLINE_GZIP_BYTES = 64 * 1024;

export const gzipText = async (text) => (text.length < INLINE_GZIP_BYTES ? gzipSync(text) : gzipAsync(text));

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// The files of one history entry. `delta` and `checkpoint` are history v2; `legacy` is a full
// record written before it (slices 2 and 3).
export const historyEntryFiles = (dir, entry) => ({
  delta: path.join(dir, `${entry}.delta.json.gz`),
  checkpoint: path.join(dir, `${entry}.excalidraw.gz`),
  legacy: path.join(dir, `${entry}.excalidraw`),
  meta: path.join(dir, `${entry}.meta.json`),
});

const readBuffer = async (file) => {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

// Parsed JSON of a gzipped (or, for legacy records, plain) file; null when missing or unreadable.
export const readRecordFile = async (file) => {
  const buffer = await readBuffer(file);
  if (buffer === null) {
    return null;
  }
  try {
    const text = file.endsWith(".gz") ? (await gunzipAsync(buffer)).toString("utf8") : buffer.toString("utf8");
    return { text, data: JSON.parse(text) };
  } catch {
    return null;
  }
};

// Deep equality that also requires the same key order: two elements are equal only when they
// serialize to the same bytes, so a rebuilt version hashes to its id.
export const sameJson = (left, right) => {
  if (left === right) {
    return true;
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index++) {
      if (!sameJson(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (let index = 0; index < leftKeys.length; index++) {
    const key = leftKeys[index];
    if (key !== rightKeys[index] || !sameJson(left[key], right[key])) {
      return false;
    }
  }
  return true;
};

const SCENE_PARTS = new Set(["elements", "appState", "files"]);

/**
 * The delta from `parent` to `scene` (both scenes; `files` are handled by the caller).
 * `order` rebuilds the element array: `[start, count]` copies that run of the parent's elements,
 * an object is an added or changed element. `top` keeps the scene's other top-level fields and
 * the key order. `appState` is present only when it changed. `added`, `modified` and `deleted`
 * (the tombstones) list element ids, for readers; rebuilding needs only `order`.
 */
export const encodeDelta = (parent, scene) => {
  const parentElements = parent?.elements ?? [];
  const positions = new Map();
  parentElements.forEach((element, index) => {
    const list = positions.get(element?.id);
    if (list) {
      list.push(index);
    } else {
      positions.set(element?.id, [index]);
    }
  });
  const used = new Uint8Array(parentElements.length);
  const order = [];
  const added = [];
  const modified = [];
  let run = null;
  for (const element of scene.elements) {
    const candidates = positions.get(element.id);
    let position = -1;
    if (candidates) {
      const next = run ? run[0] + run[1] : -1;
      const preferred = candidates.includes(next) && !used[next] ? next : candidates.find((candidate) => !used[candidate]);
      if (preferred !== undefined && sameJson(parentElements[preferred], element)) {
        position = preferred;
      }
    }
    if (position < 0) {
      run = null;
      order.push(element);
      (candidates ? modified : added).push(element.id);
      continue;
    }
    used[position] = 1;
    if (run && run[0] + run[1] === position) {
      run[1] += 1;
    } else {
      run = [position, 1];
      order.push(run);
    }
  }
  const present = new Set(scene.elements.map((element) => element.id));
  const deleted = [...positions.keys()].filter((id) => !present.has(id));
  const top = {};
  for (const key of Object.keys(scene)) {
    top[key] = SCENE_PARTS.has(key) ? 0 : scene[key];
  }
  const delta = { top, order, added, modified, deleted };
  if ("appState" in scene && !(parent && "appState" in parent && sameJson(parent.appState, scene.appState))) {
    delta.appState = scene.appState;
  }
  return delta;
};

// Rebuilds a scene from its parent and a delta. `files` is left empty for the caller to fill.
export const applyDelta = (parent, delta) => {
  const parentElements = parent?.elements ?? [];
  const elements = [];
  for (const item of delta.order) {
    if (Array.isArray(item)) {
      const [start, count] = item;
      if (start < 0 || start + count > parentElements.length) {
        throw new Error("history delta refers past the end of its parent");
      }
      for (let index = start; index < start + count; index++) {
        elements.push(parentElements[index]);
      }
    } else {
      elements.push(item);
    }
  }
  const scene = {};
  for (const key of Object.keys(delta.top)) {
    if (key === "elements") {
      scene.elements = elements;
    } else if (key === "appState") {
      scene.appState = "appState" in delta ? delta.appState : parent?.appState ?? {};
    } else if (key === "files") {
      scene.files = {};
    } else {
      scene[key] = delta.top[key];
    }
  }
  return scene;
};

const leafPath = (root, segments, extension) => path.join(root, ...segments.slice(0, -1), `${segments.at(-1)}${extension}`);

/**
 * Read-only view of one board's history in a state dir, for `xcld history export`. Works next to
 * a running server: closed entries never change, and the open entry is re-read if it moved on.
 */
export const openHistory = async ({ stateDir, board }) => {
  const segments = splitBoardPath(board);
  const dir = path.join(stateDir, "history", ...segments);
  const filesDir = path.join(stateDir, "files", ...segments);
  const statePath = leafPath(path.join(stateDir, "state"), segments, ".json");
  const readJson = async (file) => {
    const buffer = await readBuffer(file);
    if (buffer === null) {
      return null;
    }
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      return null;
    }
  };

  const loadEntries = async () => {
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    const entries = new Map();
    for (const name of names.filter((item) => item.endsWith(".meta.json")).sort()) {
      const meta = await readJson(path.join(dir, name));
      if (meta?.version) {
        entries.set(name.slice(0, -".meta.json".length), { entry: name.slice(0, -".meta.json".length), meta, open: false });
      }
    }
    const state = await readJson(statePath);
    if (state?.open?.entry && state.open.version) {
      entries.set(state.open.entry, { entry: state.open.entry, meta: { ...state.open, closedBy: null }, open: true });
    }
    return { state, entries: [...entries.values()].sort((left, right) => (left.entry < right.entry ? -1 : left.entry > right.entry ? 1 : 0)) };
  };

  let { state, entries } = await loadEntries();
  // Meta-only entries (`record: "none"`: losers of a write that changed nothing) hold no version.
  const versionMap = () => new Map(entries.filter((item) => item.meta.record !== "none").map((item) => [item.meta.version, item]));
  let byVersion = versionMap();

  const images = new Map();
  const loadFiles = async (refs) => {
    const files = {};
    for (const [id, key] of refs ?? []) {
      if (!images.has(key)) {
        const file = await readJson(path.join(filesDir, `${key}.json`));
        if (!file) {
          throw new Error(`image ${id} of ${board} is missing from the file store`);
        }
        images.set(key, file);
      }
      files[id] = images.get(key);
    }
    return files;
  };

  // The stored record of an entry, as written: `delta`, `checkpoint` or `legacy`.
  const readRaw = async (item) => {
    const files = historyEntryFiles(dir, item.entry);
    for (const [record, file] of [["delta", files.delta], ["checkpoint", files.checkpoint], ["legacy", files.legacy]]) {
      const read = await readRecordFile(file);
      if (!read) {
        continue;
      }
      const info = read.data?.xcld;
      if (info ? info.version === item.meta.version : record === "legacy" && sha256(read.text) === item.meta.version) {
        return { record, data: read.data, text: read.text };
      }
    }
    return null;
  };

  // Rebuilt scenes, the last few kept: entries are usually read in order, each delta's parent
  // being the entry before it.
  const memo = new Map();
  const MEMO_LIMIT = 32;
  // `before` (a delta's parent) takes the newest entry older than that entry: a board that went
  // back to an earlier state repeats a version id, and the newest entry with it may come later.
  const sceneOf = async (version, guard = 0, before = null) => {
    if (memo.has(version)) {
      return memo.get(version);
    }
    if (guard > 4 * CHECKPOINT_EVERY) {
      throw new Error(`history of ${board}: delta chain too long at ${version}`);
    }
    let item = byVersion.get(version);
    if (before && item && !(item.entry < before)) {
      item = entries.filter((candidate) => candidate.entry < before && candidate.meta.record !== "none" && candidate.meta.version === version).at(-1);
    }
    const raw = item ? await readRaw(item) : null;
    if (!raw) {
      return null;
    }
    let scene;
    if (raw.record === "delta") {
      const parent = await sceneOf(raw.data.xcld.parent, guard + 1, item.entry);
      if (!parent) {
        throw new Error(`history of ${board}: the parent of ${item.entry} (${raw.data.xcld.parent}) is missing`);
      }
      scene = applyDelta(parent, raw.data);
      scene.files = await loadFiles(raw.data.xcld.files);
    } else if (raw.data.xcld) {
      const { xcld: info, ...rest } = raw.data;
      scene = { ...rest, files: await loadFiles(info.files) };
    } else {
      scene = raw.data;
    }
    memo.set(version, scene);
    while (memo.size > MEMO_LIMIT) {
      memo.delete(memo.keys().next().value);
    }
    return scene;
  };

  // The open entry is rewritten by every coalesced save; pick up its latest version.
  const refreshOpen = async () => {
    ({ state, entries } = await loadEntries());
    byVersion = versionMap();
  };

  return {
    board,
    dir,
    filesDir,
    get state() {
      return state;
    },
    get entries() {
      return entries;
    },
    readRaw,
    sceneOf,
    loadFiles,
    refreshOpen,
  };
};

const canonicalText = (scene) => `${JSON.stringify(scene, null, 2)}\n`;

const writeFileSafe = async (file, content) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, content);
  await fs.rename(temp, file);
};

// Refuses a destination in the versions state dir (the history folder: <cache>/history, the
// Docker volume or boards/.xcld), also when that folder is reached through another path (a
// symlink, or a second mount of it).
export const checkExportDestination = async (to, stateDir) => {
  const target = path.resolve(to);
  const stateRoot = path.resolve(stateDir);
  const relative = path.relative(stateRoot, target);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(`refusing to export into the versions state dir (${target}); pass --to with another folder`);
  }
  let stateStat;
  try {
    stateStat = await fs.stat(stateRoot);
  } catch {
    return;
  }
  for (let dir = target, parent = path.dirname(dir); ; dir = parent, parent = path.dirname(dir)) {
    let info = null;
    try {
      info = await fs.stat(dir);
    } catch {}
    if (info && info.ino === stateStat.ino && info.dev === stateStat.dev && info.ino !== 0) {
      throw new Error(`refusing to export into the versions state dir (${target} is in ${dir}, the same folder as ${stateRoot}); pass --to with another folder`);
    }
    if (parent === dir) return;
  }
};

/**
 * Writes a board's history to `to`:
 * - default: as stored, decompressed: `<entry>.checkpoint.json` or `<entry>.delta.json`, plus
 *   `<entry>.meta.json` and the images the records reference under `files/`;
 * - `full`: every entry rebuilt as an Excalidraw file, `<entry>.excalidraw` (images inline),
 *   plus `<entry>.meta.json`.
 * Both write `index.json` (entries in order). Overwritten (losing) edits are only in the meta
 * files' `overwritten`; they are never a version of their own.
 */
export const exportHistory = async ({ stateDir, board, to, full = false, now = Date.now }) => {
  await checkExportDestination(to, stateDir);
  const history = await openHistory({ stateDir, board });
  if (!history.entries.length) {
    throw new Error(`no history for board ${board} in ${stateDir}`);
  }
  const target = path.resolve(to);
  const index = [];
  const copiedImages = new Set();
  let bytes = 0;
  const write = async (name, content) => {
    await writeFileSafe(path.join(target, name), content);
    bytes += Buffer.byteLength(content);
  };
  const counts = { checkpoint: 0, delta: 0, none: 0, skipped: 0 };
  for (let position = 0; position < history.entries.length; position++) {
    let item = history.entries[position];
    if (item.meta.record === "none") {
      counts.none += 1;
      await write(`${item.entry}.meta.json`, `${JSON.stringify(item.meta, null, 2)}\n`);
      index.push({ entry: item.entry, version: item.meta.version, record: "none", author: item.meta.author, displayName: item.meta.displayName, lastCommitAt: item.meta.lastCommitAt, closedBy: item.meta.closedBy, overwritten: (item.meta.overwritten ?? []).length });
      continue;
    }
    let raw = await history.readRaw(item);
    if (!raw && item.open) {
      await history.refreshOpen();
      item = history.entries.find((candidate) => candidate.entry === item.entry) ?? item;
      raw = await history.readRaw(item);
    }
    if (!raw) {
      counts.skipped += 1;
      index.push({ entry: item.entry, version: item.meta.version, skipped: "record not readable" });
      continue;
    }
    const record = raw.record === "delta" ? "delta" : "checkpoint";
    counts[record] += 1;
    const meta = { ...item.meta, ...(item.open ? { open: true } : {}) };
    let file;
    if (full) {
      const scene = await history.sceneOf(item.meta.version);
      file = `${item.entry}.excalidraw`;
      await write(file, canonicalText(scene));
    } else {
      file = `${item.entry}.${record}.json`;
      await write(file, `${JSON.stringify(raw.data, null, 2)}\n`);
      // Legacy records without `xcld` embed their images.
      for (const [, key] of raw.data?.xcld?.files ?? []) {
        if (!copiedImages.has(key)) {
          copiedImages.add(key);
          const image = await fs.readFile(path.join(history.filesDir, `${key}.json`), "utf8");
          await write(path.join("files", `${key}.json`), image);
        }
      }
    }
    await write(`${item.entry}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
    index.push({
      entry: item.entry,
      file,
      version: item.meta.version,
      record,
      ...(raw.record === "delta" ? { parent: raw.data.xcld.parent, depth: raw.data.xcld.depth } : {}),
      author: item.meta.author,
      displayName: item.meta.displayName,
      openedAt: item.meta.openedAt,
      lastCommitAt: item.meta.lastCommitAt,
      closedBy: item.meta.closedBy ?? null,
      coalescedCount: item.meta.coalescedCount,
      overwritten: (item.meta.overwritten ?? []).length,
      ...(item.meta.pinned ? { pinned: item.meta.pinned } : {}),
    });
  }
  await write("index.json", `${JSON.stringify({ board, mode: full ? "full" : "raw", exportedAt: new Date(now()).toISOString(), current: history.state?.version ?? null, entries: index }, null, 2)}\n`);
  return { board, to: target, mode: full ? "full" : "raw", entries: index.length, ...counts, bytes };
};
