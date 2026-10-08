// Bookkeeping fields are not edits (the lead's real check, 2026-10-08). An agent asked for four
// changes re-sent the whole board it had read, with Excalidraw's bookkeeping dropped or changed
// (`created`, `index`, `seed`, `updated` null, `version` bumped, a new `versionNonce`, the origin
// stamp redone). The merge counted every element as changed, the agent won 20 units by write time
// and the human's concurrent edits were overwritten by untouched copies. Now only semantic changes
// count, omitted bookkeeping is filled back in, and untouched units keep their attribution: for
// write_board (POST /api/branch), a tab PUT, a direct file write and a Mermaid write.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { createBoardApi } from "../app/server/api.mjs";
import { createVersionStore } from "../app/server/versions.mjs";

const HUMAN = "human:Hana#tab1";
const AGENT = "agent:copilot-cli#8cb0a4";
const SEED_AUTHOR = "cli:seed";
const HASH = "m1-64360009b8f7b58a";
const T0 = 1791443136556;
const rootDir = path.resolve(".");
const needsParser = { skip: !existsSync(path.join(rootDir, "tools", "mermaid-parse.bundle.mjs")) && "Run cd app; npm ci; npm run build first (Mermaid parser bundle)." };

// scripts/real-check/demo.mmd as a converted board: shapes with bound text and bound arrows, every
// element with Excalidraw's bookkeeping and xcld's Mermaid stamps.
const NODES = [["Client", "Web client"], ["API", "API"], ["Orders", "Orders service"], ["Payments", "Payments service"], ["OrdersDB", "Orders DB"], ["Ledger", "Ledger"], ["Queue", "Event queue"], ["Notify", "Notifications"], ["Analytics", "Analytics"]];
const EDGES = [["Client", "API"], ["API", "Orders"], ["API", "Payments"], ["Orders", "OrdersDB"], ["Payments", "Ledger"], ["Orders", "Queue"], ["Queue", "Notify"], ["Queue", "Analytics"]];
const origin = (nodeId) => ({ xcldMermaidHash: HASH, xcldOrigin: { mermaid: { source: "main", nodeId, hash: HASH }, canvas: null, active: "mermaid" } });

const demoBoard = () => {
  let n = 0;
  const common = (id, type, nodeId, extra) => {
    n += 1;
    return {
      id, type, x: 0, y: 0, width: 180, height: 70, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2,
      strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: `a${n.toString(36).padStart(2, "0")}`, roundness: null,
      seed: 851400554 + n * 7919, version: 1, versionNonce: 1200000 + n, isDeleted: false, boundElements: null, updated: T0 + n, created: T0 + n,
      link: null, locked: false, customData: origin(nodeId), ...extra,
    };
  };
  const positions = new Map(NODES.map(([id], position) => [id, { x: (position % 3) * 260, y: Math.floor(position / 3) * 200 }]));
  const elements = [];
  for (const [id, label] of NODES) {
    const { x, y } = positions.get(id);
    elements.push(common(id, "rectangle", id, { x, y, boundElements: [{ type: "text", id: `${id}-text` }] }));
    elements.push(common(`${id}-text`, "text", id, {
      x: x + 20, y: y + 22, width: 140, height: 25, text: label, originalText: label, fontSize: 20, fontFamily: 5, textAlign: "center",
      verticalAlign: "middle", containerId: id, autoResize: true, lineHeight: 1.25,
    }));
  }
  for (const [from, to] of EDGES) {
    const id = `${from}_${to}`;
    const start = positions.get(from);
    const end = positions.get(to);
    elements.push(common(id, "arrow", id, {
      x: start.x + 90, y: start.y + 70, width: end.x - start.x, height: end.y - start.y - 70, points: [[0, 0], [end.x - start.x, end.y - start.y - 70]],
      lastCommittedPoint: null, startBinding: { elementId: from, focus: 0, gap: 5 }, endBinding: { elementId: to, focus: 0, gap: 5 },
      startArrowhead: null, endArrowhead: "arrow", elbowed: false,
    }));
    for (const shape of [from, to]) {
      elements.find((element) => element.id === shape).boundElements.push({ type: "arrow", id });
    }
  }
  return elements;
};

