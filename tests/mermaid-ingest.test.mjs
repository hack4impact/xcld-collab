import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { createBoardApi } from "../app/server/api.mjs";
import { diffElements, formatDiff } from "../tools/diff.mjs";
import { mermaidSourceHash } from "../tools/mermaid-hash.mjs";
import { stampCanvasEdits } from "../tools/mermaid-origin.mjs";
import { sceneToMermaid } from "../tools/to-mermaid.mjs";

// Mermaid ingestion (slice 6a): the inbox merges instead of replacing, placement of a new
// group, pending writes (a tab during the backoff, or the server's grid after it, and a restart
// in between), named sources, the no-op re-ingest, and the dual origin of a shape.
const rootDir = path.resolve(".");
const needsParser = { skip: !existsSync(path.join(rootDir, "tools", "mermaid-parse.bundle.mjs")) && "Run cd app; npm ci; npm run build first (Mermaid parser bundle)." };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  return check();
};

// mermaid-apply-base.excalidraw: a real tab conversion of its `mermaid` field (A "Start", the
// "Valid?" diamond B, C in subgraph G, D "Fix input"); its elements stand in for what a tab posts.
const BASE = JSON.parse(await readFile(path.join(rootDir, "tests", "fixtures", "mermaid-apply-base.excalidraw"), "utf8"));
const SOURCE = BASE.mermaid;
const AGENT = "agent:copilot-cli#6a6a6a";
const HUMAN = { "X-Xcld-Author-Name": "Ada", "X-Xcld-Tab": "t1" };
const SHAPES = new Set(["rectangle", "diamond", "ellipse"]);
const live = (scene) => scene.elements.filter((element) => !element.isDeleted);
const labelOf = (scene, containerId) => live(scene).find((element) => element.type === "text" && element.containerId === containerId)?.originalText ?? null;
const boxOf = (element) => ({ x: element.x, y: element.y, w: element.width, h: element.height });
const overlaps = (left, right, clearance = 0) => left.x < right.x + right.w + clearance && right.x < left.x + left.w + clearance && left.y < right.y + right.h + clearance && right.y < left.y + left.h + clearance;
const originOf = (element) => element?.customData?.xcldOrigin;

// A human's drawing: two boxes with labels and an arrow, nothing from Mermaid.
const handDrawn = () => {
  const box = (id, x, y, text) => [
    { id, type: "rectangle", x, y, width: 220, height: 100, angle: 0, strokeColor: "#1971c2", backgroundColor: "#a5d8ff", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 2, versionNonce: 2, isDeleted: false, boundElements: [{ type: "text", id: `${id}-t` }], updated: 1, link: null, locked: false },
    { id: `${id}-t`, type: "text", x: x + 20, y: y + 37, width: 180, height: 25, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 2, version: 2, versionNonce: 3, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, text, fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: id, originalText: text, autoResize: true, lineHeight: 1.25 },
  ];
  return [...box("mine", 0, 0, "My idea"), ...box("notes", 400, 60, "Notes")];
};

