// Arrow and line styles across Mermaid round trips, Mermaid writes and the ledger
// (tools/edge-style.mjs; docs/DESIGN.md#mermaid-round-trip).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { bannerDetails, mergeItems } from "../app/src/merge-banner.mjs";
import { describeLineStyleChange, edgeForm, edgeOperator } from "../tools/edge-style.mjs";
import { diffElements, formatDiff } from "../tools/diff.mjs";
import { mergeBoard } from "../tools/merge.mjs";
import { applyMermaid, edgeStyleFor } from "../tools/mermaid-apply.mjs";
import { adoptConverted } from "../tools/mermaid-group.mjs";
import { mermaidSourceHash } from "../tools/mermaid-hash.mjs";
import { originOf, stampCanvasEdits } from "../tools/mermaid-origin.mjs";
import { parseFlowchart } from "../tools/mermaid-parse.mjs";
import { sceneToMermaid } from "../tools/to-mermaid.mjs";
import { formatMergedEvent } from "../tools/watch.mjs";

const NOW = 1_800_000_000_000;
const HUMAN = "human:Ada#t1";
const STYLE_KEYS = ["strokeStyle", "strokeWidth", "strokeColor", "roundness", "elbowed", "startArrowhead", "endArrowhead", "points"];
const TYPES = ["arrow_open", "arrow_point", "arrow_circle", "arrow_cross", "double_arrow_point", "double_arrow_circle", "double_arrow_cross"];
const STROKES = ["normal", "thick", "dotted"];

// mermaid-apply-base.excalidraw is a real tab conversion of its `mermaid` (A --> B is arrow A_B).
const fixture = async () => JSON.parse(await readFile(path.resolve("tests", "fixtures", "mermaid-apply-base.excalidraw"), "utf8"));
const styleOf = (element) => Object.fromEntries(STYLE_KEYS.map((key) => [key, element?.[key] ?? null]));
const byId = (elements) => new Map(elements.map((element) => [element.id, element]));
// The board after a human restyled arrow A_B in the tab (the server stamps the canvas origin).
const humanRestyle = (base, patch) => stampCanvasEdits({
  base: base.elements,
  branch: base.elements.map((element) => (element.id === "A_B" ? { ...element, ...patch, version: element.version + 1 } : element)),
  author: HUMAN,
  at: NOW - 1000,
});
const apply = async (elements, source, previous) => applyMermaid({
  master: elements,
  parsed: await parseFlowchart(source),
  hashOfSource: mermaidSourceHash(source),
  now: NOW,
  previous: previous ? await parseFlowchart(previous) : null,
});
// Edge A --> B as the fixture's Mermaid writes it.
const AB = 'A["Start"] --> B{"Valid?"}';
const edgeAB = (parsed) => parsed.edges.find((edge) => edge.start === "A" && edge.end === "B");

test("every Mermaid edge form parses, with and without a label and a curve, and maps back to the same form", async () => {
  const lines = ["flowchart TD"];
  const cases = [];
  for (const type of TYPES) {
    for (const stroke of STROKES) {
      for (const label of ["", "a label"]) {
        for (const curve of [null, "linear", "step"]) {
          const index = cases.length;
          const operator = edgeOperator({ type, stroke });
          const link = label ? `${operator}|"${label}"|` : operator;
          lines.push(`  n${index} ${curve ? `e${index}@` : ""}${link} m${index}`);
          if (curve) lines.push(`  e${index}@{ curve: ${curve} }`);
          cases.push({ type, stroke, label, curve, operator });
        }
      }
    }
  }
  const parsed = await parseFlowchart(lines.join("\n"));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.error));
  assert.equal(parsed.edges.length, cases.length);
  assert.equal(parsed.nodes.length, cases.length * 2, "edge ids never become nodes");
  cases.forEach((want, index) => {
    const edge = parsed.edges[index];
    const what = `${want.operator} ${JSON.stringify(want.label)} ${want.curve}`;
    assert.deepEqual([edge.type, edge.stroke, edge.label, edge.curve], [want.type, want.stroke, want.label, want.curve], what);
    // A new arrow for the edge exports to the same form.
    const form = edgeForm(edgeStyleFor(edge));
    assert.deepEqual([form.type, form.stroke, form.curve], [want.type, want.stroke, want.curve], what);
  });
  // The operators themselves, as an agent sees them.
  assert.deepEqual(STROKES.map((stroke) => TYPES.map((type) => edgeOperator({ type, stroke })).join(" ")), [
    "--- --> --o --x <--> o--o x--x",
    "=== ==> ==o ==x <==> o==o x==x",
    "-.- -.-> -.-o -.-x <-.-> o-.-o x-.-x",
  ]);
});

