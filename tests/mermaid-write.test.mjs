import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { createBoardApi } from "../app/server/api.mjs";
import { listBoards } from "../tools/board-index.mjs";
import { mermaidSourceHash } from "../tools/mermaid-hash.mjs";

// Server-side Mermaid writes (slice 4b): POST /api/mermaid, MCP write_mermaid, the CLI and direct
// .mmd writes apply Mermaid on the server and merge it like any other write.
const rootDir = path.resolve(".");
const parserBundle = path.join(rootDir, "tools", "mermaid-parse.bundle.mjs");
const mcpBundle = path.join(rootDir, "tools", "mcp.bundle.mjs");
const needsParser = { skip: !existsSync(parserBundle) && "Run cd app; npm ci; npm run build first (Mermaid parser bundle)." };
const needsMcp = { skip: !(existsSync(parserBundle) && existsSync(mcpBundle)) && "Run cd app; npm ci; npm run build first (MCP and parser bundles)." };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(25);
  }
  return check();
};

const fixture = async (name) => JSON.parse(await readFile(path.join(rootDir, "tests", "fixtures", name), "utf8"));
// mermaid-apply-base.excalidraw: a real tab conversion of its `mermaid` field. Node A's label is
// "Start", B is the "Valid?" diamond, C sits in subgraph G, D "Fix input" loops back to B.
const BASE = await fixture("mermaid-apply-base.excalidraw").catch(() => null);
const SOURCE = BASE?.mermaid ?? "";
const labelOf = (scene, containerId) => scene.elements.find((element) => element.type === "text" && element.containerId === containerId && !element.isDeleted)?.originalText ?? null;
const live = (scene) => scene.elements.filter((element) => !element.isDeleted);
const ids = (scene) => live(scene).map((element) => element.id).sort();

const withApi = async (options, fn) => {
  const boardsDir = path.resolve(".test-run", `mermaid-write-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(boardsDir, { recursive: true });
  const api = createBoardApi({ boardsDir, pollMs: 0, useFsWatch: false, ...options });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = (method, url, body, headers = {}) => fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const writeMermaid = (board, body) => json("POST", `/api/mermaid/${board}`, body);
  const read = async (board) => {
    const response = await fetch(`${base}/api/board/${board}`);
    return { version: response.headers.get("etag")?.replace(/"/g, "") ?? null, scene: response.ok ? await response.json() : null };
  };
  // Like a tab's autosave: PUT with If-Match and the tab's identity.
  const save = (board, version, scene) => json("PUT", `/api/board/${board}`, scene, { "If-Match": `"${version}"`, "X-Xcld-Author-Name": "Ada", "X-Xcld-Tab": "t1" });
  // Server-sent events, collected from the start.
  const events = [];
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/events`, { signal: controller.signal });
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of stream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let index = buffer.indexOf("\n\n"); index >= 0; index = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data) events.push({ event, ...JSON.parse(data) });
        }
      }
    } catch {}
  })();
  try {
    await fn({ api, boardsDir, base, writeMermaid, read, save, events });
  } finally {
    controller.abort();
    await api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true, maxRetries: 5 });
  }
};

