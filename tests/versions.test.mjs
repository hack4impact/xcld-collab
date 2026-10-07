import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { createBoardApi } from "../app/server/api.mjs";
import { authorKeySafe, contentHash, createVersionStore, parseAuthorKey } from "../app/server/versions.mjs";

const HUMAN = "human:Ada Lovelace#tab1";
const HUMAN2 = "human:Ada Lovelace#tab2";
const AGENT = "agent:copilot-cli#4242";
const AGENT2 = "agent:copilot-cli#5151";
const CLI = "cli:docs-bot";

const el = (id, extra = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 100, height: 60, strokeColor: "#1e1e1e", version: 1, versionNonce: 1, ...extra });
const sceneText = (elements) => `${JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements, appState: {}, files: {} })}\n`;
const find = (scene, id) => scene.elements.find((element) => element.id === id);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withDir = async (fn) => {
  const dir = path.resolve(".test-run", `versions-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
};

const withStore = (options, fn) => withDir(async (dir) => {
  const store = createVersionStore({ boardsDir: dir, ...options });
  try {
    return await fn(store, dir);
  } finally {
    await store.close();
  }
});

const masterOf = async (dir, board) => JSON.parse(await readFile(path.join(dir, ...`${board}.excalidraw`.split("/")), "utf8"));
const historyOf = async (dir, board) => {
  const folder = path.join(dir, ".xcld", "history", ...board.split("/"));
  const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith(".meta.json")).sort();
  return Promise.all(names.map(async (name) => ({ entry: name.slice(0, -".meta.json".length), ...JSON.parse(await readFile(path.join(folder, name), "utf8")) })));
};
const branchesOf = async (dir, board) => (await readdir(path.join(dir, ".xcld", "branches", ...board.split("/"))).catch(() => [])).filter((name) => name.endsWith(".json"));

test("author keys: the four forms, nothing else", () => {
  assert.deepEqual(parseAuthorKey(HUMAN), { kind: "human", name: "Ada Lovelace" });
  assert.deepEqual(parseAuthorKey("human:A#B#tab-1"), { kind: "human", name: "A#B" });
  assert.deepEqual(parseAuthorKey(AGENT), { kind: "agent", name: "copilot-cli" });
  assert.deepEqual(parseAuthorKey(CLI), { kind: "cli", name: "docs-bot" });
  assert.deepEqual(parseAuthorKey("external"), { kind: "external", name: "external" });
  for (const bad of ["human:Ada", "human:#tab", "agent:x#", "bot:x", "external:x", "", null, "cli:a\nb"]) {
    assert.equal(parseAuthorKey(bad), null, String(bad));
  }
  assert.equal(authorKeySafe(HUMAN), "human_Ada_Lovelace_tab1");
});

test("a commit writes history, then state with masterMeta, then master, and archives the branch", async () => {
  await withStore({ now: () => 5000 }, async (store, dir) => {
    const result = await store.submitBranch("p/demo", { author: HUMAN, base: null, writtenAt: 4000, elements: [el("a"), el("b")] });
    assert.equal(result.status, "committed");
    const master = await readFile(path.join(dir, "p", "demo.excalidraw"), "utf8");
    assert.equal(result.version, contentHash(master), "the version id is the sha256 of master's bytes (the ETag)");
    assert.deepEqual(JSON.parse(master).elements.map((element) => element.id), ["a", "b"]);
    const state = await store.readState("p/demo");
    assert.equal(state.version, result.version);
    assert.deepEqual(state.masterMeta, { a: { writtenAt: 4000, author: HUMAN }, b: { writtenAt: 4000, author: HUMAN } });
    const [entry] = await historyOf(dir, "p/demo");
    assert.equal(entry.version, result.version);
    assert.equal(entry.author, HUMAN);
    assert.equal(entry.displayName, "Ada Lovelace");
    assert.deepEqual(entry.parents, []);
    assert.equal(entry.coalescedCount, 1);
    assert.equal(entry.closedBy, null, "a human entry stays open for coalescing");
    assert.equal(await readFile(path.join(dir, ".xcld", "history", "p", "demo", `${entry.entry}.excalidraw`), "utf8"), master);
    assert.deepEqual(await branchesOf(dir, "p/demo"), []);
    assert.equal((await store.readVersion("p/demo", result.version)).scene.elements.length, 2);
  });
});

test("invalid writes are rejected before the journal", async () => {
  await withStore({}, async (store, dir) => {
    assert.equal((await store.submitBranch("b", { author: "bot", base: null, elements: [] })).status, "invalid");
    assert.equal((await store.submitBranch("b", { author: HUMAN, base: null, elements: [{ type: "rectangle" }] })).status, "invalid");
    assert.deepEqual(await branchesOf(dir, "b"), []);
    await assert.rejects(store.submitBranch("../escape", { author: HUMAN, base: null, elements: [] }), /invalid-board/);
  });
});

test("masterMeta feeds the merge: a queued older write loses a unit to a newer one (D8 through the pipeline)", async () => {
  await withStore({}, async (store) => {
    const v1 = await store.submitBranch("d8", { author: HUMAN, base: null, writtenAt: 1000, elements: [el("a"), el("b")] });
    const v2 = await store.submitBranch("d8", { author: AGENT, base: v1.version, writtenAt: 3000, elements: [el("a", { x: 30 }), el("b")] });
    // Written at 2000 against v1, merged after v2.
    const stale = await store.submitBranch("d8", { author: CLI, base: v1.version, writtenAt: 2000, elements: [el("a", { x: 20 }), el("b", { x: 20 })] });
    assert.equal(stale.status, "committed");
    const master = (await store.readVersion("d8", stale.version)).scene;
    assert.equal(find(master, "a").x, 30, "the newer agent edit keeps the unit");
    assert.equal(find(master, "b").x, 20, "the stale write's disjoint edit still applies");
    assert.deepEqual(stale.overwritten.map((entry) => [entry.unitId, entry.winner.author, entry.loser.author]), [["a", AGENT, CLI]]);
    const state = await store.readState("d8");
    assert.deepEqual(state.masterMeta.a, { writtenAt: 3000, author: AGENT });
    assert.deepEqual(state.masterMeta.b, { writtenAt: 2000, author: CLI });
    assert.equal(v2.status, "committed");
  });
});

test("one board: concurrent submits commit one at a time, in submit order", async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const onStep = async (step, { branch }) => {
    if (step === "commit-start") {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(branch.author);
      await delay(5);
    }
    if (step === "before-archive") {
      active -= 1;
    }
  };
  await withStore({ testHooks: { onStep } }, async (store) => {
    const seed = await store.submitBranch("q", { author: HUMAN, base: null, elements: [0, 1, 2, 3, 4].map((n) => el(`e${n}`)) });
    order.length = 0;
    const authors = [0, 1, 2, 3, 4].map((n) => `agent:bot#p${n}`);
    const results = await Promise.all(authors.map((author, n) => store.submitBranch("q", {
      author,
      base: seed.version,
      writtenAt: 2000 + n,
      elements: [0, 1, 2, 3, 4].map((m) => el(`e${m}`, m === n ? { x: 100 + n } : {})),
    })));
    assert.deepEqual(order, authors);
    assert.equal(maxActive, 1);
    assert.ok(results.every((result) => result.status === "committed"));
    const master = (await store.readVersion("q", results.at(-1).version)).scene;
    assert.deepEqual(master.elements.map((element) => element.x), [100, 101, 102, 103, 104], "every disjoint edit lands");
  });
});