const textOf = (elements, containerId) => elements.find((element) => element.containerId === containerId && !element.isDeleted)?.originalText;
const byId = (elements, id) => elements.find((element) => element.id === id);
const relabel = (elements, containerId, label) => elements.map((element) => (element.containerId === containerId ? { ...element, text: label, originalText: label } : element));
const patch = (elements, id, change) => elements.map((element) => (element.id === id ? { ...element, ...change } : element));

// What the real check's agent sent for elements it didn't touch: bookkeeping set to null or left
// out, the version bumped, a new nonce, and the origin stamp redone (or dropped) for itself.
const llmResend = (elements, author = AGENT) => elements.map((element, position) => {
  const copy = structuredClone(element);
  if (position % 3 === 1) {
    for (const key of ["created", "index", "seed", "updated", "versionNonce"]) delete copy[key];
  } else {
    Object.assign(copy, { created: null, index: null, seed: null, updated: null, versionNonce: 4_000_000 + position });
  }
  copy.version = (element.version ?? 1) + 1;
  if (position % 4 === 2) {
    const { xcldOrigin, ...rest } = copy.customData;
    copy.customData = rest;
  } else {
    copy.customData = { ...copy.customData, xcldOrigin: { ...copy.customData.xcldOrigin, canvas: { author, at: T0 }, active: "canvas" } };
  }
  return copy;
});

// The agent's four real edits (the real check's agent B), applied to what it read.
const AGENT_UNITS = ["API", "Ledger", "Queue", "owner-note"];
const agentEdits = (elements) => [
  ...relabel(relabel(patch(elements, "API", { strokeColor: "#e03131" }), "Queue", "Kafka topic"), "Ledger", "Ledger v2"),
  {
    id: "owner-note", type: "text", x: 800, y: 222, width: 220, height: 25, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
    strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, isDeleted: false, boundElements: null,
    link: null, locked: false, text: "Owner: payments team", originalText: "Owner: payments team", fontSize: 20, fontFamily: 5, textAlign: "left",
    verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25,
  },
];
// The human's two concurrent edits: a nudge and a restyle.
const HUMAN_UNITS = ["Analytics", "Orders"];
const humanEdits = (elements) => patch(patch(elements, "Analytics", { x: 700, version: 2, versionNonce: 77 }), "Orders", { backgroundColor: "#ffc9c9", version: 2, versionNonce: 78 });
const humanEditsWithText = (elements) => {
  const moved = humanEdits(elements);
  return patch(moved, "Analytics-text", { x: byId(moved, "Analytics").x + 20, version: 2, versionNonce: 79 });
};

const checkMaster = (elements, before, context, stampAuthor = AGENT) => {
  assert.equal(byId(elements, "API").strokeColor, "#e03131", `${context}: the agent's restyle`);
  assert.equal(textOf(elements, "Queue"), "Kafka topic", `${context}: the agent's relabel`);
  assert.equal(textOf(elements, "Ledger"), "Ledger v2", `${context}: the agent's relabel`);
  assert.equal(byId(elements, "owner-note")?.originalText, "Owner: payments team", `${context}: the agent's note`);
  assert.equal(byId(elements, "Analytics").x, 700, `${context}: the human's nudge survives`);
  assert.equal(byId(elements, "Orders").backgroundColor, "#ffc9c9", `${context}: the human's restyle survives`);
  for (const original of before) {
    const stored = byId(elements, original.id);
    assert.ok(stored, `${context}: ${original.id} kept`);
    for (const key of ["seed", "index", "created"]) {
      assert.equal(stored[key], original[key], `${context}: ${original.id}.${key} kept`);
    }
    for (const key of ["updated", "version", "versionNonce"]) {
      assert.equal(typeof stored[key], "number", `${context}: ${original.id}.${key} is a number`);
    }
    assert.equal(stored.customData?.xcldMermaidHash, HASH, `${context}: ${original.id} keeps its Mermaid hash`);
    assert.ok(stored.customData?.xcldOrigin, `${context}: ${original.id} keeps its origin`);
  }
  // Untouched units keep their origin; only the agent's changed elements carry its canvas stamp.
  const stampedBy = (author) => elements.filter((element) => element.customData?.xcldOrigin?.canvas?.author === author).map((element) => element.id).sort();
  if (stampAuthor) assert.deepEqual(stampedBy(stampAuthor), ["API", "Ledger-text", "Queue-text"], `${context}: canvas stamps by the agent`);
  for (const id of ["Client", "Client-text", "Payments", "Payments-text", "Notify-text", "Client_API", "Queue_Analytics"]) {
    assert.deepEqual(byId(elements, id).customData, byId(before, id).customData, `${context}: ${id} keeps its origin`);
  }
};

