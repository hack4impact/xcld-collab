// Shared by the canvas (browser) and the board index (Node), so: no Node imports.
//
// When a tab converts boards/<path>.mmd it stamps every converted element with
// customData.xcldMermaidHash = mermaidSourceHash(source). Excalidraw keeps element
// customData through restore, edits and saves, so the board itself records which Mermaid
// it came from. "Mermaid pending" is then a content comparison that survives a fresh clone
// or checkout (mtimes don't).
export const MERMAID_HASH_KEY = "xcldMermaidHash";

// BOM, CRLF and trailing whitespace don't change the diagram (and fetch() drops a BOM).
export const normalizeMermaidSource = (text) => String(text ?? "")
  .replace(/^\uFEFF/, "")
  .replace(/\r\n?/g, "\n")
  .replace(/\s+$/, "");

const fnv1a32 = (text, seed) => {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

// Two FNV-1a passes with different offset bases: 64 bits, enough to tell edits apart.
export const mermaidSourceHash = (text) => {
  const normalized = normalizeMermaidSource(text);
  return `m1-${fnv1a32(normalized, 2166136261)}${fnv1a32(normalized, 0x811c9dc5 ^ 0x5bd1e995)}`;
};

export const stampMermaidHash = (elements, hash) => elements.map((element) => ({
  ...element,
  customData: { ...(element.customData ?? {}), [MERMAID_HASH_KEY]: hash },
}));

export const recordedMermaidHashes = (elements) => new Set(
  (Array.isArray(elements) ? elements : [])
    .filter((element) => element && !element.isDeleted)
    .map((element) => element.customData?.[MERMAID_HASH_KEY])
    .filter((hash) => typeof hash === "string" && hash),
);
