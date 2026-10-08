import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { canonicalText, contentHash, createVersionStore } from "../app/server/versions.mjs";
import { encodeDelta, openHistory } from "../tools/history.mjs";

// A board that goes back to an earlier state (add a shape, delete it again: A, B, A) repeats a
// version id. Found by the concurrency test (seed 157): stored as a delta, the repeated entry made
// the parent chain loop ("delta chain too long"). Now such a version is a checkpoint, and a delta's
// parent always resolves to an older entry, so history written before the fix reads too.
const AGENT = "agent:sim#1";
const el = (id, extra = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 100, height: 60, strokeColor: "#1e1e1e", version: 1, versionNonce: 1, ...extra });

const withStore = async (fn) => {
  const dir = path.resolve(".test-run", `history-repeat-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  let clock = 1_000_000;
  const options = { boardsDir: dir, now: () => clock, idleMs: 60_000 };
  try {
    await fn({ dir, options, tick: () => { clock += 1000; } });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
};

const write = async (store, board, base, elements, tick) => {
  tick();
  const result = await store.submitBranch(board, { author: AGENT, base, writtenAt: 1_000_000, elements });
  assert.equal(result.status, "committed");
  return result;
};

test("a board back at an earlier version: the repeated version is a checkpoint and every version rebuilds", async () => {
  await withStore(async ({ dir, options, tick }) => {
    const store = createVersionStore(options);
    const board = "rep/b";
    const a = await write(store, board, null, [el("a"), el("b")], tick);
    const b = await write(store, board, a.version, [el("a"), el("b"), el("x")], tick);
    const again = await write(store, board, b.version, [el("a"), el("b")], tick);
    assert.equal(again.version, a.version, "the same content is the same version id");
    const c = await write(store, board, again.version, [el("a"), el("b"), el("y")], tick);
    await store.whenIdle();
    const folder = path.join(dir, ".xcld", "history", "rep", "b");
    const files = (await readdir(folder)).sort();
    assert.ok(files.includes(`${again.entry}.excalidraw.gz`), `the repeated version is a checkpoint: ${files.join(", ")}`);
    await store.close();

    // A fresh store (no caches) and the history reader both rebuild every version.
    const fresh = createVersionStore(options);
    for (const version of [a.version, b.version, c.version]) {
      const found = await fresh.readVersion(board, version);
      assert.equal(contentHash(found.text), version);
    }
    const history = await openHistory({ stateDir: path.join(dir, ".xcld"), board });
    for (const version of [a.version, b.version, c.version]) {
      assert.equal(contentHash(canonicalText(await history.sceneOf(version))), version);
    }
    await fresh.close();
  });
});

test("history written before the fix (the repeated version as a delta) still rebuilds", async () => {
  await withStore(async ({ dir, options, tick }) => {
    const store = createVersionStore(options);
    const board = "rep/old";
    const a = await write(store, board, null, [el("a"), el("b")], tick);
    const b = await write(store, board, a.version, [el("a"), el("b"), el("x")], tick);
    const again = await write(store, board, b.version, [el("a"), el("b")], tick);
    const c = await write(store, board, again.version, [el("a"), el("b"), el("y")], tick);
    await store.whenIdle();
    await store.close();
    // Rewrite the repeated entry as the delta the old code wrote: parent b, which is itself a delta
    // from a; the index's newest entry for a is this one, so a naive parent lookup loops.
    const folder = path.join(dir, ".xcld", "history", "rep", "old");
    const checkpoint = JSON.parse(gunzipSync(await readFile(path.join(folder, `${again.entry}.excalidraw.gz`))).toString("utf8"));
    const { xcld: _info, ...sceneA } = checkpoint;
    const bRecord = (await readdir(folder)).find((name) => name.startsWith(b.entry) && name.endsWith(".gz"));
    assert.ok(bRecord.endsWith(".delta.json.gz"), "b is a delta from a");
    const sceneB = { ...sceneA, elements: [...sceneA.elements, ...b.scene.elements.filter((element) => element.id === "x")] };
    const delta = { xcld: { schema: 3, record: "delta", version: again.version, parent: b.version, depth: 2, files: [] }, ...encodeDelta(sceneB, sceneA) };
    await writeFile(path.join(folder, `${again.entry}.delta.json.gz`), gzipSync(JSON.stringify(delta)));
    await rm(path.join(folder, `${again.entry}.excalidraw.gz`));
    const metaFile = path.join(folder, `${again.entry}.meta.json`);
    await writeFile(metaFile, JSON.stringify({ ...JSON.parse(await readFile(metaFile, "utf8")), record: "delta", depth: 2 }));

    const fresh = createVersionStore(options);
    for (const version of [a.version, b.version, c.version]) {
      const found = await fresh.readVersion(board, version);
      assert.ok(found, `version ${version.slice(0, 8)} resolves`);
      assert.equal(contentHash(found.text), version);
    }
    await fresh.close();
    const history = await openHistory({ stateDir: path.join(dir, ".xcld"), board });
    for (const version of [a.version, b.version, c.version]) {
      assert.equal(contentHash(canonicalText(await history.sceneOf(version))), version);
    }
  });
});
