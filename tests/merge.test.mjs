import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeBoard } from "../tools/merge.mjs";
import { arrow, editBoard, makeBoard, mulberry32, shape, shuffled, text } from "./merge-fixtures.mjs";

const find = (elements, id) => elements.find((element) => element.id === id);
const ids = (elements) => elements.map((element) => element.id);
const clone = (elements) => structuredClone(elements);
const edit = (elements, id, patch) => elements.map((element) => (element.id === id ? { ...element, ...patch } : element));
const without = (elements, ...removed) => elements.filter((element) => !removed.includes(element.id));
const stamp = (writtenAt, author) => ({ writtenAt, author });
const metaFor = (elements, writtenAt, author) => Object.fromEntries(elements.map((element) => [element.id, stamp(writtenAt, author)]));

// Two labelled shapes joined by an arrow, plus a free note; Excalidraw-style back-references.
const smallBoard = () => {
  const [a, aText] = shape("a", "a0", { label: "Alpha", textIndex: "a1" });
  const [b, bText] = shape("b", "a2", { x: 300, label: "Beta", textIndex: "a3" });
  const link = arrow("ab", "a4", "a", "b");
  a.boundElements.push({ id: "ab", type: "arrow" });
  b.boundElements.push({ id: "ab", type: "arrow" });
  return [a, aText, b, bText, link, text("note", "a5", "remember", { y: -100 })];
};

const merge = (input) => mergeBoard({ branchAuthor: "agent#1", branchWrittenAt: 2000, masterMeta: {}, ...input });

// Content the merge must agree on: no version bookkeeping, no arrow back-references.
const content = (element) => {
  const { version, versionNonce, updated, isDeleted, boundElements, ...rest } = element;
  const refs = (boundElements ?? []).filter((entry) => entry.type !== "arrow");
  return JSON.stringify(Object.keys(rest).sort().reduce((copy, key) => ({ ...copy, [key]: rest[key] }), refs.length ? { boundElements: refs } : {}));
};
const contentMap = (elements) => new Map(elements.filter((element) => !element.isDeleted).map((element) => [element.id, content(element)]));

test("disjoint edits from both sides both apply", () => {
  const base = smallBoard();
  const master = edit(base, "a", { strokeColor: "#e03131" });
  const branch = edit(edit(base, "b-t", { text: "Beta 2", originalText: "Beta 2" }), "note", { x: 40 });
  const result = merge({ base, master, branch, masterMeta: metaFor(base, 1000, "seed") });
  assert.equal(find(result.elements, "a").strokeColor, "#e03131");
  assert.equal(find(result.elements, "b-t").originalText, "Beta 2");
  assert.equal(find(result.elements, "note").x, 40);
  assert.deepEqual(result.overwritten, []);
  assert.deepEqual(result.applied.map(({ unitId, kind, label }) => ({ unitId, kind, label })), [
    { unitId: "b", kind: "changed", label: "Beta 2" },
    { unitId: "note", kind: "changed", label: "remember" },
  ]);
  assert.equal(result.fastForward, false);
  assert.deepEqual(ids(result.elements), ids(base));
});