test("different boards commit in parallel", async () => {
  let releaseA;
  const aBlocked = new Promise((resolve) => {
    releaseA = resolve;
  });
  const onStep = async (step, { branch }) => {
    if (step === "commit-start" && branch.board === "a") {
      await aBlocked;
    }
  };
  await withStore({ testHooks: { onStep } }, async (store) => {
    const a = store.submitBranch("a", { author: HUMAN, base: null, elements: [el("x")] });
    const b = await Promise.race([store.submitBranch("b", { author: HUMAN, base: null, elements: [el("y")] }), delay(3000).then(() => "timeout")]);
    assert.equal(b.status, "committed", "board b committed while board a's commit was blocked");
    releaseA();
    assert.equal((await a).status, "committed");
  });
});

test("history coalesces a human's consecutive commits until another author, an agent merge, a checkpoint or idle", async () => {
  // A fake clock: idle only counts once the test moves it.
  let clock = 50_000;
  await withStore({ idleMs: 50, now: () => clock }, async (store, dir) => {
    let version = null;
    const commit = async (author, x) => {
      const result = await store.submitBranch("h", { author, base: version, elements: [el("a", { x }), el(`${authorKeySafe(author)}-${x}`)] });
      assert.equal(result.status, "committed");
      version = result.version;
      return result;
    };
    await commit(HUMAN, 1);
    await commit(HUMAN, 2);
    await commit(HUMAN, 3);
    let history = await historyOf(dir, "h");
    assert.equal(history.length, 1);
    assert.equal(history[0].coalescedCount, 3);
    assert.equal(history[0].closedBy, null);
    assert.deepEqual(history[0].applied.map((item) => [item.unitId, item.kind]), [["a", "added"], ["human_Ada_Lovelace_tab1-3", "added"]], "added then removed within the turn drops out");

    await commit(HUMAN2, 4);
    await commit(AGENT, 5);
    await commit(AGENT, 6);
    await commit(HUMAN, 7);
    const checkpoint = await store.checkpoint("h");
    assert.equal(checkpoint.closed, true);
    assert.equal((await store.checkpoint("h")).closed, false, "nothing open, nothing to close");
    await commit(HUMAN, 8);
    await delay(120);
    assert.equal((await store.readState("h")).open?.coalescedCount, 1, "still open: no idle time has passed");
    clock += 60;
    await delay(250);
    history = await historyOf(dir, "h");
    assert.deepEqual(history.map((entry) => [entry.author, entry.coalescedCount, entry.closedBy]), [
      [HUMAN, 3, "author"],
      [HUMAN2, 1, "agent-merge"],
      [AGENT, 1, "agent-write"],
      [AGENT, 1, "agent-write"],
      [HUMAN, 1, "checkpoint"],
      [HUMAN, 1, "idle"],
    ]);
    assert.deepEqual(history[1].parents, [history[0].version], "an entry's parent is the version it started from");
  });
});