const checkMeta = (meta, agentAuthor, humanAuthor, context) => {
  const authors = new Map();
  for (const [id, stamp] of Object.entries(meta)) authors.set(id, stamp.author);
  for (const id of ["API", "API-text", "Ledger", "Ledger-text", "Queue", "Queue-text", "owner-note"]) assert.equal(authors.get(id), agentAuthor, `${context}: ${id} attributed to the agent`);
  for (const id of ["Analytics", "Analytics-text", "Orders", "Orders-text"]) assert.equal(authors.get(id), humanAuthor, `${context}: ${id} attributed to the human`);
  for (const id of ["Client", "Client-text", "Payments", "Payments-text", "Notify", "Notify-text", "OrdersDB", "Client_API", "Queue_Analytics", "Payments_Ledger"]) {
    assert.equal(authors.get(id), SEED_AUTHOR, `${context}: untouched ${id} keeps its attribution`);
  }
};

const unitIds = (items) => (items ?? []).map((item) => item.unitId).sort();

const withStore = async (options, fn) => {
  const dir = path.resolve(".test-run", `bookkeeping-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const store = createVersionStore({ boardsDir: dir, ...options });
  try {
    return await fn(store, dir);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
};
const masterOf = async (dir, board, store) => {
  await store?.whenIdle();
  return JSON.parse(await readFile(path.join(dir, ...`${board}.excalidraw`.split("/")), "utf8"));
};

test("write_board re-sending the whole board with bookkeeping stripped: only its 4 edits apply, the human's 2 survive (both arrival orders)", async () => {
  for (const agentFirst of [false, true]) {
    const context = agentFirst ? "agent lands first" : "human lands first";
    await withStore({}, async (store, dir) => {
      const v0 = await store.submitBranch("rc/demo", { author: SEED_AUTHOR, base: null, writtenAt: T0, elements: demoBoard() });
      const before = (await masterOf(dir, "rc/demo", store)).elements;
      const human = () => store.submitBranch("rc/demo", { author: HUMAN, base: v0.version, writtenAt: T0 + 10_000, elements: humanEditsWithText(before) });
      const agent = () => store.submitBranch("rc/demo", { author: AGENT, base: v0.version, writtenAt: T0 + 20_000, kind: "json", elements: agentEdits(llmResend(before)) });
      const results = agentFirst ? [await agent(), await human()] : [await human(), await agent()];
      const agentResult = agentFirst ? results[0] : results[1];
      await store.whenIdle();
      assert.deepEqual(unitIds(agentResult.applied), AGENT_UNITS, `${context}: exactly the agent's 4 units`);
      assert.deepEqual(results.flatMap((result) => result.overwritten), [], `${context}: nothing overwritten`);
      if (agentFirst) assert.deepEqual(unitIds(results[1].applied), HUMAN_UNITS, `${context}: exactly the human's 2 units`);
      checkMaster((await masterOf(dir, "rc/demo", store)).elements, before, context);
      checkMeta((await store.readState("rc/demo")).masterMeta, AGENT, HUMAN, context);
    });
  }
});

test("fast-forward: a stripped re-send with no edits is no change; with edits, master keeps its bookkeeping", async () => {
  await withStore({}, async (store, dir) => {
    const v0 = await store.submitBranch("rc/ff", { author: SEED_AUTHOR, base: null, writtenAt: T0, elements: demoBoard() });
    const before = (await masterOf(dir, "rc/ff", store)).elements;
    const same = await store.submitBranch("rc/ff", { author: AGENT, base: v0.version, writtenAt: T0 + 5000, elements: llmResend(before) });
    assert.equal(same.status, "unchanged");
    assert.equal(same.version, v0.version, "re-sending the board as read changes nothing");
    assert.deepEqual(same.applied, []);
    const human = await store.submitBranch("rc/ff", { author: HUMAN, base: v0.version, writtenAt: T0 + 6000, elements: humanEditsWithText(before) });
    const agent = await store.submitBranch("rc/ff", { author: AGENT, base: human.version, writtenAt: T0 + 7000, elements: agentEdits(llmResend((await masterOf(dir, "rc/ff", store)).elements)) });
    assert.equal(agent.fastForward, true);
    assert.deepEqual(unitIds(agent.applied), AGENT_UNITS);
    await store.whenIdle();
    const master = (await masterOf(dir, "rc/ff", store)).elements;
    checkMaster(master, before, "fast-forward");
    checkMeta((await store.readState("rc/ff")).masterMeta, AGENT, HUMAN, "fast-forward");
    assert.ok(byId(master, "Ledger-text").version > 1, "a changed element's version still goes up");
  });
});

