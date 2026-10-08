import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileToMermaid } from "../tools/to-mermaid.mjs";

test("to-mermaid preserves valid IDs and full note IDs", async () => {
  const output = await fileToMermaid(path.resolve("tests", "fixtures", "fixture-b.excalidraw"));
  assert.doesNotMatch(output, /\bn_n_/);
  assert.match(output, /\bn_done\b/);
  assert.match(output, /Free text note_schema/);
  assert.doesNotMatch(output, /note_schem\b/);
});

// demo-converted.excalidraw is real browser output from boards/examples/demo.mmd. Excalidraw
// soft-wraps labels in narrow shapes ("Do\nne"); the author's text is in originalText.
test("to-mermaid round-trips real converter output with unwrapped labels and Mermaid IDs", async () => {
  const output = await fileToMermaid(path.resolve("tests", "fixtures", "demo-converted.excalidraw"));
  assert.match(output, /\bDone\(\("Done"\)\)/);
  assert.match(output, /\bValid\{"Valid\?"\}/);
  assert.match(output, /\bReq\["Receive request"\]/);
  assert.match(output, /Valid -->\|"Yes"\| Process/);
  assert.match(output, /Valid -->\|"No"\| Fix/);
  assert.doesNotMatch(output, /Do ne|Valid \?/);
});

// style-check-converted.excalidraw is real browser output of a Mermaid flowchart whose
// Cache node used `classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2`.
test("to-mermaid keeps non-default node colors as Mermaid styles", async () => {
  const output = await fileToMermaid(path.resolve("tests", "fixtures", "style-check-converted.excalidraw"));
  assert.match(output, /^  style Cache fill:#a5d8ff,stroke:#1971c2,color:#1971c2$/m);
  assert.doesNotMatch(output, /style API\b/);
  assert.doesNotMatch(output, /style DB\b/);
});

// subgraph-converted.excalidraw is real browser output from the pinned converter
// plus the local mermaid-to-excalidraw subgraph patch.
test("to-mermaid emits real converted subgraph containers as subgraph blocks", async () => {
  const output = await fileToMermaid(path.resolve("tests", "fixtures", "subgraph-converted.excalidraw"));
  assert.match(output, /^  subgraph G\["Group"\]$/m);
  assert.match(output, /^    A\["One"\]$/m);
  assert.match(output, /^    B\["Two"\]$/m);
  assert.match(output, /^    A --> B$/m);
  assert.match(output, /^  end$/m);
  assert.doesNotMatch(output, /^  G\["Group"\]$/m);
});

test("to-mermaid maps supported arrow styles", async () => {
  const output = await fileToMermaid(path.resolve("tests", "fixtures", "arrow-styles.excalidraw"));
  // The fixture's arrows have no roundness (an agent's minimal JSON): the canvas draws them
  // straight, so each gets an edge id and `curve: linear`.
  assert.match(output, /^  A e_solid@--> B$/m);
  assert.match(output, /^  A e_line@--- B$/m);
  assert.match(output, /^  A e_dashed@-\.-> B$/m);
  assert.match(output, /^  A e_bold@==> B$/m);
  assert.match(output, /^  A e_both@<--> B$/m);
  assert.match(output, /^  e_solid@\{ curve: linear \}$/m);
});