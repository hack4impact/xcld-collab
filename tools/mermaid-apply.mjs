// Applies a parsed Mermaid flowchart (tools/mermaid-parse.mjs) to a board's current
// elements without a browser. Pure: the same inputs give the same output.
//
//   applyMermaid({ master, parsed, hashOfSource, now?, previous? })
//     -> { elements, ops, needsTabLayout, reason?, error? }
//
// - Identity: a Mermaid node id is the element id (the tab converts with regenerateIds:
//   false). Ids that to-mermaid had to rewrite (e.g. "-" -> "_") are mapped back the same
//   way, so a human-drawn shape exported by to-mermaid is updated, not duplicated. Edges
//   match an existing arrow bound start -> end first, then the converter's edge id
//   (`${start}_${end}`, `_2`, ... for parallel edges).
// - Existing shapes keep their geometry. Labels, shape type, classDef/class/style colors,
//   edge style and subgraph membership are updated. Bound text changes with its container.
// - Only Mermaid-origin elements (customData.xcldMermaidHash, stamped by the tab's converter
//   and by this module) are ever deleted, and only when the new Mermaid no longer has them.
//   With `previous` (the parse of the Mermaid the board was last built from), deletes are
//   limited to ids that Mermaid had. Arrows left pointing at a deleted shape are kept, unbound.
// - New shapes go next to a connected neighbour, in free space (no overlap with any live
//   element's bounding box), in the flowchart's direction; new edges are straight bound arrows.
// - A board with no Mermaid-origin shapes (new board, or an image fallback) returns
//   needsTabLayout: true and the elements unchanged: a tab lays out the whole diagram.
// Element JSON follows what mermaid-to-excalidraw + convertToExcalidrawElements produce in the
// tab. Text widths are estimated (no font metrics in Node); Excalidraw centers bound text, so
// the estimate only affects wrapping and the selection box.
import { MERMAID_HASH_KEY } from "./mermaid-hash.mjs";
import { DEFAULT_SOURCE, ORIGIN_KEY, mermaidCustomData, originOf, sourcePrefix } from "./mermaid-origin.mjs";
import { mermaidIdMapper } from "./to-mermaid.mjs";
import { describeUnlabeled, labelContext } from "./unit-label.mjs";

const FONT_SIZE = 20;
const FONT_FAMILY = 5;
const LINE_HEIGHT = 1.25;
const BOUND_TEXT_PADDING = 5;
const DEFAULT_STROKE = "#1e1e1e";
export const GAP_PRIMARY = 80;
export const GAP_CROSS = 40;
const CLEARANCE = 20;
export const SUBGRAPH_PADDING = 30;
export const SUBGRAPH_TITLE_SPACE = 40;
const ARROW_GAP = 4;
const PARALLEL_OFFSET = 30;
const SEARCH_STEPS = 30;
const SEARCH_CROSS = 8;
// Widths are estimates; wrap only when a line is clearly too wide, so a relabel rarely
// reshapes a box whose text the real font would fit.
const WRAP_TOLERANCE = 1.05;
const SHAPE_TYPES = new Set(["rectangle", "diamond", "ellipse"]);
const CONTAINER_DEFAULTS = { strokeColor: DEFAULT_STROKE, backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid" };
const SUBGRAPH_GROUP_PREFIX = "subgraph_group_";

// ---------------------------------------------------------------------------
// Fractional indices (Excalidraw's `index`): base-62 keys, ordered as plain strings.
// ---------------------------------------------------------------------------
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const integerLength = (head) => {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new Error(`invalid index head: ${head}`);
};
const integerPart = (key) => {
  const length = integerLength(key[0]);
  if (length > key.length) throw new Error(`invalid index: ${key}`);
  return key.slice(0, length);
};
const incrementInteger = (value) => {
  const head = value[0];
  const digits = value.slice(1).split("");
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const next = DIGITS.indexOf(digits[index]) + 1;
    if (next < DIGITS.length) {
      digits[index] = DIGITS[next];
      return head + digits.join("");
    }
    digits[index] = "0";
  }
  if (head === "Z") return "a0";
  if (head === "z") return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > "a") digits.push("0");
  else digits.pop();
  return nextHead + digits.join("");
};
const decrementInteger = (value) => {
  const head = value[0];
  const digits = value.slice(1).split("");
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const next = DIGITS.indexOf(digits[index]) - 1;
    if (next >= 0) {
      digits[index] = DIGITS[next];
      return head + digits.join("");
    }
    digits[index] = "z";
  }
  if (head === "a") return "Zz";
  if (head === "A") return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (nextHead < "Z") digits.push("z");
  else digits.pop();
  return nextHead + digits.join("");
};
const midpoint = (low, high) => {
  if (high !== null) {
    let shared = 0;
    while ((low[shared] ?? "0") === high[shared]) shared += 1;
    if (shared > 0) return high.slice(0, shared) + midpoint(low.slice(shared), high.slice(shared));
  }
  const lowDigit = low ? DIGITS.indexOf(low[0]) : 0;
  const highDigit = high !== null ? DIGITS.indexOf(high[0]) : DIGITS.length;
  if (highDigit - lowDigit > 1) return DIGITS[Math.round((lowDigit + highDigit) / 2)];
  if (high !== null && high.length > 1) return high.slice(0, 1);
  return DIGITS[lowDigit] + midpoint(low.slice(1), null);
};

/** True for a well-formed fractional index. */
export const isValidIndex = (key) => {
  if (typeof key !== "string" || !key || ![...key].every((char) => DIGITS.includes(char))) return false;
  try {
    const fraction = key.slice(integerPart(key).length);
    return !fraction.endsWith("0") && key !== "A" + "0".repeat(26);
  } catch {
    return false;
  }
};

/** A key strictly between `low` and `high` (either may be null for an open end). */
export const generateKeyBetween = (low, high) => {
  if (low !== null && high !== null && low >= high) throw new Error(`index ${low} is not below ${high}`);
  if (low === null) {
    if (high === null) return "a0";
    const highInteger = integerPart(high);
    const highFraction = high.slice(highInteger.length);
    if (highFraction) return highInteger;
    const decremented = decrementInteger(highInteger);
    if (decremented === null) throw new Error("index underflow");
    return decremented;
  }
  const lowInteger = integerPart(low);
  const lowFraction = low.slice(lowInteger.length);
  if (high === null) {
    return incrementInteger(lowInteger) ?? lowInteger + midpoint(lowFraction, null);
  }
  const highInteger = integerPart(high);
  if (lowInteger === highInteger) return lowInteger + midpoint(lowFraction, high.slice(highInteger.length));
  const incremented = incrementInteger(lowInteger);
  if (incremented !== null && incremented < high) return incremented;
  return lowInteger + midpoint(lowFraction, null);
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const fnv1a = (text) => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};
const intFor = (...parts) => (fnv1a(parts.join("\u0000")) % 2147483646) + 1;
const clone = (value) => JSON.parse(JSON.stringify(value));
const round = (value) => Math.round(value * 1000) / 1000;
const isLive = (element) => element && !element.isDeleted;
const hasMermaidOrigin = (element) => typeof element?.customData?.[MERMAID_HASH_KEY] === "string";
const textOf = (element) => element?.originalText ?? element?.text ?? "";
const arrowEnds = (element) => ({
  start: element.startBinding?.elementId ?? element.start?.id ?? null,
  end: element.endBinding?.elementId ?? element.end?.id ?? null,
});
const subgraphGroupIds = (groupIds) => (groupIds ?? []).filter((id) => String(id).startsWith(SUBGRAPH_GROUP_PREFIX));
const otherGroupIds = (groupIds) => (groupIds ?? []).filter((id) => !String(id).startsWith(SUBGRAPH_GROUP_PREFIX));
const sameList = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

