import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { createBoardApi } from "../app/server/api.mjs";
import { createSlowIoRecorder, formatDuration, SLOW_IO_MS, slowIoMessage, slowIoThresholdFromEnv, stageLabel } from "../app/server/slow-io.mjs";
import { createVersionStore } from "../app/server/versions.mjs";
import { describeWrite } from "../tools/board-client.mjs";

const el = (id, extra = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, ...extra });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const AGENT = "agent:slow-io#p1";

// A fake monotonic clock: an "operation" advances it instead of taking real time.
const fakeClock = () => {
  let time = 1000;
  return { clock: () => time, advance: (ms) => { time += ms; } };
};

test("slow-I/O recorder: an operation over the threshold is logged once and counted per stage; a fast one isn't", async () => {
  const { clock, advance } = fakeClock();
  const lines = [];
  const recorder = createSlowIoRecorder({ thresholdMs: 1000, clock, now: () => Date.UTC(2026, 9, 7, 20, 0, 0), log: (line) => lines.push(line) });
  assert.equal(await recorder.time("journal.fsync", "sandbox/a", async () => { advance(4213); return "ok"; }), "ok");
  await recorder.time("journal.write", "sandbox/a", async () => advance(12));
  await recorder.time("state.fsync", "sandbox/b", async () => advance(1000));
  await assert.rejects(recorder.time("master.rename", "sandbox/a", async () => {
    advance(1500);
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  }), /busy/, "the operation's error passes through");
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.thresholdMs, 1000);
  assert.equal(snapshot.count, 3);
  assert.equal(snapshot.maxMs, 4213);
  assert.deepEqual(snapshot.byStage, {
    "journal.fsync": { count: 1, maxMs: 4213 },
    "master.rename": { count: 1, maxMs: 1500 },
    "state.fsync": { count: 1, maxMs: 1000 },
  });
  assert.deepEqual(snapshot.recent, [
    { stage: "journal.fsync", board: "sandbox/a", ms: 4213, at: "2026-10-07T20:00:00.000Z" },
    { stage: "state.fsync", board: "sandbox/b", ms: 1000, at: "2026-10-07T20:00:00.000Z" },
    { stage: "master.rename", board: "sandbox/a", ms: 1500, at: "2026-10-07T20:00:00.000Z" },
  ]);
  assert.deepEqual(snapshot.inFlight, []);
  assert.equal(lines.length, 3, "one line per slow operation");
  assert.equal(lines[0], "slow I/O: journal.fsync took 4213 ms (board sandbox/a, 2026-10-07T20:00:00.000Z, threshold 1000 ms)");
});

test("slow-I/O recorder: the ring keeps the last N; counts and max cover everything since start", async () => {
  const { clock, advance } = fakeClock();
  const recorder = createSlowIoRecorder({ thresholdMs: 100, limit: 3, clock, log: () => {} });
  for (const ms of [150, 900, 200, 300, 250]) {
    await recorder.time("journal.fsync", "b", async () => advance(ms));
  }
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.count, 5);
  assert.equal(snapshot.maxMs, 900);
  assert.deepEqual(snapshot.byStage, { "journal.fsync": { count: 5, maxMs: 900 } });
  assert.deepEqual(snapshot.recent.map((event) => event.ms), [200, 300, 250]);
});