test("same unit on both sides: the later write takes all, both directions", () => {
  const base = smallBoard();
  const master = edit(base, "a", { x: 50 });
  const branch = edit(base, "a", { strokeColor: "#2f9e44" });
  const masterMeta = { ...metaFor(base, 1000, "seed"), a: stamp(1500, "human#t1") };

  const branchNewer = merge({ base, master, branch, branchWrittenAt: 2000, masterMeta });
  assert.equal(find(branchNewer.elements, "a").x, 0, "the branch takes the whole unit, master's move is overwritten");
  assert.equal(find(branchNewer.elements, "a").strokeColor, "#2f9e44");
  assert.equal(branchNewer.overwritten.length, 1);
  const [lost] = branchNewer.overwritten;
  assert.equal(lost.unitId, "a");
  assert.equal(lost.label, "Alpha");
  assert.deepEqual(lost.winner, { side: "branch", author: "agent#1", writtenAt: 2000 });
  assert.equal(lost.loser.side, "master");
  assert.equal(lost.loser.author, "human#t1");
  assert.equal(find(lost.loser.elements, "a").x, 50, "the loser's version travels with the report");
  assert.deepEqual(branchNewer.meta.a, stamp(2000, "agent#1"));
  assert.deepEqual(branchNewer.meta["a-t"], stamp(2000, "agent#1"));

  const masterNewer = merge({ base, master, branch, branchWrittenAt: 1200, masterMeta });
  assert.equal(find(masterNewer.elements, "a").x, 50);
  assert.equal(find(masterNewer.elements, "a").strokeColor, "#1e1e1e");
  assert.deepEqual(masterNewer.overwritten[0].winner, { side: "master", author: "human#t1", writtenAt: 1500 });
  assert.equal(masterNewer.overwritten[0].loser.side, "branch");
  assert.deepEqual(masterNewer.applied, []);
  assert.deepEqual(masterNewer.meta.a, stamp(1500, "human#t1"));
});

test("equal write times: the greater author key wins whichever side it is on", () => {
  const base = smallBoard();
  const left = edit(base, "a", { x: 1 });
  const right = edit(base, "a", { x: 2 });
  const one = merge({ base, master: left, branch: right, branchAuthor: "zed", branchWrittenAt: 1000, masterMeta: { a: stamp(1000, "amy") } });
  const two = merge({ base, master: right, branch: left, branchAuthor: "amy", branchWrittenAt: 1000, masterMeta: { a: stamp(1000, "zed") } });
  assert.equal(find(one.elements, "a").x, 2);
  assert.equal(find(two.elements, "a").x, 2);
});

test("a container and its bound text are one unit", () => {
  const base = smallBoard();
  const master = edit(base, "a-t", { text: "Alpha (human)", originalText: "Alpha (human)" });
  const branch = edit(edit(base, "a", { x: 200 }), "a-t", { x: 210 });
  const result = merge({ base, master, branch, branchWrittenAt: 2000, masterMeta: { "a-t": stamp(1500, "human#t1") } });
  assert.equal(find(result.elements, "a").x, 200);
  assert.equal(find(result.elements, "a-t").x, 210);
  assert.equal(find(result.elements, "a-t").originalText, "Alpha", "no mixed state: the label comes with the winning container");
  assert.deepEqual(result.overwritten.map((entry) => [entry.unitId, entry.label, entry.elementIds]), [["a", "Alpha", ["a", "a-t"]]]);
});

test("an arrow whose bound target was deleted on the other side is kept but unbound", () => {
  const base = smallBoard();
  const master = without(base, "b", "b-t");
  const branch = [...edit(base, "a", { boundElements: [...find(base, "a").boundElements, { id: "new", type: "arrow" }] }), arrow("new", "a6", "a", "b", { strokeColor: "#1971c2" })];
  const result = merge({ base, master, branch, masterMeta: metaFor(base, 1000, "seed") });
  assert.equal(find(result.elements, "b"), undefined);
  assert.equal(find(result.elements, "new").startBinding.elementId, "a");
  assert.equal(find(result.elements, "new").endBinding, null);
  assert.equal(find(result.elements, "ab").endBinding, null);
  assert.deepEqual(result.unbound, [
    { arrowId: "ab", end: "end", elementId: "b" },
    { arrowId: "new", end: "end", elementId: "b" },
  ]);
  assert.deepEqual(find(result.elements, "a").boundElements.map((entry) => entry.id), ["a-t", "ab", "new"]);
  assert.deepEqual(result.overwritten, []);
});

