// Three-way merge of Excalidraw boards for versions and merge. Rules: docs/DESIGN.md#merge-rules.
//
// Pure and deterministic: no I/O, no clock, no randomness, inputs are never mutated. Times
// are inputs. It has no Node-only imports, so the server and the browser bundle can both
// import it.

import { describeUnlabeled, labelContext } from "./unit-label.mjs";

// Bookkeeping that Excalidraw (or a writer) maintains per element: never a change, and a writer
// that omits it gets it back from the copy it started from (docs/DESIGN.md#merge-rules). `seed`
// and `created` never change for an element id; the others are the writer's when it sent them.
const BOOKKEEPING_FIELDS = ["version", "versionNonce", "updated", "seed", "created", "index"];
const IDENTITY_FIELDS = ["seed", "created"];
// Compared separately: `isDeleted` (liveness), `boundElements` (arrow back-references are
// derived), `customData` (xcld's stamps in it are bookkeeping).
const SKIP_KEYS = new Set([...BOOKKEEPING_FIELDS, "isDeleted", "boundElements", "customData"]);
// xcld's own keys in customData. The origin stamp (tools/mermaid-origin.mjs) is written by the
// server, so it never counts. The Mermaid hash counts when both sides carry one; a writer that
// dropped it didn't change it. Both are backfilled when omitted.
const ORIGIN_DATA_KEY = "xcldOrigin";
const HASH_DATA_KEY = "xcldMermaidHash";
const STAMP_DATA_KEYS = [HASH_DATA_KEY, ORIGIN_DATA_KEY];
const HEAD = Symbol("head");

// Canonical JSON: object keys sorted at every level, so key order from different writers
// doesn't count as a change. Arrays without objects (points) are not copied.
const canonical = (value) => {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    let copy = null;
    for (let position = 0; position < value.length; position++) {
      const item = value[position];
      if (item !== null && typeof item === "object") {
        const next = canonical(item);
        if (next !== item) {
          copy ??= value.slice();
          copy[position] = next;
        }
      }
    }
    return copy ?? value;
  }
  const copy = {};
  for (const key of Object.keys(value).sort()) {
    copy[key] = canonical(value[key]);
  }
  return copy;
};

const stableStringify = (value) => JSON.stringify(canonical(value)) ?? "null";

const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const isLive = (element) => element !== undefined && element.isDeleted !== true;
const isArrowEntry = (entry) => entry?.type === "arrow";

const EMPTY = Object.freeze({});
const STAMP_SKIP = new Set(STAMP_DATA_KEYS);
const dataOf = (element) => (element.customData !== null && typeof element.customData === "object" && !Array.isArray(element.customData) ? element.customData : null);

// What counts as a change: the semantic fields. Not the bookkeeping above, not xcld's origin
// stamp, not the arrow back-references in `boundElements` (those are derived from the arrows' own
// bindings, so an arrow attached on one side doesn't make the target shape "changed"). A field
// set to null and an absent one are the same. A deleted element (tombstone or absent) has no
// content. Used to break ties and to derive version nonces; sameContent() is the change test.
const contentKey = (element, { withArrowRefs = false } = {}) => {
  if (!isLive(element)) {
    return null;
  }
  const copy = {};
  for (const key of Object.keys(element).sort()) {
    if (key === "boundElements") {
      const refs = refsOf(element, withArrowRefs);
      if (refs.length) {
        copy.boundElements = canonical(refs);
      }
    } else if (key === "customData") {
      const data = dataOf(element);
      if (!data) {
        if (element.customData != null) {
          copy.customData = canonical(element.customData);
        }
        continue;
      }
      const kept = {};
      for (const dataKey of Object.keys(data).sort()) {
        if (dataKey !== ORIGIN_DATA_KEY && data[dataKey] != null) {
          kept[dataKey] = canonical(data[dataKey]);
        }
      }
      if (Object.keys(kept).length) {
        copy.customData = kept;
      }
    } else if (!SKIP_KEYS.has(key) && element[key] != null) {
      copy[key] = canonical(element[key]);
    }
  }
  return JSON.stringify(copy);
};

// Structural equality, key order ignored, null and undefined values same as absent. Used on the hot
// path instead of serializing: most elements are unchanged, and this allocates nothing.
const deepEqual = (left, right) => {
  if (left === right) {
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    return false;
  }
  if (Array.isArray(left)) {
    if (left.length !== right.length) {
      return false;
    }
    for (let position = 0; position < left.length; position++) {
      if (!deepEqual(left[position] ?? null, right[position] ?? null)) {
        return false;
      }
    }
    return true;
  }
  return sameFields(left, right, null);
};

