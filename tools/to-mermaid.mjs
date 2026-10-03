import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const NODE_TYPES = new Set(["rectangle", "diamond", "ellipse"]);
const VALID_MERMAID_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_STROKE = "#1e1e1e";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
// Excalidraw stores soft-wrapped text in `text` and the author's text in `originalText`.
const textOf = (element) => element?.originalText ?? element?.text;
const escapeLabel = (value) => clean(value).replace(/\\/g, "\\\\").replace(/"/g, "#quot;");
const noneHead = (value) => value === undefined || value === null || value === "none";
const subgraphGroupId = (id) => `subgraph_group_${id}`;
const isSubgraphContainer = (element) => Array.isArray(element?.groupIds) && element.groupIds.includes(subgraphGroupId(element.id));

export const mermaidIdMapper = () => {
  const used = new Set();
  const map = new Map();
  const sanitize = (id) => {
    const raw = String(id ?? "element");
    let candidate = VALID_MERMAID_ID.test(raw) ? raw : raw.replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Za-z_]/.test(candidate)) candidate = `n_${candidate}`;
    if (!candidate) candidate = "element";
    const base = candidate;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}_${suffix++}`;
    used.add(candidate);
    return candidate;
  };
  return (id) => {
    if (!map.has(id)) map.set(id, sanitize(id));
    return map.get(id);
  };
};

const center = (element) => ({ x: Number(element.x ?? 0) + Number(element.width ?? 0) / 2, y: Number(element.y ?? 0) + Number(element.height ?? 0) / 2 });
const distance = (left, right) => {
  const a = center(left);
  const b = center(right);
  return Math.hypot(a.x - b.x, a.y - b.y);
};

const edgeOperator = (element, comments) => {
  const start = element.startArrowhead;
  const end = element.endArrowhead === undefined ? "arrow" : element.endArrowhead;
  const startArrow = !noneHead(start);
  const endArrow = !noneHead(end);
  const unsupported = [start, end].filter((head) => !noneHead(head) && head !== "arrow").map(String);
  if (unsupported.length) comments.push(`%% Unsupported arrowhead style on ${element.id}: start=${start ?? "none"} end=${end ?? "none"}`);
  if (startArrow && endArrow) return "<-->";
  if (!startArrow && !endArrow) return "---";
  if (!startArrow && endArrow && Number(element.strokeWidth ?? 2) === 4) return "==>";
  if (!startArrow && endArrow && (element.strokeStyle === "dashed" || element.strokeStyle === "dotted")) return "-.->";
  if (!startArrow && endArrow) return "-->";
  comments.push(`%% Unsupported arrow direction on ${element.id}: start=${start ?? "none"} end=${end ?? "none"}`);
  return "---";
};

const linkWithLabel = (operator, label) => {
  if (!label) return operator;
  const escaped = escapeLabel(label);
  if (operator === "-.->") return `-. "${escaped}" .->`;
  if (operator === "---") return `---|"${escaped}"|`;
  if (operator === "==>") return `==>|"${escaped}"|`;
  if (operator === "<-->") return `<-->|"${escaped}"|`;
  return `-->|"${escaped}"|`;
};

export const sceneToMermaid = (data) => {
  const elements = Array.isArray(data.elements) ? data.elements.filter((element) => !element.isDeleted) : [];
  const textByContainer = new Map();
  const nodes = [];
  const edges = [];
  const comments = [];
  const toMermaidId = mermaidIdMapper();

  for (const element of elements) {
    if (element.type === "text" && element.containerId) {
      const bucket = textByContainer.get(element.containerId) ?? [];
      bucket.push(element);
      textByContainer.set(element.containerId, bucket);
    }
  }
  for (const bucket of textByContainer.values()) bucket.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const labelForContainer = (id, fallback = id) => clean(textByContainer.get(id)?.map((item) => textOf(item)).filter(Boolean).join(" ") || fallback);

  for (const element of elements) {
    if (NODE_TYPES.has(element.type)) nodes.push({ id: element.id, mermaidId: toMermaidId(element.id), element, label: labelForContainer(element.id, element.id), type: element.type, isSubgraph: isSubgraphContainer(element) });
  }
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const subgraphs = nodes.filter((node) => node.isSubgraph);
  const subgraphByGroupId = new Map(subgraphs.map((node) => [subgraphGroupId(node.id), node]));
  const subgraphForNode = (node) => {
    if (!node || node.isSubgraph || !Array.isArray(node.element.groupIds)) return null;
    for (const groupId of node.element.groupIds) {
      const subgraph = subgraphByGroupId.get(groupId);
      if (subgraph) return subgraph;
    }
    return null;
  };

  for (const element of elements) {
    if (element.type === "arrow") {
      const startId = element.startBinding?.elementId ?? element.start?.id ?? null;
      const endId = element.endBinding?.elementId ?? element.end?.id ?? null;
      const start = nodesById.get(startId);
      const end = nodesById.get(endId);
      const label = labelForContainer(element.id, "");
      if (start && end) {
        const localComments = [];
        const operator = edgeOperator(element, localComments);
        edges.push({ id: element.id, start, end, label, operator });
        comments.push(...localComments);
      } else {
        comments.push(`%% Unbound arrow ${element.id}: ${startId ?? "<none>"} -> ${endId ?? "<none>"}${label ? ` label="${label}"` : ""}`);
      }
    } else if (element.type === "text" && !element.containerId) {
      let nearest = null;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const node of nodes) {
        const currentDistance = distance(element, node.element);
        if (currentDistance < nearestDistance) {
          nearest = node;
          nearestDistance = currentDistance;
        }
      }
      comments.push(`%% Free text ${element.id}${nearest ? ` near ${nearest.mermaidId} (${Math.round(nearestDistance)}px)` : ""}: ${clean(textOf(element))}`);
    } else if (!NODE_TYPES.has(element.type) && element.type !== "text") {
      comments.push(`%% Unsupported element ${element.id}: type=${element.type}`);
    }
  }

  nodes.sort((left, right) => left.id.localeCompare(right.id));
  edges.sort((left, right) => left.id.localeCompare(right.id));
  comments.sort();

  const shape = (node) => {
    const label = escapeLabel(node.label || node.id);
    if (node.type === "diamond") return `${node.mermaidId}{"${label}"}`;
    if (node.type === "ellipse") return `${node.mermaidId}(("${label}"))`;
    return `${node.mermaidId}["${label}"]`;
  };

  const lines = ["flowchart TD"];
  const edgesBySubgraph = new Map();
  const topLevelEdges = [];
  for (const edge of edges) {
    const startSubgraph = subgraphForNode(edge.start);
    const endSubgraph = subgraphForNode(edge.end);
    if (startSubgraph && startSubgraph === endSubgraph) {
      const bucket = edgesBySubgraph.get(startSubgraph.id) ?? [];
      bucket.push(edge);
      edgesBySubgraph.set(startSubgraph.id, bucket);
    } else {
      topLevelEdges.push(edge);
    }
  }

  for (const node of nodes.filter((node) => !node.isSubgraph && !subgraphForNode(node))) lines.push(`  ${shape(node)}`);
  for (const subgraph of subgraphs) {
    const members = nodes.filter((node) => !node.isSubgraph && subgraphForNode(node) === subgraph);
    lines.push(`  subgraph ${subgraph.mermaidId}["${escapeLabel(subgraph.label || subgraph.id)}"]`);
    for (const node of members) lines.push(`    ${shape(node)}`);
    for (const edge of edgesBySubgraph.get(subgraph.id) ?? []) lines.push(`    ${edge.start.mermaidId} ${linkWithLabel(edge.operator, edge.label)} ${edge.end.mermaidId}`);
    lines.push("  end");
  }
  for (const edge of topLevelEdges) lines.push(`  ${edge.start.mermaidId} ${linkWithLabel(edge.operator, edge.label)} ${edge.end.mermaidId}`);
  // Colors carry meaning (e.g. light blue = proposed), so non-default ones are kept as Mermaid styles.
  const color = (value) => (typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value.toLowerCase() : null);
  for (const node of nodes) {
    const parts = [];
    const fill = color(node.element.backgroundColor);
    const stroke = color(node.element.strokeColor);
    const textColor = color(textByContainer.get(node.id)?.[0]?.strokeColor);
    if (fill) parts.push(`fill:${fill}`);
    if (stroke && stroke !== DEFAULT_STROKE) parts.push(`stroke:${stroke}`);
    if (textColor && textColor !== DEFAULT_STROKE) parts.push(`color:${textColor}`);
    if (parts.length) lines.push(`  style ${node.mermaidId} ${parts.join(",")}`);
  }
  for (const comment of comments) lines.push(`  ${comment}`);
  return lines.join("\n");
};

export const fileToMermaid = async (file) => sceneToMermaid(JSON.parse(await readFile(file, "utf8")));

export const main = async (argv = process.argv.slice(2)) => {
  const file = argv[0];
  if (!file) {
    console.error("Usage: node tools/to-mermaid.mjs <file.excalidraw>");
    process.exitCode = 1;
    return;
  }
  console.log(await fileToMermaid(file));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();