// Canvas styles of arrow A_B, as a human sets them in the tab.
const CANVAS_STYLES = {
  plain: {},
  dashed: { strokeStyle: "dashed" },
  dotted: { strokeStyle: "dotted" },
  straight: { roundness: null },
  elbow: { elbowed: true, roundness: null, points: [[0, 0], [0, 20], [10, 20], [10, 45]] },
  thin: { strokeWidth: 1 },
  thick: { strokeWidth: 4 },
  "thick dashed": { strokeWidth: 4, strokeStyle: "dashed" },
  "thick dotted straight": { strokeWidth: 4, strokeStyle: "dotted", roundness: null },
  red: { strokeColor: "#e03131" },
  "no heads": { endArrowhead: null },
  "no heads dashed": { endArrowhead: null, strokeStyle: "dashed" },
  "no heads thick": { endArrowhead: null, strokeWidth: 4 },
  "start head only": { startArrowhead: "arrow", endArrowhead: null },
  "both heads": { startArrowhead: "arrow" },
  "both heads dashed": { startArrowhead: "arrow", strokeStyle: "dashed" },
  "both heads thick": { startArrowhead: "arrow", strokeWidth: 4 },
  triangle: { endArrowhead: "triangle" },
  "triangle outline both": { startArrowhead: "triangle_outline", endArrowhead: "triangle_outline" },
  circle: { endArrowhead: "circle" },
  "circle outline": { endArrowhead: "circle_outline" },
  "circle both dotted": { startArrowhead: "circle", endArrowhead: "circle", strokeStyle: "dotted" },
  bar: { endArrowhead: "bar" },
  "bar both thick": { startArrowhead: "bar", endArrowhead: "bar", strokeWidth: 4 },
  "mixed heads": { startArrowhead: "triangle", endArrowhead: "circle" },
  diamond: { endArrowhead: "diamond" },
  crowfoot: { startArrowhead: "crowfoot_one", endArrowhead: "crowfoot_many" },
  "everything at once": { strokeStyle: "dotted", strokeWidth: 1, strokeColor: "#1971c2", elbowed: true, roundness: null, startArrowhead: "diamond_outline", endArrowhead: "triangle", points: [[0, 0], [0, 20], [10, 20], [10, 45]] },
};

test("a canvas edge style exports, parses and applies back unchanged (every style dimension)", async () => {
  const base = await fixture();
  for (const [name, patch] of Object.entries(CANVAS_STYLES)) {
    const elements = humanRestyle(base, patch);
    const arrow = byId(elements).get("A_B");
    const exported = sceneToMermaid({ elements });
    const parsed = await parseFlowchart(exported);
    assert.equal(parsed.ok, true, `${name}: ${exported}`);
    const form = edgeForm(arrow);
    const edge = edgeAB(parsed);
    assert.deepEqual([edge.type, edge.stroke, edge.curve], [form.type, form.stroke, form.curve], `${name}: export and parse agree`);
    // The export applied back as is (an agent that read the board and wrote it straight back).
    for (const previous of [base.mermaid, exported, null]) {
      const result = await apply(elements, exported, previous);
      assert.deepEqual(styleOf(byId(result.elements).get("A_B")), styleOf(arrow), `${name}: round trip, previous ${previous === exported ? "the export" : previous ? "the original" : "unknown"}`);
      assert.equal(result.ops.filter((op) => op.id === "A_B" && op.op !== "keep-canvas").length, 0, `${name}: no op on A_B`);
    }
  }
});

