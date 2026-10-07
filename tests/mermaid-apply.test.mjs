import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { applyMermaid, converterElementIds, generateKeyBetween } from "../tools/mermaid-apply.mjs";
import { disambiguateDuplicateElementIds } from "../app/src/ids.mjs";
import { MERMAID_HASH_KEY, mermaidSourceHash, recordedMermaidHashes } from "../tools/mermaid-hash.mjs";
import { parseFlowchart } from "../tools/mermaid-parse.mjs";
import { sceneToMermaid } from "../tools/to-mermaid.mjs";

// mermaid-apply-base/-next.excalidraw are real tab conversions (headless Chromium through
// tests/browser/run-mermaid-conversion.mjs --app): the converter + convertToExcalidrawElements
// + disambiguated ids + the Mermaid hash stamp, exactly as convertMermaidInbox writes them.
const fixture = async (name) => JSON.parse(await readFile(path.resolve("tests", "fixtures", name), "utf8"));
const NOW = 1_800_000_000_000;

const apply = async (master, source, options = {}) => applyMermaid({
  master,
  parsed: await parseFlowchart(source),
  hashOfSource: mermaidSourceHash(source),
  now: NOW,
  ...options,
});

const byId = (elements) => new Map(elements.map((element) => [element.id, element]));
const labelOf = (elements, containerId) => elements.find((element) => element.type === "text" && element.containerId === containerId && !element.isDeleted);
const opsOf = (result, op) => result.ops.filter((item) => item.op === op);
const boxOf = (element) => {
  if (Array.isArray(element.points)) {
    const xs = element.points.map((point) => element.x + point[0]);
    const ys = element.points.map((point) => element.y + point[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return { x: element.x, y: element.y, w: element.width, h: element.height };
};
const intersects = (left, right) => left.x < right.x + right.w && right.x < left.x + left.w && left.y < right.y + right.h && right.y < left.y + left.h;
const humanNote = (id, x, y, text = "Human note") => ({
  id, type: "text", x, y, width: 120, height: 25, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent",
  fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null,
  index: "b00", roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1,
  link: null, locked: false, text, fontSize: 20, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null,
  originalText: text, autoResize: true, lineHeight: 1.25,
});

test("applyMermaid leaves new boards, human-only boards and other diagram types to a tab", async () => {
  const source = "flowchart TD\n  A --> B\n";
  for (const master of [null, { elements: [] }, { elements: [humanNote("note", 0, 0)] }]) {
    const result = await apply(master, source);
    assert.equal(result.needsTabLayout, true);
    assert.deepEqual(result.ops, []);
  }
  const base = await fixture("mermaid-apply-base.excalidraw");
  const sequence = await apply(base, "sequenceDiagram\n  A->>B: hi");
  assert.equal(sequence.needsTabLayout, true);
  assert.match(sequence.reason, /unsupported diagram type: sequence/);
  assert.deepEqual(sequence.elements, base.elements);
  const broken = await apply(base, "flowchart TD\n  A -->> \n");
  assert.equal(broken.needsTabLayout, false);
  assert.equal(broken.error.line, 2);
  assert.deepEqual(broken.elements, base.elements);
});

test("applyMermaid with the board's own Mermaid changes nothing", async () => {
  const base = await fixture("mermaid-apply-base.excalidraw");
  const result = await apply(base, base.mermaid);
  assert.equal(result.needsTabLayout, false);
  assert.deepEqual(result.ops, []);
  assert.deepEqual(result.elements, base.elements);
});

test("applyMermaid relabels nodes and edges in place, keeping bound text with its container", async () => {
  const base = await fixture("mermaid-apply-base.excalidraw");
  const source = base.mermaid
    .replace('A["Start"]', 'A["Start here\nand go"]')
    .replace("B -->|yes| C", "B -->|ok| C")
    .replace("B -->|no| D", "B --> D")
    .replace("  D --> B", "  D -->|retry| B");
  const result = await apply(base, source);
  const before = byId(base.elements);
  const after = byId(result.elements);
  assert.deepEqual(opsOf(result, "relabel").map((op) => [op.id, op.to]), [
    ["A", "Start here\nand go"], ["B_C", "ok"], ["B_D", ""], ["D_B", "retry"],
  ]);
  const a = after.get("A");
  assert.equal(a.x, before.get("A").x);
  assert.equal(a.width, before.get("A").width);
  const aLabel = labelOf(result.elements, "A");
  assert.equal(aLabel.id, labelOf(base.elements, "A").id, "the same text element is relabeled");
  assert.equal(aLabel.originalText, "Start here\nand go");
  assert.equal(aLabel.text.includes("<br"), false);
  assert.ok(aLabel.y >= a.y && aLabel.y + aLabel.height <= a.y + a.height, "label stays inside its container");
  assert.ok(a.height >= aLabel.height, "container grows when the label needs more lines");
  assert.equal(aLabel.version, labelOf(base.elements, "A").version + 1);
  assert.equal(aLabel.customData[MERMAID_HASH_KEY], mermaidSourceHash(source));
  assert.equal(labelOf(result.elements, "B_D"), undefined, "the removed edge label is deleted");
  assert.ok(!after.get("B_D").boundElements?.some((bound) => bound.type === "text"));
  const retry = labelOf(result.elements, "D_B");
  assert.equal(retry.labelPosition, 0.5);
  assert.deepEqual(after.get("D_B").boundElements, [{ type: "text", id: retry.id }]);
  // Untouched elements keep their version and their old hash.
  assert.equal(after.get("C").version, before.get("C").version);
  assert.equal(after.get("C").customData[MERMAID_HASH_KEY], before.get("C").customData[MERMAID_HASH_KEY]);
  assert.ok(recordedMermaidHashes(result.elements).has(mermaidSourceHash(source)), "the board records the applied Mermaid");
});

test("applyMermaid deletes only Mermaid-origin elements; human notes and arrows survive", async () => {
  const base = await fixture("mermaid-apply-base.excalidraw");
  const c = base.elements.find((element) => element.id === "C");
  const humanRect = { ...humanNote("human-box", 600, 600), type: "rectangle", text: undefined, boundElements: [{ id: "human-arrow", type: "arrow" }] };
  const humanArrow = {
    ...humanNote("human-arrow", 600, 600), type: "arrow", points: [[0, 0], [c.x - 600, c.y - 600]], boundElements: null,
    startBinding: { elementId: "human-box", mode: "orbit", fixedPoint: [0.5, 0.5] },
    endBinding: { elementId: "C", mode: "orbit", fixedPoint: [0.5, 0] }, startArrowhead: null, endArrowhead: "arrow",
  };
  const master = { elements: [...base.elements.map((element) => (element.id === "C" ? { ...element, boundElements: [...element.boundElements, { id: "human-arrow", type: "arrow" }] } : element)), humanNote("note-near-c", c.x, c.y + c.height + 10), humanRect, humanArrow] };
  const source = `flowchart TD
  A["Start"] --> B{"Valid?"}
  B -->|no| D["Fix
input"]
  D --> B
  classDef hot fill:#ffc9c9,stroke:#e03131,color:#c92a2a
  class D hot`;
  const result = await apply(master, source);
  const after = byId(result.elements);
  assert.deepEqual(opsOf(result, "delete").map((op) => op.id).sort(), ["B_C", "C", "G"]);
  for (const id of ["B_C", "C", "G"]) assert.equal(after.get(id).isDeleted, true);
  assert.equal(result.elements.find((element) => element.containerId === "C").isDeleted, true, "bound text goes with its container");
  for (const id of ["note-near-c", "human-box", "human-arrow"]) assert.equal(after.get(id).isDeleted, false, `${id} survives`);
  assert.equal(after.get("human-arrow").endBinding, null, "a human arrow to a deleted shape is kept, unbound");
  assert.deepEqual(after.get("human-arrow").startBinding.elementId, "human-box");
  assert.deepEqual(opsOf(result, "unbind"), [{ op: "unbind", id: "human-arrow", end: "end", from: "C" }]);
  assert.ok(!after.get("B").boundElements.some((bound) => bound.id === "B_C"));
  assert.equal(after.get("note-near-c").version, 1, "human notes are not even touched");

  // With the previous Mermaid known, elements that weren't in it are never deleted.
  const previous = await parseFlowchart(base.mermaid.replace('B -->|yes| C(["Done"])', "B --> X"));
  const limited = await apply(master, source, { previous });
  assert.deepEqual(opsOf(limited, "delete").map((op) => op.id).sort(), ["C", "G"]);
  assert.equal(byId(limited.elements).get("B_C").isDeleted, false, "B_C was not in the previous Mermaid");
});

test("applyMermaid places new nodes next to a connected neighbour, in free space, deterministically", async () => {
  const base = await fixture("mermaid-apply-base.excalidraw");
  const d = base.elements.find((element) => element.id === "D");
  // A human note exactly where the first choice (straight below D) would go.
  const master = { elements: [...base.elements, humanNote("blocker", d.x, d.y + d.height + 80, "In the way")] };
  const source = `${base.mermaid}
  D --> E(("Retry"))
  E --> F["Give up"]
  Lonely["Not connected"]`;
  const first = await apply(master, source);
  const second = await apply(master, source);
  assert.deepEqual(first, second, "same inputs, same output");
  const adds = opsOf(first, "add-node");
  assert.deepEqual(adds.map((op) => [op.id, op.anchor, op.placement]), [["E", "D", "after"], ["F", "E", "after"], ["Lonely", null, "free"]]);
  const after = byId(first.elements);
  const masterIds = new Set(master.elements.map((element) => element.id));
  for (const { id } of adds) {
    const node = after.get(id);
    assert.equal(node.customData[MERMAID_HASH_KEY], mermaidSourceHash(source));
    const others = first.elements.filter((element) => !element.isDeleted && element.id !== id
      && (masterIds.has(element.id) || adds.some((add) => add.id === element.id))
      && !(element.type === "text" && element.containerId));
    for (const other of others) assert.equal(intersects(boxOf(node), boxOf(other)), false, `${id} overlaps ${other.id}`);
  }
  assert.ok(after.get("E").y >= d.y + d.height, "TD: the new node goes below its source");
  assert.equal(after.get("E").type, "ellipse");
  assert.equal(labelOf(first.elements, "E").originalText, "Retry");
  const de = after.get("D_E");
  assert.equal(de.startBinding.elementId, "D");
  assert.equal(de.endBinding.elementId, "E");
  assert.ok(after.get("E").boundElements.some((bound) => bound.id === "D_E"));
  // New elements get valid, increasing fractional indices.
  const indices = first.elements.map((element) => element.index);
  assert.ok(indices.every((index) => typeof index === "string"));
  assert.deepEqual([...indices].sort(), indices);
});

test("applyMermaid adds straight bound arrows between existing shapes and bows parallel ones", async () => {
  const base = await fixture("mermaid-apply-base.excalidraw");
  const source = `${base.mermaid}
  A --> D
  A -.->|again| B`;
  const result = await apply(base, source);
  const after = byId(result.elements);
  assert.deepEqual(opsOf(result, "add-edge").map((op) => [op.id, op.start, op.end]), [["A_D", "A", "D"], ["A_B_2", "A", "B"]]);
  const ad = after.get("A_D");
  assert.equal(ad.points.length, 2, "straight");
  assert.deepEqual([ad.startBinding.elementId, ad.endBinding.elementId], ["A", "D"]);
  assert.equal(ad.endArrowhead, "arrow");
  assert.ok(after.get("A").boundElements.some((bound) => bound.id === "A_D"));
  assert.ok(after.get("D").boundElements.some((bound) => bound.id === "A_D"));
  const parallel = after.get("A_B_2");
  assert.equal(parallel.points.length, 3, "a second A -> B arrow bows around the first");
  assert.equal(parallel.strokeStyle, "dashed");
  assert.equal(labelOf(result.elements, "A_B_2").originalText, "again");
});

test("applyMermaid restyles via classes, reshapes, and moves nodes between subgraphs", async () => {
  const base = await fixture("mermaid-apply-base.excalidraw");
  const source = base.mermaid
    .replace("class D hot", "class A hot")
    .replace('A["Start"] --> B{"Valid?"}', 'A["Start"] --> B["Valid?"]')
    .replace("  subgraph G[\"Review\"]\n    C\n", "  subgraph G[\"Review\"]\n    C\n    D\n")
    .replace("D --> B", "D -.-> B");
  const result = await apply(base, source);
  const after = byId(result.elements);
  const before = byId(base.elements);
  assert.equal(after.get("A").backgroundColor, "#ffc9c9");
  assert.equal(after.get("A").strokeColor, "#e03131");
  assert.equal(labelOf(result.elements, "A").strokeColor, "#c92a2a");
  assert.equal(after.get("D").backgroundColor, "#ffc9c9", "without the previous Mermaid, an unstyled node keeps its colors");
  const reset = await apply(base, source, { previous: await parseFlowchart(base.mermaid) });
  assert.equal(byId(reset.elements).get("D").backgroundColor, "transparent", "a class Mermaid removed is reset");
  assert.equal(labelOf(reset.elements, "D").strokeColor, "#1e1e1e");
  assert.deepEqual(opsOf(result, "reshape"), [{ op: "reshape", id: "B", from: "diamond", to: "rectangle" }]);
  assert.equal(after.get("D_B").strokeStyle, "dashed");
  assert.deepEqual(after.get("D").groupIds, ["subgraph_group_G"]);
  assert.deepEqual(labelOf(result.elements, "D").groupIds, ["subgraph_group_G"]);
  const g = after.get("G");
  const dBox = boxOf(after.get("D"));
  assert.ok(intersects(boxOf(g), dBox) && g.x <= dBox.x && g.x + g.width >= dBox.x + dBox.w, "the subgraph grows to hold its new member");
  assert.ok(g.width > before.get("G").width);
});

test("applyMermaid maps to-mermaid's rewritten ids back to human-drawn shapes", async () => {
  const base = await fixture("mermaid-apply-base.excalidraw");
  const box = { ...humanNote("h-box", 700, 0), type: "rectangle", boundElements: [{ type: "text", id: "h-box-text" }] };
  delete box.text;
  const label = { ...humanNote("h-box-text", 710, 10, "Human box"), containerId: "h-box", textAlign: "center", verticalAlign: "middle" };
  const master = { elements: [...base.elements, box, label] };
  const exported = sceneToMermaid(master);
  assert.match(exported, /h_box\["Human box"\]/);
  const result = await apply(master, exported.replace('h_box["Human box"]', 'h_box["Renamed by agent"]'));
  assert.deepEqual(opsOf(result, "add-node"), [], "no duplicate shape");
  assert.equal(labelOf(result.elements, "h-box").originalText, "Renamed by agent");
  assert.equal(byId(result.elements).get("h-box").customData, undefined, "a human shape does not become Mermaid-owned");
});

// Approximate golden check: the new elements match the tab's own conversion of the same
// Mermaid in every field that decides how they render, except position and size.
test("applyMermaid output matches the tab's converter for new nodes and edges (approximate)", async () => {
  const base = await fixture("mermaid-apply-base.excalidraw");
  const golden = await fixture("mermaid-apply-next.excalidraw");
  const result = await apply(base, golden.mermaid);
  const goldenById = byId(golden.elements);
  const created = result.elements.filter((element) => !base.elements.some((old) => old.id === element.id));
  assert.equal(created.length, 6);
  const layoutFields = new Set(["x", "y", "width", "height", "seed", "version", "versionNonce", "updated", "created", "index", "points", "boundElements", "id"]);
  for (const element of created) {
    const expected = element.containerId
      ? golden.elements.find((item) => item.type === "text" && item.containerId === element.containerId)
      : goldenById.get(element.id);
    assert.ok(expected, `golden has ${element.id}`);
    assert.deepEqual(Object.keys(element), Object.keys(expected), `${element.id}: same fields in the same order`);
    for (const key of Object.keys(expected)) {
      // `text` is the soft-wrapped label; wrapping depends on font metrics and shape size.
      if (layoutFields.has(key) || key === "text") continue;
      if (key === "startBinding" || key === "endBinding") {
        assert.equal(element[key].elementId, expected[key].elementId, `${element.id}.${key}`);
        assert.equal(element[key].mode, expected[key].mode);
        continue;
      }
      assert.deepEqual(element[key], expected[key], `${element.id}.${key}`);
    }
    assert.deepEqual((element.boundElements ?? []).map((bound) => bound.type), (expected.boundElements ?? []).map((bound) => bound.type));
  }
});

test("converterElementIds gives the ids the tab's conversion gives (skeleton order + disambiguation)", async () => {
  const parsed = await parseFlowchart(`flowchart TD
  subgraph Outer["Outer box"]
    subgraph Inner["Inner"]
      A[One]
    end
    B[Two]
  end
  A --> B
  A --> B
  B --> Inner
  A_B[Named like an edge]`);
  const ids = converterElementIds(parsed);
  const skeleton = [
    ...[...parsed.subgraphs].reverse().map((item) => ({ id: item.id })),
    ...parsed.nodes.map((item) => ({ id: item.id })),
    ...parsed.edges.map((item) => ({ id: `${item.start}_${item.end}` })),
  ];
  const expected = disambiguateDuplicateElementIds(skeleton).map((item) => item.id);
  assert.deepEqual([...ids.subgraphs.values(), ...ids.nodes.values(), ...ids.edges], expected);
  assert.deepEqual(ids.edges, ["A_B_2", "A_B_3", "B_Inner"]);
});
test("generateKeyBetween produces ordered fractional indices", () => {
  assert.equal(generateKeyBetween(null, null), "a0");
  assert.equal(generateKeyBetween("a0", null), "a1");
  assert.equal(generateKeyBetween("az", null), "b00");
  assert.equal(generateKeyBetween("Zz", null), "a0");
  const between = generateKeyBetween("a0", "a1");
  assert.ok(between > "a0" && between < "a1");
  const before = generateKeyBetween(null, "a0");
  assert.ok(before < "a0");
  const deeper = generateKeyBetween("a0", "a0V");
  assert.ok(deeper > "a0" && deeper < "a0V");
});

test("xcld mermaid-apply --dry-run previews the changes without writing", async () => {
  const root = path.resolve(".test-run", `mermaid-apply-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  try {
    const base = await fixture("mermaid-apply-base.excalidraw");
    const board = path.join(root, "flow.excalidraw");
    const text = `${JSON.stringify(base, null, 2)}\n`;
    await writeFile(board, text, "utf8");
    await writeFile(path.join(root, "next.mmd"), base.mermaid.replace('A["Start"]', 'A["Begin"]'), "utf8");
    const run = (args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["tools/cli.mjs", "mermaid-apply", ...args], {
        cwd: path.resolve("."), env: { ...process.env, XCLD_BOARDS_DIR: root }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    const preview = await run(["--dry-run", "flow", path.join(root, "next.mmd")]);
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /relabel node A: "Start" -> "Begin"/);
    assert.match(preview.stdout, /1 change \(dry run, nothing written\)/);
    assert.equal(await readFile(board, "utf8"), text, "the board is untouched");
    const refused = await run(["flow", path.join(root, "next.mmd")]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Usage: xcld mermaid-apply --dry-run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});