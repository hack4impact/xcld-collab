// A Mermaid diagram the tab laid out (in memory, with mermaid-to-excalidraw) joins the board as
// a group of a named source: ids namespaced, every element stamped with its Mermaid origin, the
// group placed clear of the drawing (tools/mermaid-place.mjs), and the result is the whole board
// for a merge. Pure and deterministic. The human's shapes are never touched.
//
//   adoptConverted({ master, converted, source, hash, now, position, direction, parsed? })
//     -> { elements, ops, placement }
//
// - Ids: shapes and arrows keep the converter's id (the Mermaid node id) in `main` and get
//   "<source>:" in front otherwise; bound text becomes "<container>_label" (the converter's are
//   random); a clash with a live element of another owner gets "_2", "_3", ...
// - A non-flowchart rewrite of a source that is already on the board (sequence diagrams and the
//   like can't be applied node by node) replaces that source's elements, and only those: the new
//   group goes where the old one was.
// - An empty board keeps the converter's coordinates.
// - With `parsed` (the server's parse of the same Mermaid), an edge's own curve (`e1@{ curve: linear }`)
//   makes its arrow straight or elbow: the converter draws every arrow curved.
import { curveShape, styleFor } from "./edge-style.mjs";
import { boxOf, converterElementIds, generateKeyBetween, isValidIndex, reshapePoints, unionBox } from "./mermaid-apply.mjs";
import { mermaidCustomData, originOf, sourcePrefix } from "./mermaid-origin.mjs";
import { placeGroup } from "./mermaid-place.mjs";

const SUBGRAPH_GROUP_PREFIX = "subgraph_group_";
const isLive = (element) => element && !element.isDeleted;
const clone = (value) => JSON.parse(JSON.stringify(value));

/** The element `near:<ref>` points at: a node of `source`, an element id, then a node of any source. */
export const resolveNear = (elements, ref, source) => {
  if (!ref) return null;
  const live = (Array.isArray(elements) ? elements : []).filter(isLive);
  const byId = new Map(live.map((element) => [element.id, element]));
  const shapes = live.filter((element) => element.type !== "text" && element.type !== "arrow");
  const byNode = (wanted) => shapes.filter((element) => originOf(element)?.mermaid?.nodeId === ref && (!wanted || originOf(element).mermaid.source === wanted)).sort((left, right) => (left.id < right.id ? -1 : 1))[0];
  const own = byId.get(`${sourcePrefix(source)}${ref}`);
  return (own && originOf(own)?.mermaid?.source === source ? own : null) ?? byNode(source) ?? byId.get(ref) ?? byNode(null) ?? null;
};

/** Live elements' boxes (bound text is inside its container), for placement. */
export const obstacleBoxes = (elements) => {
  const live = (Array.isArray(elements) ? elements : []).filter(isLive);
  const containers = new Set(live.filter((element) => element.type !== "text").map((element) => element.id));
  return live.filter((element) => !(element.type === "text" && containers.has(element.containerId))).map(boxOf);
};