test("slow-I/O recorder: worstSince prefers the board's own operation, and sees one still running", async () => {
  const { clock, advance } = fakeClock();
  const recorder = createSlowIoRecorder({ thresholdMs: 1000, clock, log: () => {} });
  await recorder.time("state.fsync", "other", async () => advance(3000));
  const mark = recorder.mark();
  assert.equal(recorder.worstSince(mark, "mine"), null, "nothing slow ended after the mark");
  await recorder.time("journal.fsync", "other", async () => advance(5000));
  await recorder.time("history.write", "mine", async () => advance(1200));
  assert.deepEqual(recorder.worstSince(mark, "mine"), { stage: "history.write", board: "mine", ms: 1200, inFlight: false });
  assert.deepEqual(recorder.worstSince(mark, "third"), { stage: "journal.fsync", board: "other", ms: 5000, inFlight: false }, "any board's when this one had none");
  let release;
  const running = recorder.time("master.fsync", "mine", () => new Promise((resolve) => { release = resolve; }));
  advance(7000);
  assert.deepEqual(recorder.worstSince(mark, "mine"), { stage: "master.fsync", board: "mine", ms: 7000, inFlight: true });
  assert.deepEqual(recorder.snapshot().inFlight, [{ stage: "master.fsync", board: "mine", ms: 7000, inFlight: true }]);
  release();
  await running;
  assert.deepEqual(recorder.snapshot().inFlight, []);
  assert.equal(recorder.snapshot().byStage["master.fsync"].maxMs, 7000);
});

test("slow-I/O helpers: threshold from XCLD_SLOW_IO_MS, labels and the queued sentence", () => {
  assert.equal(SLOW_IO_MS, 1000);
  assert.equal(slowIoThresholdFromEnv({}), 1000);
  assert.equal(slowIoThresholdFromEnv({ XCLD_SLOW_IO_MS: "250" }), 250);
  assert.equal(slowIoThresholdFromEnv({ XCLD_SLOW_IO_MS: "zero" }), 1000);
  assert.equal(slowIoThresholdFromEnv({ XCLD_SLOW_IO_MS: "0" }), 1000);
  assert.equal(stageLabel("journal.fsync"), "journal fsync");
  assert.equal(formatDuration(4213), "4.2 s");
  assert.equal(formatDuration(850.4), "850 ms");
  assert.equal(slowIoMessage({ stage: "journal.fsync", ms: 4213 }), "disk is slow right now (journal fsync 4.2 s); your write is safe and queued");
  assert.equal(slowIoMessage({ stage: "master.write", ms: 6000, inFlight: true }), "disk is slow right now (master write 6.0 s so far); your write is safe and queued");
});