test("a canvas edge style survives an unrelated Mermaid write, read from the board or from the agent's own text", async () => {
  const base = await fixture();
  for (const [name, patch] of Object.entries(CANVAS_STYLES)) {
    const elements = humanRestyle(base, patch);
    const arrow = byId(elements).get("A_B");
    const fromBoard = sceneToMermaid({ elements }).replace('C(("Done"))', 'C(("Done v2"))').replace('["Done"]', '["Done v2"]');
    const ownText = base.mermaid.replace('C(["Done"])', 'C(["Done v2"])');
    for (const [how, source] of [["read_board export", fromBoard], ["own text", ownText]]) {
      assert.notEqual(source, how === "own text" ? base.mermaid : sceneToMermaid({ elements }), `${how}: the write relabels C`);
      // The previous Mermaid: the original, or (read_board) the export itself, after an earlier round trip.
      for (const previous of how === "own text" ? [base.mermaid] : [base.mermaid, sceneToMermaid({ elements })]) {
        const result = await apply(elements, source, previous);
        const after = byId(result.elements);
        assert.deepEqual(styleOf(after.get("A_B")), styleOf(arrow), `${name} via ${how}`);
        assert.equal(originOf(after.get("A_B"))?.active, Object.keys(patch).length ? "canvas" : "mermaid", `${name} via ${how}: the canvas edit stays active`);
        assert.ok(result.ops.some((op) => op.op === "relabel" && op.id === "C"), `${name} via ${how}: C relabelled`);
      }
    }
  }
});

test("a real Mermaid change to an edge wins its dimension and makes Mermaid active again", async () => {
  const base = await fixture();
  const original = base.mermaid;
  const write = async (patch, source, previous = original) => {
    const elements = humanRestyle(base, patch);
    const result = await apply(elements, source, previous);
    const arrow = byId(result.elements).get("A_B");
    return { arrow, result, restyle: result.ops.find((op) => op.op === "restyle" && op.id === "A_B") };
  };
  const thick = await write({ strokeStyle: "dashed" }, original.replace(AB, "A ==> B"));
  assert.equal(thick.arrow.strokeWidth, 4);
  assert.equal(thick.arrow.strokeStyle, "dashed", "only the dimension the write changed");
  assert.equal(originOf(thick.arrow).active, "mermaid");
  assert.ok(thick.result.canvasOverwritten.some((unit) => unit.unitId === "A_B"), "the human's version goes to history");

  const solid = await write({ strokeStyle: "dashed" }, original, original.replace(AB, "A -.-> B"));
  assert.equal(solid.arrow.strokeStyle, "solid", "the agent changed -.-> to -->");

  const open = await write({ endArrowhead: "triangle" }, original.replace(AB, "A --- B"));
  assert.equal(open.arrow.endArrowhead, null);
  const circle = await write({ endArrowhead: "triangle" }, original.replace(AB, "A --o B"));
  assert.equal(circle.arrow.endArrowhead, "circle");
  const both = await write({ endArrowhead: "triangle" }, original.replace(AB, "A <--> B"));
  assert.deepEqual([both.arrow.startArrowhead, both.arrow.endArrowhead], ["arrow", "triangle"], "the end head was not changed by the write");

  const elbow = await write({}, original.replace(AB, "A e1@--> B\n  e1@{ curve: step }"));
  assert.equal(elbow.arrow.elbowed, true);
  assert.equal(elbow.arrow.roundness, null);
  assert.ok(elbow.arrow.points.slice(1).every((point, index) => point[0] === elbow.arrow.points[index][0] || point[1] === elbow.arrow.points[index][1]), `right angles: ${JSON.stringify(elbow.arrow.points)}`);
  assert.deepEqual(elbow.arrow.points.at(-1), byId(base.elements).get("A_B").points.at(-1), "the ends stay put");
  const straight = await write({}, original.replace(AB, "A e1@--> B\n  e1@{ curve: linear }"));
  assert.equal(straight.arrow.roundness, null);
  assert.equal(straight.restyle.changes.roundness.to, null);
  const curved = await write({ roundness: null }, original.replace(AB, "A e1@--> B\n  e1@{ curve: basis }"));
  assert.deepEqual(curved.arrow.roundness, { type: 2 });
  const unbent = await write({ elbowed: true, roundness: null, points: [[0, 0], [0, 20], [10, 20], [10, 45]] }, original.replace(AB, "A e1@--> B\n  e1@{ curve: linear }"));
  assert.deepEqual([unbent.arrow.elbowed, unbent.arrow.roundness, unbent.arrow.points], [false, null, [[0, 0], [10, 45]]]);
  // No curve in the Mermaid is no opinion: an elbow arrow stays elbow.
  const keep = await write({ elbowed: true, roundness: null }, original.replace(AB, "A ==> B"));
  assert.equal(keep.arrow.elbowed, true);
  assert.equal(keep.arrow.strokeWidth, 4);
});

