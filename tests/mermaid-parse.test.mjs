import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_WORKER_URL, createMermaidParser, parseFlowchart, parserStatus, warmUp } from "../tools/mermaid-parse.mjs";

// Every test here shares the module's default parser: one worker, warmed once.
const BUNDLE_HINT = "tools/mermaid-parse.bundle.mjs is missing; run \"cd app; npm ci; npm run build\" first";

test("mermaid parser warms up once in a worker, without DOM globals on this thread", async () => {
  assert.ok(existsSync(DEFAULT_WORKER_URL), BUNDLE_HINT);
  const [first, second] = await Promise.all([warmUp(), warmUp()]);
  assert.equal(first.state, "ready");
  assert.equal(second.state, "ready");
  assert.equal(first.startedAt, second.startedAt, "warmUp is idempotent");
  assert.ok(first.warmUpMs >= 0);
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(typeof globalThis.document, "undefined");
  const requireFromApp = createRequire(path.resolve("app", "package.json"));
  const appMermaid = JSON.parse(await readFile(requireFromApp.resolve("mermaid/package.json"), "utf8")).version;
  assert.equal(first.mermaidVersion, appMermaid, "the server parses with the same Mermaid the tab's converter bundles");
});

test("parseFlowchart returns shapes, multiline labels, edge labels and styles", async () => {
  const result = await parseFlowchart(`flowchart LR
  A["Two
lines"] -->|yes| B{Decide}
  B --> C((Circle))
  C -.-> D[(Store)]
  D ==> E([Pill])
  E --- F(Round)
  F <--> G[Plain #quot;quoted#quot;]
  G --x H[Cross]
  H --> I["has <br> tag"]
  style C fill:#abc,stroke-width:4px
`);
  assert.equal(result.ok, true);
  assert.equal(result.direction, "LR");
  const node = (id) => result.nodes.find((item) => item.id === id);
  assert.equal(node("A").label, "Two\nlines");
  assert.deepEqual(result.nodes.map((item) => [item.id, item.shape]), [
    ["A", "square"], ["B", "diamond"], ["C", "circle"], ["D", "cylinder"], ["E", "stadium"],
    ["F", "round"], ["G", "square"], ["H", "square"], ["I", "square"],
  ]);
  assert.equal(node("G").label, "Plain \"quoted\"");
  assert.equal(node("I").label, "has <br> tag", "<br> is not a line break (the tab shows it literally too)");
  assert.deepEqual(node("C").style.container, { backgroundColor: "#abc", fillStyle: "solid", strokeWidth: 4 });
  const edge = (start, end) => result.edges.find((item) => item.start === start && item.end === end);
  assert.equal(edge("A", "B").label, "yes");
  assert.equal(edge("B", "C").label, "");
  assert.equal(edge("C", "D").stroke, "dotted");
  assert.equal(edge("D", "E").stroke, "thick");
  assert.deepEqual(edge("E", "F").arrowheads, { endArrowhead: null, startArrowhead: null });
  assert.deepEqual(edge("F", "G").arrowheads, { endArrowhead: "arrow", startArrowhead: "arrow" });
  assert.deepEqual(edge("G", "H").arrowheads, { endArrowhead: "bar" });
});

test("parseFlowchart returns subgraphs, classDef/class styles and parallel edges", async () => {
  const result = await parseFlowchart(`flowchart TD
  subgraph Outer["Outer box"]
    subgraph Inner["Inner"]
      A[One]
    end
    B[Two]
  end
  A --> B
  A --> B
  B --> Inner
  classDef hot fill:#ffc9c9,stroke:#e03131,color:#c92a2a
  class A hot
  class Outer hot
`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.subgraphs.map((item) => [item.id, item.title, item.nodes]), [
    ["Inner", "Inner", ["A"]],
    ["Outer", "Outer box", ["Inner", "B"]],
  ]);
  assert.deepEqual(result.nodes.map((item) => item.id), ["A", "B"], "a subgraph used as an edge end is not a node");
  assert.deepEqual(result.classDefs.hot.styles, ["fill:#ffc9c9", "stroke:#e03131", "color:#c92a2a"]);
  const a = result.nodes.find((item) => item.id === "A");
  assert.deepEqual(a.classes, ["hot"]);
  assert.deepEqual(a.style, {
    container: { backgroundColor: "#ffc9c9", fillStyle: "solid", strokeColor: "#e03131" },
    label: { strokeColor: "#c92a2a" },
  });
  assert.deepEqual(result.subgraphs[1].style.container, { backgroundColor: "#ffc9c9", fillStyle: "solid", strokeColor: "#e03131" });
  assert.deepEqual(result.edges.map((item) => [item.start, item.end]), [["A", "B"], ["A", "B"], ["B", "Inner"]]);
});

test("parseFlowchart reports unsupported diagrams and syntax errors with a line", async () => {
  assert.deepEqual(await parseFlowchart("sequenceDiagram\n  A->>B: hi"), { ok: false, unsupported: true, diagramType: "sequence" });
  assert.equal((await parseFlowchart("classDiagram\n  class Animal")).unsupported, true);
  const broken = await parseFlowchart("flowchart TD\n  A --> B\n  B -->> \n");
  assert.equal(broken.ok, false);
  assert.equal(broken.unsupported, undefined);
  assert.equal(broken.error.line, 3);
  assert.match(broken.error.message, /Parse error on line 3/);
  const unknown = await parseFlowchart("not a diagram at all");
  assert.equal(unknown.ok, false);
  assert.match(unknown.error.message, /No diagram type detected/);
  assert.ok(parserStatus().parses >= 4);
});

test("a parser without its bundle reports failed instead of throwing at warm-up", async () => {
  const parser = createMermaidParser({ workerUrl: new URL("./does-not-exist.bundle.mjs", import.meta.url) });
  const status = await parser.warmUp();
  assert.equal(status.state, "failed");
  assert.match(status.error, /npm run build/);
  await assert.rejects(parser.parseFlowchart("flowchart TD\n  A"), /Mermaid parser unavailable/);
});