test("an open entry idle past the limit is closed on the next start", async () => {
  await withDir(async (dir) => {
    let clock = 10_000;
    const first = createVersionStore({ boardsDir: dir, now: () => clock, idleMs: 1000 });
    await first.submitBranch("r", { author: HUMAN, base: null, elements: [el("a")] });
    await first.close();
    clock += 5000;
    const second = createVersionStore({ boardsDir: dir, now: () => clock, idleMs: 1000 });
    assert.equal((await second.readState("r")).open, null);
    assert.equal((await historyOf(dir, "r"))[0].closedBy, "idle");
    await second.close();
  });
});

test("bases stay resolvable under coalescing while served or referenced, and expire after the TTL", async () => {
  let clock = 1_000_000;
  await withStore({ now: () => clock, baseTtlMs: 60_000 }, async (store, dir) => {
    const v1 = await store.submitBranch("k", { author: HUMAN, base: null, elements: [el("a"), el("b")] });
    // An agent reads v1 (pinned), then the human keeps typing: v1 is folded out of history.
    const read = await store.readMaster("k");
    assert.equal(read.version, v1.version);
    const v2 = await store.submitBranch("k", { author: HUMAN, base: v1.version, elements: [el("a", { x: 5 }), el("b")] });
    assert.equal((await historyOf(dir, "k")).length, 1, "coalesced");
    assert.ok(await store.readVersion("k", v1.version), "the served version is still resolvable");
    const agent = await store.submitBranch("k", { author: AGENT, base: v1.version, elements: [el("a"), el("b", { x: 9 })] });
    assert.equal(agent.status, "committed");
    const merged = (await store.readVersion("k", agent.version)).scene;
    assert.deepEqual([find(merged, "a").x, find(merged, "b").x], [5, 9]);

    // Not served: the next fold drops the version, but a queued branch referencing it keeps it.
    const v3 = await store.submitBranch("k", { author: HUMAN, base: agent.version, elements: [el("a", { x: 6 }), el("b", { x: 9 })] });
    const fold = store.submitBranch("k", { author: HUMAN, base: v3.version, elements: [el("a", { x: 7 }), el("b", { x: 9 })] });
    const queued = store.submitBranch("k", { author: AGENT2, base: v3.version, elements: [el("a", { x: 6 }), el("b", { x: 9 }), el("c")] });
    assert.equal((await fold).status, "committed");
    assert.equal((await queued).status, "committed", "the referenced base survived the fold");
    const v5 = await store.submitBranch("k", { author: HUMAN, base: (await queued).version, elements: [el("a", { x: 8 }), el("b", { x: 9 }), el("c")] });
    const v6 = await store.submitBranch("k", { author: HUMAN, base: v5.version, elements: [el("a", { x: 9 }), el("b", { x: 9 }), el("c")] });
    assert.equal(await store.readVersion("k", v5.version), null, "a version nobody was handed out or references is folded away");
    assert.equal((await store.submitBranch("k", { author: AGENT, base: v5.version, elements: [el("z")] })).status, "unknown-base");

    // The served copy of v1 expires after the TTL (GC runs on load and every 10 minutes).
    clock += 11 * 60_000;
    await store.submitBranch("k", { author: AGENT, base: v6.version, elements: [el("a", { x: 9 }), el("b", { x: 9 }), el("c"), el("d")] });
    assert.equal(await store.readVersion("k", v1.version), null);
    assert.equal(v2.status, "committed");
  });
});