test("arrow back-references don't make a shape conflict, and follow the merged arrows", () => {
  const base = smallBoard();
  const master = [...edit(base, "a", { boundElements: [...find(base, "a").boundElements, { id: "aa", type: "arrow" }] }), arrow("aa", "a6", "a", "a")];
  const branch = edit(edit(base, "a", { strokeColor: "#f08c00", boundElements: [{ id: "a-t", type: "text" }] }), "ab", { isDeleted: true });
  const result = merge({ base, master, branch, masterMeta: { ...metaFor(base, 1000, "seed"), a: stamp(1500, "human"), aa: stamp(1500, "human") } });
  assert.deepEqual(result.overwritten, []);
  assert.equal(find(result.elements, "a").strokeColor, "#f08c00");
  assert.deepEqual(find(result.elements, "a").boundElements, [{ id: "a-t", type: "text" }, { id: "aa", type: "arrow" }]);
  assert.deepEqual(find(result.elements, "b").boundElements, [{ id: "b-t", type: "text" }]);
  assert.equal(find(result.elements, "ab"), undefined, "tombstones are not written to master");
});

test("deleting a shape unbinds its arrows only if the deletion wins", () => {
  const base = smallBoard();
  // The tab deletes b the Excalidraw way: tombstones, and the arrow loses its end binding.
  const tab = base.map((element) => (["b", "b-t"].includes(element.id) ? { ...element, isDeleted: true, version: 2 } : element.id === "ab" ? { ...element, endBinding: null, version: 2 } : element));
  const agent = edit(base, "b", { backgroundColor: "#2f9e44" });
  const agentNewer = merge({ base, master: tab, branch: agent, branchWrittenAt: 2000, masterMeta: { b: stamp(1500, "human"), "b-t": stamp(1500, "human"), ab: stamp(1500, "human") } });
  assert.equal(find(agentNewer.elements, "b").backgroundColor, "#2f9e44");
  assert.equal(find(agentNewer.elements, "ab").endBinding.elementId, "b", "b survived, so the arrow stays bound");
  assert.deepEqual(agentNewer.overwritten.map((entry) => entry.unitId), ["b"]);

  const tabNewer = merge({ base, master: agent, branch: tab, branchWrittenAt: 2000, masterMeta: { b: stamp(1500, "agent") } });
  assert.equal(find(tabNewer.elements, "b"), undefined);
  assert.equal(find(tabNewer.elements, "ab").endBinding, null);
  assert.deepEqual(tabNewer.unbound, [{ arrowId: "ab", end: "end", elementId: "b" }], "master's copy was bound, so the unbinding is reported");
});

test("deletion against an edit of the same unit: the later write decides", () => {
  const base = smallBoard();
  const deleted = without(base, "b", "b-t");
  const edited = edit(base, "b", { backgroundColor: "#2f9e44" });

  const editWins = merge({ base, master: deleted, branch: edited, branchWrittenAt: 2000, masterMeta: { b: stamp(1500, "human"), "b-t": stamp(1500, "human") } });
  assert.equal(find(editWins.elements, "b").backgroundColor, "#2f9e44");
  assert.ok(find(editWins.elements, "b-t"), "the label comes back with its container");
  assert.equal(find(editWins.elements, "ab").endBinding.elementId, "b");
  assert.equal(editWins.overwritten[0].loser.side, "master");
  assert.deepEqual(editWins.overwritten[0].loser.elements, []);

  const tombstones = base.map((element) => (["b", "b-t"].includes(element.id) ? { ...element, isDeleted: true, version: 2 } : element));
  const deleteWins = merge({ base, master: edited, branch: tombstones, branchWrittenAt: 2000, masterMeta: { b: stamp(1500, "agent#2") } });
  assert.equal(find(deleteWins.elements, "b"), undefined);
  assert.equal(find(deleteWins.elements, "b-t"), undefined);
  assert.deepEqual(deleteWins.applied.map((entry) => [entry.unitId, entry.kind]), [["b", "deleted"]]);
  assert.equal(find(deleteWins.overwritten[0].loser.elements, "b").backgroundColor, "#2f9e44");
  assert.deepEqual(deleteWins.unbound, [{ arrowId: "ab", end: "end", elementId: "b" }]);
});

