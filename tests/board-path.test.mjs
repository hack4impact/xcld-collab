import assert from "node:assert/strict";
import { test } from "node:test";
import { validateBoardPath } from "../tools/board-path.mjs";

test("board path validation accepts nested board paths", () => {
  assert.equal(validateBoardPath("myproject/demo").ok, true);
  assert.equal(validateBoardPath("v2.data-model/flow_1").ok, true);
});

test("board path validation respects maxDepth option", () => {
  assert.equal(validateBoardPath("one/two", { maxDepth: 1 }).ok, true);
  assert.equal(validateBoardPath("one/two/three", { maxDepth: 1 }).ok, false);
  assert.equal(validateBoardPath("one/two/three", { maxDepth: 0 }).ok, true);
});

test("board path validation rejects unsafe paths", () => {
  const invalid = [
    "..",
    "a/..",
    ".hidden/demo",
    "a\\b",
    "a//b",
    "/a",
    "a/",
    "a".repeat(513),
  ];
  for (const name of invalid) {
    assert.equal(validateBoardPath(name).ok, false, name);
  }
});
