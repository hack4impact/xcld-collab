import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { DEFAULT_WORKER_URL, createMermaidParser } from "../tools/mermaid-parse.mjs";

// Mermaid isn't pinned (lead, 2026-10-07): these checks fail when the installed Mermaid stops
// working with the parser bundle's FlowDB patch (app/scripts/build-mermaid.mjs) or with the
// parse output tools/mermaid-apply.mjs relies on. If they fail, pin Mermaid (docs/DESIGN.md).
// CI runs them with the rest of the suite; a manual CI run can try the latest Mermaid 11.x.
const BUNDLE = path.resolve("tools", "mermaid-parse.bundle.mjs");
const needsBundle = { skip: !existsSync(BUNDLE) && "Run cd app; npm ci; npm run build first (Mermaid parser bundle)." };
// Its own worker: `configure` changes that worker's site config, not the shared parser's.
const parser = createMermaidParser();
after(() => parser.close());

const installedMermaid = async () => {
  const requireFromApp = createRequire(path.resolve("app", "package.json"));
  return JSON.parse(await readFile(requireFromApp.resolve("mermaid/package.json"), "utf8")).version;
};

test("Mermaid CI (d): the installed Mermaid version, and the bundle is built from it", needsBundle, async (t) => {
  const status = await parser.warmUp();
  assert.equal(status.state, "ready", status.error ?? "");
  const installed = await installedMermaid();
  t.diagnostic(`mermaid ${installed} installed; parser bundle built with mermaid ${status.mermaidVersion}, jsdom ${status.jsdomVersion}`);
  assert.match(installed, /^11\./, "the parser and the converter expect Mermaid 11");
  assert.equal(status.mermaidVersion, installed, "rebuild the parser bundle (cd app; npm run build) after changing Mermaid");
});

test("Mermaid CI (a): the parser bundle carries the FlowDB config-once patch", needsBundle, async () => {
  const bundle = await readFile(BUNDLE, "utf8");
  // The build replaces `this.config = getConfig();` in FlowDB.addVertex (property names survive minifying).
  assert.match(bundle, /this\.config\s*=\s*this\.xcldConfig\s*\?\?=/, "the FlowDB patch marker is missing from the bundle");
  assert.equal((bundle.match(/xcldConfig\s*\?\?=/g) ?? []).length, 1, "patched exactly once");
});

test("Mermaid CI (b): one diagram's config never carries over to the next parse", needsBundle, async () => {
  // Three labeled edges. maxEdges is read through FlowDB's cached `this.config`, so a config the
  // patch shared between diagrams would show up as the wrong edge limit.
  const chain = (prefix = "") => `${prefix}flowchart TD\n  A["a"] --> B["b"]\n  B --> C["c"]\n  C --> D["d"]\n`;
  const limited = /Edge limit exceeded/;
  try {
    await parser.configure({ maxEdges: 2 });
    const first = await parser.parseFlowchart(chain());
    assert.equal(first.ok, false);
    assert.match(first.error.message, limited, "the config of this parse applies");
    await parser.configure({});
    const second = await parser.parseFlowchart(chain());
    assert.equal(second.ok, true, `the previous parse's config leaked: ${second.error?.message ?? ""}`);
    assert.equal(second.edges.length, 3);
    await parser.configure({ maxEdges: 2 });
    assert.match((await parser.parseFlowchart(chain())).error?.message ?? "", limited, "and back again");
  } finally {
    await parser.configure({});
  }
  // Diagrams with different %%{init}%% directives parse independently too. (Mermaid 11 applies
  // no directive in getDiagramFromText, and maxEdges is a secure key a directive can't set.)
  const plain = await parser.parseFlowchart(chain());
  const withInit = await parser.parseFlowchart(chain('%%{init: {"maxEdges": 2, "flowchart": {"htmlLabels": false}}}%%\n'));
  const plainAgain = await parser.parseFlowchart(chain());
  assert.equal(withInit.ok, true, withInit.error?.message);
  assert.deepEqual(plainAgain, plain);
  assert.deepEqual(withInit.nodes, plain.nodes);
});

test("Mermaid CI (c): the parse output mermaid-apply relies on (vertices, edges, subgraphs, classes)", needsBundle, async () => {
  const result = await parser.parseFlowchart(`flowchart LR
  subgraph G["Group"]
    A["Start"] -->|go| B{"Check"}
  end
  B -.-> C(("Done"))
  B ==> D([Pill])
  classDef hot fill:#ffc9c9,stroke:#e03131,color:#c92a2a
  class C hot
  style D fill:#a5d8ff
`);
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(Object.keys(result).sort(), ["classDefs", "diagramType", "direction", "edges", "nodes", "ok", "subgraphs"]);
  assert.equal(result.direction, "LR");
  assert.ok(["flowchart-v2", "flowchart"].includes(result.diagramType), result.diagramType);
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  assert.deepEqual([...byId.keys()].sort(), ["A", "B", "C", "D"]);
  for (const node of result.nodes) {
    for (const key of ["id", "label", "shape", "classes", "styles", "link", "style"]) assert.ok(key in node, `node.${key}`);
    assert.ok(node.style.container && node.style.label, "node.style.container and .label");
  }
  assert.equal(byId.get("A").label, "Start");
  assert.equal(byId.get("B").shape, "diamond");
  assert.equal(byId.get("C").shape, "circle");
  assert.equal(byId.get("D").shape, "stadium");
  assert.deepEqual(byId.get("C").classes, ["hot"]);
  assert.equal(byId.get("C").style.container.backgroundColor, "#ffc9c9");
  assert.equal(byId.get("C").style.label.strokeColor, "#c92a2a");
  assert.equal(byId.get("D").style.container.backgroundColor, "#a5d8ff");
  assert.equal(result.edges.length, 3);
  for (const edge of result.edges) {
    for (const key of ["mermaidId", "start", "end", "label", "type", "stroke", "arrowheads"]) assert.ok(key in edge, `edge.${key}`);
  }
  assert.deepEqual(result.edges.map((edge) => [edge.start, edge.end, edge.label, edge.stroke]), [["A", "B", "go", "normal"], ["B", "C", "", "dotted"], ["B", "D", "", "thick"]]);
  assert.equal(typeof result.edges[0].arrowheads, "object");
  assert.equal(result.subgraphs.length, 1);
  const [group] = result.subgraphs;
  for (const key of ["id", "title", "nodes", "classes", "style"]) assert.ok(key in group, `subgraph.${key}`);
  assert.equal(group.id, "G");
  assert.equal(group.title, "Group");
  assert.deepEqual([...group.nodes].sort(), ["A", "B"]);
  assert.deepEqual(result.classDefs.hot.styles, ["fill:#ffc9c9", "stroke:#e03131", "color:#c92a2a"]);
  const sequence = await parser.parseFlowchart("sequenceDiagram\n  A->>B: hi");
  assert.equal(sequence.ok, false);
  assert.equal(sequence.unsupported, true);
  assert.ok(existsSync(DEFAULT_WORKER_URL));
});
