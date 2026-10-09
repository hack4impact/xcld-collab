// Element ids through a Mermaid round trip. Shared by to-mermaid (export) and the Mermaid apply
// path, and bundled into the canvas, so: no Node imports.
//
// A Mermaid node id is `[A-Za-z_][A-Za-z0-9_]*`; an Excalidraw element id can be anything (a
// hand-drawn shape's is a nanoid such as `_x7Q-2bLmN9pRt4VwKc8Ya`, a named source's is
// `<source>:<node>`). The export rewrites such an id (to-mermaid's mermaidIdMapper) and records the
// original next to it, in a Mermaid comment that the parser ignores:
//
//   %% xcld:id _x7Q_2bLmN9pRt4VwKc8Ya "_x7Q-2bLmN9pRt4VwKc8Ya"
//
// A Mermaid write that still carries the comment maps the node back to that element, so a shape
// read from the board and written back is updated in place, never deleted and re-created.
const MERMAID_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID_COMMENT = /^[ \t]*%%[ \t]*xcld:id[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+("(?:[^"\\\n]|\\.)*")[ \t]*$/gm;

/** The comment line recording that `mermaidId` stands for the element `elementId`. */
export const idComment = (mermaidId, elementId) => `%% xcld:id ${mermaidId} ${JSON.stringify(String(elementId))}`;

/** Mermaid id -> element id, from the `%% xcld:id` comments of a Mermaid text (first one wins). */
export const readIdMap = (text) => {
  const map = {};
  for (const match of String(text ?? "").matchAll(ID_COMMENT)) {
    if (!MERMAID_ID.test(match[1]) || Object.hasOwn(map, match[1])) continue;
    try {
      const elementId = JSON.parse(match[2]);
      if (typeof elementId === "string" && elementId && elementId !== match[1]) map[match[1]] = elementId;
    } catch {}
  }
  return map;
};

/** A parse result with the text's id map attached (`idMap`, only for a successful parse). */
export const withIdMap = (parsed, text) => (parsed?.ok && !parsed.idMap ? { ...parsed, idMap: readIdMap(text) } : parsed);
