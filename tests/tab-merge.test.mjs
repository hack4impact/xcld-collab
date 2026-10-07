import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { createBoardApi } from "../app/server/api.mjs";
import { identityHeaders } from "../app/src/identity.mjs";
import { keepEditsSinceSave, reapplyUnsavedEdits, serverCopies, wireElements } from "../app/src/tab-merge.mjs";

// Excalidraw-like elements: every edit bumps version and versionNonce.
const el = (id, version = 1, extra = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, version, versionNonce: version * 7 + id.length, isDeleted: false, ...extra });
const edit = (element, extra) => ({ ...element, ...extra, version: element.version + 1, versionNonce: element.versionNonce + 1 });
const byId = (elements) => new Map(elements.map((element) => [element.id, element]));
const ids = (elements) => elements.map((element) => element.id).sort();

test("after a merged save: no edits in flight means the tab shows master, keeping its own copy of what the merge left alone", () => {
  const sent = [el("a", 2, { x: 5 }), el("b")];
  const master = [el("a", 2, { x: 5 }), el("b", 3, { x: 40 }), el("c")];
  const result = keepEditsSinceSave({ sent, master, local: structuredClone(sent) });
  assert.deepEqual(ids(result.elements), ["a", "b", "c"]);
  const shown = byId(result.elements);
  assert.equal(shown.get("a"), sent[0], "a is as sent: the tab's copy");
  assert.equal(shown.get("b"), master[1], "b changed in the merge: master's");
  assert.equal(shown.get("c"), master[2]);
  assert.deepEqual(result.dropped, []);
});

test("defaults filled in by Excalidraw's restore are never this tab's edits", () => {
  // An agent wrote minimal JSON; the canvas shows it restored (seed, colors...).
  const raw = [{ id: "agent-box", type: "rectangle", x: 0, y: 0, width: 10, height: 10 }, { id: "tab-box", type: "rectangle", x: 50, y: 0, width: 10, height: 10, version: 4, versionNonce: 40 }];
  const restore = (element, seed) => ({ seed, strokeColor: "#1e1e1e", roughness: 1, isDeleted: false, version: 1, versionNonce: 0, ...element });
  const shown = [restore(raw[0], 111), restore(raw[1], 222)];
  const copies = serverCopies(raw, shown);
  // The tab moves only tab-box: agent-box goes out as the agent wrote it.
  const local = [shown[0], edit(shown[1], { x: 60 })];
  const sent = structuredClone(local);
  const wire = wireElements(sent, copies);
  assert.equal(wire[0], raw[0]);
  assert.equal(wire[1].x, 60);
  // The server merged (another writer added c). Restoring its answer again rolls a new seed for
  // agent-box, but the merge left it as sent, so the tab keeps its copy, including an edit of it
  // made while the save was in flight.
  const masterRaw = [raw[0], { ...wire[1] }, { id: "c", type: "ellipse", x: 0, y: 90, width: 10, height: 10 }];
  const master = [restore(masterRaw[0], 999), restore(masterRaw[1], 222), restore(masterRaw[2], 333)];
  const inFlight = [edit(local[0], { x: 3 }), local[1]];
  const result = keepEditsSinceSave({ sent, wire, masterRaw, master, local: inFlight });
  const merged = byId(result.elements);
  assert.equal(merged.get("agent-box").x, 3, "the in-flight edit of agent-box is kept");
  assert.equal(merged.get("agent-box").seed, 111);
  assert.equal(merged.get("tab-box").x, 60);
  assert.equal(merged.get("c").seed, 333);
  assert.deepEqual(result.dropped, []);
  // Next save: what the tab shows for master maps back to the server's copies.
  const next = serverCopies(masterRaw, result.shownMaster);
  assert.equal(wireElements(result.elements, next).find((element) => element.id === "c"), masterRaw[2]);
});

