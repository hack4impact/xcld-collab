// Seeded Excalidraw boards and edit scripts for the merge tests and the merge benchmark.
// Shapes carry bound text, arrows bind to shapes (some with a bound label), plus free notes,
// the way the tab and the Mermaid converter write boards.

export const mulberry32 = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = (rng, items) => items[Math.floor(rng() * items.length)];
const COLORS = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"];
const SHAPES = ["rectangle", "ellipse", "diamond"];

const indexKey = (prefix, position) => `${prefix}${position.toString(36).padStart(5, "0")}`;

const common = (id, type, index, extra) => ({
  id,
  type,
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  ...extra,
});

export const shape = (id, index, { x = 0, y = 0, type = "rectangle", label = id, textIndex = index } = {}) => [
  common(id, type, index, { x, y, width: 160, height: 60, boundElements: [{ id: `${id}-t`, type: "text" }] }),
  text(`${id}-t`, textIndex, label, { containerId: id, x: x + 10, y: y + 17 }),
];

export const text = (id, index, value, extra = {}) => common(id, "text", index, {
  width: 140,
  height: 25,
  text: value,
  originalText: value,
  fontSize: 20,
  fontFamily: 5,
  textAlign: "center",
  verticalAlign: "middle",
  containerId: null,
  lineHeight: 1.25,
  autoResize: true,
  ...extra,
});

export const arrow = (id, index, from, to, extra = {}) => common(id, "arrow", index, {
  width: 100,
  height: 0,
  points: [[0, 0], [100, 0]],
  lastCommittedPoint: null,
  startBinding: from ? { elementId: from, focus: 0, gap: 8 } : null,
  endBinding: to ? { elementId: to, focus: 0, gap: 8 } : null,
  startArrowhead: null,
  endArrowhead: "arrow",
  elbowed: false,
  ...extra,
});

const addArrowRef = (element, arrowId) => {
  element.boundElements = [...(element.boundElements ?? []), { id: arrowId, type: "arrow" }];
};

/**
 * A board of exactly `size` elements: a third shapes, a third their bound text, and the rest
 * split into arrows between shapes (12% of them with a bound label) and 12% free notes.
 */
export const makeBoard = (size, rng) => {
  const shapes = Math.floor(size / 3);
  const rest = size - 2 * shapes;
  const notes = Math.floor(rest * 0.12);
  const labels = Math.min(Math.floor(rest * 0.12), rest - notes);
  const arrows = rest - notes - labels;
  const elements = [];
  const byId = new Map();
  let position = 0;
  const push = (...items) => {
    for (const item of items) {
      elements.push(item);
      byId.set(item.id, item);
    }
  };
  for (let n = 0; n < shapes; n++) {
    push(...shape(`s${n}`, indexKey("a", position++), { x: (n % 25) * 200, y: Math.floor(n / 25) * 120, type: pick(rng, SHAPES), label: `Node ${n}`, textIndex: indexKey("a", position++) }));
  }
  for (let n = 0; n < arrows; n++) {
    const from = `s${Math.floor(rng() * shapes)}`;
    const to = `s${Math.floor(rng() * shapes)}`;
    const item = arrow(`e${n}`, indexKey("a", position++), from, to);
    push(item);
    addArrowRef(byId.get(from), item.id);
    if (to !== from) {
      addArrowRef(byId.get(to), item.id);
    }
    if (n < labels) {
      item.boundElements = [{ id: `e${n}-t`, type: "text" }];
      push(text(`e${n}-t`, indexKey("a", position++), `edge ${n}`, { containerId: item.id }));
    }
  }
  for (let n = 0; n < notes; n++) {
    push(text(`note${n}`, indexKey("a", position++), `note ${n}`, { x: n * 30, y: -200 }));
  }
  return elements;
};

/**
 * Applies `ops` random edits to a copy of `elements`. `tabLike` edits bump `version` and use
 * tombstones the way the Excalidraw tab does (deleting a shape unbinds its arrows); agent-like
 * edits leave versions alone and delete by omission.
 */