test("one-sided deletions apply, by omission or tombstone", () => {
  const base = smallBoard();
  const result = merge({ base, master: without(base, "note"), branch: edit(base, "b", { isDeleted: true }).filter((element) => element.id !== "b-t") });
  assert.deepEqual(ids(result.elements), ["a", "a-t", "ab"]);
  assert.deepEqual(result.applied.map((entry) => [entry.unitId, entry.kind]), [["b", "deleted"]]);
});

test("D8: a stale queued write loses to a newer edit of the same unit; its disjoint edits still apply", () => {
  const base = smallBoard();
  // Branch written at 13:00 but merged after a 15:00 human edit of the same shape.
  const queued = edit(edit(base, "a-t", { text: "Alpha (agent)", originalText: "Alpha (agent)" }), "note", { text: "agent note", originalText: "agent note" });
  const master = edit(base, "a-t", { text: "Alpha (human)", originalText: "Alpha (human)", version: 2, versionNonce: 7 });
  const result = merge({ base, master, branch: queued, branchWrittenAt: Date.UTC(2026, 9, 6, 13), masterMeta: { ...metaFor(base, Date.UTC(2026, 9, 6, 9), "seed"), "a-t": stamp(Date.UTC(2026, 9, 6, 15), "human#t1") } });
  assert.equal(find(result.elements, "a-t").originalText, "Alpha (human)");
  assert.equal(find(result.elements, "note").originalText, "agent note");
  assert.deepEqual(result.overwritten.map((entry) => ({ unitId: entry.unitId, winner: entry.winner.author, loser: entry.loser.author, loserSide: entry.loser.side })), [
    { unitId: "a", winner: "human#t1", loser: "agent#1", loserSide: "branch" },
  ]);
  assert.equal(find(result.overwritten[0].loser.elements, "a-t").originalText, "Alpha (agent)");
  assert.deepEqual(result.applied.map((entry) => entry.unitId), ["note"]);
});

test("key order, version bookkeeping and tombstone-vs-absent are not changes", () => {
  const base = smallBoard();
  const reordered = base.map((element) => Object.fromEntries(Object.entries({ ...element, version: element.version + 3, updated: 99 }).reverse()));
  const result = merge({ base, master: base, branch: [...reordered, { ...text("gone", "a9", "x"), isDeleted: true }] });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.elements, base, "master's objects are kept");
});

test("agent edits without version bumps are detected by content, and the merged copy gets a higher version", () => {
  const base = smallBoard();
  const master = edit(base, "a", { x: 10, version: 4, versionNonce: 44 });
  const branch = edit(base, "b", { x: 999 });
  const result = merge({ base, master, branch });
  assert.equal(find(result.elements, "b").x, 999);
  assert.equal(find(result.elements, "b").version, 2);
  assert.notEqual(find(result.elements, "b").versionNonce, find(base, "b").versionNonce);
  assert.equal(find(result.elements, "a"), find(master, "a"), "untouched master elements are passed through as is");
  const again = merge({ base, master, branch });
  assert.equal(find(again.elements, "b").versionNonce, find(result.elements, "b").versionNonce);
});

test("fast-forward when master still equals base: the result is the branch", () => {
  const base = smallBoard();
  const branch = [...edit(without(base, "note"), "a", { x: 5 }), text("n2", "a6", "new note")];
  const result = merge({ base, master: clone(base), branch });
  assert.equal(result.fastForward, true);
  assert.deepEqual(result.elements.map(content), branch.map(content));
  assert.deepEqual(result.overwritten, []);
});

test("groups are not units: grouped elements merge per element", () => {
  const base = smallBoard().map((element) => (["a", "a-t", "b", "b-t"].includes(element.id) ? { ...element, groupIds: ["g1"] } : element));
  const result = merge({ base, master: edit(base, "a", { x: 1 }), branch: edit(base, "b", { x: 2 }), masterMeta: { a: stamp(1500, "human") } });
  assert.equal(find(result.elements, "a").x, 1);
  assert.equal(find(result.elements, "b").x, 2);
  assert.deepEqual(result.overwritten, []);
});

