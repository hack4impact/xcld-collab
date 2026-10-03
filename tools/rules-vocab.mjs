// Hand-maintained for v1. Issue #6 tracks deterministic generation from Excalidraw's pinned type definitions.
export const RULE_KINDS = ["interpret", "protect", "draw", "check", "export", "snapshot"];
export const CHANGE_TYPES = ["added", "removed", "relabeled", "rewired", "restyled", "moved"];

export const ELEMENT_TYPES = ["rectangle", "diamond", "ellipse", "text", "arrow", "line", "freedraw", "frame", "image"];
export const STROKE_STYLES = ["solid", "dashed", "dotted"];
export const STROKE_WIDTHS = ["1", "2", "4"];
export const FILL_STYLES = ["hachure", "cross-hatch", "solid", "zigzag"];
export const ARROWHEADS = [
  "none",
  "arrow",
  "bar",
  "dot",
  "circle",
  "circle_outline",
  "triangle",
  "triangle_outline",
  "diamond",
  "diamond_outline",
  "crowfoot_one",
  "crowfoot_many",
  "crowfoot_one_or_many",
  "crowfoot_zero_or_one",
  "crowfoot_zero_or_many",
];
export const BOOLEANS = ["true", "false"];
export const EXPORT_MODES = ["off", "snapshot", "save"];
export const SNAPSHOT_MODES = ["on", "off"];
export const CROSS_TARGETS = ["note", "text", ...ELEMENT_TYPES];

export const MATCH_PROPS = [
  "type",
  "strokeColor",
  "backgroundColor",
  "strokeStyle",
  "strokeWidth",
  "fillStyle",
  "startArrowhead",
  "endArrowhead",
  "elbowed",
  "opacity",
  "bound",
  "frame",
  "crosses",
];

export const allowedValuesForProp = (prop) => {
  if (prop === "type") return ELEMENT_TYPES;
  if (prop === "strokeStyle") return STROKE_STYLES;
  if (prop === "strokeWidth") return STROKE_WIDTHS;
  if (prop === "fillStyle") return FILL_STYLES;
  if (prop === "startArrowhead" || prop === "endArrowhead") return ARROWHEADS;
  if (prop === "elbowed" || prop === "bound") return BOOLEANS;
  if (prop === "crosses") return CROSS_TARGETS;
  return null;
};