const withApi = async (options, fn, { boardsDir: givenDir } = {}) => {
  const boardsDir = givenDir ?? path.resolve(".test-run", `mermaid-ingest-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(boardsDir, { recursive: true });
  const api = createBoardApi({ boardsDir, pollMs: 0, useFsWatch: false, ...options });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = (method, url, body, headers = {}) => fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const writeMermaid = async (board, body) => {
    const response = await json("POST", `/api/mermaid/${board}`, { author: AGENT, ...body });
    return { httpStatus: response.status, ...(await response.json()) };
  };
  // What a tab does with a pending write: GET ?pending, convert, POST ?layout=<id>.
  const pendingOf = async (board) => (await (await fetch(`${base}/api/mermaid/${board}?pending`)).json()).pending;
  const tabLayout = async (board, id, elements = BASE.elements, hash = mermaidSourceHash(SOURCE)) => {
    const response = await json("POST", `/api/mermaid/${board}?layout=${id}`, { hash, elements: structuredClone(elements), files: {} });
    return { httpStatus: response.status, ...(await response.json()) };
  };
  const statusOf = async (board, id) => {
    const response = await fetch(`${base}/api/mermaid/${board}?id=${id}`);
    return { httpStatus: response.status, ...(await response.json()) };
  };
  const read = async (board) => {
    const response = await fetch(`${base}/api/board/${board}`);
    return { version: response.headers.get("etag")?.replace(/"/g, "") ?? null, scene: response.ok ? await response.json() : null };
  };
  const save = async (board, version, scene) => {
    const response = await json("PUT", `/api/board/${board}`, { type: "excalidraw", version: 2, source: "test", appState: {}, files: {}, ...scene }, { ...HUMAN, ...(version ? { "If-Match": `"${version}"` } : { "If-None-Match": "*" }) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const master = async (board) => JSON.parse(await readFile(path.join(boardsDir, ...`${board}.excalidraw`.split("/")), "utf8"));
  const metas = async (board) => {
    const folder = path.join(boardsDir, ".xcld", "history", ...board.split("/"));
    const names = (await readdir(folder)).filter((name) => name.endsWith(".meta.json")).sort();
    return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(folder, name), "utf8"))));
  };
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
    await fn({ api, base, boardsDir, writeMermaid, pendingOf, tabLayout, statusOf, read, save, master, metas, events });
  } finally {
    controller.abort();
    await api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (!givenDir) await rm(boardsDir, { recursive: true, force: true, maxRetries: 5 });
  }
};
// A board a tab converted from SOURCE (main), with its inbox.
const seedConverted = async (boardsDir, board) => {
  const { mermaid: _source, ...scene } = BASE;
  const file = path.join(boardsDir, ...`${board}.excalidraw`.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(scene, null, 2)}\n`, "utf8");
  await writeFile(path.join(boardsDir, ...`${board}.mmd`.split("/")), SOURCE, "utf8");
};
const SLOW = { retryScheduleMs: [60_000, 120_000, 180_000, 240_000] };
const assertClear = (scene, humanIds, label) => {
  const human = live(scene).filter((element) => humanIds.includes(element.id) && element.type === "rectangle");
  const added = live(scene).filter((element) => SHAPES.has(element.type) && !humanIds.includes(element.id));
  assert.ok(added.length > 0, `${label}: shapes were added`);
  for (const shape of added) {
    for (const mine of human) assert.equal(overlaps(boxOf(shape), boxOf(mine), 20), false, `${label}: ${shape.id} overlaps ${mine.id}`);
  }
};

test("stampCanvasEdits: an unchanged element keeps the base's stamps, a changed one gets canvas, a new one is kept as sent", () => {
  const origin = { mermaid: { source: "main", nodeId: "A", hash: "m1-a" }, canvas: null, active: "mermaid" };
  const base = [
    { id: "A", type: "rectangle", x: 0, y: 0, version: 2, customData: { xcldMermaidHash: "m1-a", xcldOrigin: origin } },
    { id: "B", type: "rectangle", x: 0, y: 0, version: 2, customData: { xcldMermaidHash: "m1-a", xcldOrigin: origin } },
    { id: "H", type: "rectangle", x: 0, y: 0, version: 1 },
  ];
  // A tab that never saw the stamps: A unchanged (only the legacy hash), B moved, a new copy, H untouched.
  const branch = [
    { id: "A", type: "rectangle", x: 0, y: 0, version: 2, customData: { xcldMermaidHash: "m1-a" } },
    { id: "B", type: "rectangle", x: 9, y: 0, version: 3, customData: { xcldMermaidHash: "m1-a" } },
    { id: "copy", type: "rectangle", x: 50, y: 0, version: 1, customData: { xcldMermaidHash: "m1-a", xcldOrigin: origin } },
    base[2],
  ];
  const out = stampCanvasEdits({ base, branch, author: "human:Ada#t1", at: 123 });
  assert.deepEqual(out[0].customData, base[0].customData, "unchanged: the base's origin comes back");
  assert.deepEqual(out[1].customData.xcldOrigin, { mermaid: origin.mermaid, canvas: { author: "human:Ada#t1", at: 123 }, active: "canvas" });
  assert.equal(out[1].customData.xcldMermaidHash, "m1-a");
  assert.equal(out[2], branch[2], "a new element (a board written in one go, or a copy) is kept as sent");
  assert.equal(out[3], branch[3]);
  assert.equal(stampCanvasEdits({ base, branch: [base[2]], author: "x", at: 1 })[0], base[2]);
  const fresh = [{ id: "A", type: "rectangle", customData: { xcldMermaidHash: "m1-a" } }];
  assert.equal(stampCanvasEdits({ base: [], branch: fresh, author: "cli:seed", at: 1 }), fresh, "nothing to stamp: the same array");
});