const sameFields = (left, right, skip) => {
  let count = 0;
  for (const key of Object.keys(left)) {
    if ((skip && skip.has(key)) || left[key] === undefined || left[key] === null) {
      continue;
    }
    if (!deepEqual(left[key], right[key])) {
      return false;
    }
    count++;
  }
  for (const key of Object.keys(right)) {
    if (!(skip && skip.has(key)) && right[key] !== undefined && right[key] !== null) {
      count--;
    }
  }
  return count === 0;
};

const refsOf = (element, withArrowRefs) => (Array.isArray(element.boundElements) ? element.boundElements.filter((entry) => withArrowRefs || !isArrowEntry(entry)) : []);

// customData without xcld's origin stamp; the Mermaid hash only when both sides have one.
const sameData = (left, right) => {
  if (left.customData === right.customData) {
    return true;
  }
  const leftSide = dataOf(left) ?? (left.customData == null ? EMPTY : null);
  const rightSide = dataOf(right) ?? (right.customData == null ? EMPTY : null);
  if (!leftSide || !rightSide) {
    return deepEqual(left.customData ?? null, right.customData ?? null);
  }
  const leftHash = leftSide[HASH_DATA_KEY];
  const rightHash = rightSide[HASH_DATA_KEY];
  if (leftHash != null && rightHash != null && !deepEqual(leftHash, rightHash)) {
    return false;
  }
  return sameFields(leftSide, rightSide, STAMP_SKIP);
};

/**
 * True when two copies of an element have the same semantic content: what decides whether a writer
 * changed it. Bookkeeping (`version`, `versionNonce`, `updated`, `seed`, `created`, `index`) and
 * xcld's origin stamp never count, null equals absent, arrow back-references count only with
 * `withArrowRefs`. Exported for the tab (app/src/tab-merge.mjs) and the origin stamps.
 */
export const sameContent = (left, right, { withArrowRefs = false } = {}) => {
  const leftLive = isLive(left);
  if (!leftLive || !isLive(right)) {
    return leftLive === isLive(right);
  }
  return left === right || (sameFields(left, right, SKIP_KEYS) && sameData(left, right) && deepEqual(refsOf(left, withArrowRefs), refsOf(right, withArrowRefs)));
};

/**
 * `element` with the bookkeeping its writer omitted taken from `from` (the copy the writer
 * started from, or master's): `version`, `versionNonce`, `updated` and `index` when missing,
 * `seed` and `created` always (they never change for an element id), and xcld's customData
 * stamps when missing. Returns `element` itself when nothing is missing.
 */
export const backfillBookkeeping = (element, from) => {
  if (!isLive(element) || !from || typeof from !== "object" || element === from) {
    return element;
  }
  let next = element;
  const set = (key, value) => {
    if (next === element) {
      next = { ...element };
    }
    next[key] = value;
  };
  for (const key of BOOKKEEPING_FIELDS) {
    if (from[key] == null) {
      continue;
    }
    if (element[key] == null || (IDENTITY_FIELDS.includes(key) && !deepEqual(element[key], from[key]))) {
      set(key, from[key]);
    }
  }
  const fromData = dataOf(from);
  if (fromData && (element.customData == null || dataOf(element))) {
    const own = dataOf(element);
    let data = null;
    for (const key of STAMP_DATA_KEYS) {
      if (fromData[key] != null && own?.[key] == null) {
        data ??= { ...(own ?? {}) };
        data[key] = fromData[key];
      }
    }
    if (data) {
      set("customData", data);
    }
  }
  return next;
};

// True when `element` lacks bookkeeping that `from` has (or has another seed or created).
const needsBackfill = (element, from) => backfillBookkeeping(element, from) !== element;

/**
 * The elements a fast-forward stores: the writer's own (its order, tombstones and objects),
 * except that an element whose content master already has goes back to master's copy, and one
 * that omitted bookkeeping takes the merge's filled-in copy. `merged` is mergeBoard's `elements`
 * for that write; `master` the master it merged into. Returns `branch` itself when nothing changed.
 */
