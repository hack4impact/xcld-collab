// Words for an element that has no label text, for the merged banner, `diff`, `diff --since`,
// `xcld watch` and history: `unlabeled arrow from "Payments service" to "Fraud detection"`,
// `unlabeled rectangle near "Ledger v2"`, never a bare element id. Pure, no Node imports: the
// server, the CLI and the tab bundle all use it.

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const isLive = (element) => Boolean(element) && element.isDeleted !== true;
const LINEAR = new Set(["arrow", "line"]);
const TYPE_WORDS = { freedraw: "drawing", embeddable: "embed", iframe: "embed", magicframe: "frame" };

/** A readable word for an element's type: `rectangle`, `arrow`, `drawing` (freedraw), ... */
export const typeWord = (element) => TYPE_WORDS[element?.type] ?? (typeof element?.type === "string" && element.type ? element.type : "element");

const quote = (text) => `"${text}"`;

const bounds = (element) => {
  const x = Number(element.x) || 0;
  const y = Number(element.y) || 0;
  if (Array.isArray(element.points) && element.points.length) {
    const xs = element.points.map((point) => x + (Number(point?.[0]) || 0));
    const ys = element.points.map((point) => y + (Number(point?.[1]) || 0));
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
  }
  const width = Number(element.width) || 0;
  const height = Number(element.height) || 0;
  return { left: Math.min(x, x + width), top: Math.min(y, y + height), right: Math.max(x, x + width), bottom: Math.max(y, y + height) };
};

/**
 * Lookups over one board, built on first use: `get(id)`, `labelOf(id)` (an element's bound text,
 * its own text, or a frame's name; "" when it has none) and `nearest(element)` (the closest other
 * labelled shape or free text: `{ label, relation: "near" | "around" }`, or null).
 * @param {Iterable<object> | Map<string, object>} elements
 */
export const labelContext = (elements) => {
  let byId = null;
  let boundText = null;
  let candidates = null;
  const build = () => {
    byId = new Map();
    boundText = new Map();
    for (const element of elements instanceof Map ? elements.values() : elements) {
      if (!isLive(element) || typeof element.id !== "string" || byId.has(element.id)) {
        continue;
      }
      byId.set(element.id, element);
      if (element.type === "text" && typeof element.containerId === "string") {
        const text = clean(element.originalText ?? element.text);
        if (text) {
          boundText.set(element.containerId, [...(boundText.get(element.containerId) ?? []), text]);
        }
      }
    }
  };
  const get = (id) => {
    if (!byId) build();
    return byId.get(id);
  };
  const labelOf = (id) => {
    const element = get(id);
    if (!element) {
      return "";
    }
    if (boundText.has(id)) {
      return boundText.get(id).join(" ");
    }
    if (element.type === "text") {
      return clean(element.originalText ?? element.text);
    }
    if (element.type === "frame" || element.type === "magicframe") {
      return clean(element.name);
    }
    return "";
  };
  const nearest = (element) => {
    if (!byId) build();
    candidates ??= [...byId.values()]
      .filter((item) => !LINEAR.has(item.type) && !(item.type === "text" && typeof item.containerId === "string") && labelOf(item.id))
      .map((item) => ({ id: item.id, label: labelOf(item.id), box: bounds(item) }));
    const box = bounds(element);
    const centerX = (box.left + box.right) / 2;
    const centerY = (box.top + box.bottom) / 2;
    let best = null;
    for (const candidate of candidates) {
      if (candidate.id === element.id || (typeof element.containerId === "string" && candidate.id === element.containerId)) {
        continue;
      }
      const other = candidate.box;
      const gap = Math.hypot(Math.max(0, other.left - box.right, box.left - other.right), Math.max(0, other.top - box.bottom, box.top - other.bottom));
      const center = Math.hypot((other.left + other.right) / 2 - centerX, (other.top + other.bottom) / 2 - centerY);
      if (!best || gap < best.gap || (gap === best.gap && (center < best.center || (center === best.center && candidate.id < best.id)))) {
        best = { id: candidate.id, label: candidate.label, gap, center, inside: other.left >= box.left && other.right <= box.right && other.top >= box.top && other.bottom <= box.bottom };
      }
    }
    return best ? { id: best.id, label: best.label, relation: best.inside && !LINEAR.has(element.type) ? "around" : "near" } : null;
  };
  return { get, labelOf, nearest };
};

/**
 * Describes an element with no label text. Arrows and lines by what their ends are bound to,
 * everything else (and an unbound arrow) by the nearest labelled element.
 * @param {object} element
 * @param {ReturnType<typeof labelContext>} [context] The board the element is on.
 */
export const describeUnlabeled = (element, context) => {
  const what = `unlabeled ${typeWord(element)}`;
  if (LINEAR.has(element?.type) && context) {
    const end = (binding) => {
      const id = binding?.elementId;
      if (typeof id !== "string" || id === element.id) {
        return null;
      }
      const label = context.labelOf(id);
      if (label) {
        return quote(label);
      }
      const target = context.get(id);
      return target ? `an unlabeled ${typeWord(target)}` : null;
    };
    const from = end(element.startBinding);
    const to = end(element.endBinding);
    if (from || to) {
      return [what, from && `from ${from}`, to && `to ${to}`].filter(Boolean).join(" ");
    }
  }
  const near = element && context ? context.nearest(element) : null;
  return near ? `${what} ${near.relation} ${quote(near.label)}` : what;
};
