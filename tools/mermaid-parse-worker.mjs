// Worker thread for server-side Mermaid parsing. Never import this from the main thread:
// it installs jsdom's window/document as globals, which Mermaid (DOMPurify) needs at
// import time. Inside a worker those globals stay in the worker's own isolate, so the
// server's main thread never sees a fake DOM.
//
// Built into tools/mermaid-parse.bundle.mjs by app/scripts/build-mermaid.mjs (the runtime
// image ships no node_modules). Talk to it through tools/mermaid-parse.mjs.
import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { encodeEntities, entityCodesToText } from "@excalidraw/mermaid-to-excalidraw/dist/utils.js";
import {
  computeExcalidrawArrowType,
  computeExcalidrawVertexLabelStyle,
  computeExcalidrawVertexStyle,
  getText,
} from "@excalidraw/mermaid-to-excalidraw/dist/converter/helpers.js";
import { isValidCSSColor, parseCSSDeclarations } from "@excalidraw/mermaid-to-excalidraw/dist/parser/cssUtils.js";

// Same config the tab passes to parseMermaidToExcalidraw (app/src/App.tsx), merged the way
// mermaid-to-excalidraw merges it with its defaults.
const MERMAID_CONFIG = {
  startOnLoad: false,
  flowchart: { curve: "linear" },
  fontSize: "20px",
  themeVariables: { fontSize: "20px" },
  maxEdges: 500,
  maxTextSize: 50000,
};
const FLOWCHART_TYPES = new Set(["flowchart-v2", "flowchart", "graph"]);

const started = performance.now();
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "DOMParser", "Element", "HTMLElement", "SVGElement", "Node"]) {
  globalThis[key] = dom.window[key];
}
const jsdomMs = performance.now() - started;
const { default: mermaid } = await import("mermaid");
mermaid.initialize(MERMAID_CONFIG);
const mermaidMs = performance.now() - started - jsdomMs;

// Mirrors the (unexported) style helpers in mermaid-to-excalidraw's parser/flowchart.js.
const applyContainerStyleProperty = (style, key, value) => {
  if ((key === "fill" || key === "stroke") && isValidCSSColor(value)) style[key] = value;
  else if (key === "stroke-width" || key === "stroke-dasharray") style[key] = value;
};
const applyLabelStyleProperty = (style, key, value) => {
  if (key === "color" && isValidCSSColor(value)) style.color = value;
};
const applyStyleText = (styleText, containerStyle, labelStyle) => {
  for (const { property, value } of parseCSSDeclarations(styleText ?? "")) {
    applyContainerStyleProperty(containerStyle, property, value);
    applyLabelStyleProperty(labelStyle, property, value);
  }
};
const applyClassStyles = (classId, classes, containerStyle, labelStyle) => {
  const classDef = classes.get(classId);
  if (!classDef) return;
  for (const styleText of classDef.styles ?? []) applyStyleText(styleText, containerStyle, labelStyle);
  for (const styleText of classDef.textStyles ?? []) {
    for (const { property, value } of parseCSSDeclarations(styleText)) applyLabelStyleProperty(labelStyle, property, value);
  }
};
const excalidrawStyle = (classIds, styles, classes) => {
  const containerStyle = {};
  const labelStyle = {};
  for (const classId of classIds) applyClassStyles(classId, classes, containerStyle, labelStyle);
  for (const styleText of styles) applyStyleText(styleText, containerStyle, labelStyle);
  return { container: computeExcalidrawVertexStyle(containerStyle), label: computeExcalidrawVertexLabelStyle(labelStyle) };
};

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const textOf = (item) => getText({ text: entityCodesToText(item.text ?? ""), labelType: item.labelType });

const errorDetails = (error) => {
  const hash = error?.hash ?? null;
  const loc = hash?.loc ?? null;
  return {
    message: String(error?.message ?? error).trim(),
    line: loc?.first_line ?? (Number.isInteger(hash?.line) ? hash.line + 1 : null),
    column: Number.isInteger(loc?.first_column) ? loc.first_column + 1 : null,
    token: hash?.token ?? null,
    expected: Array.isArray(hash?.expected) ? hash.expected : null,
  };
};

