// Where a board element came from: named Mermaid sources and the dual origin of a shape.
// Shared by the server, the export tools and the canvas, so: no Node imports.
//
// customData of a Mermaid-converted element (stamped by the server, for tab conversions too):
//   xcldMermaidHash: "<hash>"                      the Mermaid it was last set from (kept for
//                                                  "Mermaid pending" and boards from before 6a)
//   xcldOrigin: {
//     mermaid: { source, nodeId, hash },           the Mermaid source and node it comes from
//     canvas: { author, at } | null,               the last canvas edit (any non-Mermaid write)
//     active: "mermaid" | "canvas",                which of the two the element shows now
//   }
// An element with only xcldMermaidHash (converted before 6a) belongs to the source `main`.
//
// Element ids: a node of source `main` keeps its Mermaid id (boards converted before named
// sources keep working); a node of any other source is `<source>:<nodeId>`, so two sources
// can use the same node ids on one board.
import { MERMAID_HASH_KEY } from "./mermaid-hash.mjs";
import { sameContent } from "./merge.mjs";

export const ORIGIN_KEY = "xcldOrigin";
export const DEFAULT_SOURCE = "main";
const SOURCE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

/** True for a usable source name: a letter, then up to 39 letters, digits, "_" or "-". */
export const isValidSourceName = (name) => typeof name === "string" && SOURCE_NAME.test(name);

/** The element-id prefix of a source: "" for `main`, "<source>:" otherwise. */
export const sourcePrefix = (source = DEFAULT_SOURCE) => (source === DEFAULT_SOURCE ? "" : `${source}:`);

/** The element id a Mermaid id gets in a source. */
export const sourceElementId = (source, mermaidId) => `${sourcePrefix(source)}${mermaidId}`;

/** The element's origin, or null for an element that never came from Mermaid. */
export const originOf = (element) => {
  const data = element?.customData;
  const origin = data?.[ORIGIN_KEY];
  if (origin && typeof origin === "object") {
    const mermaid = origin.mermaid && typeof origin.mermaid === "object" && typeof origin.mermaid.source === "string" ? origin.mermaid : null;
    const canvas = origin.canvas && typeof origin.canvas === "object" ? origin.canvas : null;
    const active = origin.active === "canvas" || origin.active === "mermaid" ? origin.active : mermaid ? "mermaid" : "canvas";
    return { mermaid, canvas, active };
  }
  const hash = data?.[MERMAID_HASH_KEY];
  if (typeof hash === "string" && hash) {
    // Converted before named sources: `main`, whose element ids are the Mermaid ids.
    const nodeId = element.type === "text" && element.containerId ? element.containerId : element.id ?? null;
    return { mermaid: { source: DEFAULT_SOURCE, nodeId, hash }, canvas: null, active: "mermaid" };
  }
  return null;
};

/** The Mermaid source an element belongs to, or null. */
export const sourceOf = (element) => originOf(element)?.mermaid?.source ?? null;

/** customData stamped with a Mermaid origin (`canvas` is kept; Mermaid is now active). */
export const mermaidCustomData = (customData, { source, nodeId, hash }, { keepCanvas = true } = {}) => {
  const previous = originOf({ customData });
  return {
    ...(customData ?? {}),
    [MERMAID_HASH_KEY]: hash,
    [ORIGIN_KEY]: {
      mermaid: { source, nodeId: nodeId ?? null, hash },
      canvas: keepCanvas ? previous?.canvas ?? null : null,
      active: "mermaid",
    },
  };
};

const ORIGIN_KEYS = [MERMAID_HASH_KEY, ORIGIN_KEY];

const customDataWithout = (customData) => {
  const rest = { ...(customData ?? {}) };
  for (const key of ORIGIN_KEYS) delete rest[key];
  return rest;
};
const withOrigin = (element, origin, hash) => {
  const customData = customDataWithout(element.customData);
  if (hash !== undefined && hash !== null) customData[MERMAID_HASH_KEY] = hash;
  if (origin) customData[ORIGIN_KEY] = origin;
  return { ...element, customData: Object.keys(customData).length || element.customData ? customData : undefined };
};

