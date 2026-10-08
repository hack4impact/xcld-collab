import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMermaid } from "../tools/mermaid-apply.mjs";
import { gridLayout, shiftBoxes } from "../tools/mermaid-grid.mjs";
import { adoptConverted, resolveNear } from "../tools/mermaid-group.mjs";
import { CLEARANCE, PLACEMENT_GAP, parsePosition, placeGroup } from "../tools/mermaid-place.mjs";

// Placement of a new Mermaid group on a board that has a drawing (slice 6a), the server's grid
// layout, and a tab conversion joining the board as a group. All pure: no parser needed.
const drawing = [
  { x: 0, y: 0, w: 200, h: 100 },
  { x: 400, y: 50, w: 100, h: 300 },
];
const bbox = { x: 0, y: 0, w: 500, h: 350 };
const group = { x: 1000, y: -40, w: 300, h: 200 };
const placed = (offset) => ({ x: group.x + offset.dx, y: group.y + offset.dy, w: group.w, h: group.h });
const overlaps = (left, right, clearance = 0) => left.x < right.x + right.w + clearance && right.x < left.x + left.w + clearance && left.y < right.y + right.h + clearance && right.y < left.y + left.h + clearance;
const clearOf = (box, boxes, clearance = CLEARANCE) => boxes.every((other) => !overlaps(box, other, clearance));

test("parsePosition: below, right, near:<id>; anything else is an error", () => {
  assert.deepEqual(parsePosition(undefined), { kind: "auto" });
  assert.deepEqual(parsePosition(""), { kind: "auto" });
  assert.deepEqual(parsePosition("below"), { kind: "below" });
  assert.deepEqual(parsePosition("right"), { kind: "right" });
  assert.deepEqual(parsePosition("near:api"), { kind: "near", ref: "api" });
  assert.deepEqual(parsePosition("near:flow:A"), { kind: "near", ref: "flow:A" });
  for (const bad of ["above", "near:", "left", 3]) assert.deepEqual(parsePosition(bad), { error: "invalid-position" }, String(bad));
});

test("placeGroup: an empty board keeps the group where the converter put it", () => {
  assert.deepEqual(placeGroup({ obstacles: [], group, direction: "LR" }), { dx: 0, dy: 0, placement: "keep" });
});

test("placeGroup: no hint follows the direction; TD/TB/BT below, LR/RL right, centered on the drawing", () => {
  for (const direction of ["TD", "TB", "BT"]) {
    const result = placeGroup({ obstacles: drawing, group, direction });
    const box = placed(result);
    assert.equal(result.placement, "below", direction);
    assert.equal(box.y, bbox.y + bbox.h + PLACEMENT_GAP, `${direction}: below the drawing with the gap`);
    assert.equal(box.x + box.w / 2, bbox.x + bbox.w / 2, `${direction}: centered horizontally`);
    assert.ok(clearOf(box, drawing), `${direction}: clear of the drawing`);
  }
  for (const direction of ["LR", "RL"]) {
    const result = placeGroup({ obstacles: drawing, group, direction });
    const box = placed(result);
    assert.equal(result.placement, "right", direction);
    assert.equal(box.x, bbox.x + bbox.w + PLACEMENT_GAP, `${direction}: right of the drawing with the gap`);
    assert.equal(box.y + box.h / 2, bbox.y + bbox.h / 2, `${direction}: centered vertically`);
    assert.ok(clearOf(box, drawing), `${direction}: clear of the drawing`);
  }
});

test("placeGroup: the below and right hints win over the direction", () => {
  const below = placed(placeGroup({ obstacles: drawing, group, direction: "LR", position: { kind: "below" } }));
  assert.equal(below.y, bbox.h + PLACEMENT_GAP);
  const right = placed(placeGroup({ obstacles: drawing, group, direction: "TD", position: { kind: "right" } }));
  assert.equal(right.x, bbox.w + PLACEMENT_GAP);
  assert.ok(clearOf(below, drawing) && clearOf(right, drawing));
});

test("placeGroup: near:<id> goes beside that element in the nearest free spot, else the default", () => {
  const anchor = drawing[0];
  const result = placeGroup({ obstacles: drawing, group, direction: "TD", position: { kind: "near", ref: "a" }, nearBox: anchor });
  const box = placed(result);
  assert.equal(result.placement, "near");
  assert.ok(clearOf(box, drawing), "clear of every obstacle, with clearance");
  // Right of the anchor is blocked by the tall shape at x=400, so it goes below the anchor.
  assert.equal(box.y, anchor.y + anchor.h + PLACEMENT_GAP);
  assert.equal(box.x + box.w / 2, anchor.x + anchor.w / 2);
  // Deterministic: the same inputs, the same spot.
  assert.deepEqual(placeGroup({ obstacles: drawing, group, direction: "TD", position: { kind: "near", ref: "a" }, nearBox: anchor }), result);
  // A free right side is taken first.
  const open = placed(placeGroup({ obstacles: [drawing[0]], group, direction: "TD", position: { kind: "near", ref: "a" }, nearBox: drawing[0] }));
  assert.equal(open.x, anchor.x + anchor.w + PLACEMENT_GAP);
  // An unknown reference falls back to the direction's default and says why.
  const missing = placeGroup({ obstacles: drawing, group, direction: "LR", position: { kind: "near", ref: "nope" }, nearBox: null });
  assert.equal(missing.placement, "right");
  assert.match(missing.fallback, /near:nope is not on the board/);
});