test("a direct file write with bookkeeping stripped, landing during the human's commit, merges only its edits", async () => {
  let dir;
  let raced = null;
  const onStep = async (step, { branch }) => {
    if (step === "after-history" && branch.author === HUMAN && raced) {
      await writeFile(path.join(dir, "rc", "file.excalidraw"), `${JSON.stringify({ type: "excalidraw", version: 2, source: "an editor", elements: raced, appState: {}, files: {} }, null, 2)}\n`, "utf8");
      raced = null;
    }
  };
  await withStore({ testHooks: { onStep } }, async (store, folder) => {
    dir = folder;
    const v0 = await store.submitBranch("rc/file", { author: SEED_AUTHOR, base: null, writtenAt: T0, elements: demoBoard() });
    const before = (await masterOf(dir, "rc/file", store)).elements;
    raced = agentEdits(llmResend(before, "external"));
    const human = await store.submitBranch("rc/file", { author: HUMAN, base: v0.version, writtenAt: T0 + 10_000, elements: humanEditsWithText(before) });
    assert.equal(human.status, "committed");
    await store.whenIdle();
    const state = await store.readState("rc/file");
    // A direct write is not stamped (it keeps its bytes); its untouched copies still lose to master's.
    checkMaster((await masterOf(dir, "rc/file", store)).elements, before, "direct write", null);
    const authors = Object.fromEntries(Object.entries(state.masterMeta).map(([id, stamp]) => [id, stamp.author]));
    for (const id of ["API", "Ledger-text", "Queue-text", "owner-note"]) assert.equal(authors[id], "external", `direct write: ${id}`);
    for (const id of ["Analytics", "Orders"]) assert.equal(authors[id], HUMAN, `direct write: ${id}`);
    for (const id of ["Client", "Payments", "Notify-text", "Client_API"]) assert.equal(authors[id], SEED_AUTHOR, `direct write: untouched ${id}`);
  });
});

test("a direct file write re-saving the board without bookkeeping is adopted with it filled back in", async () => {
  await withStore({}, async (store, dir) => {
    await store.submitBranch("rc/adopt", { author: SEED_AUTHOR, base: null, writtenAt: T0, elements: demoBoard() });
    const before = (await masterOf(dir, "rc/adopt", store)).elements;
    await writeFile(path.join(dir, "rc", "adopt.excalidraw"), `${JSON.stringify({ type: "excalidraw", version: 2, source: "an editor", elements: agentEdits(llmResend(before, "external")), appState: {}, files: {} })}\n`, "utf8");
    const adopted = await store.adoptExternal("rc/adopt");
    assert.deepEqual(unitIds(adopted.applied), AGENT_UNITS);
    await store.whenIdle();
    const master = (await masterOf(dir, "rc/adopt", store)).elements;
    for (const original of before) {
      for (const key of ["seed", "index", "created"]) assert.equal(byId(master, original.id)[key], original[key], `${original.id}.${key}`);
    }
  });
});