test("z-order: fractional indices sort; without them master order holds and new elements follow their branch neighbour", () => {
  const base = smallBoard();
  const indexed = merge({ base, master: [...base, text("m", "a9", "m")], branch: [...edit(base, "note", { index: "a0V" }), text("x", "a7", "x")] });
  assert.deepEqual(ids(indexed.elements), ["a", "note", "a-t", "b", "b-t", "ab", "x", "m"]);

  const plain = base.map(({ index, ...element }) => element);
  const unindexed = merge({ base: plain, master: [...plain, text("m", undefined, "m")], branch: [plain[0], text("x1", undefined, "x1"), text("x2", undefined, "x2"), ...plain.slice(1)] });
  assert.deepEqual(ids(unindexed.elements), ["a", "x1", "x2", "a-t", "b", "b-t", "ab", "note", "m"]);
});

test("files and appState pass through", () => {
  const base = { elements: smallBoard(), appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: { f1: { id: "f1", dataURL: "data:1" } } };
  const master = { ...base, appState: { viewBackgroundColor: "#ffffff", gridSize: 20 } };
  const branch = { ...base, appState: { viewBackgroundColor: "#000000", gridSize: null }, files: { ...base.files, f2: { id: "f2", dataURL: "data:2" } } };
  const result = merge({ base, master, branch });
  assert.deepEqual(result.appState, { viewBackgroundColor: "#000000", gridSize: 20 });
  assert.deepEqual(Object.keys(result.files), ["f1", "f2"]);
});

test("validates inputs and never mutates them", () => {
  const base = smallBoard();
  const master = edit(base, "a", { x: 3 });
  const branch = without(base, "b", "b-t");
  const snapshot = JSON.stringify({ base, master, branch });
  merge({ base, master, branch, masterMeta: { a: stamp(1, "x") } });
  assert.equal(JSON.stringify({ base, master, branch }), snapshot);
  assert.throws(() => merge({ base, master, branch, branchWrittenAt: "soon" }), /branchWrittenAt/);
  assert.throws(() => merge({ base, master, branch: [{ type: "rectangle" }] }), /string id/);
  assert.throws(() => merge({ base, master, branch, masterMeta: { a: { author: "x" } } }), /writtenAt/);
});

// D3: random edit scripts from a simulated tab (version bumps, tombstones) and an agent (no
// bumps, deletion by omission) on one board. Merging A then B must give the same board as B
// then A, whatever the input element order, and every change is kept or reported overwritten.
const SEEDS = Number(process.env.XCLD_MERGE_SEEDS) || 60;
test(`D3: ${SEEDS} seeded edit scripts merge deterministically, order-independently and without silent loss`, () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = mulberry32(seed);
    const base = makeBoard(60 + Math.floor(rng() * 60), rng);
    const seedMeta = metaFor(base, 1000, "seed");
    const writers = [
      { author: "human#tab1", writtenAt: 2000 + Math.floor(rng() * 1000), elements: editBoard(base, mulberry32(seed * 7919), { author: "human", ops: 3 + Math.floor(rng() * 12), tabLike: true }) },
      { author: "agent#p1", writtenAt: 2000 + Math.floor(rng() * 1000), elements: editBoard(base, mulberry32(seed * 104729), { author: "agent", ops: 3 + Math.floor(rng() * 12), tabLike: false }) },
    ];
    if (writers[0].writtenAt === writers[1].writtenAt) {
      writers[1].writtenAt += 1;
    }
    const sequence = (first, second, order = (items) => items) => {
      const one = mergeBoard({ base: order(base), master: order(base), branch: order(first.elements), branchWrittenAt: first.writtenAt, branchAuthor: first.author, masterMeta: seedMeta });
      const two = mergeBoard({ base: order(base), master: order(one.elements), branch: order(second.elements), branchWrittenAt: second.writtenAt, branchAuthor: second.author, masterMeta: one.meta });
      return { one, two };
    };
    const [human, agent] = writers;
    const humanFirst = sequence(human, agent);
    const agentFirst = sequence(agent, human);
    const context = `seed ${seed}`;

    assert.deepEqual(sequence(human, agent), humanFirst, `${context}: repeated runs`);
    const permuted = sequence(human, agent, (items) => shuffled(items, mulberry32(seed + 1)));
    assert.deepEqual(permuted.two.elements, humanFirst.two.elements, `${context}: input element order`);
    assert.deepEqual(permuted.two.overwritten, humanFirst.two.overwritten, `${context}: input element order (report)`);
    assert.deepEqual(permuted.two.meta, humanFirst.two.meta, `${context}: input element order (meta)`);
    assert.deepEqual(humanFirst.two.elements.map(content), agentFirst.two.elements.map(content), `${context}: merge order`);
    assert.deepEqual(humanFirst.two.meta, agentFirst.two.meta, `${context}: merge order (meta)`);

    for (const { one, two } of [humanFirst, agentFirst]) {
      const branch = two === humanFirst.two ? agent : human;
      assertNoSilentLoss({ base, master: one.elements, branch: branch.elements, result: two, context });
    }
  }
});