test("resolveNear: a node of the writing source, an element id, then a node of any source", () => {
  const elements = [
    { id: "free", type: "rectangle" },
    { id: "A", type: "rectangle", customData: { xcldOrigin: { mermaid: { source: "main", nodeId: "A", hash: "h" }, canvas: null, active: "mermaid" } } },
    { id: "flow:A", type: "rectangle", customData: { xcldOrigin: { mermaid: { source: "flow", nodeId: "A", hash: "h" }, canvas: null, active: "mermaid" } } },
    { id: "gone", type: "rectangle", isDeleted: true },
  ];
  assert.equal(resolveNear(elements, "free", "main").id, "free");
  assert.equal(resolveNear(elements, "A", "flow").id, "flow:A", "the writing source's own node first");
  assert.equal(resolveNear(elements, "A", "main").id, "A");
  assert.equal(resolveNear(elements, "gone", "main"), null);
});

const parsed = (direction, extra = {}) => ({
  ok: true,
  diagramType: "flowchart-v2",
  direction,
  nodes: [
    { id: "A", label: "Start", shape: "square", classes: [], styles: [], link: null, style: { container: {}, label: {} } },
    { id: "B", label: "Check", shape: "diamond", classes: [], styles: [], link: null, style: { container: {}, label: {} } },
    { id: "C", label: "Left", shape: "square", classes: [], styles: [], link: null, style: { container: {}, label: {} } },
    { id: "D", label: "Right", shape: "round", classes: [], styles: [], link: null, style: { container: {}, label: {} } },
  ],
  edges: [
    { mermaidId: "L-A-B-0", start: "A", end: "B", label: "", type: "arrow_point", stroke: "normal", arrowheads: {} },
    { mermaidId: "L-B-C-0", start: "B", end: "C", label: "yes", type: "arrow_point", stroke: "normal", arrowheads: {} },
    { mermaidId: "L-B-D-0", start: "B", end: "D", label: "", type: "arrow_point", stroke: "normal", arrowheads: {} },
    { mermaidId: "L-D-A-0", start: "D", end: "A", label: "", type: "arrow_point", stroke: "normal", arrowheads: {} },
  ],
  subgraphs: [],
  classDefs: {},
  ...extra,
});
const center = (box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

test("gridLayout: TD rows, LR columns, BT/RL reversed; back edges don't add ranks; deterministic", () => {
  const td = gridLayout(parsed("TD")).boxes;
  assert.ok(center(td.get("A")).y < center(td.get("B")).y && center(td.get("B")).y < center(td.get("C")).y, "TD: one row per rank, top to bottom");
  assert.equal(center(td.get("C")).y, center(td.get("D")).y, "TD: C and D share a row");
  assert.ok(td.get("C").x + td.get("C").w <= td.get("D").x, "TD: siblings side by side, in Mermaid's order");
  const lr = gridLayout(parsed("LR")).boxes;
  assert.ok(center(lr.get("A")).x < center(lr.get("B")).x && center(lr.get("B")).x < center(lr.get("C")).x, "LR: one column per rank");
  assert.equal(center(lr.get("C")).x, center(lr.get("D")).x);
  assert.ok(lr.get("C").y + lr.get("C").h <= lr.get("D").y);
  const bt = gridLayout(parsed("BT")).boxes;
  assert.ok(center(bt.get("A")).y > center(bt.get("B")).y, "BT: bottom to top");
  const rl = gridLayout(parsed("RL")).boxes;
  assert.ok(center(rl.get("A")).x > center(rl.get("B")).x, "RL: right to left");
  for (const layout of [td, lr, bt, rl]) {
    const boxes = [...layout.values()];
    for (const [index, box] of boxes.entries()) {
      for (const other of boxes.slice(index + 1)) assert.equal(overlaps(box, other), false);
    }
  }
  assert.deepEqual(gridLayout(parsed("TD")), gridLayout(parsed("TD")));
  const { bbox: frame, boxes } = gridLayout(parsed("TD"));
  for (const box of boxes.values()) assert.ok(box.x >= frame.x && box.y >= frame.y && box.x + box.w <= frame.x + frame.w && box.y + box.h <= frame.y + frame.h);
});

test("grid fallback: applyMermaid with a placed grid draws the group clear of a hand-drawn board, with bound arrows", () => {
  const human = [
    { id: "note", type: "rectangle", x: 0, y: 0, width: 300, height: 120, isDeleted: false, version: 3, index: "a0" },
    { id: "note-text", type: "text", x: 10, y: 10, width: 100, height: 25, containerId: null, text: "my note", originalText: "my note", isDeleted: false, index: "a1" },
  ];
  const diagram = parsed("TD", { subgraphs: [{ id: "G", title: "Group", nodes: ["C", "D"], classes: [], style: { container: {}, label: {} } }] });
  const grid = gridLayout(diagram);
  const place = placeGroup({ obstacles: [{ x: 0, y: 0, w: 300, h: 120 }, { x: 10, y: 10, w: 100, h: 25 }], group: grid.bbox, direction: "TD" });
  assert.equal(place.placement, "below");
  const result = applyMermaid({ master: human, parsed: diagram, hashOfSource: "m1-grid", now: 1000, source: "flow", layout: shiftBoxes(grid.boxes, place.dx, place.dy) });
  assert.equal(result.needsTabLayout, false);
  const byId = new Map(result.elements.map((element) => [element.id, element]));
  assert.deepEqual(byId.get("note"), human[0], "the human's shape is untouched");
  for (const id of ["flow:A", "flow:B", "flow:C", "flow:D", "flow:G"]) assert.ok(byId.has(id), `${id} added with the source prefix`);
  for (const id of ["flow:A", "flow:B", "flow:C", "flow:D"]) {
    const element = byId.get(id);
    assert.ok(element.y > 120, `${id} below the drawing`);
    assert.equal(element.customData.xcldOrigin.mermaid.source, "flow");
    assert.equal(element.customData.xcldOrigin.mermaid.nodeId, id.slice(5));
    assert.equal(element.customData.xcldOrigin.active, "mermaid");
    assert.equal(element.updated, 1000);
  }
  const arrow = byId.get("flow:B_C");
  assert.equal(arrow.startBinding.elementId, "flow:B");
  assert.equal(arrow.endBinding.elementId, "flow:C");
  assert.ok(byId.get("flow:C").groupIds.includes("subgraph_group_flow:G"), "subgraph members are grouped");
  assert.ok(result.ops.filter((op) => op.op === "add-node").every((op) => op.placement === "grid"));
});

test("adoptConverted: a tab's conversion joins a hand-drawn board as a stamped, namespaced group, placed clear of it", () => {
  const human = [{ id: "A", type: "rectangle", x: 0, y: 0, width: 400, height: 200, isDeleted: false, index: "a5" }];
  const converted = [
    { id: "A", type: "rectangle", x: 10, y: 10, width: 120, height: 60, groupIds: [], boundElements: [{ type: "text", id: "rnd1" }, { type: "arrow", id: "A_B" }], customData: { xcldMermaidHash: "m1-x" } },
    { id: "B", type: "rectangle", x: 10, y: 150, width: 120, height: 60, groupIds: ["subgraph_group_G"], boundElements: [{ type: "arrow", id: "A_B" }] },
    { id: "A_B", type: "arrow", x: 70, y: 70, width: 0, height: 80, points: [[0, 0], [0, 80]], startBinding: { elementId: "A" }, endBinding: { elementId: "B" } },
    { id: "rnd1", type: "text", x: 20, y: 20, width: 50, height: 25, containerId: "A", text: "One", originalText: "One" },
  ];
  for (const [source, prefix] of [["main", ""], ["flow", "flow:"]]) {
    const result = adoptConverted({ master: human, converted, source, hash: "m1-x", now: 42, direction: "TD" });
    const byId = new Map(result.elements.map((element) => [element.id, element]));
    assert.deepEqual(byId.get("A"), human[0], `${source}: the human's shape keeps its id and content`);
    const shapeA = byId.get(source === "main" ? "A_2" : "flow:A");
    assert.ok(shapeA, `${source}: a clash with a human's id is renamed`);
    const label = byId.get(`${shapeA.id}_label`);
    assert.equal(label.containerId, shapeA.id);
    assert.ok(shapeA.boundElements.some((bound) => bound.id === label.id));
    const arrow = byId.get(`${prefix}A_B`);
    assert.equal(arrow.startBinding.elementId, shapeA.id);
    assert.equal(arrow.endBinding.elementId, `${prefix}B`);
    assert.deepEqual(byId.get(`${prefix}B`).groupIds, [`subgraph_group_${prefix}G`]);
    assert.equal(result.placement.placement, "below");
    for (const element of result.elements.slice(1)) {
      assert.ok(element.y >= 200 + PLACEMENT_GAP, `${element.id} below the drawing`);
      assert.equal(element.customData.xcldOrigin.mermaid.source, source);
      assert.equal(element.customData.xcldMermaidHash, "m1-x");
      assert.ok(element.index > "a5", `${element.id} above the drawing in z-order`);
    }
  }
  // An empty board keeps the converter's coordinates.
  const empty = adoptConverted({ master: [], converted, source: "main", hash: "m1-x", now: 42 });
  assert.equal(empty.placement.placement, "keep");
  assert.equal(empty.elements.find((element) => element.id === "A").x, 10);
});
