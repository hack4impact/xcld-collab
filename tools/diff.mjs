import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const NODE_TYPES = new Set(["rectangle", "diamond", "ellipse"]);
const STYLE_PROPS = ["strokeColor", "backgroundColor", "fillStyle", "strokeStyle", "strokeWidth", "roughness", "opacity"];

const round = (value) => Math.round(Number(value ?? 0));
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
// Excalidraw stores soft-wrapped text in `text` and the author's text in `originalText`.
const textOf = (element) => element?.originalText ?? element?.text;
const shortId = (id) => String(id ?? "").slice(0, 10);
const center = (element) => ({ x: Number(element.x ?? 0) + Number(element.width ?? 0) / 2, y: Number(element.y ?? 0) + Number(element.height ?? 0) / 2 });
const subgraphGroupId = (id) => `subgraph_group_${id}`;
const isSubgraphContainer = (element) => Array.isArray(element?.groupIds) && element.groupIds.includes(subgraphGroupId(element.id));

export const readScene = async (file) => {
  const text = await readFile(file, "utf8");
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.elements) ? parsed.elements : [];
};

export const makeModel = (elements) => {
  const live = elements.filter((element) => !element.isDeleted);
  const byId = new Map(live.map((element) => [element.id, element]));
  const textByContainer = new Map();
  const nodes = new Map();
  const edges = new Map();
  const notes = new Map();

  for (const element of live) {
    if (element.type === "text" && element.containerId) {
      const bucket = textByContainer.get(element.containerId) ?? [];
      bucket.push(element);
      textByContainer.set(element.containerId, bucket);
    }
  }
  for (const bucket of textByContainer.values()) {
    bucket.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  const nodeLabel = (node) => clean(textByContainer.get(node.id)?.map((item) => textOf(item)).filter(Boolean).join(" ") || textOf(node) || node.id);
  const edgeLabel = (edge) => clean(textByContainer.get(edge.id)?.map((item) => textOf(item)).filter(Boolean).join(" ") || textOf(edge) || "");

  for (const element of live) {
    if (NODE_TYPES.has(element.type)) {
      nodes.set(element.id, { id: element.id, element, label: nodeLabel(element), type: isSubgraphContainer(element) ? "subgraph" : element.type });
    } else if (element.type === "arrow") {
      const startId = element.startBinding?.elementId ?? element.start?.id ?? null;
      const endId = element.endBinding?.elementId ?? element.end?.id ?? null;
      edges.set(element.id, { id: element.id, element, startId, endId, label: edgeLabel(element) });
    } else if (element.type === "text" && !element.containerId) {
      notes.set(element.id, { id: element.id, element, text: clean(textOf(element)) });
    }
  }

  const labelFor = (id) => nodes.get(id)?.label || shortId(id);
  const edgePhrase = (edge) => {
    const middle = edge.label ? ` --${edge.label}--> ` : " --> ";
    return `${labelFor(edge.startId)}${middle}${labelFor(edge.endId)}`;
  };
  const nearestNode = (element) => {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    const itemCenter = center(element);
    for (const node of nodes.values()) {
      const nodeCenter = center(node.element);
      const distance = Math.hypot(itemCenter.x - nodeCenter.x, itemCenter.y - nodeCenter.y);
      if (distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best ? { id: best.id, label: best.label, distance: Math.round(bestDistance) } : null;
  };
  return { byId, nodes, edges, notes, labelFor, edgePhrase, nearestNode };
};

const positionChanged = (oldElement, newElement) => round(oldElement.x) !== round(newElement.x) || round(oldElement.y) !== round(newElement.y) || round(oldElement.width) !== round(newElement.width) || round(oldElement.height) !== round(newElement.height);
const summarizeGeometry = (element) => `(${round(element.x)},${round(element.y)}) ${round(element.width)}x${round(element.height)}`;

export const diffElements = (oldElements, newElements, files = {}) => {
  const oldModel = makeModel(oldElements);
  const newModel = makeModel(newElements);
  const diff = { files, nodes: { added: [], removed: [], relabeled: [] }, edges: { added: [], removed: [], rewired: [], relabeled: [] }, notes: { added: [], removed: [], changed: [] }, styles: [], moves: [] };

  for (const node of newModel.nodes.values()) {
    const oldNode = oldModel.nodes.get(node.id);
    if (!oldNode) {
      diff.nodes.added.push({ id: node.id, label: node.label, type: node.type });
    } else {
      if (oldNode.label !== node.label) diff.nodes.relabeled.push({ id: node.id, from: oldNode.label, to: node.label });
      for (const property of STYLE_PROPS) {
        if (oldNode.element[property] !== node.element[property]) diff.styles.push({ id: node.id, subject: node.label, kind: "node", property, from: oldNode.element[property] ?? null, to: node.element[property] ?? null });
      }
      if (positionChanged(oldNode.element, node.element)) diff.moves.push({ id: node.id, subject: node.label, kind: "node", from: summarizeGeometry(oldNode.element), to: summarizeGeometry(node.element) });
    }
  }
  for (const node of oldModel.nodes.values()) {
    if (!newModel.nodes.has(node.id)) diff.nodes.removed.push({ id: node.id, label: node.label, type: node.type });
  }

  for (const edge of newModel.edges.values()) {
    const oldEdge = oldModel.edges.get(edge.id);
    if (!oldEdge) {
      diff.edges.added.push({ id: edge.id, edge: newModel.edgePhrase(edge) });
    } else {
      if (oldEdge.startId !== edge.startId || oldEdge.endId !== edge.endId) diff.edges.rewired.push({ id: edge.id, from: oldModel.edgePhrase(oldEdge), to: newModel.edgePhrase(edge) });
      if (oldEdge.label !== edge.label) diff.edges.relabeled.push({ id: edge.id, edge: newModel.edgePhrase(edge), from: oldEdge.label, to: edge.label });
      for (const property of STYLE_PROPS) {
        if (oldEdge.element[property] !== edge.element[property]) diff.styles.push({ id: edge.id, subject: newModel.edgePhrase(edge), kind: "edge", property, from: oldEdge.element[property] ?? null, to: edge.element[property] ?? null });
      }
    }
  }
  for (const edge of oldModel.edges.values()) {
    if (!newModel.edges.has(edge.id)) diff.edges.removed.push({ id: edge.id, edge: oldModel.edgePhrase(edge) });
  }

  for (const note of newModel.notes.values()) {
    const oldNote = oldModel.notes.get(note.id);
    if (!oldNote) {
      diff.notes.added.push({ id: note.id, text: note.text, nearestNode: newModel.nearestNode(note.element) });
    } else {
      if (oldNote.text !== note.text) diff.notes.changed.push({ id: note.id, from: oldNote.text, to: note.text });
      if (positionChanged(oldNote.element, note.element)) diff.moves.push({ id: note.id, subject: note.text, kind: "note", from: summarizeGeometry(oldNote.element), to: summarizeGeometry(note.element) });
    }
  }
  for (const note of oldModel.notes.values()) {
    if (!newModel.notes.has(note.id)) diff.notes.removed.push({ id: note.id, text: note.text });
  }

  const byId = (left, right) => String(left.id).localeCompare(String(right.id));
  diff.nodes.added.sort(byId); diff.nodes.removed.sort(byId); diff.nodes.relabeled.sort(byId);
  diff.edges.added.sort(byId); diff.edges.removed.sort(byId); diff.edges.rewired.sort(byId); diff.edges.relabeled.sort(byId);
  diff.notes.added.sort(byId); diff.notes.removed.sort(byId); diff.notes.changed.sort(byId); diff.styles.sort(byId); diff.moves.sort(byId);
  return diff;
};

export const diffFiles = async (oldFile, newFile) => diffElements(await readScene(oldFile), await readScene(newFile), { old: oldFile, new: newFile });

export const formatDiff = (diff) => {
  const lines = [`Semantic diff ${diff.files.old ?? "old"} -> ${diff.files.new ?? "new"}`];
  const section = (title, entries) => { if (entries.length) { lines.push(`${title}:`); for (const entry of entries) lines.push(`  ${entry}`); } };
  section("Nodes", [
    ...diff.nodes.added.map((item) => `+ added ${item.type} "${item.label}" (${item.id})`),
    ...diff.nodes.removed.map((item) => `- removed "${item.label}" (${item.id})`),
    ...diff.nodes.relabeled.map((item) => `~ relabeled "${item.from}" -> "${item.to}" (${item.id})`),
  ]);
  section("Edges", [
    ...diff.edges.added.map((item) => `+ added ${item.edge} (${item.id})`),
    ...diff.edges.removed.map((item) => `- removed ${item.edge} (${item.id})`),
    ...diff.edges.rewired.map((item) => `~ rewired ${item.from} -> ${item.to} (${item.id})`),
    ...diff.edges.relabeled.map((item) => `~ label ${item.edge}: "${item.from}" -> "${item.to}" (${item.id})`),
  ]);
  section("Notes", [
    ...diff.notes.added.map((item) => `+ added "${item.text}"${item.nearestNode ? ` near "${item.nearestNode.label}"` : ""} (${item.id})`),
    ...diff.notes.removed.map((item) => `- removed "${item.text}" (${item.id})`),
    ...diff.notes.changed.map((item) => `~ changed "${item.from}" -> "${item.to}" (${item.id})`),
  ]);
  section("Style", diff.styles.map((item) => `~ ${item.kind} "${item.subject}" ${item.property}: ${item.from ?? "<unset>"} -> ${item.to ?? "<unset>"} (${item.id})`));
  section("Moves", diff.moves.map((item) => `~ ${item.kind} "${item.subject}": ${item.from} -> ${item.to} (${item.id})`));
  if (lines.length === 1) lines.push("No semantic changes detected.");
  return lines.join("\n");
};

export const main = async (argv = process.argv.slice(2)) => {
  const jsonMode = argv.includes("--json");
  const files = argv.filter((arg) => arg !== "--json");
  if (files.length !== 2) {
    console.error("Usage: node tools/diff.mjs <old.excalidraw> <new.excalidraw> [--json]");
    process.exitCode = 1;
    return;
  }
  const diff = await diffFiles(files[0], files[1]);
  console.log(jsonMode ? JSON.stringify(diff, null, 2) : formatDiff(diff));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();