test("new edges take Mermaid's curve; a tab conversion gets it too", async () => {
  const base = await fixture();
  const source = `${base.mermaid}\n  A e1@-.-> D\n  e1@{ curve: linear }\n  C e2@==> D\n  e2@{ curve: step }`;
  const result = await apply(base.elements, source, base.mermaid);
  const added = result.ops.filter((op) => op.op === "add-edge").map((op) => byId(result.elements).get(op.id));
  const [toD, fromC] = [added.find((arrow) => arrow.startBinding.elementId === "A"), added.find((arrow) => arrow.startBinding.elementId === "C")];
  assert.deepEqual([toD.roundness, toD.elbowed, toD.strokeStyle], [null, false, "dashed"]);
  assert.deepEqual([fromC.roundness, fromC.elbowed, fromC.strokeWidth], [null, true, 4]);
  // The tab's converter draws every arrow curved; the server gives the converted arrows their curve.
  const parsed = await parseFlowchart(base.mermaid.replace(AB, "A e1@--> B\n  e1@{ curve: linear }").replace("D --> B", "D e2@--> B\n  e2@{ curve: stepAfter }"));
  const adopted = adoptConverted({ master: [], converted: base.elements, source: "main", hash: "m1-test", now: NOW, parsed });
  const converted = byId(adopted.elements);
  assert.deepEqual([converted.get("A_B").roundness, converted.get("A_B").elbowed], [null, false]);
  assert.equal(converted.get("D_B").elbowed, true);
  assert.deepEqual(converted.get("B_C").roundness, { type: 2 });
});

test("to-mermaid notes styles Mermaid can't carry, and exports curves per edge", async () => {
  const base = await fixture();
  const exported = sceneToMermaid({ elements: humanRestyle(base, { strokeWidth: 4, strokeStyle: "dashed", startArrowhead: "triangle", endArrowhead: "circle", roundness: null }) });
  assert.match(exported, /^  A A_B@-\.-o B$/m);
  assert.match(exported, /^  A_B@\{ curve: linear \}$/m);
  assert.match(exported, /^  %% Canvas-only style of A_B \(Mermaid keeps it\): start arrowhead triangle$/m);
  assert.match(exported, /^  linkStyle \d+ stroke-width:4px$/m, "thick and dashed at once: the width goes in linkStyle");
  assert.doesNotMatch(sceneToMermaid({ elements: base.elements }), /@|Canvas-only|linkStyle/, "converted curved arrows need no edge ids");
});