export const fastForwardElements = ({ branch, master, merged }) => {
  const mergedById = new Map((merged ?? []).map((element) => [element.id, element]));
  const masterById = new Map((master ?? []).filter(isLive).map((element) => [element.id, element]));
  let changed = false;
  const out = branch.map((element) => {
    if (!isLive(element)) {
      return element;
    }
    const next = mergedById.get(element.id);
    if (!next || next === element) {
      return element;
    }
    const own = masterById.get(element.id);
    if (!own || deepEqual(element, own)) {
      return element;
    }
    if (next === own || needsBackfill(element, own)) {
      changed = true;
      return next;
    }
    return element;
  });
  return changed ? out : branch;
};

const sceneParts = (input, name) => {
  if (input === null || input === undefined) {
    return { elements: [], files: {}, appState: undefined };
  }
  if (Array.isArray(input)) {
    return { elements: input, files: {}, appState: undefined };
  }
  if (typeof input === "object") {
    return { elements: input.elements ?? [], files: input.files ?? {}, appState: input.appState };
  }
  throw new TypeError(`mergeBoard: ${name} must be an element array or a scene object`);
};

const indexElements = (elements, name) => {
  if (!Array.isArray(elements)) {
    throw new TypeError(`mergeBoard: ${name}.elements must be an array`);
  }
  const map = new Map();
  const order = [];
  for (const element of elements) {
    if (!element || typeof element !== "object" || typeof element.id !== "string" || element.id === "") {
      throw new TypeError(`mergeBoard: every element in ${name} needs a non-empty string id`);
    }
    if (!map.has(element.id)) {
      map.set(element.id, element);
      order.push(element.id);
    }
  }
  return { map, order };
};

const readMeta = (meta) => {
  if (!meta) {
    return new Map();
  }
  const entries = meta instanceof Map ? [...meta.entries()] : Object.entries(meta);
  const map = new Map();
  for (const [id, stamp] of entries) {
    map.set(id, checkStamp(stamp, `masterMeta[${JSON.stringify(id)}]`));
  }
  return map;
};

const checkStamp = (stamp, name) => {
  if (!stamp || typeof stamp.writtenAt !== "number" || Number.isNaN(stamp.writtenAt)) {
    throw new TypeError(`mergeBoard: ${name}.writtenAt must be a number (ms since the Unix epoch)`);
  }
  return { writtenAt: stamp.writtenAt, author: String(stamp.author ?? "") };
};

// Later write wins; equal times fall back to the author key (then, at the call site, to the
// unit content), so the winner never depends on which side is "master" and which is "branch".
const compareStamps = (left, right) => left.writtenAt - right.writtenAt || compareStrings(left.author, right.author);

// Deterministic 31-bit FNV-1a, used for the versionNonce of elements the merge bumps.
const hash31 = (text) => {
  let hash = 0x811c9dc5;
  for (let position = 0; position < text.length; position++) {
    hash ^= text.charCodeAt(position);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 1;
};

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// A unit's label: its text (bound text, or the element's own), else a description from where it
// sits on the board ("unlabeled arrow from "A" to "B"", "unlabeled rectangle near "C"", with
// `unlabeled: true`), never a bare element id. `contextOf(side)` gives tools/unit-label.mjs's
// lookups for a side.
const unitLabel = (unitId, members, sides, contextOf) => {
  for (const side of sides) {
    const texts = members.map((id) => side.get(id)).filter((element) => isLive(element) && element.type === "text").map((element) => clean(element.originalText ?? element.text)).filter(Boolean);
    if (texts.length) {
      return { label: texts.join(" ") };
    }
  }
  for (const side of sides) {
    const element = side.get(unitId);
    if (element) {
      return { label: describeUnlabeled(element, contextOf(side)), unlabeled: true };
    }
  }
  return { label: "unlabeled element", unlabeled: true };
};

const labelContexts = () => {
  const cache = new Map();
  return (side) => {
    let context = cache.get(side);
    if (!context) {
      context = labelContext(side);
      cache.set(side, context);
    }
    return context;
  };
};

const groupUnits = (ids, sides) => {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root);
    }
    while (parent.get(id) !== root) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  // Attaching the larger root under the smaller one makes every root the smallest id of its
  // unit, whatever the union order.
  const union = (left, right) => {
    if (!parent.has(left) || !parent.has(right)) {
      return;
    }
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      if (leftRoot < rightRoot) {
        parent.set(rightRoot, leftRoot);
      } else {
        parent.set(leftRoot, rightRoot);
      }
    }
  };
  for (const side of sides) {
    for (const element of side.values()) {
      if (element.type === "text" && typeof element.containerId === "string") {
        union(element.id, element.containerId);
      }
      if (Array.isArray(element.boundElements)) {
        for (const entry of element.boundElements) {
          if (entry?.type === "text" && typeof entry.id === "string") {
            union(element.id, entry.id);
          }
        }
      }
    }
  }
  const units = new Map();
  for (const id of [...ids].sort(compareStrings)) {
    const root = find(id);
    const members = units.get(root) ?? [];
    members.push(id);
    units.set(root, members);
  }
  const typeOf = (id) => sides.map((side) => side.get(id)?.type).find((type) => type !== undefined);
  return [...units.values()].map((members) => ({ unitId: members.find((id) => typeOf(id) !== "text") ?? members[0], members }));
};