// A board the tab converted from SOURCE, with the inbox file it came from.
const seed = async (boardsDir, board, { inbox = SOURCE } = {}) => {
  const { mermaid: _source, ...scene } = BASE;
  const file = path.join(boardsDir, ...`${board}.excalidraw`.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(scene, null, 2)}\n`, "utf8");
  if (inbox !== null) {
    await writeFile(path.join(boardsDir, ...`${board}.mmd`.split("/")), inbox, "utf8");
  }
};
const masterOf = async (boardsDir, board) => JSON.parse(await readFile(path.join(boardsDir, ...`${board}.excalidraw`.split("/")), "utf8"));
const inboxOf = (boardsDir, board) => readFile(path.join(boardsDir, ...`${board}.mmd`.split("/")), "utf8");
const historyMetas = async (boardsDir, board) => {
  const folder = path.join(boardsDir, ".xcld", "history", ...board.split("/"));
  const names = (await readdir(folder)).filter((name) => name.endsWith(".meta.json")).sort();
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(folder, name), "utf8"))));
};
const boxesOverlap = (left, right) => left.x < right.x + right.width && right.x < left.x + left.width && left.y < right.y + right.height && right.y < left.y + left.height;

// A human's Ctrl+D copy of node C: new ids, the same Mermaid hash in customData.
const duplicateOf = (scene, id, copyId) => {
  const shape = scene.elements.find((element) => element.id === id);
  const label = scene.elements.find((element) => element.containerId === id);
  return [
    { ...structuredClone(shape), id: copyId, x: shape.x + 400, boundElements: [{ id: `${copyId}-text`, type: "text" }], index: "b0Z", version: 1, versionNonce: 7 },
    { ...structuredClone(label), id: `${copyId}-text`, containerId: copyId, x: label.x + 400, index: "b0a", version: 1, versionNonce: 8 },
  ];
};

test("D7: Mermaid written with no tab open lands in master (relabel, a new node placed, a new edge)", needsParser, async () => {
  await withApi({}, async ({ api, boardsDir, writeMermaid, read, base, events }) => {
    await seed(boardsDir, "d7/flow");
    const before = await read("d7/flow");
    const writtenAt = Date.now() - 5000;
    const next = SOURCE.replace('A["Start"]', 'A["Begin"]').replace("  D --> B", "  D --> B\n  D --> E[\"Escalate\"]");
    const response = await writeMermaid("d7/flow", { author: "agent:copilot-cli#d7d7d7", base: before.version, writtenAt, mermaid: next });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "merged");
    assert.equal(result.fastForward, true);
    assert.equal(result.hash, mermaidSourceHash(next));
    assert.deepEqual(result.ops.map((op) => op.op).sort(), ["add-edge", "add-node", "relabel"]);
    await api.versions.whenIdle();
    const master = await masterOf(boardsDir, "d7/flow");
    assert.equal(labelOf(master, "A"), "Begin");
    assert.equal(labelOf(master, "E"), "Escalate");
    const e = master.elements.find((element) => element.id === "E");
    for (const other of live(master).filter((element) => ["rectangle", "diamond", "ellipse"].includes(element.type) && element.id !== "E" && element.id !== "G")) {
      assert.equal(boxesOverlap(e, other), false, `E overlaps ${other.id}`);
    }
    const edge = master.elements.find((element) => element.id === "D_E");
    assert.equal(edge.startBinding.elementId, "D");
    assert.equal(edge.endBinding.elementId, "E");
    // The write time is the writer's, not the apply time (D8).
    assert.equal(e.updated, writtenAt);
    const state = await api.versions.readState("d7/flow");
    assert.equal(state.masterMeta.E.writtenAt, writtenAt);
    assert.equal(state.mermaid.hash, mermaidSourceHash(next));
    const metas = await historyMetas(boardsDir, "d7/flow");
    assert.deepEqual(metas.map((meta) => [meta.author, meta.kind]), [["init", "json"], ["agent:copilot-cli#d7d7d7", "mermaid"]]);
    // The inbox file shows the applied Mermaid, marked applied so a tab doesn't convert it again.
    assert.ok(await waitFor(async () => await inboxOf(boardsDir, "d7/flow") === next.replace(/\n?$/, "\n")), "the inbox file shows the applied Mermaid");
    const inbox = await fetch(`${base}/api/mermaid/d7/flow`);
    assert.equal(inbox.headers.get("x-xcld-mermaid-applied"), "1");
    assert.equal(events.some((event) => event.kind === "mermaid"), false, "no tab conversion is requested");
    assert.ok(await waitFor(() => events.some((event) => event.event === "merged" && event.name === "d7/flow")));
    const listed = (await (await fetch(`${base}/api/boards`)).json()).boards.find((board) => board.name === "d7/flow");
    assert.equal(listed.mermaidPending, false);
  });
});

test("D8 for Mermaid: a stale write loses to a newer human edit of the same unit; its disjoint changes apply", needsParser, async () => {
  await withApi({}, async ({ api, boardsDir, writeMermaid, read, save }) => {
    await seed(boardsDir, "d8/flow");
    const v0 = await read("d8/flow");
    // The agent wrote its Mermaid a minute ago; the human relabels A now, before it arrives.
    const writtenAt = Date.now() - 60_000;
    const human = structuredClone(v0.scene);
    const label = human.elements.find((element) => element.containerId === "A");
    Object.assign(label, { text: "Human A", originalText: "Human A", version: label.version + 1 });
    assert.equal((await save("d8/flow", v0.version, human)).status, 200);
    const stale = SOURCE.replace('A["Start"]', 'A["Agent A"]').replace('D["Fix\ninput"]', 'D["Agent D"]');
    const response = await writeMermaid("d8/flow", { author: "agent:copilot-cli#d8d8d8", base: v0.version, writtenAt, mermaid: stale });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.fastForward, false);
    assert.deepEqual(result.overwritten.map((item) => [item.unitId, item.winner.side, item.loser.author]), [["A", "master", "agent:copilot-cli#d8d8d8"]]);
    await api.versions.whenIdle();
    const master = await masterOf(boardsDir, "d8/flow");
    assert.equal(labelOf(master, "A"), "Human A", "the newer human edit wins the unit");
    assert.equal(labelOf(master, "D"), "Agent D", "the disjoint Mermaid change applies");
    // A Mermaid write newer than the human's edit takes the unit.
    const v1 = await read("d8/flow");
    const fresh = await (await writeMermaid("d8/flow", { author: "agent:copilot-cli#d8d8d8", base: v0.version, writtenAt: Date.now() + 1000, mermaid: stale.replace("Agent A", "Fresh A") })).json();
    assert.equal(fresh.status, "merged");
    assert.notEqual(fresh.version, v1.version);
    await api.versions.whenIdle();
    assert.equal(labelOf(await masterOf(boardsDir, "d8/flow"), "A"), "Fresh A");
  });
});

test("a human's Ctrl+D copy of a Mermaid shape survives Mermaid writes, also ones that delete", needsParser, async () => {
  await withApi({}, async ({ api, boardsDir, writeMermaid, read, save }) => {
    for (const [board, inbox] of [["dup/known", SOURCE], ["dup/unknown", null]]) {
      await seed(boardsDir, board, { inbox });
      const v0 = await read(board);
      const scene = structuredClone(v0.scene);
      scene.elements.push(...duplicateOf(scene, "C", "copy-of-C"));
      const saved = await (await save(board, v0.version, scene)).json();
      // Remove D (and its two edges): a deletion the previous Mermaid allows.
      const withoutD = SOURCE.replace('  B -->|no| D["Fix\ninput"]\n', "").replace("  D --> B\n", "").replace(/\n  class D hot\n?/, "\n");
      const first = await (await writeMermaid(board, { author: "agent:a#000001", base: saved.version, mermaid: withoutD })).json();
      assert.equal(first.status, "merged", JSON.stringify(first));
      await api.versions.whenIdle();
      const master = await masterOf(boardsDir, board);
      assert.ok(ids(master).includes("copy-of-C") && ids(master).includes("copy-of-C-text"), `${board}: the copy is kept`);
      if (inbox === null) {
        // Which Mermaid the board came from is unknown: nothing is deleted, and the answer says so.
        assert.equal(first.deletesSkipped, true);
        assert.ok(ids(master).includes("D"));
      } else {
        assert.equal(first.deletesSkipped, undefined);
        assert.deepEqual(first.ops.filter((op) => op.op === "delete").map((op) => op.id).sort(), ["B_D", "D", "D_B"]);
        assert.equal(ids(master).includes("D"), false);
      }
      // The next write's previous Mermaid is the stored one.
      const second = await (await writeMermaid(board, { author: "agent:a#000001", mermaid: withoutD.replace('C(["Done"])', 'C(["Shipped"])') })).json();
      assert.equal(second.status, "merged");
      assert.equal(second.deletesSkipped, undefined);
      assert.equal(second.ops.some((op) => op.op === "delete"), false, JSON.stringify(second.ops));
      await api.versions.whenIdle();
      const after = await masterOf(boardsDir, board);
      assert.equal(labelOf(after, "C"), "Shipped");
      assert.ok(ids(after).includes("copy-of-C"), `${board}: the copy is still kept`);
      assert.equal(labelOf(after, "copy-of-C"), "Done", "the copy keeps its own label");
    }
  });
});

test("a Mermaid write that changes nothing records the applied hash, so Mermaid pending clears", needsParser, async () => {
  await withApi({}, async ({ api, boardsDir, writeMermaid, read, base, events }) => {
    await seed(boardsDir, "same/flow");
    const v0 = await read("same/flow");
    const commented = `${SOURCE}\n%% the same diagram, one comment more\n`;
    const result = await (await writeMermaid("same/flow", { author: "agent:a#000002", base: v0.version, mermaid: commented })).json();
    assert.equal(result.status, "merged");
    assert.equal(result.unchanged, true);
    assert.equal(result.version, v0.version);
    assert.deepEqual(result.ops, []);
    await api.versions.whenIdle();
    assert.equal((await read("same/flow")).version, v0.version, "master is untouched");
    assert.equal((await api.versions.readMermaid("same/flow")).hash, mermaidSourceHash(commented));
    assert.ok(await waitFor(async () => await inboxOf(boardsDir, "same/flow") === commented.replace(/\n?$/, "\n")));
    // The board doesn't carry the new hash, so the file-only check still says pending; the server's list doesn't.
    assert.equal((await listBoards(boardsDir)).boards.find((board) => board.name === "same/flow").mermaidPending, true);
    assert.equal((await (await fetch(`${base}/api/boards`)).json()).boards.find((board) => board.name === "same/flow").mermaidPending, false);
    assert.equal((await fetch(`${base}/api/mermaid/same/flow`)).headers.get("x-xcld-mermaid-applied"), "1");
    assert.ok(await waitFor(() => events.some((event) => event.kind === "mermaid-applied" && event.name === "same/flow")));
  });
});

test("POST /api/mermaid: a syntax error is 400 with the line; an unknown base is 409; nothing is written", needsParser, async () => {
  await withApi({}, async ({ boardsDir, writeMermaid, read }) => {
    await seed(boardsDir, "bad/flow");
    const v0 = await read("bad/flow");
    const broken = await writeMermaid("bad/flow", { author: "agent:a#000003", base: v0.version, mermaid: "flowchart TD\n  A --> B\n  B -->> \n" });
    assert.equal(broken.status, 400);
    const error = await broken.json();
    assert.equal(error.error, "mermaid-syntax-error");
    assert.equal(error.line, 3);
    assert.ok(typeof error.message === "string" && error.message.length > 0);
    const unknown = await writeMermaid("bad/flow", { author: "agent:a#000003", base: "0".repeat(64), mermaid: SOURCE });
    assert.equal(unknown.status, 409);
    assert.equal((await unknown.json()).error, "unknown-base");
    assert.equal((await writeMermaid("bad/flow", { author: "bot", mermaid: SOURCE })).status, 400, "an invalid author key");
    assert.equal((await writeMermaid("bad/flow", { author: "agent:a#000003" })).status, 400, "no Mermaid");
    assert.equal(await inboxOf(boardsDir, "bad/flow"), SOURCE);
    assert.equal((await read("bad/flow")).version, v0.version);
  });
});

test("a brand-new board and a non-flowchart diagram fall back to the tab: inbox written, mermaid event sent", needsParser, async () => {
  await withApi({}, async ({ boardsDir, writeMermaid, base, events }) => {
    const created = await writeMermaid("new/flow", { author: "agent:a#000004", mermaid: "flowchart TD\n  A[One] --> B[Two]" });
    assert.equal(created.status, 202);
    const result = await created.json();
    assert.equal(result.status, "needs-tab");
    assert.equal(result.reason, "new board");
    assert.equal(await inboxOf(boardsDir, "new/flow"), "flowchart TD\n  A[One] --> B[Two]\n");
    assert.equal(existsSync(path.join(boardsDir, "new", "flow.excalidraw")), false);
    const inbox = await fetch(`${base}/api/mermaid/new/flow`);
    assert.equal(inbox.headers.get("x-xcld-mermaid-applied"), null, "the tab converts it");
    await seed(boardsDir, "new/seq");
    const sequence = await (await writeMermaid("new/seq", { author: "agent:a#000004", mermaid: "sequenceDiagram\n  A->>B: hi" })).json();
    assert.equal(sequence.status, "needs-tab");
    assert.match(sequence.reason, /unsupported diagram type/);
    await waitFor(() => events.filter((event) => event.kind === "mermaid").length >= 2);
    assert.deepEqual(events.filter((event) => event.kind === "mermaid").map((event) => event.name), ["new/flow", "new/seq"]);
  });
});

// Commits for this author take `ms` longer (an artificially slow merge).
const slowFor = (author, ms) => ({ testHooks: { onStep: async (step, { branch }) => {
  if (step === "commit-start" && branch.author.startsWith(author)) await delay(ms);
} } });

test("D9 for Mermaid: a slow commit answers queued with the ops, then lands and updates the inbox", needsParser, async () => {
  await withApi({ writeWaitMs: 300, versionOptions: slowFor("agent:slow", 1500) }, async ({ api, boardsDir, writeMermaid, read }) => {
    await seed(boardsDir, "q/flow");
    const v0 = await read("q/flow");
    const next = SOURCE.replace('A["Start"]', 'A["Queued"]');
    const response = await writeMermaid("q/flow", { author: "agent:slow#q1", base: v0.version, mermaid: next });
    assert.equal(response.status, 202);
    const queued = await response.json();
    assert.equal(queued.status, "queued");
    assert.match(queued.branchId, /^[0-9A-Z]{22}$/);
    assert.deepEqual(queued.ops.map((op) => op.op), ["relabel"]);
    assert.equal((await readdir(path.join(boardsDir, ".xcld", "branches", "q", "flow"))).length, 1, "journaled");
    await api.versions.whenIdle();
    assert.equal(labelOf(await masterOf(boardsDir, "q/flow"), "A"), "Queued");
    assert.ok(await waitFor(async () => await inboxOf(boardsDir, "q/flow") === next.replace(/\n?$/, "\n")));
  });
});

test("a direct write to <board>.mmd is applied on the server as `external`, written at the file's mtime", needsParser, async () => {
  await withApi({ pollMs: 50 }, async ({ api, boardsDir, read, events }) => {
    await seed(boardsDir, "ext/flow");
    await read("ext/flow");
    await delay(200);
    const next = SOURCE.replace('A["Start"]', 'A["From a file"]');
    const file = path.join(boardsDir, "ext", "flow.mmd");
    await writeFile(file, next, "utf8");
    const mtime = new Date(Date.now() - 30_000);
    await utimes(file, mtime, mtime);
    let master;
    for (let attempt = 0; attempt < 100; attempt++) {
      await delay(50);
      master = await masterOf(boardsDir, "ext/flow");
      if (labelOf(master, "A") === "From a file") break;
    }
    assert.equal(labelOf(master, "A"), "From a file");
    await api.versions.whenIdle();
    const state = await api.versions.readState("ext/flow");
    assert.equal(state.mermaid.author, "external");
    assert.equal(state.mermaid.writtenAt, mtime.getTime());
    assert.equal(state.masterMeta.A.writtenAt, mtime.getTime());
    assert.equal(events.some((event) => event.kind === "mermaid"), false, "no tab conversion is requested");
    assert.equal(await inboxOf(boardsDir, "ext/flow"), next, "the file is left as written");
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
    }, 20_000).unref();
  });
  const init = async (name) => {
    await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  };
  const call = async (name, args) => (await send("tools/call", { name, arguments: args })).result;
  return { init, call, stop: () => child.kill() };
};

test("MCP write_mermaid end to end: two agents write Mermaid to one board in parallel and both land", needsMcp, async () => {
  await withApi({}, async ({ api, boardsDir, base }) => {
    await seed(boardsDir, "mcp/flow");
    const env = { XCLD_API_URL: base, XCLD_BOARDS_DIR: boardsDir, XCLD_PUBLIC_URL: "http://127.0.0.1:3131" };
    const first = startMcp(env);
    const second = startMcp(env);
    try {
      await Promise.all([first.init("copilot-cli"), second.init("claude-code")]);
      const [readOne, readTwo] = await Promise.all([
        first.call("read_board", { board: "mcp/flow" }),
        second.call("read_board", { board: "mcp/flow" }),
      ]);
      assert.equal(readOne.structuredContent.version, readTwo.structuredContent.version);
      const version = readOne.structuredContent.version;
      // Disjoint changes from the same base, at the same time.
      const [one, two] = await Promise.all([
        first.call("write_mermaid", { board: "mcp/flow", base: version, mermaid: SOURCE.replace('A["Start"]', 'A["From agent one"]') }),
        second.call("write_mermaid", { board: "mcp/flow", base: version, mermaid: SOURCE.replace("  D --> B", "  D --> B\n  B --> F[\"From agent two\"]") }),
      ]);
      for (const result of [one, two]) {
        assert.equal(result.isError, undefined, result.content?.[0]?.text);
        assert.equal(result.structuredContent.status, "merged");
        assert.match(result.content[0].text, /^Merged into mcp\/flow: version [0-9a-f]{64}/);
        assert.equal(result.structuredContent.url, "http://127.0.0.1:3131/?board=mcp/flow");
        assert.ok(result.structuredContent.ops.length > 0);
      }
      assert.match(one.content[0].text, /relabel node A: "Start" -> "From agent one"/);
      assert.match(two.content[0].text, /add node F/);
      await api.versions.whenIdle();
      const master = await masterOf(boardsDir, "mcp/flow");
      assert.equal(labelOf(master, "A"), "From agent one");
      assert.equal(labelOf(master, "F"), "From agent two");
      const authors = (await historyMetas(boardsDir, "mcp/flow")).map((meta) => meta.author);
      assert.equal(authors.length, 3);
      assert.ok(authors.slice(1).some((author) => /^agent:copilot-cli#[0-9a-f]{6}$/.test(author)), authors.join(", "));
      assert.ok(authors.slice(1).some((author) => /^agent:claude-code#[0-9a-f]{6}$/.test(author)), authors.join(", "));

      const syntax = await first.call("write_mermaid", { board: "mcp/flow", mermaid: "flowchart TD\n  A -->> \n" });
      assert.equal(syntax.isError, true);
      assert.match(syntax.content[0].text, /Mermaid syntax error on line 2/);
      // With the snapshot rule on, a write snapshots the board first.
      await writeFile(path.join(boardsDir, "mcp", "design-rules.csv"), "kind,rule_id,on,match,means,instruct\nsnapshot,on-agent-write,,,on,Snapshot before every agent write\n", "utf8");
      const again = await first.call("write_mermaid", { board: "mcp/flow", mermaid: SOURCE.replace('A["Start"]', 'A["Again"]') });
      assert.equal(again.structuredContent.status, "merged", again.content[0].text);
      assert.ok(existsSync(again.structuredContent.preWriteSnapshot.paths.board));
      const fresh = await first.call("write_mermaid", { board: "mcp/brand-new", mermaid: "flowchart TD\n  A --> B" });
      assert.equal(fresh.isError, undefined);
      assert.equal(fresh.structuredContent.status, "needs-tab");
      assert.match(fresh.content[0].text, /Open http:\/\/127\.0\.0\.1:3131\/\?board=mcp\/brand-new in a browser/);
      // An agent can poll a pending write.
      const status = await first.call("mermaid_status", { board: "mcp/brand-new", pendingId: fresh.structuredContent.pendingId });
      assert.equal(status.isError, undefined, status.content?.[0]?.text);
      assert.equal(status.structuredContent.status, "pending");
      assert.match(status.content[0].text, /^Pending on mcp\/brand-new \(source "main"\)/);
      const unknown = await first.call("mermaid_status", { board: "mcp/brand-new", pendingId: "nope" });
      assert.equal(unknown.isError, true);
    } finally {
      first.stop();
      second.stop();
    }
  });
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

test("xcld write-mermaid goes through the server as cli:<XCLD_AUTHOR>", needsParser, async () => {
  await withApi({}, async ({ api, boardsDir, base }) => {
    await seed(boardsDir, "cli/flow");
    const env = { XCLD_API_URL: base, XCLD_BOARDS_DIR: boardsDir, XCLD_AUTHOR: "docs-bot" };
    const read = JSON.parse((await runCli(["read", "cli/flow"], env)).stdout);
    const written = await runCli(["write-mermaid", "cli/flow", "-", "--base", read.version], env, SOURCE.replace('A["Start"]', 'A["From the CLI"]'));
    assert.equal(written.code, 0, written.stderr);
    assert.match(written.stdout, /^Merged into cli\/flow: version [0-9a-f]{64}.*relabel node A/s);
    await api.versions.whenIdle();
    assert.equal(labelOf(await masterOf(boardsDir, "cli/flow"), "A"), "From the CLI");
    assert.equal((await api.versions.readMermaid("cli/flow")).author, "cli:docs-bot");
    const broken = await runCli(["write-mermaid", "cli/flow", "-"], env, "flowchart TD\n  A -->> \n");
    assert.equal(broken.code, 1);
    assert.match(broken.stdout, /syntax error on line 2/);
  });
});
