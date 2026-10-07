import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { contentHash, createVersionStore } from "../app/server/versions.mjs";
import { applyDelta, checkExportDestination, encodeDelta, exportHistory, sameJson } from "../tools/history.mjs";
import { mulberry32 } from "./merge-fixtures.mjs";

const HUMAN = "human:Ada Lovelace#tab1";
const HUMAN2 = "human:Grace Hopper#tab9";
const AGENTS = ["agent:copilot-cli#4242", "agent:claude-code#5151", "cli:docs-bot"];

const el = (id, extra = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 100, height: 60, strokeColor: "#1e1e1e", version: 1, versionNonce: 1, ...extra });
const canonical = (scene) => `${JSON.stringify(scene, null, 2)}\n`;
// Element content as the merge sees it: the bookkeeping fields it rewrites don't count.
const sameContent = (left, right) => {
  const strip = ({ version: _v, versionNonce: _n, updated: _u, ...rest }) => rest;
  return sameJson(strip(left), strip(right));
};

const withDir = async (fn) => {
  const dir = path.resolve(".test-run", `history-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
};

const historyFolder = (dir, board) => path.join(dir, ".xcld", "history", ...board.split("/"));
const readGz = async (file) => JSON.parse(gunzipSync(await readFile(file)).toString("utf8"));
// Every stored record of a board: { entry, record, version, parent?, depth? }.
const recordsOf = async (dir, board) => {
  const folder = historyFolder(dir, board);
  const names = (await readdir(folder).catch(() => [])).sort();
  const records = [];
  for (const name of names) {
    if (name.endsWith(".delta.json.gz") || name.endsWith(".excalidraw.gz")) {
      const data = await readGz(path.join(folder, name));
      records.push({ entry: name.replace(/\.(delta\.json|excalidraw)\.gz$/, ""), record: data.xcld.record, version: data.xcld.version, parent: data.xcld.parent, depth: data.xcld.depth });
    }
  }
  return records;
};
const metasOf = async (dir, board) => {
  const folder = historyFolder(dir, board);
  const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith(".meta.json")).sort();
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(folder, name), "utf8"))));
};

test("delta codec: rebuilds the exact scene after edits, deletes, adds, z-order moves, duplicates and appState changes", () => {
  const parent = { type: "excalidraw", version: 2, source: "t", elements: [el("a"), el("b"), el("c"), el("d"), el("e")], appState: { gridSize: null }, files: {} };
  const next = {
    type: "excalidraw",
    version: 2,
    source: "t",
    elements: [el("a"), el("c", { x: 9 }), el("d"), el("new"), el("e"), el("b"), el("dup"), el("dup", { y: 3 })],
    appState: { gridSize: 20 },
    files: {},
  };
  const delta = encodeDelta(parent, next);
  assert.deepEqual(delta.added.sort(), ["dup", "dup", "new"]);
  assert.deepEqual(delta.modified, ["c"]);
  assert.deepEqual(delta.deleted, []);
  const rebuilt = applyDelta(parent, JSON.parse(JSON.stringify(delta)));
  assert.equal(canonical(rebuilt), canonical(next));
  const removed = { ...next, elements: next.elements.filter((element) => element.id !== "d"), appState: next.appState };
  const second = encodeDelta(next, removed);
  assert.deepEqual(second.deleted, ["d"]);
  assert.equal("appState" in second, false, "an unchanged appState is not stored again");
  assert.equal(canonical(applyDelta(next, second)), canonical(removed));
  assert.ok(sameJson({ a: 1, b: [1, { c: 2 }] }, { a: 1, b: [1, { c: 2 }] }));
  assert.equal(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 }), false, "key order matters: it changes the bytes");
});

// The property test: random sessions through the store (human autosaves that coalesce, agents
// from stale bases on the same units, deletes, images, Ctrl+S, idle closes, pins, restarts).
// Afterwards a fresh store (nothing in memory) rebuilds every version history keeps, byte for
// byte; no delta chain is longer than checkpointEvery - 1; and a losing (overwritten) unit never
// reappears in master unless a writer sent that content again.
const SEEDS = Number(process.env.XCLD_HISTORY_SEEDS) || 6;
let loserCount = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  test(`history v2 property: seed ${seed} rebuilds every version, chains stay short, losers never come back`, async () => {
    const rng = mulberry32(seed * 7919);
    const int = (max) => Math.floor(rng() * max);
    const checkpointEvery = 2 + (seed % 4);
    await withDir(async (dir) => {
      let clock = 1_000_000;
      const options = { boardsDir: dir, now: () => clock, idleMs: 60_000, checkpointEvery };
      let store = createVersionStore(options);
      const board = "prop/b";
      const image = (n) => ({ mimeType: "image/png", id: `img${n}`, dataURL: `data:image/png;base64,${String(n).repeat(200)}`, created: n });
      let master = { elements: [el("u0"), el("u1"), el("u1-t", { type: "text", containerId: "u1", text: "one" }), el("u2")], files: {} };
      const first = await store.submitBranch(board, { author: AGENTS[0], base: null, writtenAt: clock, elements: master.elements });
      let current = first.version;
      const committed = new Map([[current, canonical(first.scene)]]);
      const seen = [];
      // Every element content any writer sent, by id: a loser may only come back through these.
      const sent = new Map();
      const noteSent = (elements, at) => {
        for (const element of elements) {
          const list = sent.get(element.id) ?? [];
          list.push({ json: JSON.stringify(element), at });
          sent.set(element.id, list);
        }
      };
      const versionsInOrder = [current];
      const losers = [];
      let nextId = 3;
      const mutate = (elements, files) => {
        let out = elements.map((element) => ({ ...element }));
        const nextFiles = { ...files };
        const ops = 1 + int(3);
        for (let n = 0; n < ops; n++) {
          const roll = rng();
          if (roll < 0.45 && out.length) {
            const index = int(out.length);
            out[index] = { ...out[index], x: out[index].x + 1 + int(50), version: out[index].version + 1 };
          } else if (roll < 0.65) {
            out.push(el(`u${nextId++}`, { x: int(500) }));
          } else if (roll < 0.8 && out.length > 2) {
            out.splice(int(out.length), 1);
          } else if (roll < 0.9) {
            const n2 = int(3);
            nextFiles[`img${n2}`] = image(n2);
            out.push(el(`p${nextId++}`, { type: "image", fileId: `img${n2}` }));
          } else if (out.length > 1) {
            const [moved] = out.splice(int(out.length), 1);
            out.push(moved);
          }
        }
        return { elements: out, files: nextFiles };
      };
      let commits = 0;
      for (let step = 0; step < 45; step++) {
        clock += 1000 + int(4000);
        const roll = rng();
        if (roll < 0.06) {
          await store.checkpoint(board, rng() < 0.5 ? { pin: `pin-${step}` } : {});
          continue;
        }
        if (roll < 0.1) {
          clock += 61_000;
          await store.close();
          store = createVersionStore(options);
          continue;
        }
        const author = roll < 0.55 ? (rng() < 0.85 ? HUMAN : HUMAN2) : AGENTS[int(AGENTS.length)];
        // Stale bases half the time: agents work from what they read a few commits ago.
        const base = rng() < 0.5 && versionsInOrder.length > 1 ? versionsInOrder[Math.max(0, versionsInOrder.length - 1 - int(3))] : current;
        if (base !== current) {
          // A writer that read `base` through the server keeps it resolvable (a served ETag).
          await store.readVersion(board, base).catch(() => null);
        }
        const from = base === current ? master : (await store.readVersion(board, base))?.scene;
        if (!from) {
          continue;
        }
        const next = mutate(from.elements, from.files ?? {});
        noteSent(next.elements, commits + 1);
        const result = await store.submitBranch(board, { author, base, writtenAt: clock - int(3000), elements: next.elements, files: next.files, appState: { viewBackgroundColor: "#fff" } });
        if (result.status !== "committed") {
          assert.ok(["unchanged", "unknown-base"].includes(result.status), result.status);
          continue;
        }
        const masterBefore = master;
        commits += 1;
        current = result.version;
        master = result.scene;
        const text = canonical(result.scene);
        assert.equal(contentHash(text), current, "a commit's version is the hash of its canonical text");
        committed.set(current, text);
        versionsInOrder.push(current);
        seen.push({ version: current, scene: result.scene, at: commits });
        for (const lost of result.overwritten) {
          losers.push({ ...lost, at: commits, winnerInput: lost.winner.side === "branch" ? next.elements : masterBefore.elements });
        }
      }
      await store.whenIdle();
      await store.close();

      const fresh = createVersionStore({ ...options, idleMs: 10 ** 9 });
      try {
        // Every version in a history entry (closed or open) rebuilds byte for byte.
        const metas = await metasOf(dir, board);
        const state = await fresh.readState(board);
        const kept = new Set([...metas.map((meta) => meta.version), state.version, ...(state.open ? [state.open.version] : [])]);
        assert.ok(kept.size >= 2);
        for (const version of kept) {
          const read = await fresh.readVersion(board, version);
          assert.ok(read, `version ${version} rebuilds`);
          assert.equal(read.text, committed.get(version), `version ${version} is byte-identical`);
          assert.equal(contentHash(read.text), version);
        }
        // Chains: a delta's depth is below checkpointEvery and its parent is the entry before.
        const records = await recordsOf(dir, board);
        const byVersion = new Map(records.map((record) => [record.version, record]));
        for (const record of records) {
          let hops = 0;
          for (let cursor = record; cursor.record === "delta"; cursor = byVersion.get(cursor.parent)) {
            hops += 1;
            assert.ok(byVersion.has(cursor.parent), `the parent of ${cursor.entry} is in history`);
          }
          assert.ok(hops <= checkpointEvery - 1, `${record.entry}: ${hops} deltas to a checkpoint (limit ${checkpointEvery - 1})`);
          assert.equal(hops, record.record === "delta" ? record.depth : 0);
        }
        assert.ok(records.some((record) => record.record === "delta"), "deltas were written");
        // Losers stay in history only: an overwritten element's losing content never reappears
        // in a later master unless some writer sent that exact content again afterwards.
        for (const lost of losers) {
          for (const loserElement of lost.loser.elements) {
            // Not lost: the winning side had this element exactly as the loser did.
            const winnerCopy = lost.winnerInput.find((element) => element.id === loserElement.id);
            if (winnerCopy && sameContent(winnerCopy, loserElement)) {
              continue;
            }
            for (const later of seen.filter((item) => item.at >= lost.at)) {
              const inMaster = later.scene.elements.find((element) => element.id === loserElement.id);
              if (inMaster && sameContent(inMaster, loserElement)) {
                const resent = (sent.get(loserElement.id) ?? []).some((item) => sameContent(JSON.parse(item.json), loserElement) && item.at > lost.at && item.at <= later.at);
                assert.ok(resent, `loser ${loserElement.id} (commit ${lost.at}) came back in commit ${later.at} without being sent again`);
              }
            }
          }
        }
        loserCount += losers.length;
        if (process.env.XCLD_HISTORY_DEBUG) {
          const kinds = records.reduce((counts, record) => ({ ...counts, [record.record]: (counts[record.record] ?? 0) + 1 }), {});
          console.log(`seed ${seed}: every ${checkpointEvery}, ${commits} commits, ${kept.size} kept versions, records ${JSON.stringify(kinds)}, coalesced ${metas.filter((meta) => meta.coalescedCount > 1).length}, pinned ${metas.filter((meta) => meta.pinned).length}, losers ${losers.length}, images ${(await readdir(path.join(dir, ".xcld", "files", "prop", "b")).catch(() => [])).length}`);
        }
      } finally {
        await fresh.close();
      }
    });
  });
}

test("the property sessions produced overwritten (losing) units", () => {
  assert.ok(loserCount > 0, "no session had a conflict; the loser check proved nothing");
});

const runCli = (args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, ["tools/cli.mjs", ...args], { cwd: path.resolve("."), env: { ...process.env, XCLD_HISTORY: "", XCLD_CACHE_DIR: "", XCLD_CACHE_HOST_DIR: "", XCLD_HISTORY_VOLUME_DIR: "", ...env } }, (error, stdout, stderr) => {
    resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
  });
});

test("default cadence: a checkpoint every 20 entries, at most 19 deltas in between", async () => {
  await withDir(async (dir) => {
    const store = createVersionStore({ boardsDir: dir });
    try {
      let version = null;
      for (let n = 0; n < 45; n++) {
        const result = await store.submitBranch("cadence", { author: AGENTS[n % 2], base: version, elements: [el("a", { x: n }), el(`b${n}`)] });
        assert.equal(result.status, "committed");
        version = result.version;
      }
      await store.whenIdle();
    } finally {
      await store.close();
    }
    const records = await recordsOf(dir, "cadence");
    assert.equal(records.length, 45);
    assert.deepEqual(records.map((record, index) => [index, record.record]).filter(([, kind]) => kind === "checkpoint").map(([index]) => index), [0, 20, 40]);
    assert.equal(Math.max(...records.map((record) => record.depth)), 19);
  });
});

test("losers stay in history only: kept (also when nothing else changed), never re-applied, never a version of their own (decision 2)", async () => {
  await withDir(async (dir) => {
    let clock = 100_000;
    const options = { boardsDir: dir, now: () => clock, idleMs: 60_000 };
    let store = createVersionStore(options);
    const v1 = await store.submitBranch("l/b", { author: AGENTS[0], base: null, writtenAt: clock, elements: [el("u", { strokeColor: "#000000" }), el("v")] });
    // An agent recolors u (written at +20). A tab save from v1, written earlier (+10) but merged
    // later, recolors u too and loses it: master doesn't change at all.
    const agent = await store.submitBranch("l/b", { author: AGENTS[1], base: v1.version, writtenAt: clock + 20, elements: [el("u", { strokeColor: "#2f9e44" }), el("v")] });
    const tab = await store.submitBranch("l/b", { author: HUMAN, base: v1.version, writtenAt: clock + 10, elements: [el("u", { strokeColor: "#e03131" }), el("v")] });
    assert.equal(tab.status, "unchanged");
    assert.deepEqual(tab.overwritten.map((item) => [item.unitId, item.loser.side, item.loser.author, item.loser.elements[0].strokeColor]), [["u", "branch", HUMAN, "#e03131"]]);
    // The same tab, stale again: loses u, but its edit of v lands (a commit with a loser).
    clock += 1000;
    const mixed = await store.submitBranch("l/b", { author: HUMAN, base: v1.version, writtenAt: clock - 990, elements: [el("u", { strokeColor: "#1971c2" }), el("v", { x: 7 })] });
    assert.equal(mixed.status, "committed");
    assert.deepEqual(mixed.overwritten.map((item) => item.loser.elements[0].strokeColor), ["#1971c2"]);
    const loserBoards = [tab, mixed].map((result) => ({ ...result.scene, elements: result.scene.elements.map((element) => (element.id === "u" ? result.overwritten[0].loser.elements[0] : element)) }));
    // Then: other writers, a pin, an idle close and a restart.
    clock += 1000;
    const more = await store.submitBranch("l/b", { author: AGENTS[2], base: mixed.version, writtenAt: clock, elements: [...mixed.scene.elements, el("w")] });
    await store.checkpoint("l/b", { pin: "review" });
    clock += 61_000;
    await store.whenIdle();
    await store.close();
    store = createVersionStore(options);
    try {
      const state = await store.readState("l/b");
      assert.equal(state.version, more.version);
      const master = (await store.readVersion("l/b", state.version)).scene;
      assert.equal(master.elements.find((element) => element.id === "u").strokeColor, "#2f9e44", "the winner stays");
      assert.equal(master.elements.find((element) => element.id === "v").x, 7, "the stale tab's other edit landed");
      // No version id leads to a board with a loser's content: none was ever master.
      for (const scene of loserBoards) {
        assert.equal(await store.readVersion("l/b", contentHash(canonical(scene))), null);
      }
      // Both losers are in history metas (for diff and the banner), and in no record.
      const metas = await metasOf(dir, "l/b");
      const kept = metas.flatMap((meta) => (meta.overwritten ?? []).map((item) => [meta.author, meta.record, item.loser.elements[0].strokeColor]));
      assert.deepEqual(kept, [[HUMAN, "none", "#e03131"], [HUMAN, "delta", "#1971c2"]]);
      assert.equal(metas.find((meta) => meta.record === "none").version, agent.version, "a meta-only entry names the version it lost against");
      const fullDir = path.join(dir, "export-full");
      const exported = await exportHistory({ stateDir: path.join(dir, ".xcld"), board: "l/b", to: fullDir, full: true });
      assert.equal(exported.none, 1);
      for (const name of (await readdir(fullDir)).filter((item) => item.endsWith(".excalidraw"))) {
        const scene = JSON.parse(await readFile(path.join(fullDir, name), "utf8"));
        assert.ok(!["#e03131", "#1971c2"].includes(scene.elements.find((element) => element.id === "u").strokeColor), `${name} holds no loser content`);
      }
    } finally {
      await store.close();
    }
  });
});
test("a pinned version is a full checkpoint; later entries chain from it", async () => {
  await withDir(async (dir) => {
    const store = createVersionStore({ boardsDir: dir });
    try {
      const v1 = await store.submitBranch("pin", { author: AGENTS[0], base: null, elements: [el("a")] });
      const v2 = await store.submitBranch("pin", { author: AGENTS[1], base: v1.version, elements: [el("a"), el("b")] });
      assert.deepEqual((await recordsOf(dir, "pin")).map((record) => record.record), ["checkpoint", "delta"]);
      const pinned = await store.checkpoint("pin", { pin: "before review" });
      assert.equal(pinned.pinned.label, "before review");
      const records = await recordsOf(dir, "pin");
      assert.deepEqual(records.map((record) => record.record), ["checkpoint", "checkpoint"], "the delta became a checkpoint");
      assert.equal((await readdir(historyFolder(dir, "pin"))).filter((name) => name.endsWith(".delta.json.gz")).length, 0);
      const meta = (await metasOf(dir, "pin")).at(-1);
      assert.deepEqual([meta.version, meta.pinned, meta.record, meta.depth], [v2.version, "before review", "checkpoint", 0]);
      const v3 = await store.submitBranch("pin", { author: AGENTS[0], base: v2.version, elements: [el("a"), el("b"), el("c")] });
      const last = (await recordsOf(dir, "pin")).at(-1);
      assert.deepEqual([last.record, last.depth, last.parent], ["delta", 1, v2.version]);
      await store.whenIdle();
      const fresh = createVersionStore({ boardsDir: dir });
      try {
        for (const result of [v1, v2, v3]) {
          assert.equal((await fresh.readVersion("pin", result.version)).text, canonical(result.scene));
        }
      } finally {
        await fresh.close();
      }
    } finally {
      await store.close();
    }
  });
});

test("slice 2/3 full entries stay valid as checkpoints; an open pre-v2 entry becomes a checkpoint, then deltas follow", async () => {
  await withDir(async (dir) => {
    const legacy = (elements) => `${JSON.stringify({ type: "excalidraw", version: 2, source: "xcld-collab", elements, appState: {}, files: {} }, null, 2)}\n`;
    const textA = legacy([el("a")]);
    const textB = legacy([el("a"), el("b")]);
    const [vA, vB] = [contentHash(textA), contentHash(textB)];
    const folder = historyFolder(dir, "old");
    await mkdir(folder, { recursive: true });
    // Slice 3 layout: a closed agent entry and an open human entry, full records, no `depth`.
    const record = (text, version) => `${text.slice(0, -3)},\n  "xcld": ${JSON.stringify({ schema: 2, version, files: [] })}\n}\n`;
    await writeFile(path.join(folder, "20261006T000001.000Z-agent_x_1.excalidraw"), record(textA, vA));
    await writeFile(path.join(folder, "20261006T000001.000Z-agent_x_1.meta.json"), JSON.stringify({ version: vA, author: "agent:x#1", closedBy: "agent-write" }));
    await writeFile(path.join(folder, "20261006T000002.000Z-human_Ada_Lovelace_tab1.excalidraw"), record(textB, vB));
    await writeFile(path.join(dir, "old.excalidraw"), textB);
    await mkdir(path.join(dir, ".xcld", "state"), { recursive: true });
    const open = { entry: "20261006T000002.000Z-human_Ada_Lovelace_tab1", version: vB, author: HUMAN, displayName: "Ada Lovelace", base: vA, parents: [vA], applied: [], overwritten: [], coalescedCount: 1, openedAt: Date.now(), lastCommitAt: Date.now(), lastBranchId: "x", kind: "json" };
    await writeFile(path.join(dir, ".xcld", "state", "old.json"), JSON.stringify({ schema: 1, board: "old", version: vB, masterMeta: {}, last: { branchId: "x", author: HUMAN, entry: open.entry, previous: vA }, open, mermaid: null, lastEntryAt: Date.now(), records: 2 }));
    const store = createVersionStore({ boardsDir: dir });
    try {
      assert.equal((await store.readVersion("old", vA)).text, textA, "a pre-v2 entry reads as before");
      const coalesced = await store.submitBranch("old", { author: HUMAN, base: vB, elements: [el("a"), el("b", { x: 1 })] });
      assert.equal(coalesced.status, "committed");
      await store.whenIdle();
      const names = await readdir(folder);
      assert.ok(names.includes(`${open.entry}.excalidraw.gz`), "the open entry was rewritten as a v2 checkpoint");
      assert.ok(!names.includes(`${open.entry}.excalidraw`), "its pre-v2 file is gone");
      const agent = await store.submitBranch("old", { author: AGENTS[0], base: coalesced.version, elements: [el("a"), el("b", { x: 1 }), el("c")] });
      const last = (await recordsOf(dir, "old")).at(-1);
      assert.deepEqual([last.record, last.depth, last.parent], ["delta", 1, coalesced.version]);
      await store.whenIdle();
      const fresh = createVersionStore({ boardsDir: dir });
      try {
        for (const [version, text] of [[vA, textA], [coalesced.version, canonical(coalesced.scene)], [agent.version, canonical(agent.scene)]]) {
          assert.equal((await fresh.readVersion("old", version)).text, text);
        }
      } finally {
        await fresh.close();
      }
    } finally {
      await store.close();
    }
  });
});

test("history size: 60 small turns on a 300-element board stay a few percent of full copies", async () => {
  await withDir(async (dir) => {
    const rng = mulberry32(5);
    const store = createVersionStore({ boardsDir: dir });
    try {
      let elements = Array.from({ length: 300 }, (_, n) => el(`e${n}-${Math.floor(rng() * 1e9)}`, { x: n * 3, seed: Math.floor(rng() * 2 ** 31), versionNonce: Math.floor(rng() * 2 ** 31) }));
      let version = null;
      let fullBytes = 0;
      for (let turn = 0; turn < 60; turn++) {
        elements = elements.map((element, index) => (index % 60 === turn % 60 ? { ...element, x: element.x + 1, version: element.version + 1, versionNonce: Math.floor(rng() * 2 ** 31) } : element));
        const result = await store.submitBranch("size", { author: turn % 2 ? HUMAN : AGENTS[0], base: version, elements });
        version = result.version;
        fullBytes += canonical(result.scene).length;
      }
      await store.whenIdle();
      let historyBytes = 0;
      for (const name of await readdir(historyFolder(dir, "size"))) {
        historyBytes += (await stat(path.join(historyFolder(dir, "size"), name))).size;
      }
      assert.ok(historyBytes < 0.05 * fullBytes, `history ${historyBytes} bytes vs ${fullBytes} for full copies`);
    } finally {
      await store.close();
    }
  });
});

test("a served version's base copy is dropped once its entry closes (history resolves it)", async () => {
  await withDir(async (dir) => {
    const store = createVersionStore({ boardsDir: dir });
    try {
      const v1 = await store.submitBranch("bc", { author: AGENTS[0], base: null, elements: [el("a")] });
      const h = await store.submitBranch("bc", { author: HUMAN, base: v1.version, elements: [el("a"), el("b")] });
      const read = await store.readMaster("bc");
      assert.equal(read.version, h.version);
      const copy = path.join(dir, ".xcld", "bases", "bc", `${h.version}.excalidraw`);
      assert.ok((await stat(copy)).isFile(), "the open entry's served version is copied to the base store");
      await store.submitBranch("bc", { author: AGENTS[1], base: h.version, elements: [el("a"), el("b"), el("c")] });
      await store.whenIdle();
      await assert.rejects(stat(copy), /ENOENT/);
      assert.ok(await store.readVersion("bc", h.version), "still resolvable, from history");
    } finally {
      await store.close();
    }
  });
});

test("xcld history export: checkpoints and deltas as stored, or every version in full; never into the state dir", async () => {
  await withDir(async (dir) => {
    const store = createVersionStore({ boardsDir: dir });
    const image = { mimeType: "image/png", id: "img1", dataURL: "data:image/png;base64,AAAA", created: 1 };
    let results = [];
    try {
      let version = null;
      for (let n = 0; n < 5; n++) {
        const result = await store.submitBranch("ex/board", { author: n === 4 ? HUMAN : AGENTS[n % 2], base: version, elements: [el("photo", { type: "image", fileId: "img1" }), el(`n${n}`)], files: { img1: image } });
        version = result.version;
        results.push(result);
      }
      await store.whenIdle();
    } finally {
      await store.close();
    }
    const cacheDir = path.join(dir, "home-excalidraw");
    const raw = await runCli(["history", "export", "ex/board", "--json"], { XCLD_BOARDS_DIR: dir, XCLD_CACHE_DIR: cacheDir, XCLD_CACHE_HOST_DIR: "~/.excalidraw" });
    assert.equal(raw.code, 0, raw.stderr);
    const summary = JSON.parse(raw.stdout);
    assert.deepEqual([summary.entries, summary.checkpoint, summary.delta, summary.mode], [5, 1, 4, "raw"]);
    assert.equal(summary.to, path.join(cacheDir, "exports", "ex", "board"), "default destination: <cache>/exports/<board>");
    assert.equal(summary.hostPath, "~/.excalidraw/exports/ex/board", "named as the host sees it");
    const index = JSON.parse(await readFile(path.join(summary.to, "index.json"), "utf8"));
    assert.deepEqual(index.entries.map((item) => item.record), ["checkpoint", "delta", "delta", "delta", "delta"]);
    assert.equal(index.entries.at(-1).closedBy, null, "the open human entry is included");
    const delta = JSON.parse(await readFile(path.join(summary.to, index.entries[1].file), "utf8"));
    assert.deepEqual([delta.added, delta.deleted], [["n1"], ["n0"]]);
    assert.equal((await readdir(path.join(summary.to, "files"))).length, 1, "the image, once");

    const fullDir = path.join(dir, "full");
    const full = await runCli(["history", "export", "ex/board", "--to", fullDir, "--full"], { XCLD_BOARDS_DIR: dir, XCLD_CACHE_HOST_DIR: "~/.excalidraw" });
    assert.equal(full.code, 0, full.stderr);
    assert.match(full.stdout, /Exported 5 history entries of ex\/board \(5 full versions\)/);
    const files = (await readdir(fullDir)).filter((name) => name.endsWith(".excalidraw")).sort();
    assert.equal(files.length, 5);
    for (const [position, name] of files.entries()) {
      const text = await readFile(path.join(fullDir, name), "utf8");
      assert.equal(contentHash(text), results[position].version, `${name} is that version, byte for byte`);
      assert.equal(JSON.parse(text).files.img1.dataURL, image.dataURL);
    }

    const refused = await runCli(["history", "export", "ex/board", "--to", path.join(dir, ".xcld", "history", "copy")], { XCLD_BOARDS_DIR: dir });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /refusing to export into the versions state dir/);
    await assert.rejects(checkExportDestination(path.join(dir, ".xcld", "state"), path.join(dir, ".xcld")), /refusing/);
    await assert.rejects(checkExportDestination(path.join(dir, ".xcld", "sandbox", "x"), path.join(dir, ".xcld")), /refusing/, "anywhere in the history folder");
    // The same folder reached through another path (a symlink, or a second mount of it).
    const alias = path.join(dir, "alias-of-state");
    await symlink(path.join(dir, ".xcld"), alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(checkExportDestination(path.join(alias, "history", "x"), path.join(dir, ".xcld")), /the same folder as/);
    await assert.rejects(checkExportDestination(alias, path.join(dir, ".xcld")), /the same folder as/);
    await checkExportDestination(path.join(dir, "exports", "x"), path.join(dir, ".xcld"));
    const missing = await runCli(["history", "export", "nope"], { XCLD_BOARDS_DIR: dir, XCLD_CACHE_DIR: cacheDir });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no history for board nope/);
  });
});

test("xcld history export with XCLD_HISTORY=cache (the Linux layout): reads <cache>/history, writes <cache>/exports, never into history", async () => {
  await withDir(async (dir) => {
    const cacheDir = path.join(dir, "cache");
    const store = createVersionStore({ boardsDir: path.join(dir, "boards"), stateDir: path.join(cacheDir, "history") });
    try {
      await store.submitBranch("sandbox/demo", { author: AGENTS[0], base: null, elements: [el("a")] });
      await store.whenIdle();
    } finally {
      await store.close();
    }
    const env = { XCLD_BOARDS_DIR: path.join(dir, "boards"), XCLD_HISTORY: "cache", XCLD_CACHE_DIR: cacheDir };
    const result = await runCli(["history", "export", "sandbox/demo", "--json"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).to, path.join(cacheDir, "exports", "sandbox", "demo"));
    const into = await runCli(["history", "export", "sandbox/demo", "--to", path.join(cacheDir, "history", "copy")], env);
    assert.equal(into.code, 1);
    assert.match(into.stderr, /refusing to export into the versions state dir/);
    const volume = await runCli(["history", "export", "sandbox/demo"], { ...env, XCLD_HISTORY: "volume" });
    assert.equal(volume.code, 1);
    assert.match(volume.stderr, /only the container sees/, "the volume is not reachable from the host");
  });
});

test("a write whose every change lost is still announced (SSE merged event) with its losers", async () => {
  await withDir(async (dir) => {
    const events = [];
    const store = createVersionStore({ boardsDir: dir, onCommitted: (event) => events.push(event) });
    try {
      const v1 = await store.submitBranch("sse", { author: AGENTS[0], base: null, writtenAt: 1000, elements: [el("u")] });
      await store.submitBranch("sse", { author: AGENTS[1], base: v1.version, writtenAt: 3000, elements: [el("u", { x: 3 })] });
      const lost = await store.submitBranch("sse", { author: HUMAN, base: v1.version, writtenAt: 2000, elements: [el("u", { x: 2 })] });
      assert.equal(lost.status, "unchanged");
      await lost.post;
      const last = events.at(-1);
      assert.deepEqual([last.author, last.masterChanged, last.overwritten.map((item) => item.unitId)], [HUMAN, false, ["u"]]);
    } finally {
      await store.close();
    }
  });
});
