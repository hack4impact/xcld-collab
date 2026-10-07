import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileElements } from "../app/src/reconcile.mjs";

const el = (id, version, extra = {}) => ({ id, type: "rectangle", version, versionNonce: version * 10, x: 0, ...extra });
const ids = (elements) => elements.map((element) => element.id);
const find = (elements, id) => elements.find((element) => element.id === id);

test("without base: higher version wins per id, ties go to the tab, one-sided elements kept", () => {
  const merged = reconcileElements({
    local: [el("a", 3, { x: 1 }), el("b", 1, { x: 1 }), el("tie", 2, { x: 1 }), el("tab-only", 1)],
    remote: [el("a", 2, { x: 2 }), el("b", 4, { x: 2 }), el("tie", 2, { x: 2 }), el("disk-only", 1)],
  });
  assert.deepEqual(ids(merged), ["a", "b", "tie", "tab-only", "disk-only"]);
  assert.equal(find(merged, "a").x, 1);
  assert.equal(find(merged, "b").x, 2);
  assert.equal(find(merged, "tie").x, 1);
});

test("with base: one-sided changes win even when the agent did not bump version", () => {
  const base = [el("tab-edits", 1), el("agent-edits", 1), el("untouched", 1)];
  const local = [el("tab-edits", 2, { x: 50 }), el("agent-edits", 1), el("untouched", 1)];
  const remote = [el("tab-edits", 1), el("agent-edits", 1, { x: 99 }), el("untouched", 1)];
  const merged = reconcileElements({ base, local, remote });
  assert.equal(find(merged, "tab-edits").x, 50);
  assert.equal(find(merged, "agent-edits").x, 99);
  assert.equal(find(merged, "untouched").x, 0);
});

test("both sides changed the same element: higher version wins, ties go to the tab", () => {
  const base = [el("a", 1), el("b", 1)];
  const local = [el("a", 3, { x: 10 }), el("b", 2, { x: 10 })];
  const remote = [el("a", 2, { x: 20 }), el("b", 5, { x: 20 })];
  const merged = reconcileElements({ base, local, remote });
  assert.equal(find(merged, "a").x, 10);
  assert.equal(find(merged, "b").x, 20);

  const tie = reconcileElements({ base, local: [el("a", 2, { x: 10 })], remote: [el("a", 2, { x: 20 })] });
  assert.equal(find(tie, "a").x, 10);
});

test("deletions: tombstones follow version rules, omissions use the base", () => {
  const base = [el("tab-deletes", 1), el("agent-deletes", 1), el("agent-omits", 1), el("agent-omits-edited", 1)];
  const local = [
    el("tab-deletes", 2, { isDeleted: true }),
    el("agent-deletes", 1),
    el("agent-omits", 1),
    el("agent-omits-edited", 2, { x: 7 }),
    el("tab-new", 1),
  ];
  const remote = [el("tab-deletes", 1), el("agent-deletes", 2, { isDeleted: true }), el("agent-new", 1)];
  const merged = reconcileElements({ base, local, remote });
  assert.equal(find(merged, "tab-deletes").isDeleted, true);
  assert.equal(find(merged, "agent-deletes").isDeleted, true);
  assert.equal(find(merged, "agent-omits"), undefined, "an untouched element the agent left out stays removed");
  assert.equal(find(merged, "agent-omits-edited").x, 7, "a tab edit keeps an element the agent left out");
  assert.ok(find(merged, "tab-new"));
  assert.ok(find(merged, "agent-new"));
});

test("tab-only elements keep their place; fractional indices decide order when present", () => {
  const order = reconcileElements({
    local: [el("a", 1), el("new", 1), el("b", 1)],
    remote: [el("a", 1), el("b", 1), el("c", 1)],
  });
  assert.deepEqual(ids(order), ["a", "new", "b", "c"]);

  const indexed = reconcileElements({
    local: [el("a", 1, { index: "a0" }), el("new", 1, { index: "a2" })],
    remote: [el("b", 1, { index: "a1" }), el("a", 1, { index: "a0" })],
  });
  assert.deepEqual(ids(indexed), ["a", "b", "new"]);
});

test("does not mutate its inputs", () => {
  const base = [el("a", 1)];
  const local = [el("a", 2, { x: 1 })];
  const remote = [el("a", 1), el("b", 1)];
  const snapshot = JSON.stringify({ base, local, remote });
  reconcileElements({ base, local, remote });
  assert.equal(JSON.stringify({ base, local, remote }), snapshot);
});