export const adoptConverted = ({ master = [], converted = [], source, hash, now, position = { kind: "auto" }, direction = "TD", parsed = null }) => {
  const prefix = sourcePrefix(source);
  const ops = [];
  const board = clone(Array.isArray(master) ? master : []);
  // A non-flowchart rewrite of this source: its old elements go, the new group takes their place.
  const old = board.filter((element) => isLive(element) && originOf(element)?.mermaid?.source === source);
  const oldBox = old.length ? unionBox(old.map(boxOf)) : null;
  for (const element of old) {
    Object.assign(element, { isDeleted: true, version: Number(element.version ?? 0) + 1, updated: now });
    if (element.type !== "text" || !element.containerId) ops.push({ op: "delete", id: element.id, kind: element.type === "arrow" ? "edge" : element.type === "text" ? "text" : "node" });
  }
  const taken = new Set(board.filter(isLive).map((element) => element.id));
  const unique = (wanted) => {
    let candidate = wanted;
    for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${wanted}_${suffix}`;
    taken.add(candidate);
    return candidate;
  };

  // New ids: shapes, arrows and free text first, then bound text after its container.
  const incoming = clone(converted).filter(isLive);
  const rename = new Map();
  for (const element of incoming) {
    if (element.type === "text" && element.containerId) continue;
    rename.set(element.id, unique(`${prefix}${element.id}`));
  }
  for (const element of incoming) {
    if (!(element.type === "text" && element.containerId)) continue;
    rename.set(element.id, unique(`${rename.get(element.containerId) ?? `${prefix}${element.containerId}`}_label`));
  }
  const mapId = (id) => (typeof id === "string" && rename.has(id) ? rename.get(id) : id);
  const mapGroup = (groupId) => {
    const text = String(groupId);
    if (text.startsWith(SUBGRAPH_GROUP_PREFIX)) return `${SUBGRAPH_GROUP_PREFIX}${prefix}${text.slice(SUBGRAPH_GROUP_PREFIX.length)}`;
    const circle = /^doublecircle_(.*)}$/.exec(text);
    if (circle) return `doublecircle_${mapId(circle[1])}}`;
    return prefix ? `${prefix}${text}` : text;
  };
  const group = incoming.map((element) => {
    const nodeId = element.type === "text" && element.containerId ? element.containerId : element.id;
    const next = {
      ...element,
      id: rename.get(element.id),
      groupIds: (element.groupIds ?? []).map(mapGroup),
      ...(element.containerId ? { containerId: mapId(element.containerId) } : {}),
      ...(Array.isArray(element.boundElements) ? { boundElements: element.boundElements.map((bound) => ({ ...bound, id: mapId(bound.id) })) } : {}),
      ...(element.frameId ? { frameId: mapId(element.frameId) } : {}),
      updated: now,
      customData: mermaidCustomData(element.customData, { source, nodeId, hash }, { keepCanvas: false }),
    };
    for (const key of ["startBinding", "endBinding"]) {
      if (next[key]?.elementId) next[key] = { ...next[key], elementId: mapId(next[key].elementId) };
    }
    return next;
  });

  if (parsed?.ok) {
    const edgeIds = converterElementIds(parsed).edges;
    const byId = new Map(group.map((element) => [element.id, element]));
    parsed.edges.forEach((edge, index) => {
      const shape = curveShape(edge.curve);
      const arrow = byId.get(rename.get(edgeIds[index]));
      if (!shape || arrow?.type !== "arrow") return;
      const props = styleFor(arrow, "shape", shape);
      if (Object.keys(props).length) Object.assign(arrow, props, { points: reshapePoints(arrow.points, shape, Boolean(arrow.elbowed)) });
    });
  }

  // Placement: clear of the drawing (the replaced group's place for a rewrite).
  let placement = { dx: 0, dy: 0, placement: "keep" };
  if (group.length) {
    const groupBox = unionBox(group.map(boxOf));
    if (oldBox) {
      placement = { dx: oldBox.x - groupBox.x, dy: oldBox.y - groupBox.y, placement: "replace" };
    } else {
      const nearBox = position?.kind === "near" ? resolveNear(board, position.ref, source) : null;
      placement = placeGroup({ obstacles: obstacleBoxes(board), group: groupBox, direction, position, nearBox: nearBox ? boxOf(nearBox) : null });
    }
    if (placement.dx || placement.dy) {
      for (const element of group) {
        element.x = Math.round((Number(element.x ?? 0) + placement.dx) * 1000) / 1000;
        element.y = Math.round((Number(element.y ?? 0) + placement.dy) * 1000) / 1000;
      }
    }
  }

  // Z-order: above everything on the board, in the converter's order.
  let last = null;
  for (const element of board) {
    if (isValidIndex(element.index) && (last === null || element.index > last)) last = element.index;
  }
  for (const element of group) {
    last = generateKeyBetween(last, null);
    element.index = last;
    if (element.type !== "text" || !element.containerId) {
      ops.push(element.type === "arrow"
        ? { op: "add-edge", id: element.id, start: element.startBinding?.elementId ?? null, end: element.endBinding?.elementId ?? null }
        : { op: "add-node", id: element.id, shape: element.type, x: element.x, y: element.y, width: element.width, height: element.height, anchor: null, placement: placement.placement });
    }
  }
  return { elements: [...board, ...group], ops, placement };
};