test("inbox merge: a tab's conversion joins a hand-drawn board as the agent's write; the human's shapes stay", needsParser, async () => {
  await withApi({ mermaidOptions: SLOW }, async ({ api, writeMermaid, pendingOf, tabLayout, statusOf, read, save, master, metas, events }) => {
    const drawn = handDrawn();
    await save("hand/flow", null, { elements: drawn });
    const writtenAt = Date.now() - 7000;
    const written = await writeMermaid("hand/flow", { writtenAt, mermaid: SOURCE });
    assert.equal(written.httpStatus, 202);
    assert.equal(written.status, "needs-tab");
    assert.equal(written.reason, "board has no Mermaid-origin shapes");
    assert.match(written.pendingId, /^[0-9A-Z]{22}$/);
    assert.equal(written.pending.status, "pending");
    assert.ok(await waitFor(() => events.some((event) => event.kind === "mermaid" && event.id === written.pendingId)), "open tabs are asked to lay it out");
    const [item] = await pendingOf("hand/flow");
    assert.equal(item.id, written.pendingId);
    assert.equal(item.mermaid, SOURCE.replace(/\n?$/, "\n"));
    assert.equal(item.author, AGENT);

    const landed = await tabLayout("hand/flow", item.id);
    assert.equal(landed.httpStatus, 200, JSON.stringify(landed));
    assert.equal(landed.status, "merged");
    assert.equal(landed.via, "tab");
    assert.equal(landed.placement, "below", "a TD diagram goes below the drawing");
    await api.versions.whenIdle();
    const scene = await master("hand/flow");
    for (const element of drawn) {
      const kept = scene.elements.find((candidate) => candidate.id === element.id);
      assert.ok(kept, `${element.id} kept`);
      assert.equal(kept.x, element.x);
      assert.equal(kept.text ?? null, element.text ?? null);
    }
    for (const id of ["A", "B", "C", "D", "G", "A_B", "B_C"]) {
      const element = scene.elements.find((candidate) => candidate.id === id);
      assert.ok(element, `${id} added`);
      assert.deepEqual(originOf(element).mermaid, { source: "main", nodeId: id, hash: mermaidSourceHash(SOURCE) });
      assert.equal(originOf(element).active, "mermaid");
    }
    assert.equal(labelOf(scene, "A"), "Start");
    assert.ok(scene.elements.some((element) => element.id === "A_label"), "bound text gets a stable id");
    assertClear(scene, drawn.map((element) => element.id), "tab layout");
    const minY = Math.min(...live(scene).filter((element) => !drawn.some((own) => own.id === element.id)).map((element) => element.y));
    assert.ok(minY >= 160 + 100, "below the drawing with clearance");
    // Written by the agent that wrote the Mermaid, at its write time.
    const history = await metas("hand/flow");
    assert.deepEqual(history.map((meta) => [meta.author, meta.kind]), [["human:Ada#t1", "json"], [AGENT, "mermaid"]]);
    const state = await api.versions.readState("hand/flow");
    assert.equal(state.masterMeta.A.writtenAt, writtenAt);
    assert.equal(state.masterMeta.A.author, AGENT);
    assert.equal(state.mermaidSources.main.pendingId, item.id);
    assert.equal((await statusOf("hand/flow", item.id)).status, "landed");
    assert.ok(await waitFor(() => events.some((event) => event.event === "mermaid-write" && event.id === item.id && event.status === "landed" && event.via === "tab")));
    // Nothing waits any more, and a second tab's late conversion is refused.
    assert.deepEqual(await pendingOf("hand/flow"), []);
    const late = await tabLayout("hand/flow", item.id);
    assert.equal(late.httpStatus, 409);
    assert.equal(late.status, "landed");
    // The shapes are stamped, so the next write applies on the server with no tab.
    const v1 = await read("hand/flow");
    const next = await writeMermaid("hand/flow", { base: v1.version, mermaid: SOURCE.replace('A["Start"]', 'A["Begin"]') });
    assert.equal(next.httpStatus, 200, JSON.stringify(next));
    assert.deepEqual(next.ops.map((op) => op.op), ["relabel"]);
    await api.versions.whenIdle();
    assert.equal(labelOf(await master("hand/flow"), "A"), "Begin");
    assert.ok((await master("hand/flow")).elements.some((element) => element.id === "mine"));
  });
});