const BINDING_KEYS = ["startBinding", "endBinding"];

// A side's arrow binding only counts if that side still has the target. Deleting a shape
// unbinds its arrows (Excalidraw does it; agents often just omit the shape), and that unbinding
// is implied by the deletion, not a change of its own: an end whose base target the same side
// deleted reads as the base binding. Any other binding to an element the side doesn't have
// reads as unbound. Bindings to targets that don't survive the merge are dropped later, so a
// target that survives keeps its arrows, whatever the merge order.
const normalizeBindings = (side, baseMap) => {
  for (const [id, element] of side) {
    if (!isLive(element)) {
      continue;
    }
    let next = element;
    for (const key of BINDING_KEYS) {
      if (isLive(side.get(element[key]?.elementId))) {
        continue;
      }
      const baseBinding = baseMap.get(id)?.[key];
      const implied = typeof baseBinding?.elementId === "string" && !isLive(side.get(baseBinding.elementId)) ? baseBinding : null;
      if ((element[key] ?? null) !== implied) {
        next = { ...next, [key]: implied };
      }
    }
    if (next !== element) {
      side.set(id, next);
    }
  }
};

const mergeAppState = (base, master, branch) => {
  if (branch === undefined) {
    return master;
  }
  if (master === undefined) {
    return branch;
  }
  const result = { ...master };
  for (const key of new Set([...Object.keys(base ?? {}), ...Object.keys(branch)])) {
    if (stableStringify(branch[key]) !== stableStringify(base?.[key])) {
      if (branch[key] === undefined) {
        delete result[key];
      } else {
        result[key] = branch[key];
      }
    }
  }
  return result;
};

const mergeFiles = (masterFiles, branchFiles) => {
  const result = {};
  for (const key of [...new Set([...Object.keys(masterFiles ?? {}), ...Object.keys(branchFiles ?? {})])].sort(compareStrings)) {
    result[key] = masterFiles?.[key] ?? branchFiles[key];
  }
  return result;
};

/**
 * Three-way merge of a writer's branch into master. See docs/DESIGN.md#merge-rules.
 *
 * `base`, `master` and `branch` are element arrays or scenes (`{ elements, files?, appState? }`).
 * `base` is the master version the branch started from; null means an empty board.
 *
 * @param {object} input
 * @param {readonly object[] | { elements: readonly object[], files?: object, appState?: object } | null} [input.base]
 * @param {readonly object[] | { elements: readonly object[], files?: object, appState?: object } | null} input.master
 * @param {readonly object[] | { elements: readonly object[], files?: object, appState?: object }} input.branch
 * @param {number} input.branchWrittenAt When the branch was written, ms since the Unix epoch.
 * @param {string} input.branchAuthor Author key of the branch writer.
 * @param {Map<string, { writtenAt: number, author: string }> | Record<string, { writtenAt: number, author: string }>} [input.masterMeta]
 *   Per element id: write time and author of the change that last set (or deleted) that element
 *   in master. Feed back the `meta` this function returns.
 * @param {{ writtenAt: number, author: string }} [input.masterDefault] Stamp for master units with
 *   no `masterMeta` entry. Defaults to `-Infinity`, so the branch wins those conflicts.
 * @returns {{
 *   elements: object[],
 *   files: Record<string, object>,
 *   appState: object | undefined,
 *   meta: Record<string, { writtenAt: number, author: string }>,
 *   fastForward: boolean,
 *   applied: { unitId: string, label: string, unlabeled?: true, kind: "added" | "changed" | "deleted", elementIds: string[] }[],
 *   overwritten: {
 *     unitId: string, label: string, unlabeled?: true, elementIds: string[],
 *     winner: { side: "master" | "branch", author: string, writtenAt: number },
 *     loser: { side: "master" | "branch", author: string, writtenAt: number, elements: object[] },
 *   }[],
 *   unbound: { arrowId: string, end: "start" | "end", elementId: string }[],
 * }} The new master (`elements` without tombstones, `files`, `appState`), the per-element
 *   write stamps to store with it, whether master still equalled the base, the branch's units
 *   that changed master, every unit where one side's change was overwritten (with the loser's
 *   live elements), and arrow ends the merge left unbound.
 */
