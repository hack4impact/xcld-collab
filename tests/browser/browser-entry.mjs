import mermaid from "mermaid";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { MERMAID_CONFIG } from "@excalidraw/mermaid-to-excalidraw/dist/constants.js";
import { parseMermaidFlowChartDiagram } from "@excalidraw/mermaid-to-excalidraw/dist/parser/flowchart.js";
// The runner bundles a copy of this file from app/.scratch/, so these paths are relative to there.
import { disambiguateDuplicateElementIds } from "../src/ids.mjs";
import { mermaidSourceHash, stampMermaidHash } from "../../tools/mermaid-hash.mjs";

const CONFIG = {
  startOnLoad: false,
  flowchart: { curve: "linear" },
  themeVariables: { fontSize: "20px" },
};

const APPLY_BASE = `flowchart TD
  A["Start"] --> B{"Valid?"}
  B -->|yes| C(["Done"])
  B -->|no| D["Fix
input"]
  D --> B
  subgraph G["Review"]
    C
  end
  classDef hot fill:#ffc9c9,stroke:#e03131,color:#c92a2a
  class D hot`;

const DEFINITIONS = {
  flat: `flowchart LR
  A[One] --> B[Two]`,
  subgraph: `flowchart LR
  subgraph G[Group]
    A[One] --> B[Two]
  end`,
  // Server-side Mermaid apply (tests/mermaid-apply.test.mjs): a base board, then the same
  // diagram with a new node, a parallel edge and new edge styles.
  "apply-base": APPLY_BASE,
  "apply-next": `${APPLY_BASE}
  D --> E(("Retry"))
  A -.-> C
  A ==> E
  A --> B`,
};

const capturedConsoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  capturedConsoleErrors.push(args.map(describeValue));
  originalConsoleError(...args);
};

const summarizeElements = (parsed) => {
  const elements = Array.isArray(parsed) ? parsed : parsed.elements;
  const files = Array.isArray(parsed) ? {} : parsed.files ?? {};
  return {
    count: elements.length,
    types: elements.map((element) => element.type),
    ids: elements.map((element) => element.id),
    groupIds: elements.map((element) => element.groupIds ?? []),
    fileIds: Object.keys(files),
  };
};

const describeValue = (value) => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return String(value);
};

const runRawFlowchartParser = async (definition) => {
  const mergedConfig = {
    ...MERMAID_CONFIG,
    ...CONFIG,
    themeVariables: {
      ...MERMAID_CONFIG.themeVariables,
      ...CONFIG.themeVariables,
    },
  };
  mermaid.initialize(mergedConfig);
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(definition);
  const renderId = `browser-harness-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const svgContainer = document.createElement("div");
  svgContainer.id = `${renderId}-container`;
  svgContainer.setAttribute("style", "opacity:0;position:fixed;z-index:-1;left:-99999px;top:-99999px;");
  document.body.appendChild(svgContainer);
  try {
    const { svg } = await mermaid.render(renderId, definition, svgContainer);
    svgContainer.innerHTML = svg;
    const svgIds = Array.from(svgContainer.querySelectorAll("[id]"), (element) => element.id).filter(Boolean);
    const subgraphs = diagram.db.getSubGraphs?.() ?? [];
    const dbSubGraphs = Array.isArray(subgraphs)
      ? subgraphs.map((subgraph) => ({ id: subgraph.id, title: subgraph.title, nodes: subgraph.nodes }))
      : [];
    try {
      const parsed = parseMermaidFlowChartDiagram(diagram.db, svgContainer);
      return { ok: true, diagramType: diagram.type, dbSubGraphs, svgIds, parsed };
    } catch (error) {
      return { ok: false, diagramType: diagram.type, dbSubGraphs, svgIds, error: describeValue(error) };
    }
  } finally {
    svgContainer.remove();
  }
};

const runCase = async (name, definition) => {
  const parsed = await parseMermaidToExcalidraw(definition, CONFIG);
  const raw = await runRawFlowchartParser(definition);
  return { name, converted: summarizeElements(parsed), raw };
};

export const convertedScene = async (name = "subgraph") => {
  const definition = DEFINITIONS[name];
  if (!definition) throw new Error(`Unknown harness case: ${name}`);
  const parsed = await parseMermaidToExcalidraw(definition, CONFIG);
  const skeleton = Array.isArray(parsed) ? parsed : parsed.elements;
  const files = Array.isArray(parsed) ? {} : parsed.files ?? {};
  return {
    type: "excalidraw",
    version: 2,
    source: "tests/browser/run-mermaid-conversion.mjs",
    elements: convertToExcalidrawElements(skeleton, { regenerateIds: false }),
    appState: { viewBackgroundColor: "#ffffff" },
    files,
  };
};

// The tab's own conversion (convertMermaidInbox in app/src/App.tsx): disambiguated ids,
// regenerateIds: false, and the Mermaid source hash stamped on every element.
export const appScene = async (name) => {
  const definition = DEFINITIONS[name];
  if (!definition) throw new Error(`Unknown harness case: ${name}`);
  const parsed = await parseMermaidToExcalidraw(definition, CONFIG);
  const skeleton = Array.isArray(parsed) ? parsed : parsed.elements;
  return {
    type: "excalidraw",
    version: 2,
    source: "tests/browser/run-mermaid-conversion.mjs --app",
    mermaid: definition,
    elements: stampMermaidHash(convertToExcalidrawElements(disambiguateDuplicateElementIds(skeleton), { regenerateIds: false }), mermaidSourceHash(definition)),
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
};

export const runAll = async () => ({
  userAgent: navigator.userAgent,
  flat: await runCase("flat", DEFINITIONS.flat),
  subgraph: await runCase("subgraph", DEFINITIONS.subgraph),
  capturedConsoleErrors,
});
