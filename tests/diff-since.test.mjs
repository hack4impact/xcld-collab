import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { createBoardApi } from "../app/server/api.mjs";
import { authorLabel, formatDiffSince, parseSinceSpec, parseSinceTime } from "../tools/diff-since.mjs";
import { snapshotAndPin } from "../tools/snapshot.mjs";
import { formatHistoryEntry, formatMergedEvent } from "../tools/watch.mjs";

// Slice 6b: `xcld diff <board> --since <version|time|author|snapshot>` with the losers, and
// snapshots as pinned versions (POST /api/board/<path>/checkpoint { pin }).
const rootDir = path.resolve(".");
const AGENT = "agent:copilot-cli#a1b2c3";
const HUMAN = { "X-Xcld-Author-Name": "Ada", "X-Xcld-Tab": "t1" };

const unit = (id, label, x = 0) => [
  { id, type: "rectangle", x, y: 0, width: 200, height: 80, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: [{ type: "text", id: `${id}-t` }], updated: 1, link: null, locked: false },
  { id: `${id}-t`, type: "text", x: x + 10, y: 25, width: 180, height: 25, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 2, version: 1, versionNonce: 2, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, text: label, fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: id, originalText: label, autoResize: true, lineHeight: 1.25 },
];
const relabel = (elements, id, label) => elements.map((element) => (element.containerId === id ? { ...element, text: label, originalText: label, version: element.version + 1, versionNonce: element.versionNonce + 7 } : element));