const withApi = async (fn) => {
  const boardsDir = path.resolve(".test-run", `bookkeeping-api-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(boardsDir, { recursive: true });
  const api = createBoardApi({ boardsDir, pollMs: 0, useFsWatch: false });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = (method, url, body, headers = {}) => fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (response) => ({ httpStatus: response.status, ...(await response.json()) }));
  const scene = (elements) => ({ type: "excalidraw", version: 2, source: "test", elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} });
  const put = (board, ifMatch, elements, tab) => json("PUT", `/api/board/${board}`, scene(elements), { "If-Match": `"${ifMatch}"`, "X-Xcld-Author-Name": "Hana", "X-Xcld-Tab": tab });
  const read = async (board) => {
    const response = await fetch(`${base}/api/board/${board}`);
    return { version: response.headers.get("etag")?.replace(/"/g, ""), scene: await response.json() };
  };
  try {
    await fn({ api, base, json, put, read });
  } finally {
    await api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true, maxRetries: 5 });
  }
};

test("over HTTP: POST /api/branch and a tab PUT, each re-sending the board stripped, next to another tab's edits", async () => {
  await withApi(async ({ api, json, put, read }) => {
    for (const writer of ["branch", "put"]) {
      const board = `rc/http-${writer}`;
      const seeded = await json("POST", `/api/branch/${board}`, { author: SEED_AUTHOR, base: null, writtenAt: T0, elements: demoBoard() });
      assert.equal(seeded.httpStatus, 200);
      const v0 = await read(board);
      const before = v0.scene.elements;
      const human = await put(board, v0.version, humanEditsWithText(before), "tab1");
      assert.equal(human.httpStatus, 200);
      const stripped = agentEdits(llmResend(before, writer === "put" ? "human:Hana#tab2" : AGENT));
      const answer = writer === "branch"
        ? await json("POST", `/api/branch/${board}`, { author: AGENT, base: v0.version, writtenAt: Date.now(), elements: stripped })
        : await put(board, v0.version, stripped, "tab2");
      assert.equal(answer.httpStatus, 200, JSON.stringify(answer));
      assert.deepEqual(unitIds(answer.applied), AGENT_UNITS, `${writer}: exactly the 4 edited units`);
      assert.deepEqual(answer.overwritten, [], `${writer}: nothing overwritten`);
      await api.versions.whenIdle();
      const master = (await read(board)).scene.elements;
      const author = writer === "put" ? "human:Hana#tab2" : AGENT;
      if (writer === "branch") {
        checkMaster(master, before, writer);
      } else {
        assert.deepEqual(master.filter((element) => element.customData?.xcldOrigin?.canvas?.author === author).map((element) => element.id).sort(), ["API", "Ledger-text", "Queue-text"]);
      }
      const state = await api.versions.readState(board);
      checkMeta(state.masterMeta, author, HUMAN, writer);
    }
  });
});

test("a Mermaid write next to a human edit applies only the node it changes; untouched units keep their stamps", needsParser, async () => {
  await withApi(async ({ api, json, put, read }) => {
    const fixture = JSON.parse(await readFile(path.join(rootDir, "tests", "fixtures", "mermaid-apply-base.excalidraw"), "utf8"));
    const board = "rc/mermaid";
    await json("POST", `/api/branch/${board}`, { author: SEED_AUTHOR, base: null, writtenAt: T0, elements: fixture.elements });
    const v0 = await read(board);
    const before = v0.scene.elements;
    const human = await put(board, v0.version, patch(before, "C", { x: byId(before, "C").x + 40, version: byId(before, "C").version + 1 }), "tab1");
    assert.equal(human.httpStatus, 200);
    const mermaid = fixture.mermaid.replace('A["Start"]', 'A["Begin"]');
    const written = await json("POST", `/api/mermaid/${board}`, { author: AGENT, base: v0.version, writtenAt: Date.now(), mermaid });
    assert.equal(written.httpStatus, 200, JSON.stringify(written));
    assert.deepEqual(unitIds(written.applied), ["A"]);
    assert.deepEqual(written.overwritten, []);
    await api.versions.whenIdle();
    const master = (await read(board)).scene.elements;
    assert.equal(byId(master, "C").x, byId(before, "C").x + 40, "the human's move survives");
    const meta = (await api.versions.readState(board)).masterMeta;
    for (const element of before) {
      const stored = byId(master, element.id);
      for (const key of ["seed", "created"]) assert.equal(stored[key], element[key], `${element.id}.${key}`);
      if (element.id === "C" || element.containerId === "C") assert.equal(meta[element.id].author, HUMAN);
      else if (element.id === "A" || element.containerId === "A") assert.equal(meta[element.id].author, AGENT, `${element.id} attributed to the Mermaid write`);
      else assert.equal(meta[element.id].author, SEED_AUTHOR, `untouched ${element.id} keeps its attribution`);
    }
  });
});