test("a direct write to master is adopted as an external branch and merges with queued writes", async () => {
  await withStore({}, async (store, dir) => {
    const v1 = await store.submitBranch("x", { author: HUMAN, base: null, elements: [el("a"), el("b")] });
    const file = path.join(dir, "x.excalidraw");
    const direct = sceneText([el("a", { strokeColor: "#e03131" }), el("b")]);
    await writeFile(file, direct, "utf8");
    const mtime = new Date(Date.now() - 1000);
    await utimes(file, mtime, mtime);
    const adopted = await store.adoptExternal("x");
    assert.equal(adopted.status, "committed");
    assert.equal(adopted.author, "external");
    assert.equal(adopted.version, contentHash(direct));
    assert.equal(await readFile(file, "utf8"), direct, "master is left as written");
    const state = await store.readState("x");
    assert.equal(state.masterMeta.a.author, "external");
    assert.equal(Math.round(state.masterMeta.a.writtenAt / 1000), Math.round(mtime.getTime() / 1000), "write time is the file's mtime");
    assert.equal(await store.adoptExternal("x"), null, "adopted once");

    // A tab that still holds v1 saves a disjoint edit: both survive.
    const tab = await store.submitBranch("x", { author: HUMAN, base: v1.version, elements: [el("a"), el("b", { x: 40 })] });
    const master = await masterOf(dir, "x");
    assert.deepEqual([find(master, "a").strokeColor, find(master, "b").x], ["#e03131", 40]);
    assert.equal(tab.status, "committed");
    const authors = (await historyOf(dir, "x")).map((entry) => entry.author);
    assert.deepEqual(authors, [HUMAN, "external", HUMAN]);
  });
});