const withApi = async (fn) => {
  const boardsDir = path.resolve(".test-run", `diff-since-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(boardsDir, { recursive: true });
  const api = createBoardApi({ boardsDir, pollMs: 0, useFsWatch: false });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = async (board) => {
    const response = await fetch(`${base}/api/board/${board}`);
    return { version: response.headers.get("etag").replace(/"/g, ""), scene: await response.json() };
  };
  const put = async (board, version, elements, editAge = 1) => {
    const response = await fetch(`${base}/api/board/${board}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...HUMAN, "X-Xcld-Edit-Age": String(editAge), ...(version ? { "If-Match": `"${version}"` } : { "If-None-Match": "*" }) },
      body: JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements, appState: {}, files: {} }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const post = async (board, body) => (await fetch(`${base}/api/branch/${board}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author: AGENT, ...body }) })).json();
  const since = async (board, spec) => {
    const response = await fetch(`${base}/api/diff/${board}?since=${encodeURIComponent(spec)}`);
    return { httpStatus: response.status, ...(await response.json()) };
  };
  const pin = async (board, label) => (await fetch(`${base}/api/board/${board}/checkpoint`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: label }) })).json();
  try {
    await fn({ api, base, boardsDir, read, put, post, since, pin });
  } finally {
    await api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true, maxRetries: 5 });
  }
};

// Ada draws A and B, pins "review"; the agent (stale write time) relabels A and adds C; Ada,
// still on the pinned version, relabels A later: the agent's A loses.
const scenario = async ({ api, read, put, post, pin }) => {
  const created = await put("ds/b", null, [...unit("A", "Login"), ...unit("B", "Store", 300)]);
  const pinned = await pin("ds/b", "review");
  assert.equal(pinned.pinned.label, "review");
  assert.equal(pinned.pinned.version, created.version);
  const agent = await post("ds/b", { base: created.version, writtenAt: Date.now() - 60_000, elements: [...relabel(unit("A", "Sign in"), "A", "Sign in"), ...unit("B", "Store", 300), ...unit("C", "Audit log", 600)] });
  assert.equal(agent.status, "merged");
  const human = await put("ds/b", created.version, [...relabel(unit("A", "Login"), "A", "Log in (Ada)"), ...unit("B", "Store", 300)]);
  assert.equal(human.merged, true);
  assert.deepEqual(human.overwritten.map((item) => [item.unitId, item.winner.author.split("#")[0], item.loser.author]), [["A", "human:Ada", AGENT]]);
  await api.versions.checkpoint("ds/b");
  await api.versions.whenIdle();
  return { created, agent, human, current: await read("ds/b") };
};

test("since parsing: prefixes, relative and ISO times, author labels", () => {
  assert.deepEqual(parseSinceSpec("author:Ada"), { kind: "author", value: "Ada" });
  assert.deepEqual(parseSinceSpec("pin:review"), { kind: "snapshot", value: "review" });
  assert.deepEqual(parseSinceSpec("3f9a"), { kind: "auto", value: "3f9a" });
  assert.throws(() => parseSinceSpec("author:"), /needs a value/);
  assert.equal(parseSinceTime("10m", 1_000_000), 400_000);
  assert.equal(parseSinceTime("2h", 10_000_000), 2_800_000);
  assert.equal(parseSinceTime("2026-10-07T21:00:00Z"), Date.UTC(2026, 9, 7, 21));
  assert.equal(parseSinceTime("12"), null);
  assert.equal(authorLabel("human:Ada#t1"), "Ada");
  assert.equal(authorLabel("agent:copilot-cli#a1b2c3"), "copilot-cli#a1b2c3");
  assert.equal(authorLabel("cli:bot"), "cli:bot");
});

test("diff --since a snapshot label, a version prefix, a time and an author lists changes and losers", async () => {
  await withApi(async (ctx) => {
    const { created, agent } = await scenario(ctx);
    const { since } = ctx;

    const bySnapshot = await since("ds/b", "review");
    assert.equal(bySnapshot.httpStatus, 200);
    assert.equal(bySnapshot.since.kind, "snapshot");
    assert.equal(bySnapshot.since.version, created.version);
    assert.deepEqual(bySnapshot.diff.nodes.added.map((item) => item.label), ["Audit log"]);
    assert.deepEqual(bySnapshot.diff.nodes.relabeled.map((item) => [item.from, item.to]), [["Login", "Log in (Ada)"]]);
    assert.equal(bySnapshot.overwritten.length, 1);
    const [lost] = bySnapshot.overwritten;
    assert.equal(lost.unitId, "A");
    assert.equal(lost.winner.author, "human:Ada#t1");
    assert.equal(lost.loser.author, AGENT);
    assert.deepEqual(lost.loser.labels, ["Sign in"]);
    assert.deepEqual(bySnapshot.turns.map((turn) => turn.author), [AGENT, "human:Ada#t1"]);
    const text = formatDiffSince(bySnapshot);
    assert.match(text, /Since snapshot "review"/);
    assert.match(text, /\+ added rectangle "Audit log"/);
    // One copilot-cli session on this board: no session id needed.
    assert.match(text, /! "Log in \(Ada\)" \(A\): copilot-cli \(agent\)'s edit \("Sign in", written .*\) lost to Ada/);
    assert.match(text, /2 history entries since: copilot-cli \(agent\) 1, Ada 1\./);

    // The same point by version prefix (explicit and bare), and as snapshot:<label>.
    for (const spec of [created.version.slice(0, 10), `version:${created.version.slice(0, 8)}`, "snapshot:review"]) {
      const result = await since("ds/b", spec);
      assert.equal(result.since.version, created.version, spec);
      assert.equal(result.overwritten.length, 1, spec);
    }

    // Since the agent's last entry: its own loss is included (the entry where it lost is later),
    // and the diff starts at the agent's version.
    const byAuthor = await since("ds/b", "author:copilot-cli");
    assert.equal(byAuthor.since.kind, "author");
    assert.equal(byAuthor.since.version, agent.version);
    assert.deepEqual(byAuthor.overwritten.map((item) => item.loser.author), [AGENT]);
    assert.deepEqual((await since("ds/b", `author:${AGENT}`)).since.version, agent.version);
    // Ada's own entry: inclusive, so the loss she caused shows too.
    assert.equal((await since("ds/b", "author:ada")).overwritten.length, 1);

    // A time before the board: everything is added, every loser listed; a time from now: nothing.
    const fromStart = await since("ds/b", "1d");
    assert.equal(fromStart.since.emptyBoard, true);
    assert.equal(fromStart.diff.nodes.added.length, 3);
    assert.equal(fromStart.overwritten.length, 1);
    const future = await since("ds/b", new Date(Date.now() + 60_000).toISOString());
    assert.equal(future.overwritten.length, 0);
    assert.equal(future.diff.nodes.added.length + future.diff.nodes.relabeled.length, 0);

    // Errors: unknown label, unknown author, empty.
    assert.equal((await since("ds/b", "nope")).httpStatus, 404);
    assert.match((await since("ds/b", "author:Zed")).message, /no history entry by Zed.*authors: Ada/);
    assert.equal((await since("ds/b", "time:yesterday")).httpStatus, 400);
    assert.equal((await fetch(`${ctx.base}/api/diff/ds/b`)).status, 400);
    assert.equal((await since("ds/none", "1h")).httpStatus, 404);
  });
});

test("pinning keeps the pinned version a full checkpoint, adopts a direct write first, and keeps every label", async () => {
  await withApi(async ({ api, base, boardsDir, read, put, post, pin, since }) => {
    let current = await put("ds/p", null, unit("A", "one"));
    // Enough agent turns that the head entry is a delta.
    for (let index = 0; index < 3; index++) {
      const answer = await post("ds/p", { base: current.version, elements: relabel(unit("A", "x"), "A", `turn ${index}`) });
      current = { version: answer.version };
    }
    const folder = path.join(api.versions.stateDir, "history", "ds", "p");
    const before = (await readdir(folder)).sort();
    assert.ok(before.at(-1).endsWith(".delta.json.gz") || before.some((name) => name.endsWith(".delta.json.gz")));
    const first = await pin("ds/p", "v1 review");
    assert.equal(first.pinned.version, current.version);
    const pinnedEntry = first.pinned.entry;
    assert.ok((await readdir(folder)).includes(`${pinnedEntry}.excalidraw.gz`), "a pinned delta becomes a checkpoint");
    assert.ok(!(await readdir(folder)).includes(`${pinnedEntry}.delta.json.gz`));
    const second = await pin("ds/p", "also-this");
    assert.equal(second.pinned.entry, pinnedEntry);
    const meta = JSON.parse(await readFile(path.join(folder, `${pinnedEntry}.meta.json`), "utf8"));
    assert.deepEqual(meta.pins.map((item) => item.label), ["v1 review", "also-this"]);
    assert.equal(meta.pinned, "also-this");
    assert.equal((await since("ds/p", "v1 review")).since.version, current.version);
    assert.equal((await read("ds/p")).version, current.version);
    // Bad labels.
    const bad = await fetch(`${base}/api/board/ds/p/checkpoint`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "../x" }) });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "invalid-pin");
    // A direct write not adopted yet (no watcher here) is adopted, then pinned.
    const direct = { type: "excalidraw", version: 2, source: "test", elements: relabel(unit("A", "x"), "A", "edited in a text editor"), appState: {}, files: {} };
    await writeFile(path.join(boardsDir, "ds", "p.excalidraw"), `${JSON.stringify(direct, null, 2)}\n`);
    const third = await pin("ds/p", "direct");
    assert.notEqual(third.pinned.version, current.version);
    assert.equal(third.pinned.version, (await read("ds/p")).version);
    const turns = (await since("ds/p", "v1 review")).turns;
    assert.deepEqual(turns.map((turn) => turn.author), ["external"]);
  });
});

test("xcld snapshot pins through the server; xcld diff --since prints the losers", async () => {
  await withApi(async (ctx) => {
    await scenario(ctx);
    const env = { ...process.env, XCLD_API_URL: ctx.base, XCLD_BOARDS_DIR: ctx.boardsDir, XCLD_AUTO_EXPORT: "off" };
    const run = (args) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(rootDir, "tools", "cli.mjs"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    const snap = await run(["snapshot", "ds/b", "--name", "after-merge"]);
    assert.equal(snap.code, 0, snap.stderr);
    const current = await ctx.read("ds/b");
    assert.match(snap.stdout, new RegExp(`pinned version ${current.version} as "after-merge"`));
    assert.match(snap.stdout, /\.snapshots[\\/]ds[\\/]b\.\d{8}T\d{9}Z\.excalidraw/);

    const text = await run(["diff", "ds/b", "--since", "review"]);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Overwritten since then \(1\)/);
    assert.match(text.stdout, /copilot-cli \(agent\)'s edit \("Sign in"/);
    const json = JSON.parse((await run(["diff", "ds/b", "--since", "author:Ada", "--json"])).stdout);
    assert.equal(json.since.kind, "author");
    // Since the snapshot just taken: nothing changed, nothing lost.
    const none = await run(["diff", "ds/b", "--since", "after-merge"]);
    assert.match(none.stdout, /No semantic changes detected[\s\S]*Nothing overwritten since then/);
    // The old snapshot-based diff still works.
    const old = await run(["diff", "ds/b"]);
    assert.equal(old.code, 0, old.stderr);
    assert.match(old.stdout, /Semantic diff/);
    const bad = await run(["diff", "ds/b", "--since", "nope"]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /not in the history of ds\/b/);

    // Server down: the CLI reads the history folder and the board file itself, and says so.
    const offlineRun = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(rootDir, "tools", "cli.mjs"), "diff", "ds/b", "--since", "review"], { env: { ...env, XCLD_API_URL: "http://127.0.0.1:9" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(offlineRun.code, 0, offlineRun.stderr);
    assert.match(offlineRun.stderr, /Read from the history folder/);
    assert.match(offlineRun.stdout, /Overwritten since then \(1\)/);

    // snapshotAndPin without a server: the copy only, with a warning.
    const offline = await snapshotAndPin("ds/b", ctx.boardsDir, { autoExport: "off", pin: async () => ({ error: "server down" }) });
    assert.equal(offline.pinned, null);
    assert.match(offline.pinWarning, /Not pinned in version history: server down/);
  });
});

test("watch lines name merges, losers and history entries", () => {
  const merged = formatMergedEvent({ name: "b", version: "abcdef0123456789", author: "human:Ada#t1", applied: [{ kind: "changed", label: "Login" }], overwritten: [{ label: "Login", winner: { author: "human:Ada#t1" }, loser: { author: AGENT } }], unbound: [] }, Date.UTC(2026, 9, 7, 21, 0, 0));
  assert.equal(merged, `21:00:00.000 MERGED  b vabcdef012345 by Ada: applied changed "Login"; OVERWRITTEN "Login": copilot-cli#a1b2c3 (agent) lost to Ada`);
  const entry = formatHistoryEntry({ entry: "20261007T210000000Z-human_Ada_t1", version: "abcdef0123456789", author: "human:Ada#t1", displayName: "Ada", open: true, coalescedCount: 3, lastCommitAt: Date.UTC(2026, 9, 7, 21), applied: [{}], overwritten: [] }, "grew");
  assert.match(entry, /HISTORY grew {3}20261007T210000000Z-human_Ada_t1 vabcdef012345 by Ada \[human:Ada#t1\], open, 3 save\(s\), 1 applied/);
});
