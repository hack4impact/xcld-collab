// Excalidraw's own values come from tools/rules-vocab.generated.mjs (regenerate with
// node scripts/gen-rules-vocab.mjs). Everything here is xcld-collab's own vocabulary.
import {
  ARROWHEADS as EXCALIDRAW_ARROWHEADS,
  ELEMENT_TYPES,
  FILL_STYLES,
  LEGACY_ARROWHEADS,
  PALETTE,
  ROUNDNESS,
  STROKE_STYLES,
  STROKE_WIDTHS,
} from "./rules-vocab.generated.mjs";

export { ELEMENT_TYPES, FILL_STYLES, LEGACY_ARROWHEADS, PALETTE, ROUNDNESS, STROKE_STYLES, STROKE_WIDTHS };

export const RULE_KINDS = ["interpret", "protect", "draw", "check", "export", "snapshot"];
export const CHANGE_TYPES = ["added", "removed", "relabeled", "rewired", "restyled", "moved"];

// "none" stands for a null arrowhead (a plain line end).
export const ARROWHEADS = ["none", ...EXCALIDRAW_ARROWHEADS];
export const PALETTE_COLORS = [...new Set(Object.values(PALETTE).flat())];
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
  "roundness",
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
  if (prop === "roundness") return ROUNDNESS;
  if (prop === "startArrowhead" || prop === "endArrowhead") return ARROWHEADS;
  if (prop === "elbowed" || prop === "bound") return BOOLEANS;
  if (prop === "crosses") return CROSS_TARGETS;
  return null;
};
