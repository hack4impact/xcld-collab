// Where a new Mermaid group goes on a board that already has a drawing. Pure and
// deterministic; shared by the tab-conversion path and the server's grid fallback
// (app/server/mermaid-write.mjs), so both place a group the same way.
//
//   parsePosition(text)  "below" | "right" | "near:<elementOrNodeId>" -> { kind, ref? } | { error }
//   placeGroup({ obstacles, group, direction, position, nearBox })
//     -> { dx, dy, placement: "keep" | "below" | "right" | "near", fallback?: string }
//
// - No obstacles (an empty board): the group keeps its own coordinates ("keep").
// - `below`: under the drawing's bounding box, horizontally centered on it.
// - `right`: right of the drawing's bounding box, vertically centered on it.
// - `near`: beside the given element's box, trying right, below, left, then above, each slid
//   outward until it is clear of every obstacle; if nothing near is free, the default.
// - No hint: the diagram's direction decides. TD/TB/BT go below the drawing, LR/RL to the right.
// "Clear" means no overlap with any obstacle box grown by CLEARANCE on every side.

export const PLACEMENT_GAP = 120;
export const CLEARANCE = 40;
const NEAR_STEPS = 24;

export const parsePosition = (text) => {
  if (text === undefined || text === null || text === "") return { kind: "auto" };
  if (typeof text !== "string") return { error: "invalid-position" };
  const value = text.trim();
  if (value === "below" || value === "right") return { kind: value };
  const near = /^near:(.+)$/.exec(value);
  if (near && near[1].trim()) return { kind: "near", ref: near[1].trim() };
  return { error: "invalid-position" };
};

const unionBox = (boxes) => {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  return {
    x: minX,
    y: minY,
    w: Math.max(...boxes.map((box) => box.x + box.w)) - minX,
    h: Math.max(...boxes.map((box) => box.y + box.h)) - minY,
  };
};
const overlaps = (left, right, clearance) => left.x < right.x + right.w + clearance
  && right.x < left.x + left.w + clearance
  && left.y < right.y + right.h + clearance
  && right.y < left.y + left.h + clearance;
const round = (value) => Math.round(value * 1000) / 1000;

/** The default placement for a diagram direction: below for top-down, right for left-right. */
export const defaultPlacement = (direction) => {
  const value = String(direction ?? "TD").toUpperCase();
  return value === "LR" || value === "RL" ? "right" : "below";
};

export const placeGroup = ({ obstacles = [], group, direction = "TD", position = { kind: "auto" }, nearBox = null }) => {
  const boxes = obstacles.filter((box) => box && Number.isFinite(box.x) && Number.isFinite(box.y) && Number.isFinite(box.w) && Number.isFinite(box.h));
  if (!boxes.length) return { dx: 0, dy: 0, placement: "keep" };
  const drawing = unionBox(boxes);
  const offsetTo = (x, y) => ({ dx: round(x - group.x), dy: round(y - group.y) });
  const below = () => ({ ...offsetTo(drawing.x + drawing.w / 2 - group.w / 2, drawing.y + drawing.h + PLACEMENT_GAP), placement: "below" });
  const right = () => ({ ...offsetTo(drawing.x + drawing.w + PLACEMENT_GAP, drawing.y + drawing.h / 2 - group.h / 2), placement: "right" });
  const byDefault = (fallback) => ({ ...(defaultPlacement(direction) === "right" ? right() : below()), ...(fallback ? { fallback } : {}) });
  const kind = position?.kind ?? "auto";
  if (kind === "below") return below();
  if (kind === "right") return right();
  if (kind === "near") {
    if (!nearBox) return byDefault(`near:${position.ref} is not on the board`);
    const clear = (x, y) => !boxes.some((box) => overlaps({ x, y, w: group.w, h: group.h }, box, CLEARANCE));
    const centerX = nearBox.x + nearBox.w / 2 - group.w / 2;
    const centerY = nearBox.y + nearBox.h / 2 - group.h / 2;
    const sides = [
      { x: nearBox.x + nearBox.w + PLACEMENT_GAP, y: centerY, dx: group.w / 2 + CLEARANCE, dy: 0 },
      { x: centerX, y: nearBox.y + nearBox.h + PLACEMENT_GAP, dx: 0, dy: group.h / 2 + CLEARANCE },
      { x: nearBox.x - PLACEMENT_GAP - group.w, y: centerY, dx: -(group.w / 2 + CLEARANCE), dy: 0 },
      { x: centerX, y: nearBox.y - PLACEMENT_GAP - group.h, dx: 0, dy: -(group.h / 2 + CLEARANCE) },
    ];
    // The nearest free spot first: step outward on all four sides in turn.
    for (let step = 0; step < NEAR_STEPS; step += 1) {
      for (const side of sides) {
        const x = side.x + side.dx * step;
        const y = side.y + side.dy * step;
        if (clear(x, y)) return { ...offsetTo(x, y), placement: "near" };
      }
    }
    return byDefault(`no free space near ${position.ref}`);
  }
  return byDefault(null);
};