test("a direct write landing during a commit is journaled and merged, not overwritten", async () => {
  let dir;
  const onStep = async (step, { branch }) => {
    if (step === "after-history" && branch.author === AGENT) {
      await writeFile(path.join(dir, "race.excalidraw"), sceneText([el("a"), el("b", { strokeColor: "#2f9e44" })]), "utf8");
    }
  };
  await withDir(async (folder) => {
    dir = folder;
    const store = createVersionStore({ boardsDir: dir, testHooks: { onStep } });
    try {
      const v1 = await store.submitBranch("race", { author: HUMAN, base: null, elements: [el("a"), el("b")] });
      await store.submitBranch("race", { author: AGENT, base: v1.version, elements: [el("a", { x: 50 }), el("b")] });
      await store.whenIdle();
      const master = await masterOf(dir, "race");
      assert.deepEqual([find(master, "a").x, find(master, "b").strokeColor], [50, "#2f9e44"]);
      assert.deepEqual((await historyOf(dir, "race")).map((entry) => entry.author), [HUMAN, AGENT, "external"]);
    } finally {
      await store.close();
    }
  });
});

test("the board watcher adopts a settled direct write and publishes a merged event", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "w.excalidraw"), sceneText([el("a")]), "utf8");
    const api = createBoardApi({ boardsDir: dir, pollMs: 50, useFsWatch: false });
    const server = createServer((req, res) => {
      void api.handle(req, res);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const chunks = [];
    const events = await fetch(`http://127.0.0.1:${port}/api/events`);
    const reader = events.body.getReader();
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        chunks.push(Buffer.from(value).toString("utf8"));
      }
    })().catch(() => {});
    try {
      await delay(300);
      await writeFile(path.join(dir, "w.excalidraw"), sceneText([el("a"), el("b")]), "utf8");
      const deadline = Date.now() + 4000;
      while (!chunks.join("").includes("event: merged") && Date.now() < deadline) {
        await delay(50);
      }
      const merged = chunks.join("").split("\n\n").find((block) => block.startsWith("event: merged"));
      assert.ok(merged, "merged event published");
      const data = JSON.parse(merged.split("\n").find((line) => line.startsWith("data: ")).slice(6));
      assert.equal(data.name, "w");
      assert.equal(data.author, "external");
      assert.equal((await api.versions.readState("w")).last.author, "external");
    } finally {
      await reader.cancel().catch(() => {});
      await api.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("PUT /api/board commits through the pipeline and keeps its 409 semantics", async () => {
  await withDir(async (dir) => {
    const api = createBoardApi({ boardsDir: dir, pollMs: 0, useFsWatch: false });
    const server = createServer((req, res) => {
      void api.handle(req, res);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/board/put`;
    try {
      const body = sceneText([el("a")]);
      const created = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body });
      assert.equal(created.status, 200);
      assert.equal(created.headers.get("etag"), `"${contentHash(body)}"`);
      const stale = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": '"0000"' }, body: sceneText([el("b")]) });
      assert.equal(stale.status, 409);
      const history = await historyOf(dir, "put");
      assert.deepEqual(history.map((entry) => [entry.author, entry.version]), [["human:anonymous#legacy", contentHash(body)]]);
      assert.deepEqual(await branchesOf(dir, "put"), [], "the rejected save left no branch behind");
    } finally {
      await api.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("Mermaid writes record their source, also when no element changed", async () => {
  await withStore({}, async (store) => {
    const v1 = await store.submitBranch("m", { author: AGENT, base: null, kind: "mermaid", elements: [el("A")], ops: [{ op: "add", id: "A" }], mermaid: { source: "flowchart TD\n  A", hash: "h1" } });
    assert.equal(v1.status, "committed");
    let record = await store.readMermaid("m");
    assert.deepEqual([record.source, record.hash, record.version, record.author], ["flowchart TD\n  A", "h1", v1.version, AGENT]);
    const same = await store.submitBranch("m", { author: AGENT, base: v1.version, kind: "mermaid", elements: null, mermaid: { source: "flowchart TD\n  A\n", hash: "h2" } });
    assert.equal(same.status, "unchanged");
    assert.equal(same.version, v1.version);
    record = await store.readMermaid("m");
    assert.deepEqual([record.hash, record.version], ["h2", v1.version]);
  });
});

// D2: a real process is killed (SIGKILL) at each step of a commit, then a new store replays
// the journal. Nothing is lost, nothing is applied twice.
const runChild = (dir, step, board, branch) => new Promise((resolve) => {
  execFile(process.execPath, [path.resolve("tests", "versions-crash-child.mjs"), dir, step, board, JSON.stringify(branch)], (error) => {
    resolve(error?.code ?? error?.signal ?? 0);
  });
});

for (const crashAt of ["after-ingest", "mid-history", "after-history", "after-master", "before-archive"]) {
  for (const coalesce of [false, true]) {
    test(`D2: killed ${crashAt}${coalesce ? " (coalescing commit)" : ""}, the restart replays it exactly once`, async () => {
      await withDir(async (dir) => {
        const setup = createVersionStore({ boardsDir: dir });
        const v1 = await setup.submitBranch("d2", { author: HUMAN, base: null, writtenAt: 1000, elements: [el("a"), el("b")] });
        await setup.close();
        const author = coalesce ? HUMAN : AGENT;
        const exit = await runChild(dir, crashAt, "d2", { author, base: v1.version, writtenAt: 2000, elements: [el("a", { x: 77 }), el("b")] });
        assert.notEqual(exit, 3, "the child reached the crash step");
        assert.notEqual(exit, 0);

        const store = createVersionStore({ boardsDir: dir });
        try {
          await store.whenIdle();
          const master = await masterOf(dir, "d2");
          assert.equal(find(master, "a").x, 77, "the write is in master");
          const state = await store.readState("d2");
          assert.equal(state.version, contentHash(await readFile(path.join(dir, "d2.excalidraw"), "utf8")));
          assert.deepEqual(state.masterMeta.a, { writtenAt: 2000, author });
          const history = await historyOf(dir, "d2");
          if (coalesce) {
            assert.deepEqual(history.map((entry) => [entry.author, entry.coalescedCount]), [[HUMAN, 2]], "folded once");
          } else {
            assert.deepEqual(history.map((entry) => entry.author), [HUMAN, AGENT], "one entry per commit, no duplicate");
          }
          assert.equal(history.at(-1).version, state.version);
          assert.deepEqual(await branchesOf(dir, "d2"), [], "the journal is empty");
          const leftovers = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith(".tmp"));
          assert.deepEqual(leftovers, []);
        } finally {
          await store.close();
        }
      });
    });
  }
}

test("D2: replay after a crash with several queued branches commits them oldest first", async () => {
  await withDir(async (dir) => {
    const setup = createVersionStore({ boardsDir: dir });
    const v1 = await setup.submitBranch("j", { author: HUMAN, base: null, writtenAt: 1000, elements: [el("a"), el("b")] });
    await setup.close();
    // Two journaled branches nobody committed (as if the server died with them queued).
    const journal = path.join(dir, ".xcld", "branches", "j");
    await mkdir(journal, { recursive: true });
    const branch = (id, author, writtenAt, elements) => ({ schema: 1, id, board: "j", author, displayName: author, base: v1.version, writtenAt, receivedAt: writtenAt, kind: "json", elements });
    for (const item of [branch("01NEWER0000000000000000", AGENT2, 3000, [el("a", { x: 3 }), el("b")]), branch("01OLDER0000000000000000", AGENT, 2000, [el("a", { x: 2 }), el("b", { x: 2 })])]) {
      await writeFile(path.join(journal, `${authorKeySafe(item.author)}.${item.id}.json`), JSON.stringify(item), "utf8");
    }
    const store = createVersionStore({ boardsDir: dir });
    try {
      await store.whenIdle();
      const history = await historyOf(dir, "j");
      assert.deepEqual(history.map((entry) => entry.author), [HUMAN, AGENT, AGENT2]);
      const master = await masterOf(dir, "j");
      assert.deepEqual([find(master, "a").x, find(master, "b").x], [3, 2]);
      assert.deepEqual(await branchesOf(dir, "j"), []);
      assert.ok((await stat(path.join(dir, "j.excalidraw"))).isFile());
    } finally {
      await store.close();
    }
  });
});
