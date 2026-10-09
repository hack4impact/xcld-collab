// Upgrade migration: Mermaid shapes from a build before versions.
//
// Before versions (up to 0d7330e), a tab converted the board's `.mmd` inbox and REPLACED the
// board with the result, unstamped: no xcldMermaidHash, no xcldOrigin. The ids follow the
// converter (regenerateIds: false): a node or subgraph is its Mermaid id, an edge
// `<start>_<end>` (`_2`, ... for parallel ones). The `.mmd` stays on disk afterwards. On a
// versions build such a board has no shapes of source `main`, so the leftover inbox would be
// taken for a new diagram and added again as a group, every id clashing (`<id>_2`).
//
// Instead, an inbox from before the upgrade is adopted: the shapes it made are stamped as source
// `main` (the node of the Mermaid each one is), and the inbox becomes main's last applied
// Mermaid. Nothing on the board changes. A shape whose label or style differs from that Mermaid
// was edited on the canvas since: its canvas origin is active, so a later Mermaid write keeps the
// edit unless it changes that node. Only exact converter ids are adopted, and only unstamped
// shapes; anything else (a hand-drawn shape, another source's) stays as it is.
//
//   legacyAdoption({ elements, parsed, writtenAt }) -> { adopt, count }
//     adopt: { [elementId]: { nodeId, canvas: { author, at } | null } }   (JSON, for the journal)
//   applyAdoption(elements, adopt, hash) -> elements (the same array when nothing to stamp)
import { edgeForm, formDimensions, linkStyleProps, sameLinkValue, DEFAULT_EDGE_STROKE } from "./edge-style.mjs";
import { converterElementIds, shapeFor } from "./mermaid-apply.mjs";
import { DEFAULT_SOURCE, mermaidCustomData, originOf } from "./mermaid-origin.mjs";

export const ADOPTION_AUTHOR = "init";
const SHAPE_TYPES = new Set(["rectangle", "diamond", "ellipse"]);
const isLive = (element) => element && !element.isDeleted;
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const textOf = (element) => element?.originalText ?? element?.text ?? "";
const arrowEnds = (element) => ({ start: element.startBinding?.elementId ?? null, end: element.endBinding?.elementId ?? null });

// The node's Mermaid style differs from the shape (only properties Mermaid sets).
const styleDiffers = (element, wanted) => Object.entries(wanted ?? {}).some(([key, value]) => !sameLinkValue(element?.[key], value));

export const legacyAdoption = ({ elements, parsed, writtenAt = 0 }) => {
  const adopt = {};
  if (!parsed?.ok) return { adopt, count: 0 };
  const live = (Array.isArray(elements) ? elements : []).filter(isLive);
  const byId = new Map(live.map((element) => [element.id, element]));
  const unstamped = (element) => Boolean(element) && !originOf(element);
  const labelOf = (container) => live.find((element) => element.type === "text" && element.containerId === container.id && unstamped(element)) ?? null;
  const canvasOf = (element) => ({ author: ADOPTION_AUTHOR, at: Number.isFinite(element.updated) ? element.updated : writtenAt });
  const take = (container, nodeId, differs) => {
    const label = labelOf(container);
    const canvas = differs ? canvasOf(container) : null;
    adopt[container.id] = { nodeId, canvas };
    if (label) adopt[label.id] = { nodeId, canvas };
  };
  const ids = converterElementIds(parsed);
  const shapeOf = new Map();
  for (const subgraph of parsed.subgraphs) {
    const element = byId.get(ids.subgraphs.get(subgraph.id));
    if (!SHAPE_TYPES.has(element?.type) || !unstamped(element)) continue;
    shapeOf.set(subgraph.id, element);
    const label = labelOf(element);
    take(element, subgraph.id, clean(textOf(label)) !== clean(subgraph.title) || styleDiffers(element, subgraph.style?.container));
  }
  for (const node of parsed.nodes) {
    const element = byId.get(ids.nodes.get(node.id));
    if (!SHAPE_TYPES.has(element?.type) || !unstamped(element) || shapeOf.has(node.id)) continue;
    shapeOf.set(node.id, element);
    const label = labelOf(element);
    const differs = clean(textOf(label)) !== clean(node.label)
      || element.type !== shapeFor(node.shape).type
      || styleDiffers(element, node.style?.container)
      || (label && styleDiffers(label, node.style?.label));
    take(element, node.id, differs);
  }
  parsed.edges.forEach((edge, index) => {
    const arrow = byId.get(ids.edges[index]);
    const start = shapeOf.get(edge.start);
    const end = shapeOf.get(edge.end);
    if (arrow?.type !== "arrow" || !unstamped(arrow) || !start || !end) return;
    const ends = arrowEnds(arrow);
    if (ends.start !== start.id || ends.end !== end.id) return;
    const shown = edgeForm(arrow);
    const wanted = formDimensions(edge);
    const link = linkStyleProps(edge.style);
    const differs = clean(textOf(labelOf(arrow))) !== clean(edge.label)
      || shown.type !== edge.type
      || (!("strokeWidth" in link) && (shown.stroke === "thick") !== wanted.thick)
      || (!("strokeStyle" in link) && (shown.stroke === "dotted") !== wanted.dotted)
      || (!("strokeColor" in link) && !sameLinkValue(arrow.strokeColor ?? DEFAULT_EDGE_STROKE, DEFAULT_EDGE_STROKE))
      || styleDiffers(arrow, link);
    take(arrow, `${edge.start}_${edge.end}`, differs);
  });
  return { adopt, count: Object.keys(adopt).length };
};

/**
 * Stamps the adopted elements of `elements` as source `main` (with `hash`), each only while it is
 * still live and unstamped. Deterministic, so a replay of the journaled branch gives the same.
 */
export const applyAdoption = (elements, adopt, hash) => {
  if (!Array.isArray(elements) || !adopt || typeof adopt !== "object") return elements;
  let changed = false;
  const out = elements.map((element) => {
    const entry = isLive(element) && Object.hasOwn(adopt, element.id) ? adopt[element.id] : null;
    if (!entry || originOf(element)) return element;
    changed = true;
    const customData = mermaidCustomData(element.customData, { source: DEFAULT_SOURCE, nodeId: entry.nodeId ?? null, hash }, { keepCanvas: false });
    if (entry.canvas) customData.xcldOrigin = { ...customData.xcldOrigin, canvas: { author: String(entry.canvas.author ?? ADOPTION_AUTHOR), at: Number(entry.canvas.at ?? 0) }, active: "canvas" };
    return { ...element, customData };
  });
  return changed ? out : elements;
};
