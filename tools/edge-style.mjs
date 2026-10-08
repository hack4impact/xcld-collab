// Arrow and line styles: what Mermaid can say about an edge, and how the ledger words a change.
// Shared by to-mermaid (export), mermaid-apply (apply), merge (applied units) and diff, and
// bundled into the canvas, so: no Node imports. Round-trip table: docs/DESIGN.md#mermaid-round-trip.
//
// Mermaid 11.17 flowchart edges carry, per edge:
//   stroke   normal `--`, thick `==`, dotted `-.` (Excalidraw: width 4 = thick; dashed or dotted = dotted)
//   heads    none `---`, end `-->` / `--o` / `--x`, both `<-->` / `o--o` / `x--x` (one kind on both
//            ends; a head on the start only, or two different kinds, has no Mermaid form)
//   curve    per edge with an edge id: `a e1@--> b` plus `e1@{ curve: linear }` (Mermaid 11.10+)
// Excalidraw has more: dashed vs dotted, thick and dashed at once, widths 1/2/4, colours, and
// heads such as triangle, diamond or crow's foot. Those stay canvas-only: a Mermaid write never
// resets them unless it changes that edge's Mermaid form in the same dimension.

// Head kinds Mermaid knows. Excalidraw's other heads show as the nearest kind.
const HEAD_KINDS = new Map([
  ["arrow", "arrow"], ["triangle", "arrow"], ["triangle_outline", "arrow"], ["diamond", "arrow"], ["diamond_outline", "arrow"],
  ["crowfoot_one", "arrow"], ["crowfoot_many", "arrow"], ["crowfoot_one_or_many", "arrow"],
  ["circle", "circle"], ["circle_outline", "circle"], ["dot", "circle"],
  ["bar", "cross"],
]);
// The Excalidraw head a Mermaid head kind draws (mermaid-to-excalidraw's computeExcalidrawArrowType).
const KIND_HEAD = { arrow: "arrow", circle: "circle", cross: "bar" };
const KIND_MARK = { circle: "o", cross: "x" };
// Heads Mermaid draws exactly; any other head is shown as its kind.
const EXACT_HEADS = new Set(["arrow", "circle", "bar"]);

/** The Mermaid head kind of an Excalidraw arrowhead: null (none), "arrow", "circle" or "cross". */
export const headKind = (head) => (head === undefined || head === null || head === "none" ? null : HEAD_KINDS.get(head) ?? "arrow");

/** Mermaid curve name -> the Excalidraw arrow type it means: "straight", "curved" or "elbow". */
export const curveShape = (curve) => {
  if (typeof curve !== "string" || !curve) return null;
  if (curve === "linear") return "straight";
  if (/^step/.test(curve)) return "elbow";
  return "curved";
};
/** The arrow type an Excalidraw arrow or line has: "elbow", "straight" or "curved". */
export const canvasShape = (element) => (element?.elbowed ? "elbow" : element?.roundness ? "curved" : "straight");
// The curve name exported for each arrow type. Curved is the default (converted Mermaid draws
// curved arrows), so it is never written out.
const SHAPE_CURVE = { straight: "linear", elbow: "step", curved: "basis" };

/**
 * The Mermaid form of an arrow, exactly as tools/to-mermaid.mjs writes it:
 * `{ type, stroke, curve, start, end }` with `type` and `stroke` as Mermaid's parser names them
 * (arrow_open, arrow_point, arrow_circle, arrow_cross, double_arrow_*; normal, thick, dotted),
 * `curve` "linear", "step" or null (curved, the default) and `start`/`end` the head kinds the
 * form shows. `notes` lists what the form can't show.
 */
export const edgeForm = (element) => {
  const startHead = element?.startArrowhead;
  const endHead = element?.endArrowhead === undefined ? "arrow" : element.endArrowhead;
  let start = headKind(startHead);
  const end = headKind(endHead);
  const notes = [];
  for (const [side, head] of [["start", startHead], ["end", endHead]]) {
    if (headKind(head) && !EXACT_HEADS.has(head)) notes.push(`${side} arrowhead ${head}`);
  }
  // Mermaid has no head on the start alone, nor two kinds of head: the start head stays canvas-only.
  if (start && (!end || start !== end)) {
    if (EXACT_HEADS.has(startHead)) notes.push(end ? `start arrowhead ${startHead}` : "arrowhead on the start only");
    start = null;
  }
  const type = !end ? "arrow_open" : `${start ? "double_" : ""}arrow_${end === "arrow" ? "point" : end}`;
  const dashed = element?.strokeStyle === "dashed" || element?.strokeStyle === "dotted";
  const thick = Number(element?.strokeWidth ?? 2) >= 4;
  if (dashed && thick) notes.push("thick");
  const stroke = dashed ? "dotted" : thick ? "thick" : "normal";
  const shape = canvasShape(element);
  return { type, stroke, curve: shape === "curved" ? null : SHAPE_CURVE[shape], start, end, notes };
};

/** Head kinds per end of a parsed Mermaid edge type. */
export const typeHeads = (type) => {
  const match = /^(double_)?arrow_(open|point|circle|cross)$/.exec(String(type ?? "arrow_point"));
  if (!match || match[2] === "open") return { start: null, end: null };
  const kind = match[2] === "point" ? "arrow" : match[2];
  return { start: match[1] ? kind : null, end: kind };
};