export function mergeBoard({ base = null, master = null, branch, branchWrittenAt, branchAuthor, masterMeta, masterDefault }) {
  if (typeof branchWrittenAt !== "number" || !Number.isFinite(branchWrittenAt)) {
    throw new TypeError("mergeBoard: branchWrittenAt must be a finite number (ms since the Unix epoch)");
  }
  if (typeof branchAuthor !== "string") {
    throw new TypeError("mergeBoard: branchAuthor must be a string");
  }
  if (branch === null || branch === undefined) {
    throw new TypeError("mergeBoard: branch is required");
  }
  const baseScene = sceneParts(base, "base");
  const masterScene = sceneParts(master, "master");
  const branchScene = sceneParts(branch, "branch");
  const baseSide = indexElements(baseScene.elements, "base");
  const masterSide = indexElements(masterScene.elements, "master");
  const branchSide = indexElements(branchScene.elements, "branch");
  const masterOriginal = new Map(masterSide.map);
  const branchOriginal = new Map(branchSide.map);
  normalizeBindings(masterSide.map, baseSide.map);
  normalizeBindings(branchSide.map, baseSide.map);
  const metaIn = readMeta(masterMeta);
  const fallback = masterDefault ? checkStamp(masterDefault, "masterDefault") : { writtenAt: Number.NEGATIVE_INFINITY, author: "" };
  const branchStamp = { writtenAt: branchWrittenAt, author: branchAuthor };

  const ids = [...new Set([...baseSide.order, ...masterSide.order, ...branchSide.order])];
  const changedIds = (side) => new Set(ids.filter((id) => !sameContent(side.map.get(id), baseSide.map.get(id))));
  const masterChangedIds = changedIds(masterSide);
  const branchChangedIds = changedIds(branchSide);
  const fastForward = masterChangedIds.size === 0;

  const chosen = new Map();
  const source = new Map();
  const metaOut = new Map(metaIn);
  const applied = [];
  const overwritten = [];
  // Per element id of a unit both sides changed: the side that won it (for its z-order).
  const winnerSide = new Map();
  const contextOf = labelContexts();
  const units = groupUnits(ids, [branchSide.map, masterSide.map, baseSide.map]);

  for (const { unitId, members } of units) {
    const masterChanged = members.some((id) => masterChangedIds.has(id));
    const branchChanged = members.some((id) => branchChangedIds.has(id));
    let takeBranch = branchChanged && !masterChanged;
    let report = takeBranch;
    if (masterChanged && branchChanged) {
      let masterStamp = null;
      for (const id of members) {
        const stamp = metaIn.get(id);
        if (stamp && (!masterStamp || compareStamps(stamp, masterStamp) > 0)) {
          masterStamp = stamp;
        }
      }
      masterStamp = masterStamp ?? fallback;
      const same = members.every((id) => sameContent(masterSide.map.get(id), branchSide.map.get(id)));
      const state = (side) => members.map((id) => `${id}=${contentKey(side.get(id)) ?? "-"}`).join("\n");
      takeBranch = (compareStamps(branchStamp, masterStamp) || compareStrings(state(branchSide.map), state(masterSide.map))) > 0;
      report = takeBranch && !same;
      for (const id of members) {
        winnerSide.set(id, takeBranch ? "branch" : "master");
      }
      if (!same) {
        const [winner, loser] = takeBranch ? [["branch", branchStamp], ["master", masterStamp, masterOriginal]] : [["master", masterStamp], ["branch", branchStamp, branchOriginal]];
        overwritten.push({
          unitId,
          ...unitLabel(unitId, members, takeBranch ? [branchSide.map, masterSide.map, baseSide.map] : [masterSide.map, branchSide.map, baseSide.map], contextOf),
          elementIds: members,
          winner: { side: winner[0], author: winner[1].author, writtenAt: winner[1].writtenAt },
          loser: {
            side: loser[0],
            author: loser[1].author,
            writtenAt: loser[1].writtenAt,
            elements: members.map((id) => loser[2].get(id)).filter(isLive),
          },
        });
      }
    }
    if (takeBranch) {
      for (const id of members) {
        metaOut.set(id, { ...branchStamp });
        const element = branchSide.map.get(id);
        if (isLive(element)) {
          // A writer that omitted bookkeeping (agents re-sending a board often do) keeps master's.
          const from = isLive(masterOriginal.get(id)) ? masterOriginal.get(id) : baseSide.map.get(id);
          chosen.set(id, backfillBookkeeping(element, from));
          source.set(id, branchOriginal.get(id));
        }
      }
      if (report) {
        const liveIn = (side) => members.some((id) => isLive(side.get(id)));
        applied.push({
          unitId,
          ...unitLabel(unitId, members, [branchSide.map, masterSide.map, baseSide.map], contextOf),
          kind: !liveIn(masterSide.map) ? "added" : !liveIn(branchSide.map) ? "deleted" : "changed",
          elementIds: members,
        });
      }
    } else {
      for (const id of members) {
        const element = masterSide.map.get(id);
        if (isLive(element)) {
          chosen.set(id, element);
          source.set(id, masterOriginal.get(id));
        }
      }
    }
  }

  // An arrow bound to an element that is gone (deleted on the other side) is kept but unbound.
  // Reported: every binding the chosen writer's copy had that the merged arrow no longer has.
  const unbound = [];
  for (const [id, element] of chosen) {
    let next = element;
    for (const [end, key] of [["start", "startBinding"], ["end", "endBinding"]]) {
      const target = next[key]?.elementId;
      if (target !== undefined && target !== null && !chosen.has(target)) {
        next = { ...next, [key]: null };
      }
      const written = source.get(id)?.[key]?.elementId;
      if (typeof written === "string" && next[key]?.elementId !== written) {
        unbound.push({ arrowId: id, end, elementId: written });
      }
    }
    if (next !== element) {
      chosen.set(id, next);
    }
  }

  // Arrow back-references follow the merged arrows: keep entries for arrows that still bind to
  // the element (from either side's copy), drop the rest. Boards that never list arrows stay so.
  const boundTo = new Map();
  for (const [id, element] of chosen) {
    for (const key of BINDING_KEYS) {
      const target = element[key]?.elementId;
      if (typeof target === "string") {
        const set = boundTo.get(target) ?? new Set();
        set.add(id);
        boundTo.set(target, set);
      }
    }
  }
  for (const [id, element] of chosen) {
    const arrows = boundTo.get(id) ?? new Set();
    const own = Array.isArray(element.boundElements) ? element.boundElements : [];
    const listed = new Set();
    const kept = own.filter((entry) => {
      if (!isArrowEntry(entry)) {
        return true;
      }
      if (!arrows.has(entry.id) || listed.has(entry.id)) {
        return false;
      }
      listed.add(entry.id);
      return true;
    });
    const extra = [];
    for (const side of [masterSide.map, branchSide.map]) {
      for (const entry of side.get(id)?.boundElements ?? []) {
        if (isArrowEntry(entry) && arrows.has(entry.id) && !listed.has(entry.id)) {
          listed.add(entry.id);
          extra.push(entry);
        }
      }
    }
    extra.sort((left, right) => compareStrings(left.id, right.id));
    const next = [...kept, ...extra];
    if (next.length !== own.length || next.some((entry, position) => entry !== own[position])) {
      chosen.set(id, { ...element, boundElements: next });
    }
  }

  // Excalidraw treats a higher `version` as newer. Agents often don't bump it, so a merged
  // element that differs from master's copy gets a version above every copy of it. An element
  // with master's exact content stays master's object.
  for (const [id, element] of chosen) {
    const masterElement = masterOriginal.get(id);
    if (element === masterElement) {
      continue;
    }
    if (isLive(masterElement) && sameContent(element, masterElement, { withArrowRefs: true })) {
      chosen.set(id, masterElement);
      continue;
    }
    const versions = [baseSide.map.get(id), masterElement].filter(Boolean).map((copy) => (typeof copy.version === "number" ? copy.version : 0));
    if (!versions.length) {
      continue;
    }
    const known = Math.max(...versions);
    const own = typeof element.version === "number" ? element.version : 0;
    if (own <= known) {
      const branchVersion = typeof branchOriginal.get(id)?.version === "number" ? branchOriginal.get(id).version : 0;
      const version = Math.max(known, own, branchVersion) + 1;
      chosen.set(id, { ...element, version, versionNonce: hash31(`${id}:${version}:${contentKey(element, { withArrowRefs: true })}`) });
    }
  }

  // Z-order is not content: `index` never makes a unit changed, so it merges on its own, per
  // element. A side that set a new index moved the element; one that omitted it didn't. A unit
  // both sides changed takes the winner's index; an element both sides moved otherwise takes the
  // higher index (deterministic, whatever the merge order). A new index bumps the version.
  const indexOf = (element) => (isLive(element) && typeof element.index === "string" ? element.index : null);
  for (const [id, element] of chosen) {
    const baseIndex = indexOf(baseSide.map.get(id));
    const masterIndex = indexOf(masterOriginal.get(id));
    const branchIndex = indexOf(branchOriginal.get(id));
    const masterMoved = masterIndex !== null && masterIndex !== baseIndex;
    const branchMoved = branchIndex !== null && branchIndex !== baseIndex;
    const winner = winnerSide.get(id);
    let index;
    if (winner) {
      index = (winner === "branch" ? branchIndex ?? masterIndex : masterIndex ?? branchIndex) ?? baseIndex;
    } else if (masterMoved && branchMoved) {
      index = compareStrings(masterIndex, branchIndex) >= 0 ? masterIndex : branchIndex;
    } else if (branchMoved) {
      index = branchIndex;
    } else {
      index = masterIndex ?? baseIndex ?? branchIndex;
    }
    if (index === null || index === element.index) {
      continue;
    }
    const known = Math.max(0, ...[baseSide.map.get(id), masterOriginal.get(id), branchOriginal.get(id), element].map((copy) => (typeof copy?.version === "number" ? copy.version : 0)));
    const version = known + 1;
    chosen.set(id, { ...element, index, version, versionNonce: hash31(`${id}:${version}:${index}:${contentKey(element, { withArrowRefs: true })}`) });
  }

  const elements = orderElements(chosen, fastForward ? branchSide.order : masterSide.order, fastForward ? masterSide.order : branchSide.order);
  const byUnit = (left, right) => compareStrings(left.unitId, right.unitId);
  return {
    elements,
    files: mergeFiles(masterScene.files, branchScene.files),
    appState: mergeAppState(baseScene.appState, masterScene.appState, branchScene.appState),
    meta: Object.fromEntries([...metaOut.keys()].sort().map((id) => [id, metaOut.get(id)])),
    fastForward,
    applied: applied.sort(byUnit),
    overwritten: overwritten.sort(byUnit),
    unbound: unbound.sort((left, right) => compareStrings(left.arrowId, right.arrowId) || compareStrings(left.end, right.end)),
  };
}