// Every element a side changed is in the result as that side wrote it, or its unit is reported
// overwritten with that side as the loser. "As written" follows the merge's binding rule: an
// unbinding implied by deleting the target isn't a change, and bindings to elements that are
// gone from the result are dropped.
function assertNoSilentLoss({ base, master, branch, result, context }) {
  const baseById = new Map(base.map((element) => [element.id, element]));
  const baseMap = contentMap(base);
  const finalById = new Map(result.elements.map((element) => [element.id, element]));
  const settle = (element) => ({
    ...element,
    ...Object.fromEntries(["startBinding", "endBinding"].filter((key) => key in element).map((key) => [key, finalById.has(element[key]?.elementId) ? element[key] : null])),
  });
  for (const [side, elements] of [["master", master], ["branch", branch]]) {
    const live = new Map(elements.filter((element) => !element.isDeleted).map((element) => [element.id, element]));
    const view = new Map([...live].map(([id, element]) => {
      const baseElement = baseById.get(id);
      const restored = { ...element };
      for (const key of ["startBinding", "endBinding"]) {
        if (key in element && !live.has(element[key]?.elementId)) {
          restored[key] = baseElement?.[key] && !live.has(baseElement[key].elementId) ? baseElement[key] : null;
        }
      }
      return [id, restored];
    }));
    for (const id of new Set([...baseMap.keys(), ...view.keys()])) {
      const written = view.get(id);
      if ((written && content(written)) === baseMap.get(id)) {
        continue;
      }
      if (result.overwritten.some((entry) => entry.loser.side === side && entry.elementIds.includes(id))) {
        continue;
      }
      const final = finalById.get(id);
      assert.equal(final && content(final), written && content(settle(written)), `${context}: ${side} change to ${id} silently lost`);
    }
  }
}

test("D5 guard: a 1,500-element merge with 10% changed per side stays far below a generous bound", () => {
  const rng = mulberry32(1500);
  const base = makeBoard(1500, rng);
  const master = editBoard(base, mulberry32(1), { author: "human", ops: 75, tabLike: true });
  const branch = editBoard(base, mulberry32(2), { author: "agent", ops: 75, tabLike: false });
  const started = performance.now();
  const result = mergeBoard({ base, master, branch, branchWrittenAt: 3000, branchAuthor: "agent#p1", masterMeta: metaFor(base, 1000, "seed") });
  const elapsed = performance.now() - started;
  assert.ok(result.elements.length > 1400);
  assert.ok(elapsed < 2000, `merge took ${elapsed.toFixed(1)} ms`);
});