test("inbox on an empty board: the tab's layout is the board, at the converter's coordinates", needsParser, async () => {
  await withApi({ mermaidOptions: SLOW }, async ({ api, boardsDir, writeMermaid, tabLayout, master }) => {
    const created = await writeMermaid("empty/new", { mermaid: SOURCE });
    assert.equal(created.reason, "new board");
    const landed = await tabLayout("empty/new", created.pendingId);
    assert.equal(landed.status, "merged");
    assert.equal(landed.placement, "keep");
    await api.versions.whenIdle();
    const scene = await master("empty/new");
    const fixtureA = BASE.elements.find((element) => element.id === "A");
    const a = scene.elements.find((element) => element.id === "A");
    assert.deepEqual([a.x, a.y], [fixtureA.x, fixtureA.y]);
    // A board file with no live elements counts as empty too.
    await writeFile(path.join(boardsDir, "empty", "blank.excalidraw"), `${JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements: [], appState: {}, files: {} })}\n`, "utf8");
    const blank = await writeMermaid("empty/blank", { mermaid: SOURCE });
    assert.equal(blank.reason, "new board");
    assert.equal((await tabLayout("empty/blank", blank.pendingId)).placement, "keep");
  });
});

test("backoff, then a tab: the write lands from the tab during the backoff and the grid never runs", needsParser, async () => {
  await withApi({ mermaidOptions: { retryScheduleMs: [150, 300, 450, 2500] } }, async ({ api, writeMermaid, tabLayout, statusOf, save, master, metas, events }) => {
    await save("backoff/tab", null, { elements: handDrawn() });
    const written = await writeMermaid("backoff/tab", { mermaid: SOURCE });
    assert.equal(written.httpStatus, 202);
    // The first check (150 ms) finds no tab and asks again.
    assert.ok(await waitFor(() => events.filter((event) => event.kind === "mermaid" && event.id === written.pendingId).length >= 2), "the server checks again during the backoff");
    assert.equal((await statusOf("backoff/tab", written.pendingId)).attempts >= 1, true);
    const landed = await tabLayout("backoff/tab", written.pendingId);
    assert.equal(landed.via, "tab");
    await delay(2700);
    await api.versions.whenIdle();
    const status = await statusOf("backoff/tab", written.pendingId);
    assert.equal(status.status, "landed");
    assert.equal(status.via, "tab");
    assert.equal((await metas("backoff/tab")).filter((meta) => meta.author === AGENT).length, 1, "landed once");
    const shapes = live(await master("backoff/tab")).filter((element) => SHAPES.has(element.type));
    assert.equal(shapes.length, 2 + 5, "the human's two boxes and the diagram's four nodes and subgraph, no copy from the grid");
  });
});

test("backoff, then the grid: with no tab the server lays the diagram out itself, as the agent", needsParser, async () => {
  await withApi({ mermaidOptions: { retryScheduleMs: [40, 80, 120, 200] } }, async ({ api, writeMermaid, statusOf, save, master, metas, read, events }) => {
    const drawn = handDrawn();
    await save("backoff/grid", null, { elements: drawn });
    const writtenAt = Date.now() - 3000;
    const lr = "flowchart LR\n  A[Ingest] --> B{Valid?}\n  B -->|yes| C[Store]\n  B -->|no| D[Reject]\n  subgraph S[Sinks]\n    C\n    D\n  end\n";
    const written = await writeMermaid("backoff/grid", { writtenAt, mermaid: lr });
    assert.equal(written.httpStatus, 202);
    assert.ok(written.pending.layoutAt >= written.pending.receivedAt + 200);
    const status = await waitFor(async () => {
      const current = await statusOf("backoff/grid", written.pendingId);
      return current.status === "landed" ? current : null;
    });
    assert.ok(status, "landed");
    assert.equal(status.via, "grid");
    assert.ok(await waitFor(() => events.filter((event) => event.kind === "mermaid" && event.id === written.pendingId).length === 4), "asked tabs at the write and at each of the three checks");
    await api.versions.whenIdle();
    const scene = await master("backoff/grid");
    assertClear(scene, drawn.map((element) => element.id), "grid");
    const byId = new Map(live(scene).map((element) => [element.id, element]));
    // LR: columns, right of the drawing.
    assert.ok(byId.get("A").x > 620, "right of the drawing");
    const centerX = (id) => byId.get(id).x + byId.get(id).width / 2;
    assert.ok(centerX("A") < centerX("B") && centerX("B") < centerX("C"), "one column per rank");
    assert.equal(centerX("C"), centerX("D"));
    assert.equal(byId.get("B_C").startBinding.elementId, "B");
    assert.equal(byId.get("B_C").endBinding.elementId, "C");
    assert.equal(labelOf(scene, "B_C"), "yes");
    assert.ok(byId.get("S"), "the subgraph container");
    assert.ok(byId.get("C").groupIds.includes("subgraph_group_S"));
    assert.equal(originOf(byId.get("C")).mermaid.source, "main");
    const history = await metas("backoff/grid");
    assert.deepEqual(history.at(-1).author, AGENT);
    assert.equal((await api.versions.readState("backoff/grid")).masterMeta.A.writtenAt, writtenAt);
    // Stamped like a server apply: the next write applies node by node.
    const v1 = await read("backoff/grid");
    const next = await writeMermaid("backoff/grid", { base: v1.version, mermaid: lr.replace("C[Store]", "C[Archive]") });
    assert.equal(next.httpStatus, 200);
    assert.deepEqual(next.ops.map((op) => op.op), ["relabel"]);
  });
});