// Z-order. When every merged element has a fractional `index`, sort by it (ties by id).
// Otherwise keep the primary side's order (master, or the branch on a fast-forward) and put
// each element only the other side has right after its nearest preceding neighbour there.
function orderElements(chosen, primaryOrder, secondaryOrder) {
  const all = [...chosen.values()];
  if (all.length && all.every((element) => typeof element.index === "string")) {
    return all.sort((left, right) => compareStrings(left.index, right.index) || compareStrings(left.id, right.id));
  }
  const primary = new Set(primaryOrder.filter((id) => chosen.has(id)));
  const after = new Map();
  let previous = HEAD;
  for (const id of secondaryOrder) {
    if (!chosen.has(id)) {
      continue;
    }
    if (!primary.has(id)) {
      const bucket = after.get(previous) ?? [];
      bucket.push(id);
      after.set(previous, bucket);
    }
    previous = id;
  }
  const result = [];
  // Depth-first, without recursion: inserts can chain (each anchored on the previous one).
  const emit = (anchor) => {
    const stack = [...(after.get(anchor) ?? [])].reverse();
    while (stack.length) {
      const id = stack.pop();
      result.push(chosen.get(id));
      const children = after.get(id) ?? [];
      for (let position = children.length - 1; position >= 0; position--) {
        stack.push(children[position]);
      }
    }
  };
  emit(HEAD);
  for (const id of primary) {
    result.push(chosen.get(id));
    emit(id);
  }
  return result;
}