test("linkStyle: Mermaid edge colour, width and dash apply by edge index (issue #42); classDef fills still apply", async () => {
  const base = await fixture();
  const styled = `${base.mermaid}\n  linkStyle 1,2,3 stroke:#1c7ed6,stroke-width:3px`;
  const parsed = await parseFlowchart(styled);
  assert.deepEqual(parsed.edges.map((edge) => edge.style), [null, { stroke: "#1c7ed6", width: 3 }, { stroke: "#1c7ed6", width: 3 }, { stroke: "#1c7ed6", width: 3 }]);
  const result = await apply(base.elements, styled, base.mermaid);
  const after = byId(result.elements);
  assert.deepEqual(["A_B", "B_C", "B_D", "D_B"].map((id) => [after.get(id).strokeColor, after.get(id).strokeWidth]), [["#1e1e1e", 2], ["#1c7ed6", 3], ["#1c7ed6", 3], ["#1c7ed6", 3]]);
  assert.equal(after.get("D").backgroundColor, "#ffc9c9", "classDef on nodes is unaffected");
  const restyle = result.ops.find((op) => op.op === "restyle" && op.id === "B_C");
  assert.deepEqual(restyle.changes.strokeColor, { from: "#1e1e1e", to: "#1c7ed6" });
  // The same Mermaid again changes nothing; exported and applied back, nothing either.
  assert.equal((await apply(result.elements, styled, styled)).ops.filter((op) => op.op === "restyle").length, 0);
  const exported = sceneToMermaid({ elements: result.elements });
  assert.match(exported, /^  linkStyle (\d+,){2}\d+ stroke:#1c7ed6,stroke-width:3px$/m);
  const back = await apply(result.elements, exported, null);
  assert.equal(back.ops.filter((op) => op.op === "restyle").length, 0, exported);
  // Dash: a short first dash is dotted, a longer one dashed, `0` solid; on the dotted operator too.
  const dashed = await apply(base.elements, `${base.mermaid}\n  linkStyle 0 stroke-dasharray:2 4\n  linkStyle 1 stroke-dasharray:6 3\n  linkStyle 2 stroke:red`, base.mermaid);
  assert.deepEqual(["A_B", "B_C", "B_D"].map((id) => byId(dashed.elements).get(id).strokeStyle), ["dotted", "dashed", "solid"]);
  assert.equal(byId(dashed.elements).get("B_D").strokeColor, "red");
});

test("linkStyle default, edge classes and new edges; a tab conversion and the grid get them too", async () => {
  const base = await fixture();
  const parsed = await parseFlowchart("flowchart TD\n  A e1@--> B\n  B e2@--> C\n  C --> A\n  classDef warn stroke:#e03131,stroke-width:4px\n  class e1 warn\n  linkStyle default stroke:#2f9e44");
  assert.deepEqual(parsed.edges.map((edge) => edge.style), [{ stroke: "#2f9e44", width: 4 }, { stroke: "#2f9e44" }, { stroke: "#2f9e44" }], "linkStyle (here: default) over the edge's classes");
  // A new edge from a Mermaid write is drawn in its colour.
  const added = await apply(base.elements, `${base.mermaid}\n  A --> D\n  linkStyle 4 stroke:#f08c00,stroke-dasharray:5 5`, base.mermaid);
  const edge = added.ops.find((op) => op.op === "add-edge");
  const arrow = byId(added.elements).get(edge.id);
  assert.deepEqual([arrow.strokeColor, arrow.strokeStyle, arrow.strokeWidth], ["#f08c00", "dashed", 2]);
  // The tab's converter ignores linkStyle: the server styles the converted arrows.
  const styled = await parseFlowchart(`${base.mermaid}\n  linkStyle 0 stroke:#1c7ed6,stroke-width:1px`);
  const adopted = byId(adoptConverted({ master: [], converted: base.elements, source: "main", hash: "m1-test", now: NOW, parsed: styled }).elements);
  assert.deepEqual([adopted.get("A_B").strokeColor, adopted.get("A_B").strokeWidth], ["#1c7ed6", 1]);
  assert.equal(adopted.get("B_C").strokeColor, "#1e1e1e");
});

test("linkStyle keeps #43's rule: a canvas recolour stays until Mermaid changes that edge's colour", async () => {
  const base = await fixture();
  const blue = `${base.mermaid}\n  linkStyle 0 stroke:#1c7ed6`;
  const applied = await apply(base.elements, blue, base.mermaid);
  // The human recolours A_B red after the agent made it blue.
  const recoloured = stampCanvasEdits({ base: applied.elements, branch: applied.elements.map((element) => (element.id === "A_B" ? { ...element, strokeColor: "#e03131", version: element.version + 1 } : element)), author: HUMAN, at: NOW });
  const relabel = blue.replace('C(["Done"])', 'C(["Done v2"])');
  assert.equal(byId((await apply(recoloured, relabel, blue)).elements).get("A_B").strokeColor, "#e03131", "the same linkStyle again: the human's colour stays");
  assert.equal(byId((await apply(recoloured, base.mermaid.replace('C(["Done"])', 'C(["Done v2"])'), blue)).elements).get("A_B").strokeColor, "#e03131", "linkStyle dropped, but the canvas changed it since: stays");
  assert.equal(byId((await apply(applied.elements, base.mermaid, blue)).elements).get("A_B").strokeColor, "#1e1e1e", "linkStyle dropped and unchanged since: back to the default");
  const green = await apply(recoloured, `${base.mermaid}\n  linkStyle 0 stroke:#2f9e44`, blue);
  assert.equal(byId(green.elements).get("A_B").strokeColor, "#2f9e44", "a new Mermaid colour wins");
  assert.equal(originOf(byId(green.elements).get("A_B")).active, "mermaid");
  // A board recoloured on the canvas only (no linkStyle ever): a Mermaid write without one keeps it.
  const canvasOnly = stampCanvasEdits({ base: base.elements, branch: base.elements.map((element) => (element.id === "B_C" ? { ...element, strokeColor: "#1c7ed6", version: element.version + 1 } : element)), author: HUMAN, at: NOW });
  for (const previous of [base.mermaid, null]) {
    assert.equal(byId((await apply(canvasOnly, base.mermaid.replace('A["Start"]', 'A["Go"]'), previous)).elements).get("B_C").strokeColor, "#1c7ed6");
  }
});

test("linkStyle past the last edge: the error names the line and the edge count", async () => {
  const parsed = await parseFlowchart("flowchart TD\n  A --> B\n  B --> C\n  linkStyle 0 stroke:red\n  linkStyle 2 stroke:#1c7ed6");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.line, 5);
  assert.match(parsed.error.message, /^linkStyle 2 stroke:#1c7ed6: no such edge\. This diagram has 2 edges \(numbered 0 to 1/);
});

test("the ledger words arrow and line style changes: diff, merge (banner, xcld watch)", () => {
  const arrow = (id, extra = {}) => ({ id, type: "arrow", x: 0, y: 0, width: 100, height: 0, strokeColor: "#1e1e1e", strokeWidth: 2, strokeStyle: "solid", roundness: { type: 2 }, elbowed: false, startArrowhead: null, endArrowhead: "arrow", points: [[0, 0], [100, 0]], version: 1, ...extra });
  const line = (extra = {}) => ({ id: "l", type: "line", x: 0, y: 50, width: 100, height: 0, strokeColor: "#1e1e1e", strokeWidth: 2, strokeStyle: "solid", roundness: null, points: [[0, 0], [100, 0]], version: 1, ...extra });
  const before = [arrow("a1"), arrow("a2"), arrow("a3", { roundness: null }), arrow("a4"), arrow("a5", { elbowed: true, roundness: null }), line()];
  const after = [
    arrow("a1", { strokeStyle: "dashed", version: 2 }),
    arrow("a2", { roundness: null, version: 2 }),
    arrow("a3", { elbowed: true, version: 2 }),
    arrow("a4", { endArrowhead: "triangle", startArrowhead: "dot", strokeWidth: 4, version: 2 }),
    arrow("a5", { elbowed: false, roundness: { type: 2 }, version: 2 }),
    line({ strokeStyle: "dotted", roundness: { type: 2 }, strokeColor: "#2f9e44", version: 2 }),
  ];
  const text = formatDiff(diffElements(before, after, { old: "old", new: "new" }));
  for (const words of ["made dashed (strokeStyle: solid -> dashed) (a1)", "made straight (roundness: {\"type\":2} -> <unset>) (a2)", "made elbow (elbowed: false -> true) (a3)", "arrowhead to triangle", "start arrowhead to dot", "made extra bold", "made curved (elbowed: true -> false) (a5)", "~ line \"line mark\" made dotted", "~ line \"line mark\" made curved", "colour to #2f9e44"]) {
    assert.ok(text.includes(words), `${words} in:\n${text}`);
  }
  assert.ok(!/a5\)[^\n]*\n[^\n]*roundness[^\n]*\(a5\)/.test(text), "to or from elbow is one line");
  assert.deepEqual(describeLineStyleChange(arrow("x"), arrow("x", { elbowed: true, roundness: null, endArrowhead: null })), ["made elbow", "arrowhead to none"]);

  const merged = mergeBoard({ base: before, master: before, branch: after, branchWrittenAt: NOW, branchAuthor: HUMAN });
  const styled = Object.fromEntries(merged.applied.map((unit) => [unit.unitId, unit.styled]));
  assert.deepEqual(styled.a1, ["made dashed"]);
  assert.deepEqual(styled.a2, ["made straight"]);
  assert.deepEqual(styled.l, ["made dotted", "made curved", "colour to #2f9e44"]);
  const details = bannerDetails(mergeItems({ author: "agent:copilot-cli#a1b2c3", applied: merged.applied, at: NOW }, { name: "Ada", tabId: "t1" }));
  assert.ok(details.some((line) => /changed unlabeled arrow[^:]*: made dashed$/.test(line)), details.join("\n"));
  const watched = formatMergedEvent({ name: "b", version: "v1", author: HUMAN, applied: merged.applied }, NOW);
  assert.match(watched, /changed [^,]*\(made straight\)/);
});
