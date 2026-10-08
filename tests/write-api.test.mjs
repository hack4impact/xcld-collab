import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { createBoardApi } from "../app/server/api.mjs";

const rootDir = path.resolve(".");
const bundlePath = path.join(rootDir, "tools", "mcp.bundle.mjs");
const el = (id, extra = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, ...extra });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withApi = async (options, fn) => {
  const boardsDir = path.resolve(".test-run", `write-api-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(boardsDir, { recursive: true });
  const api = createBoardApi({ boardsDir, pollMs: 0, useFsWatch: false, ...options });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (board, body) => fetch(`${base}/api/branch/${board}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    await fn({ api, boardsDir, base, post });
  } finally {
    await api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true, maxRetries: 5 });
  }
};

const master = async (boardsDir, board) => JSON.parse(await readFile(path.join(boardsDir, `${board}.excalidraw`), "utf8"));
const historyAuthors = async (boardsDir, board) => {
  const folder = path.join(boardsDir, ".xcld", "history", board);
  const metas = (await readdir(folder)).filter((name) => name.endsWith(".meta.json")).sort();
  return Promise.all(metas.map(async (name) => JSON.parse(await readFile(path.join(folder, name), "utf8")).author));
};
const waitFor = async (check, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(50);
  }
  return check();
};

// Commits for this author take `ms` longer (an artificially slow merge).
const slowFor = (author, ms) => ({ testHooks: { onStep: async (step, { branch }) => {
  if (step === "commit-start" && branch.author.startsWith(author)) await delay(ms);
} } });

test("POST /api/branch merges and answers with the version and what was applied", async () => {
  await withApi({}, async ({ api, boardsDir, post }) => {
    const first = await post("w/one", { base: null, elements: [el("a")] });
    assert.equal(first.status, 200);
    const created = await first.json();
    assert.equal(created.status, "merged");
    assert.equal(created.version.length, 64);
    const second = await (await post("w/one", { author: "agent:copilot-cli#abc123", base: created.version, elements: [el("a"), el("b")] })).json();
    assert.equal(second.status, "merged");
    assert.deepEqual(second.applied.map((item) => [item.unitId, item.kind]), [["b", "added"]]);
    // Written against the first version, after the second: merges.
    const third = await (await post("w/one", { author: "cli:docs", base: created.version, elements: [el("a", { x: 3 })] })).json();
    assert.equal(third.status, "merged");
    assert.equal(third.fastForward, false);
    await api.versions.whenIdle();
    assert.deepEqual((await master(boardsDir, "w/one")).elements.map((item) => item.id).sort(), ["a", "b"], "the third write didn't know b, so it doesn't delete it");
    assert.deepEqual(await historyAuthors(boardsDir, "w/one"), ["cli:api", "agent:copilot-cli#abc123", "cli:docs"]);
  });
});

test("POST /api/branch: validation errors are 400, an unknown base is 409, never a timeout", async () => {
  await withApi({ writeWaitMs: 200 }, async ({ post }) => {
    const missingBase = await post("w/v", { elements: [el("a")] });
    assert.equal(missingBase.status, 400);
    assert.equal((await missingBase.json()).error, "base-required");
    assert.equal((await post("w/v", { base: null, author: "bot", elements: [el("a")] })).status, 400);
    const noIds = await post("w/v", { base: null, elements: [{ type: "rectangle" }] });
    assert.equal(noIds.status, 400);
    assert.equal((await noIds.json()).error, "invalid-elements");
    assert.equal((await post("w/v", { base: null, kind: "mermaid", elements: [] })).status, 400);
    const unknown = await post("w/v", { base: "f".repeat(64), elements: [el("a")] });
    assert.equal(unknown.status, 409);
    assert.equal((await unknown.json()).error, "unknown-base");
    assert.equal((await post("%2E%2E%2Fescape", { base: null, elements: [] })).status, 400);
  });
});

test("D9: a write whose commit takes longer than the wait answers queued, then lands", async () => {
  await withApi({ writeWaitMs: 300, versionOptions: slowFor("agent:slow", 1500) }, async ({ api, boardsDir, post }) => {
    const started = Date.now();
    const response = await post("d9", { author: "agent:slow#p1", base: null, elements: [el("late")] });
    const waited = Date.now() - started;
    assert.equal(response.status, 202);
    const queued = await response.json();
    assert.equal(queued.status, "queued");
    assert.match(queued.branchId, /^[0-9A-Z]{22}$/);
    assert.ok(waited >= 280 && waited < 1400, `answered after ${waited} ms`);
    assert.equal((await readdir(path.join(boardsDir, ".xcld", "branches", "d9"))).length, 1, "the queued write is in the journal");
    await api.versions.whenIdle();
    assert.deepEqual((await master(boardsDir, "d9")).elements.map((item) => item.id), ["late"]);
    assert.deepEqual(api.versions.status().pending, {});
  });
});

test("GET /api/config exposes the default human name; /api/status reports the pipeline", async () => {
  const previous = process.env.XCLD_AUTHOR_NAME;
  process.env.XCLD_AUTHOR_NAME = "Ada Lovelace";
  try {
    await withApi({}, async ({ base }) => {
      const config = await (await fetch(`${base}/api/config`)).json();
      assert.equal(config.authorName, "Ada Lovelace");
      assert.equal(config.writeWaitMs, 5000);
      const status = await (await fetch(`${base}/api/status`)).json();
      assert.deepEqual(status, { ok: true, pending: {}, failing: {}, slowIo: { thresholdMs: 1000, count: 0, maxMs: 0, byStage: {}, recent: [], inFlight: [] } });
    });
  } finally {
    if (previous === undefined) delete process.env.XCLD_AUTHOR_NAME;
    else process.env.XCLD_AUTHOR_NAME = previous;
  }
});

