// The server's own layout of a Mermaid flowchart, for when no tab picked a write up during its
// backoff (app/server/mermaid-write.mjs): a simple grid that follows the diagram's direction.
// Pure and deterministic.
//
//   gridLayout(parsed) -> { boxes: Map<nodeId, { x, y, w, h }>, bbox: { x, y, w, h } }
//
// - Ranks: the longest path from a root, along the edges (back edges of cycles are ignored,
//   found by a depth-first walk in the order Mermaid lists the nodes).
// - TD/TB: one row per rank, top to bottom (BT: bottom to top). LR: one column per rank, left
//   to right (RL: right to left). Rows and columns are centered on each other.
// - Within a rank, nodes keep Mermaid's order, members of one subgraph next to each other.
// - Node sizes are the ones server-side apply gives new nodes (nodeSize); the boxes go to
//   applyMermaid({ layout }), which draws the shapes, straight bound arrows and the subgraph
//   containers (groups) with the usual conventions. `bbox` includes the room those containers
//   take, for placement (tools/mermaid-place.mjs).
import { GAP_CROSS, GAP_PRIMARY, SUBGRAPH_PADDING, SUBGRAPH_TITLE_SPACE, nodeSize } from "./mermaid-apply.mjs";

const RANK_GAP = GAP_PRIMARY;
const CROSS_GAP = GAP_CROSS + 20;

export const gridLayout = (parsed) => {
  const nodes = parsed?.nodes ?? [];
  const boxes = new Map();
  if (!nodes.length) return { boxes, bbox: { x: 0, y: 0, w: 0, h: 0 } };
  const direction = String(parsed.direction ?? "TD").toUpperCase();
  const horizontal = direction === "LR" || direction === "RL";
  const reversed = direction === "BT" || direction === "RL";
  const order = new Map(nodes.map((node, index) => [node.id, index]));

  // Subgraph path of each node (outermost first), for clustering and padding.
  const parent = new Map();
  for (const subgraph of parsed.subgraphs ?? []) {
    for (const member of subgraph.nodes ?? []) parent.set(member, subgraph.id);
  }
  const pathOf = (id) => {
    const path = [];
    const seen = new Set();
    for (let current = parent.get(id); current && !seen.has(current); current = parent.get(current)) {
      seen.add(current);
      path.unshift(current);
    }
    return path;
  };

  // Forward edges only: a depth-first walk marks back edges (cycles) and skips them.
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of parsed.edges ?? []) {
    if (outgoing.has(edge.start) && outgoing.has(edge.end) && edge.start !== edge.end) outgoing.get(edge.start).push(edge.end);
  }
  const state = new Map();
  const forward = new Map(nodes.map((node) => [node.id, []]));
  const visit = (id) => {
    state.set(id, "open");
    for (const next of outgoing.get(id)) {
      if (state.get(next) === "open") continue;
      forward.get(id).push(next);
      if (!state.has(next)) visit(next);
    }
    state.set(id, "done");
  };
  const hasIncoming = new Set((parsed.edges ?? []).map((edge) => edge.end));
  for (const node of nodes) if (!hasIncoming.has(node.id) && !state.has(node.id)) visit(node.id);
  for (const node of nodes) if (!state.has(node.id)) visit(node.id);

  // Longest-path ranks over the forward edges (a DAG), in topological order.
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const targets of forward.values()) for (const target of targets) indegree.set(target, indegree.get(target) + 1);
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    for (const target of forward.get(id)) {
      rank.set(target, Math.max(rank.get(target), rank.get(id) + 1));
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }

  const ranks = [];
  for (const node of nodes) {
    const value = rank.get(node.id);
    (ranks[value] ??= []).push(node);
  }
  const clusterKey = (node) => pathOf(node.id).join("\u0000");
  const firstOfCluster = new Map();
  for (const node of nodes) if (!firstOfCluster.has(clusterKey(node))) firstOfCluster.set(clusterKey(node), order.get(node.id));
  for (const row of ranks) {
    row?.sort((left, right) => firstOfCluster.get(clusterKey(left)) - firstOfCluster.get(clusterKey(right)) || order.get(left.id) - order.get(right.id));
  }

  // Subgraph containers need room around their members (title above, padding around), per
  // nesting level: kept between ranks, between clusters and around the drawing.
  const depthPad = Math.max(0, ...nodes.map((node) => pathOf(node.id).length));
  const pad = depthPad * (SUBGRAPH_TITLE_SPACE + SUBGRAPH_PADDING);
  const crossPad = pad;
  const rankPad = pad;

  // Lay each rank out along the cross axis, centered on 0; ranks follow each other.
  let along = 0;
  const sequence = reversed ? [...ranks].reverse() : ranks;
  for (const row of sequence) {
    if (!row?.length) continue;
    const sizes = row.map((node) => nodeSize(node));
    const crossOf = (size) => (horizontal ? size.height : size.width);
    const depthOf = (size) => (horizontal ? size.width : size.height);
    let total = 0;
    let previousKey = null;
    const gaps = row.map((node) => {
      const key = clusterKey(node);
      const gap = previousKey === null ? 0 : key === previousKey ? CROSS_GAP : CROSS_GAP + 2 * crossPad;
      previousKey = key;
      return gap;
    });
    sizes.forEach((size, index) => { total += gaps[index] + crossOf(size); });
    const thickness = Math.max(...sizes.map(depthOf));
    let cursor = -total / 2;
    row.forEach((node, index) => {
      const size = sizes[index];
      cursor += gaps[index];
      const offset = (thickness - depthOf(size)) / 2;
      const box = horizontal
        ? { x: along + offset, y: cursor, w: size.width, h: size.height }
        : { x: cursor, y: along + offset, w: size.width, h: size.height };
      boxes.set(node.id, box);
      cursor += crossOf(size);
    });
    along += thickness + RANK_GAP + rankPad;
  }

  // Shift so the drawing (with container room) starts at 0,0.
  const all = [...boxes.values()];
  const minX = Math.min(...all.map((box) => box.x)) - pad;
  const minY = Math.min(...all.map((box) => box.y)) - pad;
  const maxX = Math.max(...all.map((box) => box.x + box.w)) + pad;
  const maxY = Math.max(...all.map((box) => box.y + box.h)) + pad;
  for (const box of all) {
    box.x = Math.round((box.x - minX) * 1000) / 1000;
    box.y = Math.round((box.y - minY) * 1000) / 1000;
  }
  return { boxes, bbox: { x: 0, y: 0, w: maxX - minX, h: maxY - minY } };
};

/** Moves every box by dx, dy (a placed grid). */
export const shiftBoxes = (boxes, dx, dy) => new Map([...boxes].map(([id, box]) => [id, { ...box, x: box.x + dx, y: box.y + dy }]));