test("the commit pipeline times every file-system operation (journal, files, history, state, master, archive)", async () => {
  const dir = path.resolve(".test-run", `slow-io-store-${Date.now()}-${process.pid}`);
  await mkdir(dir, { recursive: true });
  // Threshold 0: every operation counts as slow, so byStage lists each one the pipeline ran.
  const recorder = createSlowIoRecorder({ thresholdMs: 0, limit: 1000, log: () => {} });
  const store = createVersionStore({ boardsDir: dir, slowIo: recorder });
  try {
    const image = { mimeType: "image/png", id: "img1", dataURL: "data:image/png;base64,AAAA", created: 1 };
    const first = await store.submitBranch("io/b", { author: AGENT, base: null, elements: [el("a"), el("pic", { type: "image", fileId: "img1" })], files: { img1: image } });
    assert.equal(first.status, "committed");
    const second = await store.submitBranch("io/b", { author: "agent:slow-io#p2", base: first.version, elements: [el("a", { x: 5 }), el("pic", { type: "image", fileId: "img1" })], files: { img1: image } });
    assert.equal(second.status, "committed");
    await store.whenIdle();
    const stages = Object.keys(store.status().slowIo.byStage);
    for (const stage of ["journal.open", "journal.write", "journal.fsync", "journal.close", "journal.rename", "files.fsync", "files.rename", "history.write", "history.rename", "state.fsync", "state.rename", "master.write", "master.stat", "master.rename", "archive.unlink"]) {
      assert.ok(stages.includes(stage), `${stage} is timed (got ${stages.join(", ")})`);
    }
    assert.ok(store.status().slowIo.recent.every((event) => event.board === "io/b"));
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

const withApi = async (options, fn) => {
  const boardsDir = path.resolve(".test-run", `slow-io-api-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(boardsDir, { recursive: true });
  const api = createBoardApi({ boardsDir, pollMs: 0, useFsWatch: false, ...options });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (board, body) => fetch(`${base}/api/branch/${board}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    await fn({ api, base, post });
  } finally {
    await api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true, maxRetries: 5 });
  }
};

test("a write queued behind a slow journal fsync says so; /api/status exposes the slow operation", async () => {
  // The journal fsync "takes" 4.2 s on the recorder's clock; in real time it waits 20 ms, longer
  // than the write wait, so the answer is `queued`.
  let skew = 0;
  let stall = false;
  const lines = [];
  const slowIo = createSlowIoRecorder({ thresholdMs: 1000, clock: () => performance.now() + skew, log: (line) => lines.push(line) });
  const onIo = async (stage) => {
    if (stall && stage === "journal.fsync") {
      skew += 4200;
      await delay(20);
    }
  };
  await withApi({ writeWaitMs: 1, versionOptions: { slowIo, testHooks: { onIo } } }, async ({ api, base, post }) => {
    const quiet = await (await fetch(`${base}/api/status`)).json();
    assert.deepEqual(quiet.slowIo, { thresholdMs: 1000, count: 0, maxMs: 0, byStage: {}, recent: [], inFlight: [] });

    stall = true;
    const response = await post("sandbox/stall", { author: AGENT, base: null, elements: [el("a")] });
    stall = false;
    assert.equal(response.status, 202);
    const queued = await response.json();
    assert.equal(queued.status, "queued");
    assert.equal(queued.message, "disk is slow right now (journal fsync 4.2 s); your write is safe and queued");
    assert.equal(queued.slowIo.stage, "journal.fsync");
    assert.equal(queued.slowIo.board, "sandbox/stall");
    assert.equal(queued.slowIo.inFlight, false);
    assert.ok(queued.slowIo.ms >= 4200 && queued.slowIo.ms < 4300, `ms ${queued.slowIo.ms}`);
    assert.match(describeWrite("sandbox/stall", { httpStatus: 202, ...queued }), /^Queued: disk is slow right now \(journal fsync 4\.2 s\); your write is safe and queued\. The server has your write for sandbox\/stall safely in its journal \(branch [0-9A-Z]{22}\) and will merge it; nothing is lost\./);

    await api.versions.whenIdle();
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.ok, true);
    assert.equal(status.slowIo.thresholdMs, 1000);
    assert.equal(status.slowIo.count, 1);
    assert.equal(status.slowIo.maxMs, queued.slowIo.ms);
    assert.deepEqual(status.slowIo.byStage, { "journal.fsync": { count: 1, maxMs: queued.slowIo.ms } });
    assert.equal(status.slowIo.recent.length, 1);
    assert.equal(status.slowIo.recent[0].stage, "journal.fsync");
    assert.equal(status.slowIo.recent[0].board, "sandbox/stall");
    assert.match(status.slowIo.recent[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^slow I\/O: journal\.fsync took 42\d\d ms \(board sandbox\/stall, .*Z, threshold 1000 ms\)$/);
  });
});

test("a write queued without a slow operation gets the plain queued message", async () => {
  const slowFor = { testHooks: { onStep: async (step) => {
    if (step === "commit-start") await delay(150);
  } } };
  await withApi({ writeWaitMs: 30, versionOptions: { ...slowFor, slowIo: createSlowIoRecorder({ log: () => {} }) } }, async ({ api, post }) => {
    const response = await post("sandbox/busy", { author: AGENT, base: null, elements: [el("a")] });
    assert.equal(response.status, 202);
    const queued = await response.json();
    assert.equal(queued.slowIo, undefined);
    assert.equal(queued.message, "the commit is taking longer than 30 ms; your write is safe and queued");
    assert.match(describeWrite("sandbox/busy", { httpStatus: 202, ...queued }), /^Queued: the server has your write/);
    await api.versions.whenIdle();
  });
});