test("after a merged save: edits made while the save was in flight are kept on top of master", () => {
  const sent = [el("a", 2, { x: 5 }), el("b"), el("gone")];
  const master = [el("a", 2, { x: 5 }), el("b", 3, { x: 40 }), el("gone"), el("agent-new")];
  const local = [edit(sent[0], { x: 9 }), sent[1], { ...edit(sent[2], {}), isDeleted: true }, el("tab-new")];
  const result = keepEditsSinceSave({ sent, master, local });
  const merged = byId(result.elements);
  assert.deepEqual(ids(result.elements), ["a", "agent-new", "b", "tab-new"]);
  assert.equal(merged.get("a").x, 9, "the in-flight drag of a is kept");
  assert.equal(merged.get("b").x, 40, "the merge's change to b shows");
  assert.equal(merged.get("gone"), undefined, "the in-flight deletion is kept");
  assert.deepEqual(result.dropped, []);
});

test("after a merged save: an edit of this tab that lost is never kept, even if the tab kept editing it", () => {
  // The tab sent `u` moved to x=7; another writer's newer edit (a relabel) won, so master has theirs.
  const base = el("u", 1, { strokeColor: "#000000" });
  const sent = [edit(base, { x: 7 }), el("label", 1, { type: "text", containerId: "u", text: "old" })];
  const master = [edit(base, { strokeColor: "#e03131" }), el("label", 2, { type: "text", containerId: "u", text: "theirs" })];
  // Nothing in flight: master's unit.
  const quiet = byId(keepEditsSinceSave({ sent, master, local: structuredClone(sent) }).elements);
  assert.equal(quiet.get("u").x, 0);
  assert.equal(quiet.get("u").strokeColor, "#e03131");
  // The tab kept dragging the losing shape while the save was in flight: master still wins the
  // unit (shape and label together), and the drop is reported, not silent.
  const local = [edit(sent[0], { x: 12 }), sent[1]];
  const result = keepEditsSinceSave({ sent, master, local });
  const merged = byId(result.elements);
  assert.equal(merged.get("u").x, 0);
  assert.equal(merged.get("u").strokeColor, "#e03131");
  assert.equal(merged.get("label").text, "theirs");
  assert.deepEqual(result.dropped.map((unit) => [unit.unitId, unit.label]), [["u", "theirs"]]);
});

test("offline fallback (409): the tab's unsaved edits merge onto the board on disk, the tab wins a clash", () => {
  const base = [el("tab-edits"), el("disk-edits"), el("both"), el("disk-removed"), el("untouched")];
  const local = [edit(base[0], { x: 50 }), base[1], edit(base[2], { x: 1 }), base[3], base[4], el("tab-new")];
  // An agent writing the file often doesn't bump versions; content decides.
  const remote = [base[0], { ...base[1], x: 99 }, { ...base[2], x: 2 }, base[4], el("disk-new")];
  const result = reapplyUnsavedEdits({ base, remote, local, author: "human:Ada Lovelace#tabA" });
  const merged = byId(result.elements);
  assert.deepEqual(ids(result.elements), ["both", "disk-edits", "disk-new", "tab-edits", "tab-new", "untouched"]);
  assert.equal(merged.get("tab-edits").x, 50);
  assert.equal(merged.get("disk-edits").x, 99);
  assert.equal(merged.get("both").x, 1);
  assert.deepEqual(result.overwritten.map((unit) => [unit.unitId, unit.winner.author]), [["both", "human:Ada Lovelace#tabA"]]);
});

