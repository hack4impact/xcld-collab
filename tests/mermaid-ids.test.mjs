// Element ids through a Mermaid round trip (the upgrade path): to-mermaid rewrites ids Mermaid can't
// spell and records the original in a `%% xcld:id` comment; a write of that text maps every node
// back to its element, so a shape read from the board and written back is never deleted and
// re-created, or duplicated (tools/mermaid-ids.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMermaid, appliesOnBoard } from "../tools/mermaid-apply.mjs";
import { mermaidSourceHash } from "../tools/mermaid-hash.mjs";
import { idComment, readIdMap } from "../tools/mermaid-ids.mjs";
import { mermaidCustomData } from "../tools/mermaid-origin.mjs";
import { parseFlowchart } from "../tools/mermaid-parse.mjs";
import { sceneToMermaid } from "../tools/to-mermaid.mjs";

const NOW = 1_800_000_000_000;
const SHAPES = new Set(["rectangle", "diamond", "ellipse"]);
const box = (id, x, y, text, extra = {}) => [
  { id, type: "rectangle", x, y, width: 200, height: 80, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 2, versionNonce: 2, isDeleted: false, boundElements: [{ type: "text", id: `${id}~t` }], updated: 1, link: null, locked: false, ...extra },
  { id: `${id}~t`, type: "text", x: x + 10, y: y + 27, width: 180, height: 25, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 2, version: 2, versionNonce: 3, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, text, fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: id, originalText: text, autoResize: true, lineHeight: 1.25, ...(extra.customData ? { customData: extra.customData } : {}) },
];
const arrow = (id, from, to, extra = {}) => ({ id, type: "arrow", x: 0, y: 0, width: 100, height: 100, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: { type: 2 }, seed: 3, version: 2, versionNonce: 4, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, points: [[0, 0], [100, 100]], startBinding: { elementId: from, focus: 0, gap: 4 }, endBinding: { elementId: to, focus: 0, gap: 4 }, startArrowhead: null, endArrowhead: "arrow", elbowed: false, ...extra });
const live = (elements) => elements.filter((element) => !element.isDeleted);
const labelOf = (elements, id) => live(elements).find((element) => element.type === "text" && element.containerId === id)?.originalText ?? null;
const apply = async (elements, source, { previous = null, sourceName = "main" } = {}) => applyMermaid({
  master: elements,
  parsed: await parseFlowchart(source),
  hashOfSource: mermaidSourceHash(source),
  now: NOW,
  previous: previous ? await parseFlowchart(previous) : null,
  source: sourceName,
});
const shapeIds = (elements) => live(elements).filter((element) => SHAPES.has(element.type)).map((element) => element.id).sort();

test("readIdMap reads `%% xcld:id` comments: any element id, first one wins, malformed lines ignored", () => {
  const text = [
    "flowchart TD",
    `  ${idComment("_x7Q_2bL", "_x7Q-2bL")}`,
    `  ${idComment("odd", 'a "quoted" \\ id')}`,
    `  ${idComment("_x7Q_2bL", "second")}`,
    "  %% xcld:id 1bad \"x\"",
    "  %% xcld:id ok not-json",
    `  ${idComment("same", "same")}`,
  ].join("\n");
  assert.deepEqual(readIdMap(text), { _x7Q_2bL: "_x7Q-2bL", odd: 'a "quoted" \\ id' });
  assert.deepEqual(readIdMap(""), {});
});

// A hand-drawn board: nanoid-style ids with "-", an id starting with a digit, two ids that
// sanitize to the same Mermaid id, and a named source's shape.
const drawing = () => [
  ...box("_x7Q-2bLmN9pRt4VwKc8Ya", 0, 0, "Model hub"),
  ...box("Hq3ZtUe81LbVn0yPoWx_7", 300, 0, "Agent environment"),
  ...box("9lead-digit", 600, 0, "Digit first"),
  ...box("a-b", 0, 200, "Dash"),
  ...box("a_b", 300, 200, "Underscore"),
  arrow("x-arrow-1", "_x7Q-2bLmN9pRt4VwKc8Ya", "Hq3ZtUe81LbVn0yPoWx_7", { strokeColor: "#1c7ed6" }),
  arrow("x-arrow-2", "a-b", "a_b"),
];