/** The Mermaid link operator for a form (`-->`, `<-.->`, `===`, `o--o`, ...). */
export const edgeOperator = ({ type, stroke }) => {
  const { start, end } = typeHeads(type);
  if (!end) return stroke === "thick" ? "===" : stroke === "dotted" ? "-.-" : "---";
  const body = stroke === "thick" ? "==" : stroke === "dotted" ? "-.-" : "--";
  const mark = (kind, side) => (kind === "arrow" ? (side === "start" ? "<" : ">") : KIND_MARK[kind]);
  return `${start ? mark(start, "start") : ""}${body}${mark(end, "end")}`;
};

/**
 * The style an apply gives a Mermaid edge's dimensions, per dimension of a parsed edge:
 * `thick` and `dotted` (stroke), `start`/`end` head kinds, `shape` (null when the edge has no
 * curve of its own).
 */
export const formDimensions = (form) => {
  const heads = typeHeads(form?.type);
  return {
    thick: form?.stroke === "thick",
    dotted: form?.stroke === "dotted",
    start: heads.start,
    end: heads.end,
    shape: curveShape(form?.curve),
  };
};

/**
 * The Excalidraw properties that make `element` show a Mermaid dimension value, or {} when the
 * element already shows it (a dotted canvas arrow stays dotted under Mermaid's dotted, a triangle
 * head stays a triangle under Mermaid's arrow, a thin arrow stays thin under Mermaid's normal).
 */
export const styleFor = (element, dimension, value) => {
  switch (dimension) {
    case "thick":
      if (value) return Number(element.strokeWidth ?? 2) >= 4 ? {} : { strokeWidth: 4 };
      return Number(element.strokeWidth ?? 2) >= 4 ? { strokeWidth: 2 } : {};
    case "dotted": {
      const dashed = element.strokeStyle === "dashed" || element.strokeStyle === "dotted";
      if (value) return dashed ? {} : { strokeStyle: "dashed" };
      return dashed ? { strokeStyle: "solid" } : {};
    }
    case "start":
    case "end": {
      const key = dimension === "start" ? "startArrowhead" : "endArrowhead";
      const current = dimension === "end" && element.endArrowhead === undefined ? "arrow" : element[key];
      if (headKind(current) === value) return {};
      return { [key]: value ? KIND_HEAD[value] : null };
    }
    case "shape":
      if (!value || canvasShape(element) === value) return {};
      if (value === "elbow") return { elbowed: true, roundness: null };
      return { elbowed: false, roundness: value === "curved" ? { type: 2 } : null };
    default:
      return {};
  }
};

// --- the ledger -----------------------------------------------------------------------------

/** Style properties of arrows and lines the ledger reports, besides the shared ones. */
export const LINE_STYLE_PROPS = ["roundness", "elbowed", "startArrowhead", "endArrowhead"];
const HEAD_WORDS = {
  arrow: "arrow", bar: "bar", dot: "dot", circle: "circle", circle_outline: "circle (outline)", triangle: "triangle",
  triangle_outline: "triangle (outline)", diamond: "diamond", diamond_outline: "diamond (outline)",
  crowfoot_one: "crow's foot (one)", crowfoot_many: "crow's foot (many)", crowfoot_one_or_many: "crow's foot (one or many)",
};
const headWord = (head) => (head === undefined || head === null || head === "none" ? "none" : HEAD_WORDS[head] ?? String(head));
const WIDTH_WORDS = { 1: "thin", 2: "bold", 4: "extra bold" };
const widthWord = (width) => WIDTH_WORDS[Number(width)] ?? `width ${width}`;

/**
 * Readable words for how an arrow or line's style changed between two copies: "made dashed",
 * "made straight", "made elbow", "end arrowhead to triangle", "made thick", "colour to #e03131".
 * Empty when nothing a person would see changed.
 */
export const describeLineStyleChange = (before, after) => {
  if (!before || !after) return [];
  const words = [];
  const style = (element) => element.strokeStyle ?? "solid";
  if (style(before) !== style(after)) words.push(`made ${style(after)}`);
  if (Number(before.strokeWidth ?? 2) !== Number(after.strokeWidth ?? 2)) words.push(`made ${widthWord(after.strokeWidth ?? 2)}`);
  if (canvasShape(before) !== canvasShape(after)) words.push(`made ${canvasShape(after)}`);
  const end = (element) => (element.type === "arrow" && element.endArrowhead === undefined ? "arrow" : element.endArrowhead);
  if (headWord(before.startArrowhead) !== headWord(after.startArrowhead)) words.push(`start arrowhead to ${headWord(after.startArrowhead)}`);
  if (headWord(end(before)) !== headWord(end(after))) words.push(`${after.type === "arrow" ? "arrowhead" : "end arrowhead"} to ${headWord(end(after))}`);
  if ((before.strokeColor ?? null) !== (after.strokeColor ?? null)) words.push(`colour to ${after.strokeColor ?? "default"}`);
  return words;
};

/** Words for one style property change of an arrow or line (diff's Style section). */
export const describeLineProperty = (property, from, to, type = "arrow") => {
  switch (property) {
    case "strokeStyle": return `made ${to ?? "solid"}`;
    case "strokeWidth": return `made ${widthWord(to ?? 2)}`;
    case "roundness": return to ? "made curved" : "made straight";
    case "elbowed": return to ? "made elbow" : "made not elbow";
    case "startArrowhead": return `start arrowhead to ${headWord(to)}`;
    case "endArrowhead": return `${type === "arrow" ? "arrowhead" : "end arrowhead"} to ${headWord(to)}`;
    case "strokeColor": return `colour to ${to ?? "default"}`;
    default: return null;
  }
};
