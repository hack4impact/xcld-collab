import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { diffFiles, formatDiff } from "../tools/diff.mjs";

const fixtures = path.resolve("tests", "fixtures");

test("diff reports semantic fixture changes", async () => {
  const diff = await diffFiles(path.join(fixtures, "fixture-a.excalidraw"), path.join(fixtures, "fixture-b.excalidraw"));
  const text = formatDiff(diff);
  assert.match(text, /~ relabeled/);
  assert.match(text, /~ rewired/);
  assert.match(text, /- removed/);
  assert.match(text, /backgroundColor/);
  assert.match(text, /\+ added "Human note: validate schema edge"/);
});