test("a server restart during the backoff resumes from the journal: nothing lost, nothing twice", needsParser, async () => {
  const boardsDir = path.resolve(".test-run", `mermaid-restart-${Date.now()}-${process.pid}`);
  try {
    let pendingId;
    const writtenAt = Date.now() - 1000;
    await withApi({ mermaidOptions: { retryScheduleMs: [500, 1000, 1500, 2000] } }, async ({ writeMermaid, save }) => {
      await save("restart/flow", null, { elements: handDrawn() });
      const written = await writeMermaid("restart/flow", { writtenAt, mermaid: SOURCE });
      pendingId = written.pendingId;
    }, { boardsDir });
    const recordFile = path.join(boardsDir, ".xcld", "mermaid-pending", "restart", "flow", `${pendingId}.json`);
    assert.ok(existsSync(recordFile), "the pending write is in the journal");
    const record = await readFile(recordFile, "utf8");
    await withApi({ mermaidOptions: { retryScheduleMs: [50, 100, 150, 250] } }, async ({ api, statusOf, master, metas }) => {
      const status = await waitFor(async () => {
        const current = await statusOf("restart/flow", pendingId);
        return current.status === "landed" ? current : null;
      });
      assert.ok(status, "landed after the restart");
      assert.equal(status.via, "grid");
      await api.versions.whenIdle();
      assert.equal(existsSync(recordFile), false, "the record is gone once it landed");
      const scene = await master("restart/flow");
      assert.equal(labelOf(scene, "A"), "Start");
      assert.equal((await metas("restart/flow")).filter((meta) => meta.author === AGENT).length, 1);
      assert.equal((await api.versions.readState("restart/flow")).masterMeta.A.writtenAt, writtenAt, "the agent's write time survives the restart");
    }, { boardsDir });
    // A crash after the landing commit but before the record was removed: the record comes back
    // on the next start, sees its commit in the state and lands nothing twice.
    await writeFile(recordFile, record, "utf8");
    await withApi({ mermaidOptions: { retryScheduleMs: [50, 100, 150, 250] } }, async ({ api, statusOf, metas }) => {
      await api.mermaids.ready;
      await delay(400);
      await api.versions.whenIdle();
      assert.equal((await statusOf("restart/flow", pendingId)).status, "landed");
      assert.equal(existsSync(recordFile), false);
      assert.equal((await metas("restart/flow")).filter((meta) => meta.author === AGENT).length, 1, "not landed twice");
    }, { boardsDir });
  } finally {
    await rm(boardsDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("two named sources on one board: ids are namespaced, each source's deletes touch only its own shapes", needsParser, async () => {
  await withApi({ mermaidOptions: { retryScheduleMs: [20, 40, 60, 80] } }, async ({ api, boardsDir, writeMermaid, statusOf, master }) => {
    await seedConverted(boardsDir, "two/sources");
    const flow = "flowchart LR\n  A[One] --> B[Two]\n  B --> C[Three]\n";
    const written = await writeMermaid("two/sources", { mermaid: flow, source: "flow" });
    assert.equal(written.httpStatus, 202);
    assert.equal(written.source, "flow");
    assert.equal(written.reason, "board has no shapes from Mermaid source flow");
    assert.ok(await waitFor(async () => (await statusOf("two/sources", written.pendingId)).status === "landed"));
    await api.versions.whenIdle();
    let scene = await master("two/sources");
    const ids = new Set(live(scene).map((element) => element.id));
    for (const id of ["A", "B", "C", "D", "flow:A", "flow:B", "flow:C", "flow:A_B", "flow:B_C"]) assert.ok(ids.has(id), `${id} on the board`);
    const mainRight = Math.max(...live(scene).filter((element) => SHAPES.has(element.type) && !element.id.startsWith("flow:")).map((element) => element.x + element.width));
    assert.ok(scene.elements.find((element) => element.id === "flow:A").x > mainRight, "an LR source goes right of the drawing");
    assert.equal(labelOf(scene, "flow:A"), "One");
    assert.equal(labelOf(scene, "A"), "Start");
    // main loses D: only main's D and its edges go.
    const withoutD = SOURCE.replace('  B -->|no| D["Fix\ninput"]\n', "").replace("  D --> B\n", "").replace(/\n  class D hot\n?/, "\n");
    const mainWrite = await writeMermaid("two/sources", { mermaid: withoutD });
    assert.equal(mainWrite.httpStatus, 200, JSON.stringify(mainWrite));
    assert.deepEqual(mainWrite.ops.filter((op) => op.op === "delete").map((op) => op.id).sort(), ["B_D", "D", "D_B"]);
    // flow loses C: only flow's C and its edge go; main's C stays.
    const flowWrite = await writeMermaid("two/sources", { mermaid: "flowchart LR\n  A[One] --> B[Two]\n", source: "flow" });
    assert.equal(flowWrite.httpStatus, 200, JSON.stringify(flowWrite));
    assert.deepEqual(flowWrite.ops.filter((op) => op.op === "delete").map((op) => op.id).sort(), ["flow:B_C", "flow:C"]);
    await api.versions.whenIdle();
    scene = await master("two/sources");
    const after = new Set(live(scene).map((element) => element.id));
    assert.ok(after.has("C") && after.has("flow:A") && after.has("flow:B"));
    assert.ok(!after.has("D") && !after.has("flow:C"));
    const state = await api.versions.readState("two/sources");
    assert.deepEqual(Object.keys(state.mermaidSources).sort(), ["flow", "main"]);
    assert.equal(state.mermaidSources.flow.hash, mermaidSourceHash("flowchart LR\n  A[One] --> B[Two]\n"));
    assert.equal(state.mermaid.hash, mermaidSourceHash(withoutD), "main keeps the legacy record too");
    // An invalid source name or position is refused before anything is written.
    assert.equal((await writeMermaid("two/sources", { mermaid: flow, source: "no spaces" })).error, "invalid-source");
    assert.equal((await writeMermaid("two/sources", { mermaid: flow, position: "above" })).error, "invalid-position");
  });
});

test("re-ingesting the identical document is a no-op; a pending write isn't queued twice", needsParser, async () => {
  await withApi({ mermaidOptions: SLOW }, async ({ api, boardsDir, writeMermaid, read, metas, save }) => {
    await seedConverted(boardsDir, "same/doc");
    const v0 = await read("same/doc");
    const edited = SOURCE.replace('A["Start"]', 'A["Begin"]');
    const first = await writeMermaid("same/doc", { base: v0.version, mermaid: edited });
    assert.equal(first.status, "merged");
    await api.versions.whenIdle();
    const entries = (await metas("same/doc")).length;
    const again = await writeMermaid("same/doc", { mermaid: `${edited}\n\n` });
    assert.equal(again.httpStatus, 200);
    assert.equal(again.noop, true);
    assert.equal(again.version, first.version);
    await api.versions.whenIdle();
    assert.equal((await metas("same/doc")).length, entries, "no history entry");
    assert.equal((await read("same/doc")).version, first.version);
    await save("same/hand", null, { elements: handDrawn() });
    const pending = await writeMermaid("same/hand", { mermaid: SOURCE, source: "s2" });
    const repeat = await writeMermaid("same/hand", { mermaid: SOURCE, source: "s2" });
    assert.equal(repeat.pendingId, pending.pendingId);
  });
});

test("dual origin: a human edit makes canvas active; a Mermaid write that changes the node wins it back and the human version goes to history", needsParser, async () => {
  await withApi({ mermaidOptions: SLOW }, async ({ api, boardsDir, writeMermaid, read, save, master, metas }) => {
    await seedConverted(boardsDir, "dual/flow");
    const v0 = await read("dual/flow");
    const scene = structuredClone(v0.scene);
    const text = scene.elements.find((element) => element.containerId === "A");
    Object.assign(text, { text: "Human start", originalText: "Human start", version: text.version + 1 });
    // The tab never saw the server's stamps: its elements carry the legacy hash only.
    const saved = await save("dual/flow", v0.version, scene);
    await api.versions.whenIdle();
    let current = await master("dual/flow");
    const humanText = current.elements.find((element) => element.containerId === "A");
    assert.equal(originOf(humanText).active, "canvas");
    assert.equal(originOf(humanText).canvas.author, "human:Ada#t1");
    assert.equal(originOf(humanText).mermaid.source, "main");
    const untouched = current.elements.find((element) => element.containerId === "B");
    assert.equal(originOf(untouched), undefined, "an element the human didn't change isn't stamped");
    // The human's next save, from a tab that still lacks the stamp, doesn't undo it.
    const moved = structuredClone(current);
    const noteBox = moved.elements.find((element) => element.id === "B");
    noteBox.x += 5;
    moved.elements.find((element) => element.containerId === "A").customData = { xcldMermaidHash: mermaidSourceHash(SOURCE) };
    await save("dual/flow", saved.version, moved);
    await api.versions.whenIdle();
    current = await master("dual/flow");
    assert.equal(originOf(current.elements.find((element) => element.containerId === "A")).active, "canvas", "survives a tab save");
    assert.equal(originOf(current.elements.find((element) => element.id === "B")).active, "canvas", "a move is a canvas edit");
    // to-mermaid and diff show the active origin.
    assert.match(sceneToMermaid(current), /%% Active origin of A: canvas edit by human:Ada \(over Mermaid main:A\)/);
    assert.match(formatDiff(diffElements(v0.scene.elements, current.elements)), /relabeled "Start" -> "Human start" \(A\) \[canvas edit by human:Ada/);

    // A Mermaid write that leaves A as it was keeps the human's label.
    const otherChange = SOURCE.replace('D["Fix\ninput"]', 'D["Fix it"]');
    const keep = await writeMermaid("dual/flow", { mermaid: otherChange });
    assert.equal(keep.status, "merged");
    assert.ok(keep.ops.some((op) => op.op === "keep-canvas" && op.id === "A"), JSON.stringify(keep.ops));
    assert.ok(!keep.ops.some((op) => op.op === "relabel" && op.id === "A"));
    assert.deepEqual(keep.overwritten, []);
    await api.versions.whenIdle();
    assert.equal(labelOf(await master("dual/flow"), "A"), "Human start");
    // A Mermaid write that changes A wins: Mermaid is active again, the human version is overwritten.
    const wins = await writeMermaid("dual/flow", { mermaid: otherChange.replace('A["Start"]', 'A["Agent start"]') });
    assert.equal(wins.status, "merged");
    assert.deepEqual(wins.overwritten.map((item) => [item.unitId, item.winner.author, item.loser.author]), [["A", AGENT, "human:Ada#t1"]]);
    await api.versions.whenIdle();
    current = await master("dual/flow");
    assert.equal(labelOf(current, "A"), "Agent start");
    const agentText = current.elements.find((element) => element.containerId === "A");
    assert.equal(originOf(agentText).active, "mermaid");
    assert.equal(originOf(agentText).canvas.author, "human:Ada#t1", "the last canvas edit is still recorded");
    const last = (await metas("dual/flow")).at(-1);
    assert.equal(last.author, AGENT);
    const loss = last.overwritten.find((item) => item.unitId === "A");
    assert.ok(loss, "the human version is in history as overwritten");
    assert.equal(loss.loser.author, "human:Ada#t1");
    assert.ok(loss.loser.elements.some((element) => element.originalText === "Human start"));
  });
});

test("a different diagram under the same source is an edit of it; the answer suggests a new source name", needsParser, async () => {
  await withApi({ mermaidOptions: SLOW }, async ({ boardsDir, writeMermaid }) => {
    await seedConverted(boardsDir, "other/diagram");
    const result = await writeMermaid("other/diagram", { mermaid: "flowchart TD\n  X[Other] --> Y[Diagram]\n" });
    assert.equal(result.status, "merged");
    assert.equal(result.hint.suggestSource, "diagram-2");
    assert.equal(result.hint.deletes, 5);
    assert.match(result.hint.message, /deletes 5 of the 5 nodes and subgraphs of source "main"/);
  });
});

test("position hints: right, and near a node of the drawing", needsParser, async () => {
  await withApi({ mermaidOptions: SLOW }, async ({ api, writeMermaid, tabLayout, save, master }) => {
    await save("pos/right", null, { elements: handDrawn() });
    const right = await writeMermaid("pos/right", { mermaid: SOURCE, position: "right" });
    assert.equal(right.pending.position, "right");
    assert.equal((await tabLayout("pos/right", right.pendingId)).placement, "right");
    await api.versions.whenIdle();
    const scene = await master("pos/right");
    assert.ok(scene.elements.find((element) => element.id === "A").x >= 620 + 100);
    await save("pos/near", null, { elements: handDrawn() });
    const near = await writeMermaid("pos/near", { mermaid: SOURCE, position: "near:mine" });
    assert.equal((await tabLayout("pos/near", near.pendingId)).placement, "near");
    await api.versions.whenIdle();
    assertClear(await master("pos/near"), handDrawn().map((element) => element.id), "near");
  });
});

test("a non-flowchart waits for a tab after the schedule; a rewrite of its source replaces only that source", needsParser, async () => {
  await withApi({ mermaidOptions: { retryScheduleMs: [20, 40, 60, 80] } }, async ({ api, writeMermaid, tabLayout, statusOf, save, master }) => {
    await save("seq/board", null, { elements: handDrawn() });
    const sequence = "sequenceDiagram\n  A->>B: hi\n";
    const written = await writeMermaid("seq/board", { mermaid: sequence, source: "talk" });
    assert.equal(written.pending.flowchart, false);
    assert.ok(await waitFor(async () => (await statusOf("seq/board", written.pendingId)).status === "waiting-for-tab"));
    const converted = [
      { id: "actor-a", type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
      { id: "actor-b", type: "rectangle", x: 200, y: 0, width: 100, height: 50 },
    ];
    const landed = await tabLayout("seq/board", written.pendingId, converted, mermaidSourceHash(sequence));
    assert.equal(landed.status, "merged");
    await api.versions.whenIdle();
    const first = await master("seq/board");
    const placedAt = first.elements.find((element) => element.id === "talk:actor-a");
    assert.ok(placedAt, "namespaced");
    const rewrite = "sequenceDiagram\n  A->>B: bye\n";
    const second = await writeMermaid("seq/board", { mermaid: rewrite, source: "talk" });
    assert.equal(second.httpStatus, 202);
    const replaced = await tabLayout("seq/board", second.pendingId, [{ id: "actor-c", type: "ellipse", x: 500, y: 500, width: 80, height: 80 }], mermaidSourceHash(rewrite));
    assert.equal(replaced.placement, "replace");
    await api.versions.whenIdle();
    const after = await master("seq/board");
    const ids = live(after).map((element) => element.id);
    assert.ok(!ids.includes("talk:actor-a") && !ids.includes("talk:actor-b"), "the source's old shapes are replaced");
    assert.ok(ids.includes("mine") && ids.includes("notes"), "the human's shapes stay");
    const c = after.elements.find((element) => element.id === "talk:actor-c");
    assert.deepEqual([c.x, c.y], [placedAt.x, placedAt.y], "where the old group was");
  });
});

test("xcld write-mermaid --source/--position and xcld mermaid-status", needsParser, async () => {
  await withApi({ mermaidOptions: SLOW }, async ({ base, boardsDir, save }) => {
    await save("cli/hand", null, { elements: handDrawn() });
    const file = path.join(boardsDir, "flow.mmd");
    await writeFile(file, "flowchart LR\n  A --> B\n", "utf8");
    const run = (args) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(rootDir, "tools", "cli.mjs"), ...args], { cwd: rootDir, env: { ...process.env, XCLD_API_URL: base, XCLD_BOARDS_DIR: boardsDir, XCLD_AUTHOR: "docs-bot" } });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("close", (code) => resolve({ code, stdout }));
    });
    const written = await run(["write-mermaid", "cli/hand", file, "--source", "side", "--position", "below", "--json"]);
    assert.equal(written.code, 0, written.stdout);
    const result = JSON.parse(written.stdout);
    assert.equal(result.status, "needs-tab");
    assert.equal(result.source, "side");
    assert.equal(result.pending.position, "below");
    assert.equal(result.pending.author, "cli:docs-bot");
    const status = await run(["mermaid-status", "cli/hand", result.pendingId]);
    assert.equal(status.code, 0);
    assert.match(status.stdout, /^Pending on cli\/hand \(source "side"\)/);
  });
});
