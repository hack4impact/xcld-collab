import assert from "node:assert/strict";
import { test } from "node:test";
import { disambiguateDuplicateElementIds } from "../app/src/ids.mjs";

test("duplicate Mermaid edge IDs are disambiguated before Excalidraw conversion", () => {
  const output = disambiguateDuplicateElementIds([
    { id: "A", type: "rectangle", boundElements: [{ id: "A_B", type: "arrow" }] },
    { id: "B", type: "rectangle" },
    { id: "A_B", type: "arrow", start: { id: "A" }, end: { id: "B" } },
    { id: "A_B", type: "arrow", start: { id: "A" }, end: { id: "B" } },
  ]);
  assert.deepEqual(output.map((element) => element.id), ["A", "B", "A_B", "A_B_2"]);
  assert.equal(output[2].start.id, "A");
  assert.equal(output[3].end.id, "B");
});