const runCli = (args, env, input) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(rootDir, "tools", "cli.mjs"), ...args], { cwd: rootDir, env: { ...process.env, ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  if (input !== undefined) child.stdin.end(input);
});

test("xcld read / xcld write go through the server; a slow commit answers queued (D9, CLI)", async () => {
  await withApi({ writeWaitMs: 2000, versionOptions: slowFor("cli:slowbot", 3500) }, async ({ api, boardsDir, base }) => {
    const env = { XCLD_API_URL: base, XCLD_BOARDS_DIR: boardsDir, XCLD_AUTHOR: "docs-bot" };
    const created = await runCli(["write", "c/b", "-", "--base", "none"], env, JSON.stringify([el("a")]));
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /^Merged into c\/b: version [0-9a-f]{64}/);
    const read = JSON.parse((await runCli(["read", "c/b"], env)).stdout);
    assert.equal(read.version.length, 64);
    await writeFile(path.join(boardsDir, "next.excalidraw.json"), JSON.stringify({ elements: [el("a"), el("b")] }), "utf8");
    const slow = await runCli(["write", "c/b", path.join(boardsDir, "next.excalidraw.json"), "--base", read.version], { ...env, XCLD_AUTHOR: "slowbot" });
    assert.equal(slow.code, 0, slow.stderr);
    assert.match(slow.stdout, /^Queued: .*nothing is lost/);
    await api.versions.whenIdle();
    assert.deepEqual((await master(boardsDir, "c/b")).elements.map((item) => item.id), ["a", "b"]);
    assert.deepEqual(await historyAuthors(boardsDir, "c/b"), ["cli:docs-bot", "cli:slowbot"]);
    const stale = await runCli(["write", "c/b", "-", "--base", "0".repeat(64)], env, JSON.stringify([el("z")]));
    assert.equal(stale.code, 1);
    assert.match(stale.stdout, /unknown to the server/);
  });
});

// A minimal MCP stdio client (newline-delimited JSON-RPC).
const startMcp = (env) => {
  const child = spawn(process.execPath, [path.join(rootDir, "tools", "cli.mjs"), "mcp"], { cwd: rootDir, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  const pending = new Map();
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  let nextId = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timed out waiting for ${method}: ${stderr}`));
    }, 15_000).unref();
  });
  const init = async (name) => {
    await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  };
  const call = async (name, args) => (await send("tools/call", { name, arguments: args })).result;
  return { init, call, stop: () => child.kill() };
};

test("D6 + D9 (MCP): two xcld mcp processes with the same client name write as distinct authors; a slow write is queued", { skip: !existsSync(bundlePath) && "Run cd app; npm ci; npm run build before MCP tests." }, async () => {
  await withApi({ writeWaitMs: 2000, versionOptions: slowFor("agent:slow-client", 3500) }, async ({ api, boardsDir, base }) => {
    const env = { XCLD_API_URL: base, XCLD_BOARDS_DIR: boardsDir, XCLD_PUBLIC_URL: "http://127.0.0.1:3131" };
    const first = startMcp(env);
    const second = startMcp(env);
    const slow = startMcp(env);
    try {
      await Promise.all([first.init("copilot-cli"), second.init("copilot-cli"), slow.init("slow-client")]);
      const created = await first.call("write_board", { board: "m/b", base: null, elements: [el("a")] });
      assert.equal(created.isError, undefined, created.content?.[0]?.text);
      const read = await second.call("read_board", { board: "m/b", format: "json" });
      assert.equal(read.structuredContent.version, created.structuredContent.version, "read_board returns the version from the server");
      assert.equal(read.structuredContent.warning, undefined);
      // Both sessions write against the same version, concurrently.
      const [one, two] = await Promise.all([
        first.call("write_board", { board: "m/b", base: read.structuredContent.version, elements: [el("a"), el("from-first")] }),
        second.call("write_board", { board: "m/b", base: read.structuredContent.version, elements: [el("a"), el("from-second")] }),
      ]);
      assert.match(one.content[0].text, /^Merged into m\/b/);
      assert.match(two.content[0].text, /^Merged into m\/b/);
      await api.versions.whenIdle();
      assert.deepEqual((await master(boardsDir, "m/b")).elements.map((item) => item.id).sort(), ["a", "from-first", "from-second"]);
      const authors = await historyAuthors(boardsDir, "m/b");
      assert.equal(authors.length, 3);
      assert.ok(authors.every((author) => /^agent:copilot-cli#[0-9a-f]{6}$/.test(author)), authors.join(", "));
      assert.equal(new Set(authors.slice(1)).size, 2, "the two sessions have distinct author keys");

      const queued = await slow.call("write_board", { board: "m/b", base: read.structuredContent.version, elements: [el("a"), el("slow")] });
      assert.equal(queued.isError, undefined);
      assert.match(queued.content[0].text, /^Queued: .*safely in its journal/);
      assert.ok(await waitFor(async () => (await master(boardsDir, "m/b")).elements.some((item) => item.id === "slow")), "the queued write lands");
      await api.versions.whenIdle();
      assert.deepEqual((await master(boardsDir, "m/b")).elements.map((item) => item.id).sort(), ["a", "from-first", "from-second", "slow"]);
    } finally {
      first.stop();
      second.stop();
      slow.stop();
    }
  });
});