export const editBoard = (elements, rng, { author, ops, tabLike }) => {
  const board = elements.map((element) => structuredClone(element));
  const byId = new Map(board.map((element) => [element.id, element]));
  const live = (element) => element && !element.isDeleted;
  const touch = (element) => {
    if (tabLike) {
      element.version += 1;
      element.versionNonce = Math.floor(rng() * 2 ** 31);
      element.updated += 1;
    }
  };
  const remove = (element) => {
    if (tabLike) {
      element.isDeleted = true;
      touch(element);
    } else {
      byId.delete(element.id);
    }
  };
  const containers = () => [...byId.values()].filter((element) => live(element) && element.type !== "text" && element.type !== "arrow");
  const arrows = () => [...byId.values()].filter((element) => live(element) && element.type === "arrow");
  const labelOf = (element) => byId.get(`${element.id}-t`) ?? [...byId.values()].find((item) => item.containerId === element.id);
  let top = 0;
  let added = 0;
  const nextIndex = () => indexKey("b", top++);
  for (let op = 0; op < ops; op++) {
    const kind = pick(rng, ["move", "move", "relabel", "restyle", "delete", "add", "connect", "dropArrow", "edgeLabel", "raise", "note"]);
    const node = pick(rng, containers());
    if (!node && kind !== "add") {
      continue;
    }
    if (kind === "move") {
      const dx = Math.round(rng() * 80) - 40;
      for (const element of [node, labelOf(node)].filter(live)) {
        element.x += dx;
        element.y += 5;
        touch(element);
      }
    } else if (kind === "relabel") {
      const label = labelOf(node);
      if (live(label)) {
        label.text = label.originalText = `${label.originalText} ${author}`;
        touch(label);
      }
    } else if (kind === "restyle") {
      node.strokeColor = pick(rng, COLORS);
      node.backgroundColor = pick(rng, COLORS);
      touch(node);
    } else if (kind === "delete") {
      for (const element of [node, labelOf(node)].filter(live)) {
        remove(element);
      }
      if (tabLike) {
        for (const item of arrows()) {
          for (const key of ["startBinding", "endBinding"]) {
            if (item[key]?.elementId === node.id) {
              item[key] = null;
              touch(item);
            }
          }
        }
      }
    } else if (kind === "add") {
      added += 1;
      const id = `${author}-n${added}`;
      for (const element of shape(id, nextIndex(), { x: 100 * added, y: 900, label: `new ${author} ${added}`, textIndex: nextIndex() })) {
        byId.set(element.id, element);
      }
    } else if (kind === "connect") {
      const target = pick(rng, containers());
      added += 1;
      const item = arrow(`${author}-e${added}`, nextIndex(), node.id, target.id);
      byId.set(item.id, item);
      if (tabLike) {
        addArrowRef(node, item.id);
        touch(node);
        if (target !== node) {
          addArrowRef(target, item.id);
          touch(target);
        }
      }
    } else if (kind === "dropArrow") {
      const item = pick(rng, arrows());
      if (item) {
        for (const element of [item, labelOf(item)].filter(live)) {
          remove(element);
        }
      }
    } else if (kind === "edgeLabel") {
      const item = pick(rng, arrows());
      const label = item && labelOf(item);
      if (live(label)) {
        label.text = label.originalText = `${author} says ${op}`;
        touch(label);
      }
    } else if (kind === "raise") {
      node.index = nextIndex();
      touch(node);
      const label = labelOf(node);
      if (live(label)) {
        label.index = nextIndex();
        touch(label);
      }
    } else if (kind === "note") {
      const note = [...byId.values()].find((element) => live(element) && element.id.startsWith("note"));
      if (note) {
        note.text = note.originalText = `${note.originalText}!`;
        touch(note);
      }
    }
  }
  return [...byId.values()];
};

export const shuffled = (items, rng) => {
  const copy = [...items];
  for (let position = copy.length - 1; position > 0; position--) {
    const other = Math.floor(rng() * (position + 1));
    [copy[position], copy[other]] = [copy[other], copy[position]];
  }
  return copy;
};