// Excalifont at 20px, approximated per character class (calibrated against tab-converted boards).
const charWidth = (char) => {
  if (char === " ") return 0.35;
  if (/[il.,:;|!'`]/.test(char)) return 0.3;
  if (/[fjrt()[\]/\\-]/.test(char)) return 0.43;
  if (/[mwMW@%]/.test(char)) return 0.85;
  if (/[A-Z]/.test(char)) return 0.64;
  if (/[0-9]/.test(char)) return 0.56;
  return 0.54;
};
export const estimateTextWidth = (line, fontSize = FONT_SIZE) => {
  let width = 0;
  for (const char of String(line)) width += charWidth(char);
  return round(width * fontSize);
};
const wrapText = (text, maxWidth, fontSize) => {
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let current = "";
    for (const word of paragraph.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (!current || estimateTextWidth(candidate, fontSize) <= maxWidth * WRAP_TOLERANCE) {
        current = candidate;
        continue;
      }
      lines.push(current);
      current = word;
    }
    lines.push(current);
  }
  return lines.join("\n");
};
const textMetrics = (text, fontSize, lineHeight) => {
  const lines = String(text).split("\n");
  return {
    width: Math.max(0, ...lines.map((line) => estimateTextWidth(line, fontSize))),
    height: round(lines.length * fontSize * lineHeight),
  };
};

export const boxOf = (element) => {
  if (Array.isArray(element.points) && element.points.length) {
    const xs = element.points.map((point) => point[0]);
    const ys = element.points.map((point) => point[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: element.x + minX, y: element.y + minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  }
  let x = Number(element.x ?? 0);
  let y = Number(element.y ?? 0);
  let w = Number(element.width ?? 0);
  let h = Number(element.height ?? 0);
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  const angle = Number(element.angle ?? 0);
  if (!angle) return { x, y, w, h };
  const cx = x + w / 2;
  const cy = y + h / 2;
  const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => [
    cx + (px - cx) * Math.cos(angle) - (py - cy) * Math.sin(angle),
    cy + (px - cx) * Math.sin(angle) + (py - cy) * Math.cos(angle),
  ]);
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};
const overlaps = (left, right, clearance = 0) => left.x < right.x + right.w + clearance
  && right.x < left.x + left.w + clearance
  && left.y < right.y + right.h + clearance
  && right.y < left.y + left.h + clearance;
export const unionBox = (boxes) => {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  return {
    x: minX,
    y: minY,
    w: Math.max(...boxes.map((box) => box.x + box.w)) - minX,
    h: Math.max(...boxes.map((box) => box.y + box.h)) - minY,
  };
};
const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

// ---------------------------------------------------------------------------
// Converter conventions (mermaid-to-excalidraw converter/types/flowchart.ts)
// ---------------------------------------------------------------------------
export const shapeFor = (mermaidShape) => {
  if (mermaidShape === "diamond") return { type: "diamond", roundness: null };
  if (mermaidShape === "circle" || mermaidShape === "doublecircle") return { type: "ellipse", roundness: null };
  if (mermaidShape === "round" || mermaidShape === "stadium") return { type: "rectangle", roundness: { type: 3 } };
  return { type: "rectangle", roundness: null };
};

/** The size a new node's shape gets (as the converter would roughly lay it out). */
export const nodeSize = (node) => {
  const metrics = textMetrics(node.label || " ", FONT_SIZE, LINE_HEIGHT);
  const lines = String(node.label || " ").split("\n").length;
  const { type } = shapeFor(node.shape);
  if (type === "diamond") {
    const width = Math.max(100, Math.ceil(metrics.width * 2 + 4 * BOUND_TEXT_PADDING + 20));
    const height = Math.max(Math.round(width * 0.6), Math.ceil(metrics.height * 2 + 4 * BOUND_TEXT_PADDING + 20));
    return { width, height };
  }
  if (type === "ellipse") {
    const size = Math.max(80, Math.ceil((Math.max(metrics.width, metrics.height) + 2 * BOUND_TEXT_PADDING) * Math.SQRT2 + 20));
    return { width: size, height: size };
  }
  return { width: Math.max(80, Math.ceil(metrics.width + 60)), height: 30 + 30 * lines };
};

const edgeStyleFor = (edge) => ({
  strokeWidth: edge.stroke === "thick" ? 4 : 2,
  strokeStyle: edge.stroke === "dotted" ? "dashed" : "solid",
  startArrowhead: edge.arrowheads && "startArrowhead" in edge.arrowheads ? edge.arrowheads.startArrowhead : null,
  endArrowhead: edge.arrowheads && "endArrowhead" in edge.arrowheads ? edge.arrowheads.endArrowhead : "arrow",
});
// What Mermaid can say about an arrow: thick or not, dashed or not, and its arrowheads.
const edgeSignature = (style) => JSON.stringify([
  Number(style.strokeWidth ?? 2) >= 4,
  style.strokeStyle === "dashed" || style.strokeStyle === "dotted",
  style.startArrowhead ?? null,
  style.endArrowhead ?? null,
]);

/** Subgraph group ids, as the converter's computeGroupIds builds them (prefixed per source). */
const groupResolver = (parsed, prefix = "") => {
  const tree = {};
  const vertexIds = new Set(parsed.nodes.map((node) => node.id));
  for (const subgraph of parsed.subgraphs) {
    for (const nodeId of subgraph.nodes) {
      tree[subgraph.id] = { id: subgraph.id, parent: null, isLeaf: false };
      tree[nodeId] = { id: nodeId, parent: subgraph.id, isLeaf: vertexIds.has(nodeId) };
    }
  }
  const groupIdsFor = (id) => {
    let current = tree[id];
    if (!current) return [];
    const groupIds = current.isLeaf ? [] : [`${SUBGRAPH_GROUP_PREFIX}${prefix}${current.id}`];
    while (current?.parent) {
      groupIds.push(`${SUBGRAPH_GROUP_PREFIX}${prefix}${current.parent}`);
      current = tree[current.parent];
    }
    return groupIds;
  };
  return { groupIdsFor, parentOf: (id) => tree[id]?.parent ?? null };
};

/**
 * Element ids the tab's conversion would give each subgraph, node and edge: the
 * converter's skeleton order (subgraphs reversed, vertices, edges) through
 * disambiguateDuplicateElementIds (app/src/ids.mjs). A source other than `main` prefixes
 * every id with "<source>:" (tools/mermaid-origin.mjs).
 */
export const converterElementIds = (parsed, prefix = "") => {
  const used = new Set();
  const unique = (wanted) => {
    let candidate = String(wanted);
    let suffix = 2;
    while (used.has(candidate)) candidate = `${wanted}_${suffix++}`;
    used.add(candidate);
    return candidate;
  };
  const subgraphs = new Map();
  for (const subgraph of [...parsed.subgraphs].reverse()) subgraphs.set(subgraph.id, unique(`${prefix}${subgraph.id}`));
  const nodes = new Map();
  for (const node of parsed.nodes) nodes.set(node.id, unique(`${prefix}${node.id}`));
  const edges = parsed.edges.map((edge) => unique(`${prefix}${edge.start}_${edge.end}`));
  return { subgraphs, nodes, edges };
};

// ---------------------------------------------------------------------------
// Element factories (field order and defaults as convertToExcalidrawElements writes them)
// ---------------------------------------------------------------------------
const newElement = ({ id, type, x, y, width, height, groupIds = [], roundness = null, now, hash, origin = null, extra = {}, style = {} }) => ({
  id,
  type,
  x: round(x),
  y: round(y),
  width: round(width),
  height: round(height),
  angle: 0,
  ...CONTAINER_DEFAULTS,
  ...style,
  roughness: 1,
  opacity: 100,
  groupIds,
  frameId: null,
  index: null,
  roundness,
  seed: intFor(id, hash, "seed"),
  version: 1,
  versionNonce: intFor(id, hash, 1),
  isDeleted: false,
  boundElements: type === "text" || type === "arrow" ? null : [],
  updated: now,
  created: now,
  link: null,
  locked: false,
  customData: origin ? mermaidCustomData(null, { source: origin.source, nodeId: origin.nodeId, hash }) : { [MERMAID_HASH_KEY]: hash },
  ...extra,
});

const boundTextExtra = ({ text, originalText, containerId, verticalAlign, fontSize = FONT_SIZE, onArrow = false }) => ({
  text,
  fontSize,
  baseFontSize: null,
  fontFamily: FONT_FAMILY,
  textAlign: "center",
  verticalAlign,
  containerId,
  originalText,
  autoResize: true,
  lineHeight: LINE_HEIGHT,
  labelPosition: onArrow ? 0.5 : null,
});

const maxTextWidth = (container, fontSize) => {
  const width = Math.abs(Number(container.width ?? 0));
  if (container.type === "arrow") return Math.max(0.7 * width, fontSize * 11);
  if (container.type === "ellipse") return Math.round((width / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2;
  if (container.type === "diamond") return Math.round(width / 2) - BOUND_TEXT_PADDING * 2;
  return width - BOUND_TEXT_PADDING * 2;
};

const arrowLabelCenter = (arrow) => {
  const points = arrow.points ?? [[0, 0]];
  if (points.length % 2 === 1) {
    const [px, py] = points[(points.length - 1) / 2];
    return { x: arrow.x + px, y: arrow.y + py };
  }
  const [ax, ay] = points[points.length / 2 - 1];
  const [bx, by] = points[points.length / 2];
  return { x: arrow.x + (ax + bx) / 2, y: arrow.y + (ay + by) / 2 };
};

// ---------------------------------------------------------------------------
// applyMermaid
// ---------------------------------------------------------------------------
const stableJson = (value) => {
  if (value === null || value === undefined || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
};

/**
 * @param {object} input
 * @param {string} [input.source] The named Mermaid source (default `main`): only its shapes are
 *   matched, updated and deleted; new ids get its prefix (tools/mermaid-origin.mjs).
 * @param {Map<string, {x:number,y:number,w:number,h:number}>} [input.layout] Boxes for new nodes
 *   (the server's grid fallback). With a layout, a board without this source's shapes is laid
 *   out here instead of answering needsTabLayout.
 * @returns {{ elements, ops, needsTabLayout, reason?, error?, canvasOverwritten }}
 *   `canvasOverwritten`: units whose canvas edit (active `canvas`) this write replaced, with the
 *   canvas version of their elements, for history.
 */
export function applyMermaid({ master, parsed, hashOfSource, now = Date.now(), previous = null, source = DEFAULT_SOURCE, layout = null }) {
  const sourceElements = Array.isArray(master) ? master : Array.isArray(master?.elements) ? master.elements : [];
  const elements = clone(sourceElements);
  const ops = [];
  const canvasLosses = new Map();
  const unchanged = (extra) => ({ elements, ops, needsTabLayout: false, canvasOverwritten: [], ...extra });

  if (!parsed?.ok) {
    if (parsed?.unsupported) return unchanged({ needsTabLayout: true, reason: `unsupported diagram type: ${parsed.diagramType}` });
    return unchanged({ error: parsed?.error ?? { message: "no parse result" } });
  }
  if (typeof hashOfSource !== "string" || !hashOfSource) throw new Error("applyMermaid: hashOfSource is required");

  const prefix = sourcePrefix(source);
  const mermaidSourceOf = (element) => originOf(element)?.mermaid?.source ?? null;
  const owned = (element) => mermaidSourceOf(element) === source;
  const foreign = (element) => {
    const owner = mermaidSourceOf(element);
    return owner !== null && owner !== source;
  };
  const byId = new Map(elements.map((element) => [element.id, element]));
  const originalById = new Map(sourceElements.map((element) => [element.id, element]));
  const live = elements.filter(isLive);
  if (!layout && !live.some((element) => SHAPE_TYPES.has(element.type) && owned(element))) {
    const anyMermaid = live.some((element) => SHAPE_TYPES.has(element.type) && hasMermaidOrigin(element));
    const reason = !live.length ? "new board" : anyMermaid ? `board has no shapes from Mermaid source ${source}` : "board has no Mermaid-origin shapes";
    return unchanged({ needsTabLayout: true, reason });
  }

  const hash = hashOfSource;
  const touchedIds = new Set();
  const newIds = new Set();
  const stampable = new Set(live.filter(owned).map((element) => element.id));
  // Element id -> Mermaid id (node, subgraph, `start_end` edge), for the origin stamp.
  const nodeIdOf = new Map();
  const stamp = (element, active) => {
    const current = element.customData?.[ORIGIN_KEY];
    const origin = originOf(element);
    element.customData = {
      ...(element.customData ?? {}),
      [MERMAID_HASH_KEY]: hash,
      [ORIGIN_KEY]: {
        mermaid: { source, nodeId: nodeIdOf.get(element.id) ?? origin?.mermaid?.nodeId ?? null, hash },
        canvas: origin?.canvas ?? null,
        active: active ?? (current ? origin.active : "mermaid"),
      },
    };
  };
  const touch = (element) => {
    if (newIds.has(element.id)) return element;
    if (!touchedIds.has(element.id)) {
      touchedIds.add(element.id);
      element.version = Number(element.version ?? 0) + 1;
      element.versionNonce = intFor(element.id, hash, element.version);
      element.updated = now;
    }
    if (stampable.has(element.id)) stamp(element);
    return element;
  };
  // The unit (a container and its bound text) of an element, as it was before this write.
  const textsByContainer = new Map();
  for (const item of sourceElements) {
    if (isLive(item) && item.type === "text" && item.containerId) {
      const bucket = textsByContainer.get(item.containerId) ?? [];
      bucket.push(item);
      textsByContainer.set(item.containerId, bucket);
    }
  }
  const unitOf = (element) => {
    const container = element.type === "text" && element.containerId && originalById.has(element.containerId) ? originalById.get(element.containerId) : originalById.get(element.id);
    if (!container) return null;
    return { container, members: [container, ...(textsByContainer.get(container.id) ?? [])] };
  };
  // A Mermaid write that changes an element makes Mermaid its active origin again. When a canvas
  // edit was active, the canvas version of the unit goes to history as overwritten.
  const claim = (element) => {
    if (newIds.has(element.id) || !stampable.has(element.id)) return element;
    touch(element);
    stamp(element, "mermaid");
    const unit = unitOf(element);
    if (!unit || canvasLosses.has(unit.container.id)) return element;
    const canvas = unit.members
      .map((member) => originOf(member))
      .filter((origin) => origin?.active === "canvas" && origin.canvas)
      .map((origin) => origin.canvas)
      .sort((left, right) => Number(right.at ?? 0) - Number(left.at ?? 0))[0];
    if (!canvas) return element;
    const label = unit.members.filter((member) => member.type === "text").map((member) => textOf(member).replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
    canvasLosses.set(unit.container.id, {
      unitId: unit.container.id,
      ...(label ? { label } : { label: describeUnlabeled(unit.container, labelContext(sourceElements)), unlabeled: true }),
      elementIds: unit.members.map((member) => member.id).sort(),
      loser: { author: String(canvas.author ?? ""), writtenAt: Number(canvas.at ?? 0), elements: clone(unit.members) },
    });
    return element;
  };
  // A unit whose active origin is a canvas edit (on the shape or its label).
  const canvasActive = (element) => {
    const unit = unitOf(element);
    return Boolean(unit?.members.some((member) => originOf(member)?.active === "canvas"));
  };
  const insertAfter = new Map();
  const appended = [];
  const add = (element, afterId = null) => {
    const existing = byId.get(element.id);
    if (existing) {
      // Revive a tombstone (or replace an unmatched element) under the same id.
      element.version = Number(existing.version ?? 0) + 1;
      element.versionNonce = intFor(element.id, hash, element.version);
      element.index = existing.index ?? null;
      elements[elements.indexOf(existing)] = element;
    } else if (afterId) {
      const bucket = insertAfter.get(afterId) ?? [];
      bucket.push(element);
      insertAfter.set(afterId, bucket);
    } else {
      appended.push(element);
    }
    byId.set(element.id, element);
    newIds.add(element.id);
    return element;
  };
  const freshId = (wanted) => {
    let candidate = wanted;
    let suffix = 2;
    while (byId.has(candidate) && (isLive(byId.get(candidate)) || !owned(byId.get(candidate)))) candidate = `${wanted}_${suffix++}`;
    return candidate;
  };
  const boundTextOf = (container) => {
    const ref = (container.boundElements ?? []).find((bound) => bound?.type === "text");
    const viaRef = ref ? byId.get(ref.id) : null;
    if (isLive(viaRef) && viaRef.containerId === container.id) return viaRef;
    return elements.find((element) => isLive(element) && element.type === "text" && element.containerId === container.id) ?? null;
  };
  const addBound = (container, ref) => {
    const list = Array.isArray(container.boundElements) ? container.boundElements : [];
    if (list.some((bound) => bound.id === ref.id)) return;
    touch(container);
    container.boundElements = [...list, ref];
  };
  const removeBound = (container, id) => {
    if (!Array.isArray(container?.boundElements) || !container.boundElements.some((bound) => bound.id === id)) return;
    touch(container);
    container.boundElements = container.boundElements.filter((bound) => bound.id !== id);
  };

  // Lay out bound text in its container: wrap to the container's width, center it, and
  // grow the container's height (around its center) if the text no longer fits.
  const layoutText = (container, textElement) => {
    const fontSize = Number(textElement.fontSize ?? FONT_SIZE);
    const lineHeight = Number(textElement.lineHeight ?? LINE_HEIGHT);
    const original = textElement.originalText ?? textElement.text;
    if (container.type === "arrow") {
      textElement.text = wrapText(original, maxTextWidth(container, fontSize), fontSize);
      const metrics = textMetrics(textElement.text, fontSize, lineHeight);
      const center = arrowLabelCenter(container);
      Object.assign(textElement, { x: round(center.x - metrics.width / 2), y: round(center.y - metrics.height / 2), width: metrics.width, height: metrics.height });
      return null;
    }
    textElement.text = wrapText(original, Math.max(fontSize, maxTextWidth(container, fontSize)), fontSize);
    const metrics = textMetrics(textElement.text, fontSize, lineHeight);
    let resized = null;
    const needed = container.type === "rectangle"
      ? metrics.height + BOUND_TEXT_PADDING * 2
      : container.type === "ellipse" ? (metrics.height + BOUND_TEXT_PADDING * 2) * Math.SQRT2 : (metrics.height + BOUND_TEXT_PADDING * 2) * 2;
    if (needed > container.height + 0.5) {
      const from = { x: container.x, y: container.y, width: container.width, height: container.height };
      touch(container);
      container.y = round(container.y - (needed - container.height) / 2);
      container.height = round(needed);
      resized = { op: "resize", id: container.id, from, to: { x: container.x, y: container.y, width: container.width, height: container.height } };
    }
    const top = textElement.verticalAlign === "top";
    Object.assign(textElement, {
      x: round(container.x + (container.width - metrics.width) / 2),
      y: round(top ? container.y + BOUND_TEXT_PADDING : container.y + (container.height - metrics.height) / 2),
      width: metrics.width,
      height: metrics.height,
    });
    return resized;
  };

  // Set (or create, or remove) a container's label. Returns true if anything changed.
  const setLabel = (container, label, { verticalAlign = "middle", groupIds = container.groupIds ?? [], labelStyle = {} } = {}) => {
    const existing = boundTextOf(container);
    if (!label) {
      if (!existing) return false;
      claim(container);
      claim(existing);
      touch(existing).isDeleted = true;
      removeBound(container, existing.id);
      return true;
    }
    if (existing) {
      if (textOf(existing) === label) return false;
      claim(container);
      claim(existing);
      touch(existing);
      existing.originalText = label;
      const resized = layoutText(container, existing);
      if (resized) ops.push(resized);
      return true;
    }
    claim(container);
    const textId = freshId(`${container.id}_label`);
    nodeIdOf.set(textId, nodeIdOf.get(container.id) ?? null);
    const textElement = add(newElement({
      id: textId,
      type: "text",
      x: container.x,
      y: container.y,
      width: 0,
      height: 0,
      groupIds: [...groupIds],
      now,
      hash,
      origin: { source, nodeId: nodeIdOf.get(container.id) ?? null },
      style: { strokeColor: labelStyle.strokeColor ?? DEFAULT_STROKE },
      extra: boundTextExtra({ text: label, originalText: label, containerId: container.id, verticalAlign, onArrow: container.type === "arrow" }),
    }), container.id);
    addBound(container, { type: "text", id: textId });
    const resized = layoutText(container, textElement);
    if (resized) ops.push(resized);
    return true;
  };

  // Explicit Mermaid styles win; a property Mermaid no longer styles goes back to the
  // default only if `previous` shows Mermaid styled it before (otherwise a human did).
  const applyStyle = (element, wanted, previousWanted, defaults, kind, changes) => {
    for (const [key, value] of Object.entries(wanted ?? {})) {
      if (element[key] === value) continue;
      changes[`${kind}.${key}`] = { from: element[key] ?? null, to: value };
      claim(element);
      touch(element)[key] = value;
    }
    for (const key of Object.keys(previousWanted ?? {})) {
      if (wanted && key in wanted) continue;
      if (!(key in defaults) || element[key] === defaults[key] || element[key] !== previousWanted[key]) continue;
      changes[`${kind}.${key}`] = { from: element[key], to: defaults[key] };
      claim(element);
      touch(element)[key] = defaults[key];
    }
  };

  const ids = converterElementIds(parsed, prefix);
  const previousIds = previous?.ok ? converterElementIds(previous, prefix) : null;
  const previousNodes = new Map((previous?.ok ? previous.nodes : []).map((node) => [node.id, node]));
  const previousSubgraphs = new Map((previous?.ok ? previous.subgraphs : []).map((subgraph) => [subgraph.id, subgraph]));
  const { groupIdsFor, parentOf } = groupResolver(parsed, prefix);
  const previousGroups = previous?.ok ? groupResolver(previous, prefix) : null;
  // Mermaid's own definition of a node or subgraph is unchanged since `previous`: a canvas edit
  // of it stays (it is the active origin), and a shape deleted on the canvas isn't brought back.
  const sameNodeDef = (before, after) => Boolean(before && previousGroups)
    && (before.label ?? before.title ?? "") === (after.label ?? after.title ?? "")
    && (before.shape ?? null) === (after.shape ?? null)
    && (before.link ?? null) === (after.link ?? null)
    && stableJson(before.style) === stableJson(after.style)
    && sameList(previousGroups.groupIdsFor(before.id), groupIdsFor(after.id));
  // Edges of `previous` by start, end and occurrence (parallel edges count in order).
  const edgeKeys = (edges) => {
    const seen = new Map();
    return edges.map((edge) => {
      const pair = `${edge.start}\u0000${edge.end}`;
      const count = seen.get(pair) ?? 0;
      seen.set(pair, count + 1);
      return `${pair}\u0000${count}`;
    });
  };
  const previousEdgeByKey = new Map();
  if (previous?.ok) edgeKeys(previous.edges).forEach((key, index) => previousEdgeByKey.set(key, previous.edges[index]));
  const parsedEdgeKeys = edgeKeys(parsed.edges);
  const sameEdgeDef = (index) => {
    const before = previousEdgeByKey.get(parsedEdgeKeys[index]);
    const after = parsed.edges[index];
    return Boolean(before) && (before.label ?? "") === (after.label ?? "") && before.type === after.type && before.stroke === after.stroke;
  };
  for (const [mermaidId, elementId] of ids.subgraphs) nodeIdOf.set(elementId, mermaidId);
  for (const [mermaidId, elementId] of ids.nodes) nodeIdOf.set(elementId, mermaidId);
  parsed.edges.forEach((edge, index) => nodeIdOf.set(ids.edges[index], `${edge.start}_${edge.end}`));

  // to-mermaid's id mapping over the current board, so exported ids map back to elements. Only
  // for `main` (other sources' ids carry their prefix), and never to another source's shape.
  const toMermaidId = mermaidIdMapper();
  const elementIdByMermaidId = new Map();
  for (const element of live) {
    if (SHAPE_TYPES.has(element.type)) elementIdByMermaidId.set(toMermaidId(element.id), element.id);
  }
  const resolveShape = (mermaidId, converterId) => {
    const candidates = prefix ? [converterId] : [converterId, mermaidId, elementIdByMermaidId.get(mermaidId)];
    for (const candidate of candidates) {
      const element = candidate ? byId.get(candidate) : null;
      if (isLive(element) && SHAPE_TYPES.has(element.type) && !foreign(element)) return element;
    }
    return null;
  };

  // --- match subgraphs and nodes to existing shapes -------------------------
  const shapeByMermaidId = new Map();
  const matchedIds = new Set();
  const newSubgraphs = [];
  const newNodes = [];
  // Nodes of `previous`, unchanged since, that are no longer on the board: deleted on the
  // canvas. They stay deleted until a Mermaid write changes them.
  const canvasDeleted = new Set();
  const deletedOnCanvas = (mermaidId, before, after) => {
    if (layout || !sameNodeDef(before, after)) return false;
    canvasDeleted.add(mermaidId);
    ops.push({ op: "keep-canvas", id: ids.subgraphs.get(mermaidId) ?? ids.nodes.get(mermaidId) ?? mermaidId, kind: before.title !== undefined ? "subgraph" : "node", reason: "deleted on the canvas" });
    return true;
  };
  for (const subgraph of parsed.subgraphs) {
    const element = resolveShape(subgraph.id, ids.subgraphs.get(subgraph.id));
    if (element && !matchedIds.has(element.id)) {
      shapeByMermaidId.set(subgraph.id, element);
      matchedIds.add(element.id);
      nodeIdOf.set(element.id, subgraph.id);
    } else if (!deletedOnCanvas(subgraph.id, previousSubgraphs.get(subgraph.id), subgraph)) {
      newSubgraphs.push(subgraph);
    }
  }
  for (const node of parsed.nodes) {
    if (shapeByMermaidId.has(node.id) || canvasDeleted.has(node.id)) continue;
    const element = resolveShape(node.id, ids.nodes.get(node.id));
    if (element && !matchedIds.has(element.id)) {
      shapeByMermaidId.set(node.id, element);
      matchedIds.add(element.id);
      nodeIdOf.set(element.id, node.id);
    } else if (!deletedOnCanvas(node.id, previousNodes.get(node.id), node)) {
      newNodes.push(node);
    }
  }

  // --- match edges to existing arrows ---------------------------------------
  const arrows = live.filter((element) => element.type === "arrow" && !foreign(element));
  const edgeMatches = new Array(parsed.edges.length).fill(null);
  const claimed = new Set();
  const endpointsOf = (edge) => ({ start: shapeByMermaidId.get(edge.start)?.id ?? null, end: shapeByMermaidId.get(edge.end)?.id ?? null });
  const rank = (arrow, edgeId) => (arrow.id === edgeId ? 0 : owned(arrow) ? 1 : 2);
  parsed.edges.forEach((edge, index) => {
    const { start, end } = endpointsOf(edge);
    if (!start || !end) return;
    const candidates = arrows
      .filter((arrow) => !claimed.has(arrow.id))
      .filter((arrow) => {
        const ends = arrowEnds(arrow);
        return ends.start === start && ends.end === end;
      })
      .sort((left, right) => rank(left, ids.edges[index]) - rank(right, ids.edges[index]));
    if (candidates[0]) {
      edgeMatches[index] = { arrow: candidates[0], reconnect: false };
      claimed.add(candidates[0].id);
    }
  });
  // An unmatched Mermaid-origin arrow that carries the edge's converter id is the same edge,
  // reconnected (e.g. a human dragged its end to another shape).
  parsed.edges.forEach((edge, index) => {
    if (edgeMatches[index]) return;
    const arrow = byId.get(ids.edges[index]);
    if (isLive(arrow) && arrow.type === "arrow" && owned(arrow) && !claimed.has(arrow.id)) {
      edgeMatches[index] = { arrow, reconnect: true };
      claimed.add(arrow.id);
    }
  });

  // --- delete Mermaid-origin shapes and arrows that Mermaid no longer has ---
  const keptIds = new Set([...matchedIds, ...claimed]);
  const previousOwned = previousIds ? new Set([...previousIds.subgraphs.values(), ...previousIds.nodes.values(), ...previousIds.edges]) : null;
  const doubleCircleOwner = (element) => (element.groupIds ?? [])
    .map((groupId) => /^doublecircle_(.*)}$/.exec(String(groupId))?.[1])
    .find((owner) => owner && keptIds.has(owner));
  const deletedIds = new Set();
  for (const element of live) {
    if (element.isDeleted || !owned(element) || keptIds.has(element.id)) continue;
    if (element.type === "text" && element.containerId && isLive(byId.get(element.containerId))) continue;
    if (doubleCircleOwner(element)) continue;
    if (previousOwned && !previousOwned.has(element.id)) continue;
    const kind = element.type === "arrow" ? "edge" : SHAPE_TYPES.has(element.type) ? "node" : element.type;
    const label = boundTextOf(element);
    claim(element);
    touch(element).isDeleted = true;
    deletedIds.add(element.id);
    if (label && !label.isDeleted) {
      touch(label).isDeleted = true;
      deletedIds.add(label.id);
    }
    ops.push({ op: "delete", id: element.id, kind, ...(label ? { boundText: label.id } : {}) });
  }
  for (const element of elements) {
    if (!isLive(element)) continue;
    if (Array.isArray(element.boundElements) && element.boundElements.some((bound) => deletedIds.has(bound.id))) {
      touch(element).boundElements = element.boundElements.filter((bound) => !deletedIds.has(bound.id));
    }
    if (element.type === "arrow") {
      for (const key of ["startBinding", "endBinding"]) {
        if (element[key]?.elementId && deletedIds.has(element[key].elementId)) {
          ops.push({ op: "unbind", id: element.id, end: key === "startBinding" ? "start" : "end", from: element[key].elementId });
          touch(element)[key] = null;
        }
      }
    }
    if (element.type === "text" && element.containerId && deletedIds.has(element.containerId)) {
      touch(element).isDeleted = true;
    }
  }

  // --- update matched subgraphs and nodes ----------------------------------
  const regroup = (element, wanted) => {
    const current = subgraphGroupIds(element.groupIds);
    if (sameList(current, wanted)) return false;
    const next = [...wanted, ...otherGroupIds(element.groupIds)];
    ops.push({ op: "regroup", id: element.id, from: current, to: wanted });
    claim(element);
    touch(element).groupIds = next;
    const label = boundTextOf(element);
    if (label) touch(label).groupIds = [...wanted, ...otherGroupIds(label.groupIds)];
    return true;
  };
  // A canvas edit stays the active origin while Mermaid's definition of the shape is unchanged.
  const keepsCanvas = (element, before, after, kind) => {
    if (!canvasActive(element) || !sameNodeDef(before, after)) return false;
    ops.push({ op: "keep-canvas", id: element.id, kind, reason: "edited on the canvas; unchanged in Mermaid" });
    return true;
  };
  const updateShape = (mermaidId, label, styleSpec, previousStyle, kind, verticalAlign) => {
    const element = shapeByMermaidId.get(mermaidId);
    const before = textOf(boundTextOf(element));
    if (setLabel(element, label, { verticalAlign, labelStyle: styleSpec?.label ?? {} })) {
      ops.push({ op: "relabel", id: element.id, kind, from: before, to: label });
    }
    const changes = {};
    applyStyle(element, styleSpec?.container, previousStyle?.container, CONTAINER_DEFAULTS, "container", changes);
    const text = boundTextOf(element);
    if (text) applyStyle(text, styleSpec?.label, previousStyle?.label, { strokeColor: DEFAULT_STROKE }, "label", changes);
    if (Object.keys(changes).length) ops.push({ op: "restyle", id: element.id, kind, changes });
    regroup(element, groupIdsFor(mermaidId));
    return element;
  };
  for (const subgraph of parsed.subgraphs) {
    if (!shapeByMermaidId.has(subgraph.id) || newSubgraphs.includes(subgraph)) continue;
    if (keepsCanvas(shapeByMermaidId.get(subgraph.id), previousSubgraphs.get(subgraph.id), subgraph, "subgraph")) continue;
    updateShape(subgraph.id, subgraph.title, subgraph.style, previousSubgraphs.get(subgraph.id)?.style, "subgraph", "top");
  }
  for (const node of parsed.nodes) {
    if (newNodes.includes(node) || canvasDeleted.has(node.id)) continue;
    const element = shapeByMermaidId.get(node.id);
    if (keepsCanvas(element, previousNodes.get(node.id), node, "node")) continue;
    const wanted = shapeFor(node.shape);
    if (element.type !== wanted.type) {
      ops.push({ op: "reshape", id: element.id, from: element.type, to: wanted.type });
      claim(element);
      Object.assign(touch(element), { type: wanted.type, roundness: wanted.roundness });
      const text = boundTextOf(element);
      if (text) {
        touch(text);
        const resized = layoutText(element, text);
        if (resized) ops.push(resized);
      }
    }
    updateShape(node.id, node.label, node.style, previousNodes.get(node.id)?.style, "node", "middle");
  }

  // --- place new nodes next to a connected neighbour ------------------------
  const direction = String(parsed.direction ?? "TB").toUpperCase();
  const vertical = direction !== "LR" && direction !== "RL";
  const forward = direction === "BT" || direction === "RL" ? -1 : 1;
  const subgraphContainerIds = (mermaidId) => {
    const result = [];
    let parent = parentOf(mermaidId);
    while (parent) {
      const container = shapeByMermaidId.get(parent);
      if (container) result.push(container.id);
      parent = parentOf(parent);
    }
    return result;
  };
  // Live elements' boxes, except the given containers (a node may sit inside its own
  // subgraphs). Text inside a shape is covered by the shape; arrow labels count.
  const obstacles = (excluded = new Set()) => {
    const all = elements.concat(appended, [...insertAfter.values()].flat()).filter(isLive);
    const shapeIds = new Set(all.filter((element) => element.type !== "arrow").map((element) => element.id));
    return all
      .filter((element) => !excluded.has(element.id))
      .filter((element) => !(element.type === "text" && shapeIds.has(element.containerId) && !excluded.has(element.containerId)))
      .map((element) => ({ id: element.id, box: boxOf(element) }));
  };
  // sign > 0 places the box after the anchor in the flow direction, sign < 0 before it.
  const findSpot = (anchorBox, sign, size, excluded) => {
    const blockers = obstacles(excluded).map((item) => item.box);
    let origin;
    if (vertical) {
      origin = { x: anchorBox.x + anchorBox.w / 2 - size.width / 2, y: sign > 0 ? anchorBox.y + anchorBox.h + GAP_PRIMARY : anchorBox.y - GAP_PRIMARY - size.height };
    } else {
      origin = { x: sign > 0 ? anchorBox.x + anchorBox.w + GAP_PRIMARY : anchorBox.x - GAP_PRIMARY - size.width, y: anchorBox.y + anchorBox.h / 2 - size.height / 2 };
    }
    const primary = vertical ? { dx: 0, dy: sign * (size.height + GAP_PRIMARY) } : { dx: sign * (size.width + GAP_PRIMARY), dy: 0 };
    const cross = vertical ? { dx: size.width + GAP_CROSS, dy: 0 } : { dx: 0, dy: size.height + GAP_CROSS };
    const candidates = [];
    for (let step = 0; step < SEARCH_STEPS; step += 1) {
      for (let offset = -SEARCH_CROSS; offset <= SEARCH_CROSS; offset += 1) {
        candidates.push({ step, offset, cost: step * 2 + Math.abs(offset) });
      }
    }
    candidates.sort((left, right) => left.cost - right.cost || left.step - right.step || Math.abs(left.offset) - Math.abs(right.offset) || right.offset - left.offset);
    for (const { step, offset } of candidates) {
      const box = {
        x: origin.x + step * primary.dx + offset * cross.dx,
        y: origin.y + step * primary.dy + offset * cross.dy,
        w: size.width,
        h: size.height,
      };
      if (!blockers.some((blocker) => overlaps(box, blocker, CLEARANCE))) return box;
    }
    const all = blockers.length ? unionBox(blockers) : { x: 0, y: 0, w: 0, h: 0 };
    return vertical
      ? { x: origin.x, y: all.y + all.h + GAP_PRIMARY, w: size.width, h: size.height }
      : { x: all.x + all.w + GAP_PRIMARY, y: origin.y, w: size.width, h: size.height };
  };
  const createNode = (node, box, anchor, placement) => {
    const wanted = shapeFor(node.shape);
    const id = freshId(ids.nodes.get(node.id) ?? node.id);
    nodeIdOf.set(id, node.id);
    const groupIds = groupIdsFor(node.id);
    const element = add(newElement({
      id,
      type: wanted.type,
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      groupIds,
      roundness: wanted.roundness,
      now,
      hash,
      origin: { source, nodeId: node.id },
      style: node.style?.container ?? {},
      extra: { link: node.link ?? null },
    }));
    shapeByMermaidId.set(node.id, element);
    if (node.label) setLabel(element, node.label, { groupIds, labelStyle: node.style?.label ?? {} });
    ops.push({ op: "add-node", id, shape: wanted.type, x: element.x, y: element.y, width: element.width, height: element.height, anchor, placement });
  };
  // A layout (the grid fallback) places its nodes first; the rest go next to a neighbour.
  const pendingNodes = [];
  for (const node of newNodes) {
    const box = layout?.get(node.id);
    if (box) createNode(node, box, null, "grid");
    else pendingNodes.push(node);
  }
  while (pendingNodes.length) {
    let placed = false;
    for (const node of pendingNodes) {
      let anchor = null;
      let role = null;
      for (const edge of parsed.edges) {
        if (edge.end === node.id && edge.start !== node.id && shapeByMermaidId.has(edge.start)) {
          anchor = shapeByMermaidId.get(edge.start);
          role = "after";
          break;
        }
      }
      if (!anchor) {
        for (const edge of parsed.edges) {
          if (edge.start === node.id && edge.end !== node.id && shapeByMermaidId.has(edge.end)) {
            anchor = shapeByMermaidId.get(edge.end);
            role = "before";
            break;
          }
        }
      }
      if (!anchor) continue;
      const box = findSpot(boxOf(anchor), role === "before" ? -forward : forward, nodeSize(node), new Set(subgraphContainerIds(node.id)));
      createNode(node, box, anchor.id, role);
      pendingNodes.splice(pendingNodes.indexOf(node), 1);
      placed = true;
      break;
    }
    if (placed) continue;
    // Nothing connects the remaining nodes to the board yet: start beside the drawing
    // (right of it for top-down charts, below it for left-right ones).
    const node = pendingNodes.shift();
    const size = nodeSize(node);
    const all = unionBox(obstacles().map((item) => item.box));
    const anchorBox = vertical
      ? { x: all.x + all.w + GAP_CROSS, y: all.y - GAP_PRIMARY, w: size.width, h: 0 }
      : { x: all.x - GAP_PRIMARY, y: all.y + all.h + GAP_CROSS, w: 0, h: size.height };
    createNode(node, findSpot(anchorBox, 1, size, new Set(subgraphContainerIds(node.id))), null, "free");
  }

  // --- subgraph containers: create new ones, grow existing ones to fit members ---
  const depth = (id) => {
    let count = 0;
    for (let parent = parentOf(id); parent; parent = parentOf(parent)) count += 1;
    return count;
  };
  const subgraphsDeepestFirst = [...parsed.subgraphs].sort((left, right) => depth(right.id) - depth(left.id));
  for (const subgraph of subgraphsDeepestFirst) {
    if (canvasDeleted.has(subgraph.id)) continue;
    const memberBoxes = subgraph.nodes
      .map((id) => shapeByMermaidId.get(id))
      .filter(Boolean)
      .map((element) => boxOf(element));
    const existing = shapeByMermaidId.get(subgraph.id);
    if (existing) {
      if (!memberBoxes.length) continue;
      const box = boxOf(existing);
      const needed = unionBox(memberBoxes);
      const padded = { x: needed.x - SUBGRAPH_PADDING, y: needed.y - SUBGRAPH_TITLE_SPACE, w: needed.w + 2 * SUBGRAPH_PADDING, h: needed.h + SUBGRAPH_TITLE_SPACE + SUBGRAPH_PADDING };
      if (memberBoxes.every((member) => contains(box, member))) continue;
      const grown = unionBox([box, padded]);
      const from = { x: existing.x, y: existing.y, width: existing.width, height: existing.height };
      Object.assign(touch(existing), { x: round(grown.x), y: round(grown.y), width: round(grown.w), height: round(grown.h) });
      ops.push({ op: "resize", id: existing.id, from, to: { x: existing.x, y: existing.y, width: existing.width, height: existing.height } });
      const label = boundTextOf(existing);
      if (label) layoutText(existing, touch(label));
      continue;
    }
    const needed = memberBoxes.length ? unionBox(memberBoxes) : { x: 0, y: 0, w: 160, h: 80 };
    const titleWidth = estimateTextWidth(subgraph.title || subgraph.id) + 2 * 32;
    const width = Math.max(needed.w + 2 * SUBGRAPH_PADDING, titleWidth);
    const id = freshId(ids.subgraphs.get(subgraph.id) ?? subgraph.id);
    nodeIdOf.set(id, subgraph.id);
    const groupIds = groupIdsFor(subgraph.id);
    const firstMember = subgraph.nodes.map((memberId) => shapeByMermaidId.get(memberId)).find(Boolean);
    const container = newElement({
      id,
      type: "rectangle",
      x: needed.x + needed.w / 2 - width / 2,
      y: needed.y - SUBGRAPH_TITLE_SPACE,
      width,
      height: needed.h + SUBGRAPH_TITLE_SPACE + SUBGRAPH_PADDING,
      groupIds,
      now,
      hash,
      origin: { source, nodeId: subgraph.id },
      style: subgraph.style?.container ?? {},
    });
    // Subgraph containers sit below their members, as in the converter's output.
    if (byId.has(id) || !firstMember) {
      add(container);
    } else if (!newIds.has(firstMember.id)) {
      elements.splice(elements.indexOf(firstMember), 0, container);
      byId.set(container.id, container);
      newIds.add(container.id);
    } else {
      const position = appended.indexOf(firstMember);
      appended.splice(position < 0 ? appended.length : position, 0, container);
      byId.set(container.id, container);
      newIds.add(container.id);
    }
    shapeByMermaidId.set(subgraph.id, container);
    if (subgraph.title) setLabel(container, subgraph.title, { verticalAlign: "top", groupIds, labelStyle: subgraph.style?.label ?? {} });
    ops.push({ op: "add-subgraph", id, members: subgraph.nodes.map((memberId) => shapeByMermaidId.get(memberId)?.id).filter(Boolean) });
    for (const memberId of subgraph.nodes) {
      const member = shapeByMermaidId.get(memberId);
      if (member && !newIds.has(member.id)) regroup(member, groupIdsFor(memberId));
    }
  }

  // --- edges -----------------------------------------------------------------
  // `bend` > 0 bows the arrow sideways (alternating sides) so parallel edges stay apart.
  const route = (startShape, endShape, bend = 0) => {
    const startBox = boxOf(startShape);
    const endBox = boxOf(endShape);
    const startCenter = { x: startBox.x + startBox.w / 2, y: startBox.y + startBox.h / 2 };
    const endCenter = { x: endBox.x + endBox.w / 2, y: endBox.y + endBox.h / 2 };
    if (startShape === endShape) {
      const from = { x: startBox.x + startBox.w + ARROW_GAP, y: startCenter.y };
      const to = { x: startCenter.x + startBox.w / 4, y: startBox.y - ARROW_GAP };
      return { from, to, via: [{ x: startBox.x + startBox.w + 40, y: startBox.y - 40 }] };
    }
    const edgePoint = (shape, box, center, toward) => {
      const dx = toward.x - center.x;
      const dy = toward.y - center.y;
      const length = Math.hypot(dx, dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      const halfW = Math.max(box.w / 2, 0.5);
      const halfH = Math.max(box.h / 2, 0.5);
      let distance;
      if (shape.type === "ellipse") distance = 1 / Math.sqrt((ux * ux) / (halfW * halfW) + (uy * uy) / (halfH * halfH));
      else if (shape.type === "diamond") distance = 1 / (Math.abs(ux) / halfW + Math.abs(uy) / halfH);
      else distance = Math.min(ux ? halfW / Math.abs(ux) : Infinity, uy ? halfH / Math.abs(uy) : Infinity);
      return { x: center.x + ux * (distance + ARROW_GAP), y: center.y + uy * (distance + ARROW_GAP) };
    };
    const from = edgePoint(startShape, startBox, startCenter, endCenter);
    const to = edgePoint(endShape, endBox, endCenter, startCenter);
    if (!bend) return { from, to, via: [] };
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const offset = PARALLEL_OFFSET * Math.ceil(bend / 2) * (bend % 2 ? 1 : -1);
    return { from, to, via: [{ x: (from.x + to.x) / 2 - (dy / length) * offset, y: (from.y + to.y) / 2 + (dx / length) * offset }] };
  };
  const fixedPoint = (shape, point) => {
    const box = boxOf(shape);
    // Excalidraw stores a centered fixed point as 0.5001 (normalizeFixedPoint).
    const ratio = (value) => (Math.abs(value - 0.5) < 0.0001 ? 0.5001 : value);
    return [ratio((point.x - box.x) / (box.w || 1)), ratio((point.y - box.y) / (box.h || 1))];
  };
  const geometry = (startShape, endShape, bend = 0) => {
    const { from, to, via } = route(startShape, endShape, bend);
    const points = [[0, 0], ...via.map((point) => [round(point.x - from.x), round(point.y - from.y)]), [round(to.x - from.x), round(to.y - from.y)]];
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    return {
      x: round(from.x),
      y: round(from.y),
      width: round(Math.max(...xs) - Math.min(...xs)),
      height: round(Math.max(...ys) - Math.min(...ys)),
      points,
      startBinding: { elementId: startShape.id, mode: "orbit", fixedPoint: fixedPoint(startShape, from) },
      endBinding: { elementId: endShape.id, mode: "orbit", fixedPoint: fixedPoint(endShape, to) },
    };
  };
  // Live arrows already joining the two shapes (either way), so a new one can bow around them.
  const parallelCount = (startShape, endShape, exceptId) => (startShape.boundElements ?? [])
    .filter((bound) => bound.type === "arrow" && bound.id !== exceptId)
    .map((bound) => byId.get(bound.id))
    .filter((arrow) => isLive(arrow) && arrow.type === "arrow")
    .filter((arrow) => {
      const ends = arrowEnds(arrow);
      return (ends.start === startShape.id && ends.end === endShape.id) || (ends.start === endShape.id && ends.end === startShape.id);
    }).length;
  const edgeGroupIds = (edge) => {
    const startParent = parentOf(edge.start);
    return startParent && startParent === parentOf(edge.end) ? groupIdsFor(startParent) : [];
  };

  parsed.edges.forEach((edge, index) => {
    const startShape = shapeByMermaidId.get(edge.start);
    const endShape = shapeByMermaidId.get(edge.end);
    if (!startShape || !endShape) {
      ops.push({ op: "skip", kind: "edge", start: edge.start, end: edge.end, reason: "endpoint not on the board" });
      return;
    }
    const wantedStyle = edgeStyleFor(edge);
    const match = edgeMatches[index];
    const edgeNodeId = `${edge.start}_${edge.end}`;
    if (match) {
      const { arrow } = match;
      if (!nodeIdOf.has(arrow.id)) nodeIdOf.set(arrow.id, edgeNodeId);
      if (canvasActive(arrow) && sameEdgeDef(index)) {
        ops.push({ op: "keep-canvas", id: arrow.id, kind: "edge", reason: "edited on the canvas; unchanged in Mermaid" });
        return;
      }
      if (match.reconnect) {
        const ends = arrowEnds(arrow);
        for (const oldEnd of [ends.start, ends.end]) {
          if (oldEnd && oldEnd !== startShape.id && oldEnd !== endShape.id) removeBound(byId.get(oldEnd), arrow.id);
        }
        claim(arrow);
        Object.assign(touch(arrow), geometry(startShape, endShape, parallelCount(startShape, endShape, arrow.id)));
        addBound(startShape, { id: arrow.id, type: "arrow" });
        addBound(endShape, { id: arrow.id, type: "arrow" });
        ops.push({ op: "reconnect", id: arrow.id, start: startShape.id, end: endShape.id });
        const label = boundTextOf(arrow);
        if (label) layoutText(arrow, touch(label));
      }
      const before = textOf(boundTextOf(arrow));
      if (setLabel(arrow, edge.label, { groupIds: edgeGroupIds(edge) })) {
        ops.push({ op: "relabel", id: arrow.id, kind: "edge", from: before, to: edge.label });
      }
      if (edgeSignature(arrow) !== edgeSignature(wantedStyle)) {
        const changes = {};
        for (const [key, value] of Object.entries(wantedStyle)) {
          if ((arrow[key] ?? null) !== value) changes[key] = { from: arrow[key] ?? null, to: value };
        }
        claim(arrow);
        Object.assign(touch(arrow), wantedStyle);
        ops.push({ op: "restyle", id: arrow.id, kind: "edge", changes });
      }
      if (owned(arrow)) {
        const wantedGroups = edgeGroupIds(edge);
        if (!sameList(subgraphGroupIds(arrow.groupIds), wantedGroups)) {
          ops.push({ op: "regroup", id: arrow.id, from: subgraphGroupIds(arrow.groupIds), to: wantedGroups });
          claim(arrow);
          touch(arrow).groupIds = [...wantedGroups, ...otherGroupIds(arrow.groupIds)];
        }
      }
      return;
    }
    // An unchanged edge between two shapes that were already on the board, deleted on the canvas.
    if (!layout && sameEdgeDef(index) && !newIds.has(startShape.id) && !newIds.has(endShape.id)) {
      ops.push({ op: "keep-canvas", id: ids.edges[index], kind: "edge", reason: "deleted on the canvas" });
      return;
    }
    const id = freshId(ids.edges[index]);
    nodeIdOf.set(id, edgeNodeId);
    const groupIds = edgeGroupIds(edge);
    const arrow = add(newElement({
      id,
      type: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      groupIds,
      roundness: { type: 2 },
      now,
      hash,
      origin: { source, nodeId: edgeNodeId },
      style: { strokeWidth: wantedStyle.strokeWidth, strokeStyle: wantedStyle.strokeStyle },
      extra: {
        points: [],
        startBinding: null,
        endBinding: null,
        startArrowhead: wantedStyle.startArrowhead,
        endArrowhead: wantedStyle.endArrowhead,
        elbowed: false,
      },
    }));
    Object.assign(arrow, geometry(startShape, endShape, parallelCount(startShape, endShape, id)));
    addBound(startShape, { id, type: "arrow" });
    addBound(endShape, { id, type: "arrow" });
    if (edge.label) setLabel(arrow, edge.label, { groupIds });
    ops.push({ op: "add-edge", id, start: startShape.id, end: endShape.id, ...(edge.label ? { label: edge.label } : {}) });
  });

  // --- assemble: inserted elements after their anchors, then fractional indices ----
  const result = [];
  for (const element of elements) {
    result.push(element);
    for (const inserted of insertAfter.get(element.id) ?? []) result.push(inserted);
  }
  for (const element of appended) {
    result.push(element);
    for (const inserted of insertAfter.get(element.id) ?? []) result.push(inserted);
  }
  for (let index = 0; index < result.length; index += 1) {
    const element = result[index];
    if (!newIds.has(element.id) || isValidIndex(element.index)) continue;
    const low = result.slice(0, index).reverse().find((item) => isValidIndex(item.index))?.index ?? null;
    const high = result.slice(index + 1).find((item) => !newIds.has(item.id) && isValidIndex(item.index))?.index ?? null;
    try {
      element.index = generateKeyBetween(low, high !== null && low !== null && high <= low ? null : high);
    } catch {
      element.index = null;
    }
  }
  return { elements: result, ops, needsTabLayout: false, canvasOverwritten: [...canvasLosses.values()].sort((left, right) => (left.unitId < right.unitId ? -1 : left.unitId > right.unitId ? 1 : 0)) };
}