const withApi = async (fn) => {
  const boardsDir = path.resolve(".test-run", `tab-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(boardsDir, { recursive: true });
  const api = createBoardApi({ boardsDir, pollMs: 0, useFsWatch: false });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const scene = (elements) => ({ type: "excalidraw", version: 2, source: "test", elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} });
  const post = async (board, body) => (await fetch(`${base}/api/branch/${board}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const read = async (board) => {
    const response = await fetch(`${base}/api/board/${encodeURIComponent(board)}`);
    return { version: response.headers.get("etag").replaceAll("\"", ""), elements: (await response.json()).elements };
  };
  // A tab save, as App.tsx sends it.
  const put = async (board, { version, elements, identity, editAge }) => {
    const headers = { "Content-Type": "application/json", "If-Match": `"${version}"`, ...identityHeaders(identity) };
    if (editAge !== undefined) headers["X-Xcld-Edit-Age"] = String(editAge);
    const response = await fetch(`${base}/api/board/${encodeURIComponent(board)}`, { method: "PUT", headers, body: JSON.stringify(scene(elements)) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const checkpoint = (board, identity) => fetch(`${base}/api/board/${encodeURIComponent(board)}/checkpoint`, { method: "POST", headers: identity ? identityHeaders(identity) : {} });
  try {
    await fn({ api, boardsDir, base, post, read, put, checkpoint });
  } finally {
    await api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true, maxRetries: 5 });
  }
};

const tabA = { name: "Ada Lovelace", tabId: "tabA" };
const tabB = { name: "Ada Lovelace", tabId: "tabB" };
const AGENT = "agent:copilot-cli#a1b2c3";

test("a tab never sends its losing edit again: master stays the winner's after later saves", async () => {
  await withApi(async ({ api, post, read, put }) => {
    for (const board of ["tab/careful", "tab/naive"]) {
      const seeded = await post(board, { author: "cli:seed", base: null, elements: [el("u"), el("v")] });
      assert.equal(seeded.status, "merged");
    }
    const run = async (board, naive) => {
      const start = await read(board);
      // The agent recolors u; the tab's older drag of u (edited a minute ago) loses to it.
      const agent = await post(board, { author: AGENT, base: start.version, elements: [edit(el("u"), { strokeColor: "#e03131" }), el("v")] });
      assert.equal(agent.status, "merged");
      const sent = [edit(el("u"), { x: 70 }), edit(el("v"), { x: 5 })];
      const saved = await put(board, { version: start.version, elements: sent, identity: tabA, editAge: 60_000 });
      assert.equal(saved.merged, true);
      assert.deepEqual(saved.overwritten.map((unit) => [unit.unitId, unit.winner.author, unit.loser.author]), [["u", AGENT, "human:Ada Lovelace#tabA"]]);
      assert.equal(byId(saved.master.elements).get("u").strokeColor, "#e03131");
      assert.equal(byId(saved.master.elements).get("v").x, 5, "the rest of the tab's save landed");
      // The tab's next save (it adds w), on master as the new base.
      const local = naive ? [...sent, el("w")] : [...keepEditsSinceSave({ sent, master: saved.master.elements, local: sent }).elements, el("w")];
      const next = await put(board, { version: saved.version, elements: local, identity: tabA });
      await api.versions.whenIdle();
      return { next, u: byId((await read(board)).elements).get("u") };
    };
    const careful = await run("tab/careful", false);
    assert.equal(careful.next.merged, false, "a fast-forward");
    assert.equal(careful.u.strokeColor, "#e03131", "the winner stays");
    assert.equal(careful.u.x, 0, "the losing drag is not back");
    // The hazard this guards against: resending the tab's old copy on the new base brings the
    // loser back, unreported.
    const naive = await run("tab/naive", true);
    assert.equal(naive.u.x, 70);
    assert.deepEqual(naive.next.overwritten, []);
  });
});

test("X-Xcld-Edit-Age makes the tab's write time its last edit, not the save's arrival", async () => {
  await withApi(async ({ post, read, put }) => {
    const outcomes = {};
    for (const [board, editAge] of [["age/old-edit", 60_000], ["age/fresh-edit", undefined]]) {
      await post(board, { author: "cli:seed", base: null, elements: [el("u")] });
      const start = await read(board);
      await post(board, { author: AGENT, base: start.version, elements: [edit(el("u"), { strokeColor: "#e03131" })] });
      const saved = await put(board, { version: start.version, elements: [edit(el("u"), { x: 70 })], identity: tabA, editAge });
      outcomes[board] = saved.overwritten.map((unit) => unit.winner.author);
      if (editAge) {
        assert.deepEqual(saved.applied, [], "the save lost its only change");
        assert.equal(saved.version, (await read(board)).version, "master is unchanged");
        assert.equal(byId(saved.master.elements).get("u").x, 0);
      }
    }
    assert.deepEqual(outcomes, { "age/old-edit": [AGENT], "age/fresh-edit": ["human:Ada Lovelace#tabA"] });
  });
});

test("two tabs with the same name save as distinct authors, and both land", async () => {
  await withApi(async ({ api, boardsDir, post, read, put }) => {
    await post("d6/tabs", { author: "cli:seed", base: null, elements: [el("u")] });
    const start = await read("d6/tabs");
    const first = await put("d6/tabs", { version: start.version, elements: [el("u"), el("from-a")], identity: tabA });
    const second = await put("d6/tabs", { version: start.version, elements: [el("u"), el("from-b")], identity: tabB });
    assert.equal(first.merged, false);
    assert.equal(second.merged, true);
    assert.deepEqual(ids(second.master.elements), ["from-a", "from-b", "u"]);
    await api.versions.whenIdle();
    const state = JSON.parse(await readFile(path.join(boardsDir, ".xcld", "state", "d6", "tabs.json"), "utf8"));
    assert.equal(state.open.author, "human:Ada Lovelace#tabB", "tab B's turn is open");
    const metas = (await readdir(path.join(boardsDir, ".xcld", "history", "d6", "tabs"))).filter((name) => name.endsWith(".meta.json"));
    const authors = await Promise.all(metas.map(async (name) => JSON.parse(await readFile(path.join(boardsDir, ".xcld", "history", "d6", "tabs", name), "utf8"))));
    assert.ok(authors.some((meta) => meta.author === "human:Ada Lovelace#tabA" && meta.closedBy === "author"), "tab A's turn was closed by tab B's");
  });
});

test("POST /api/board/<path>/checkpoint closes the caller's open entry, once", async () => {
  await withApi(async ({ boardsDir, post, read, put, checkpoint }) => {
    assert.equal((await checkpoint("cp/none", tabA)).status, 404);
    await post("cp/board", { author: "cli:seed", base: null, elements: [el("u")] });
    let current = await read("cp/board");
    for (let step = 1; step <= 2; step++) {
      const saved = await put("cp/board", { version: current.version, elements: [el("u", step + 1, { x: step })], identity: tabA });
      current = { version: saved.version };
    }
    const other = await checkpoint("cp/board", tabB);
    assert.deepEqual(await other.json(), { ok: true, closed: false, entry: null, version: current.version }, "another tab's Ctrl+S leaves tab A's turn open");
    const own = await (await checkpoint("cp/board", tabA)).json();
    assert.equal(own.closed, true);
    assert.match(own.entry, /Ada_Lovelace_tabA$/);
    const meta = JSON.parse(await readFile(path.join(boardsDir, ".xcld", "history", "cp", "board", `${own.entry}.meta.json`), "utf8"));
    assert.equal(meta.closedBy, "checkpoint");
    assert.equal(meta.coalescedCount, 2);
    assert.equal((await (await checkpoint("cp/board", tabA)).json()).closed, false, "nothing changed since");
    // Without identity headers (a script), any open entry closes.
    await put("cp/board", { version: current.version, elements: [el("u", 9, { x: 9 })], identity: tabA });
    assert.equal((await (await checkpoint("cp/board", null)).json()).closed, true);
  });
});

test("a board whose path ends in /checkpoint is still a board for GET and PUT", async () => {
  await withApi(async ({ post, read, put, checkpoint }) => {
    await post("cp/checkpoint", { author: "cli:seed", base: null, elements: [el("u")] });
    const start = await read("cp/checkpoint");
    const saved = await put("cp/checkpoint", { version: start.version, elements: [el("u"), el("v")], identity: tabA });
    assert.equal(saved.merged, false);
    assert.equal((await checkpoint("cp/checkpoint", tabA)).status, 200);
  });
});