test("export, then write back as main: every hand-drawn shape keeps its id, nothing is added or deleted", async () => {
  const elements = drawing();
  const exported = sceneToMermaid({ elements });
  const map = readIdMap(exported);
  assert.equal(map._x7Q_2bLmN9pRt4VwKc8Ya, "_x7Q-2bLmN9pRt4VwKc8Ya");
  assert.equal(map.n_9lead_digit, "9lead-digit");
  assert.equal(Object.values(map).includes("a-b"), true, "both colliding ids are recorded");
  assert.equal(map.Hq3ZtUe81LbVn0yPoWx_7, undefined, "an id Mermaid can spell needs no comment");
  assert.equal(new Set(Object.keys(map)).size, Object.keys(map).length);
  // The board has no Mermaid shapes, but the diagram's nodes are on it: applied on the server.
  const parsed = await parseFlowchart(exported);
  assert.equal(appliesOnBoard({ elements, parsed }), true);
  const relabelled = exported.replace('["Dash"]', '["Dash v2"]').replace('["Model hub"]', '["Model hub (EU)"]');
  const result = await apply(elements, relabelled);
  assert.equal(result.needsTabLayout, false);
  assert.deepEqual(shapeIds(result.elements), shapeIds(elements), "same shapes, same ids");
  assert.equal(labelOf(result.elements, "a-b"), "Dash v2", "the comment maps the rewritten id back");
  assert.equal(labelOf(result.elements, "a_b"), "Underscore");
  assert.equal(labelOf(result.elements, "_x7Q-2bLmN9pRt4VwKc8Ya"), "Model hub (EU)");
  assert.deepEqual(result.ops.map((op) => op.op).sort(), ["relabel", "relabel"]);
  assert.equal(live(result.elements).find((element) => element.id === "x-arrow-1").strokeColor, "#1c7ed6", "the arrow's colour went out as linkStyle and came back");
  // Written back unchanged: nothing at all.
  assert.deepEqual((await apply(elements, exported)).ops, []);
});

test("the comment wins over the order-dependent rewrite; without it the rewrite still maps unique ids", async () => {
  const elements = drawing();
  const exported = sceneToMermaid({ elements });
  const dashId = Object.entries(readIdMap(exported)).find(([, elementId]) => elementId === "a-b")[0];
  // The board changed order since the read (a_b now comes first): the rewrite alone would give
  // "a_b" to the other shape; the comment still names the right one.
  const reordered = [...elements.filter((element) => element.id.startsWith("a_b")), ...elements.filter((element) => !element.id.startsWith("a_b"))];
  const relabel = exported.replace('["Dash"]', '["Dash v3"]');
  const result = await apply(reordered, relabel);
  assert.equal(labelOf(result.elements, "a-b"), "Dash v3", `${dashId} maps to a-b`);
  assert.equal(labelOf(result.elements, "a_b"), "Underscore");
  // An agent that dropped the comments: a unique rewritten id still maps back (no duplicate).
  const bare = relabel.split("\n").filter((line) => !line.includes("xcld:id")).join("\n").replace('["Model hub"]', '["Hub"]');
  const fallback = await apply(elements, bare);
  assert.equal(labelOf(fallback.elements, "_x7Q-2bLmN9pRt4VwKc8Ya"), "Hub");
  assert.deepEqual(shapeIds(fallback.elements), shapeIds(elements));
});

test("a named source's shapes: its own export ids map back to it; written as main they are left alone", async () => {
  const hash = "m1-extra";
  const own = (nodeId) => mermaidCustomData(null, { source: "extra", nodeId, hash });
  const elements = [
    ...box("main-node", 0, 0, "Main"),
    ...box("extra:FCONN", 0, 300, "Connection", { customData: own("FCONN") }),
    ...box("extra:FTARGET", 300, 300, "Target", { customData: own("FTARGET") }),
    arrow("extra:FCONN_FTARGET", "extra:FCONN", "extra:FTARGET", { customData: own("FCONN_FTARGET") }),
  ];
  const exported = sceneToMermaid({ elements });
  assert.match(exported, /^  %% xcld:id extra_FCONN "extra:FCONN"$/m);
  // The whole export written back as main: the extra shapes are another source's, so main
  // neither copies nor changes them, and draws no edge between them.
  const asMain = await apply(elements, exported.replace('["Main"]', '["Main v2"]'));
  assert.deepEqual(shapeIds(asMain.elements), shapeIds(elements), "no copy of another source's shapes");
  assert.equal(labelOf(asMain.elements, "main-node"), "Main v2");
  assert.ok(asMain.ops.some((op) => op.op === "skip" && op.id === "extra:FCONN" && op.reason === "outside source main"));
  assert.ok(asMain.ops.some((op) => op.op === "skip" && op.kind === "edge" && op.reason === "endpoint outside source main"));
  for (const id of ["extra:FCONN", "extra:FTARGET", "extra:FCONN_FTARGET"]) {
    assert.deepEqual(asMain.elements.find((element) => element.id === id), elements.find((element) => element.id === id), `${id} untouched`);
  }
  // Written as source extra with the exported ids: its own shapes, updated in place.
  const extraText = "flowchart TD\n  extra_FCONN[\"Connection v2\"] --> extra_FTARGET[\"Target\"]\n  %% xcld:id extra_FCONN \"extra:FCONN\"\n  %% xcld:id extra_FTARGET \"extra:FTARGET\"";
  const asExtra = await apply(elements, extraText, { sourceName: "extra" });
  assert.deepEqual(shapeIds(asExtra.elements), shapeIds(elements));
  assert.equal(labelOf(asExtra.elements, "extra:FCONN"), "Connection v2");
  // A named source never maps onto a shape outside it, even with a comment: main-node stays.
  const reach = await apply(elements, "flowchart TD\n  FCONN[\"Connection\"] --> mainnode[\"Mine now\"]\n  %% xcld:id mainnode \"main-node\"", { sourceName: "extra" });
  assert.equal(labelOf(reach.elements, "main-node"), "Main");
  assert.ok(reach.ops.some((op) => op.op === "skip" && op.id === "main-node" && op.reason === "outside source extra"));
});