const parseDefinition = async (text) => {
  let diagram;
  try {
    // mermaid-to-excalidraw parses encodeEntities(definition) and decodes labels afterwards.
    diagram = await mermaid.mermaidAPI.getDiagramFromText(encodeEntities(String(text ?? "")));
  } catch (error) {
    return { ok: false, error: errorDetails(error) };
  }
  if (!FLOWCHART_TYPES.has(diagram.type)) {
    return { ok: false, unsupported: true, diagramType: diagram.type };
  }
  const db = diagram.db;
  const classes = db.getClasses() instanceof Map ? db.getClasses() : new Map();
  const subgraphIds = new Set(asArray(db.getSubGraphs()).map((subgraph) => subgraph.id));
  // An edge to a subgraph also registers the subgraph id as a vertex; the converter skips it
  // (no node in the SVG) and binds the edge to the subgraph container instead.
  const nodes = [...db.getVertices().values()].filter((vertex) => !subgraphIds.has(vertex.id)).map((vertex) => {
    const classIds = asArray(vertex.classes);
    const styles = asArray(vertex.styles);
    return {
      id: vertex.id,
      label: textOf(vertex),
      shape: vertex.type ?? "square",
      classes: classIds,
      styles,
      link: vertex.link ?? null,
      style: excalidrawStyle(classIds, styles, classes),
    };
  });
  const edges = asArray(db.getEdges()).map((edge) => ({
    mermaidId: edge.id,
    start: edge.start,
    end: edge.end,
    label: textOf(edge),
    type: edge.type ?? "arrow_point",
    stroke: edge.stroke ?? "normal",
    arrowheads: computeExcalidrawArrowType(edge.type || "arrow_point") ?? {},
    // The edge's own curve (`e1@{ curve: linear }`, `linkStyle 0 interpolate step`), or null.
    curve: typeof edge.interpolate === "string" && edge.interpolate ? edge.interpolate : null,
  }));
  const subgraphs = asArray(db.getSubGraphs()).map((subgraph) => {
    const classIds = asArray(subgraph.classes);
    return {
      id: subgraph.id,
      title: getText({ text: entityCodesToText(subgraph.title ?? ""), labelType: "text" }),
      nodes: asArray(subgraph.nodes).map((id) => (id.startsWith("flowchart-") ? id.split("-")[1] : id)),
      classes: classIds,
      style: excalidrawStyle([subgraph.id, ...classIds], [], classes),
    };
  });
  const classDefs = Object.fromEntries([...classes.entries()].map(([id, def]) => [id, {
    styles: asArray(def.styles),
    textStyles: asArray(def.textStyles),
  }]));
  return {
    ok: true,
    diagramType: diagram.type,
    direction: db.getDirection?.() ?? "TB",
    nodes,
    edges,
    subgraphs,
    classDefs,
  };
};

// One parse at a time: each request runs after the previous one settles.
// `configure` (tests only, tests/mermaid-ci.test.mjs) replaces the site config, as
// mermaid.initialize does, so a test can show that one diagram's config never leaks into the
// next parse through the bundle's FlowDB config patch.
let queue = Promise.resolve();
parentPort?.on("message", (message) => {
  if (message?.type === "configure") {
    queue = queue.then(() => {
      mermaid.initialize({ ...MERMAID_CONFIG, ...(message.config ?? {}) });
      parentPort.postMessage({ type: "result", id: message.id, result: { ok: true, configured: true }, ms: 0 });
    });
    return;
  }
  if (message?.type !== "parse") return;
  queue = queue.then(async () => {
    const startedAt = performance.now();
    let result;
    try {
      result = await parseDefinition(message.text);
    } catch (error) {
      result = { ok: false, error: errorDetails(error) };
    }
    parentPort.postMessage({ type: "result", id: message.id, result, ms: performance.now() - startedAt });
  });
});
parentPort?.postMessage({
  type: "ready",
  timings: { jsdomMs, mermaidMs, totalMs: performance.now() - started },
  // Replaced at bundle time by app/scripts/build-mermaid.mjs.
  mermaidVersion: typeof __XCLD_MERMAID_VERSION__ === "undefined" ? null : __XCLD_MERMAID_VERSION__,
  jsdomVersion: typeof __XCLD_JSDOM_VERSION__ === "undefined" ? null : __XCLD_JSDOM_VERSION__,
});