/**
 * Records canvas edits in a non-Mermaid write (a tab save, write_board, a CLI write). Pure.
 * Per element of `branch`, against the same element in `base` (what the writer started from):
 * - unchanged apart from bookkeeping and the origin keys (a tab that never saw the server's
 *   stamps, or an agent that re-sent the board with them dropped or redone): the base's origin is
 *   kept, so the write doesn't count as a change of that element;
 * - changed: the canvas origin becomes `{ author, at }` and `canvas` active (the Mermaid origin
 *   stays, so a later Mermaid write that changes the node can win it back);
 * - new (a board written in one go, or a human's copy of a Mermaid shape): left as sent. A copy
 *   has its own id, which no Mermaid write matches, and deletes only touch ids the source's
 *   previous Mermaid had.
 * Returns the branch array itself when nothing needs stamping.
 */
export const stampCanvasEdits = ({ base, branch, author, at }) => {
  if (!Array.isArray(branch)) return branch;
  let baseById = null;
  let changed = false;
  const out = branch.map((element) => {
    if (!element || element.isDeleted) return element;
    const own = originOf(element);
    baseById ??= new Map((Array.isArray(base) ? base : []).filter((item) => item && !item.isDeleted).map((item) => [item.id, item]));
    const previous = baseById.get(element.id);
    const baseOrigin = previous ? originOf(previous) : null;
    if (!own && !baseOrigin) return element;
    // A new element (also a human's copy of a Mermaid shape: it has its own id, which no Mermaid
    // write matches, and deletes only touch ids the source's Mermaid had), or one that gained an
    // origin: kept as the writer sent it.
    if (!previous || !baseOrigin) return element;
    // The common case, allocation-free: the element is exactly as the writer read it.
    if (element === previous) return element;
    const keep = previous.customData?.[ORIGIN_KEY] ?? null;
    const keepHash = previous.customData?.[MERMAID_HASH_KEY] ?? null;
    // Unchanged apart from bookkeeping and stamps (a tab that never saw the stamps, or a writer that
    // dropped or redid them, as agents re-sending a board do): the base's stamps come back, so the
    // write doesn't count as a canvas edit of that element.
    if (sameContent(element, previous)) {
      if (sameStamp(element.customData?.[ORIGIN_KEY], keep) && sameStamp(element.customData?.[MERMAID_HASH_KEY], keepHash)) return element;
      changed = true;
      return withOrigin(element, keep, keepHash);
    }
    changed = true;
    return withOrigin(element, { mermaid: baseOrigin.mermaid ?? null, canvas: { author, at }, active: "canvas" }, keepHash);
  });
  return changed ? out : branch;
};

const sortedJson = (value) => JSON.stringify(value ?? null, (_key, item) => (item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item));
const sameStamp = (left, right) => left === right || sortedJson(left) === sortedJson(right);

/**
 * A short description of the active origin, for to-mermaid and diff: null when not useful.
 * `authorName` names a canvas author key (diff --since passes one that tells two sessions of one
 * client apart); by default the key without its `#id`.
 */
export const describeOrigin = (element, { authorName = null } = {}) => {
  const origin = originOf(element);
  if (!origin) return null;
  const mermaid = origin.mermaid ? `Mermaid ${origin.mermaid.source}${origin.mermaid.nodeId ? `:${origin.mermaid.nodeId}` : ""}` : null;
  if (origin.active === "canvas") {
    const who = origin.canvas?.author ? (authorName ? authorName(String(origin.canvas.author)) : String(origin.canvas.author).replace(/#.*$/, "")) : "canvas";
    return { active: "canvas", text: `canvas edit by ${who}${mermaid ? ` (over ${mermaid})` : ""}`, source: origin.mermaid?.source ?? null };
  }
  return mermaid ? { active: "mermaid", text: mermaid, source: origin.mermaid.source } : null;
};
