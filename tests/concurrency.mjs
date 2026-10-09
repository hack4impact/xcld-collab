// Concurrency acceptance test (versions and merge, slice 6b; docs/DESIGN.md#concurrency-acceptance).
//
// A seeded scheduler drives three writers against one board on a real in-process server, over
// HTTP, interleaved at random:
//   - a human tab: local edits, PUT with If-Match <base>, author headers and X-Xcld-Edit-Age;
//     it saves before it accepts a reload, adopts the merged master a save answers with, and
//     sometimes presses Ctrl+S (POST .../checkpoint);
//   - a JSON agent: GET for a base (sometimes an older read: stale), POST /api/branch;
//   - a Mermaid agent: the default source `main` (its inbox .mmd follows each write) and a named
//     source `beta`, POST /api/mermaid with a base and a write time that is sometimes seconds
//     old (a write that sat in a queue).
// Every write's changes carry unique labels (tokens), so the end state can be checked:
//   (a) no silent loss: each change is in master, or kept in history as an overwritten loser, or
//       was replaced by a later write whose base already had it;
//   (b) history rebuilds each entry (checkpoints + deltas) to its version id, matches every scene
//       the server handed out for that version, and has an entry for every author turn;
//   (c) every overwritten unit in history is in a `merged` SSE event (the banner's payload) and in
//       `diff --since` from the end of the setup;
//   (d) D8: once per seed, a queued Mermaid write with a stale base and an older write time loses
//       the unit the human edited since, while its disjoint edit applies;
//   (e) D3: the same seed gives the same final master (the caller runs a seed twice);
//   (f) bookkeeping is not an edit: the JSON agent sometimes re-sends what it read with Excalidraw's
//       bookkeeping dropped, nulled or changed and the origin stamp redone (as LLMs do); its writes
//       still apply and win only the units it changed, and master keeps every element's seed,
//       version and nonce (and index);
//   (g) arrow styles: the human also restyles the setup arrows (dashed, dotted, straight, elbow,
//       arrowheads, width, colour), and the Mermaid agent sometimes writes its edges as it read them
//       on the board (to-mermaid's forms and curves, as read_board shows them). A style is in
//       master, or kept in history as overwritten, or replaced by a later write that saw it: (a).
//   (h) the upgrade path: the setup board has hand-drawn shapes with "-" in their ids and unstamped shapes
//       an earlier build converted from Mermaid (converter ids); no Mermaid write deletes, copies
//       (`_2`) or takes them.
// A `queued` answer (a slow disk: issue #9) is correct behaviour; the writer waits for the landing.
//
// Determinism: a virtual clock (the version store's `now`), every random choice from the seed, and
// a fixed arrival order: the scheduler waits until each write is in the journal before the next
// step (commits still run concurrently with later writes and queue up behind each other), and a
// read waits until earlier writes have landed, so it sees a defined master.
//
// Run it alone: node tests/concurrency.mjs [--seeds 200] [--start 1] [--steps 24] [--parallel 4]
// The default suite (tests/concurrency.test.mjs) runs 50 seeds, each twice.
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBoardApi } from "../app/server/api.mjs";
import { canonicalText, contentHash } from "../app/server/versions.mjs";
import { edgeForm, edgeOperator } from "../tools/edge-style.mjs";
import { openHistory } from "../tools/history.mjs";

export const DEFAULT_STEPS = 24;
const BOARD = "sim/board";
const START = Date.UTC(2026, 9, 7, 12, 0, 0);
const HUMAN = "human:Hana#tab1";
const HUMAN_HEADERS = { "X-Xcld-Author-Name": "Hana", "X-Xcld-Tab": "tab1" };
const JSON_AGENT = "agent:sim-json#j1";
const MERMAID_AGENT = "agent:sim-mermaid#m1";
const SHAPES = new Set(["rectangle", "diamond", "ellipse"]);

const mulberry32 = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const live = (elements) => (elements ?? []).filter((element) => element && !element.isDeleted);
const textOf = (element) => element?.originalText ?? element?.text ?? null;
// A unit: a shape and its bound text. `label` is null when the shape is gone.
const unitState = (scene, unitId) => {
  const elements = live(scene?.elements);
  const shape = elements.find((element) => element.id === unitId);
  if (!shape) return { present: false, label: null };
  const text = elements.find((element) => element.type === "text" && element.containerId === unitId);
  return { present: true, label: textOf(text) };
};
const labeledUnits = (scene) => live(scene?.elements).filter((element) => SHAPES.has(element.type) && live(scene.elements).some((text) => text.type === "text" && text.containerId === element.id)).map((element) => element.id).sort();
const short = (version) => (version ? version.slice(0, 8) : "none");

const unitElements = (id, x, y, label, nonce) => [
  { id, type: "rectangle", x, y, width: 180, height: 80, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: nonce, version: 1, versionNonce: nonce, isDeleted: false, boundElements: [{ type: "text", id: `${id}-t` }], updated: START, link: null, locked: false },
  { id: `${id}-t`, type: "text", x: x + 10, y: y + 27, width: 160, height: 25, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: nonce + 1, version: 1, versionNonce: nonce + 1, isDeleted: false, boundElements: null, updated: START, link: null, locked: false, text: label, fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: id, originalText: label, autoResize: true, lineHeight: 1.25 },
];
const relabel = (elements, unitId, label, nonce, at) => elements.map((element) => (element.type === "text" && element.containerId === unitId && !element.isDeleted
  ? { ...element, text: label, originalText: label, version: (element.version ?? 1) + 1, versionNonce: nonce, updated: at }
  : element));
const markDeleted = (elements, unitId, at) => elements.map((element) => (element.id === unitId || element.containerId === unitId ? { ...element, isDeleted: true, version: (element.version ?? 1) + 1, updated: at } : element));
const omit = (elements, unitId) => elements.filter((element) => element.id !== unitId && element.containerId !== unitId);
// What an LLM does to bookkeeping it re-sends (the real check, 2026-10-08): `drop` leaves the
// fields out, `null` sets them to null, `perturb` changes them; the origin stamp is redone or lost.
const BOOKKEEPING = ["seed", "created", "index", "updated", "versionNonce"];
const perturbBookkeeping = (element, mode, { nonce, at }) => {
  const copy = { ...element };
  for (const key of BOOKKEEPING) {
    if (mode === "drop") delete copy[key];
    else if (mode === "null") copy[key] = null;
  }
  if (mode === "perturb") Object.assign(copy, { version: (copy.version ?? 1) + 1, versionNonce: nonce(), seed: nonce(), updated: at });
  else copy.version = (copy.version ?? 1) + 1;
  if (copy.customData?.xcldOrigin) {
    const { xcldOrigin, ...rest } = copy.customData;
    copy.customData = mode === "drop" ? rest : { ...rest, xcldOrigin: { ...xcldOrigin, canvas: { author: JSON_AGENT, at }, active: "canvas" } };
  }
  return copy;
};

// `shown`: the board the agent read, to write each edge as read_board shows it (to-mermaid's
// form and curve of the arrow there); otherwise every edge is a plain `-->`.
const mermaidText = (model, { shown = null, prefix = "" } = {}) => {
  const arrows = new Map(live(shown?.elements).filter((element) => element.type === "arrow").map((element) => [element.id, element]));
  const curves = [];
  const edges = model.edges.map(([from, to], index) => {
    const arrow = shown ? arrows.get(`${prefix}${from}_${to}`) : null;
    const form = arrow ? edgeForm(arrow) : null;
    if (form?.curve) curves.push(`  e${index}@{ curve: ${form.curve} }`);
    return `  ${from} ${form?.curve ? `e${index}@` : ""}${form ? edgeOperator(form) : "-->"} ${to}`;
  });
  return ["flowchart TD", ...[...model.nodes].map(([id, label]) => `  ${id}["${label}"]`), ...edges, ...curves, ""].join("\n");
};
// Arrow styles a human sets in the tab, and the arrows of the setup it restyles (never deleted).
const STYLE_KEYS = ["strokeStyle", "strokeWidth", "strokeColor", "roundness", "elbowed", "startArrowhead", "endArrowhead"];
const ARROW_STYLES = [
  { strokeStyle: "dashed" }, { strokeStyle: "dotted" }, { strokeStyle: "solid" }, { roundness: null, elbowed: false }, { roundness: { type: 2 }, elbowed: false },
  { elbowed: true, roundness: null }, { endArrowhead: null }, { endArrowhead: "triangle" }, { endArrowhead: "arrow" }, { startArrowhead: "arrow" }, { startArrowhead: null },
  { strokeWidth: 1 }, { strokeWidth: 4 }, { strokeWidth: 2 }, { strokeColor: "#e03131" }, { strokeWidth: 4, strokeStyle: "dashed" }, { endArrowhead: null, strokeStyle: "dashed" },
];
const SETUP_ARROWS = ["A_B", "B_C", "beta:A_B", "beta:B_C"];
const sameStyle = (element, style) => Boolean(element) && Object.entries(style).every(([key, value]) => JSON.stringify(element[key] ?? null) === JSON.stringify(value ?? null));
const cloneModel = (model) => ({ nodes: new Map(model.nodes), edges: model.edges.map((edge) => [...edge]), added: model.added });

const readSse = async (base, events, signal) => {
  const response = await fetch(`${base}/api/events`, { signal });
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let index = buffer.indexOf("\n\n"); index >= 0; index = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event === "merged" && data) events.push(JSON.parse(data));
        }
      }
    } catch {}
  })();
};

/**
 * Runs one seed and checks (a)-(d). Resolves to `{ seed, finalVersion, writes, queued, overwritten,
 * ms }`; throws an AssertionError whose message starts with the seed and ends with the step log.
 */
export const runSeed = async (seed, { steps = DEFAULT_STEPS, dir = path.resolve(".test-run"), writeWaitMs } = {}) => {
  const started = Date.now();
  const rng = mulberry32(seed * 7919 + 17);
  const pick = (items) => items[Math.floor(rng() * items.length)];
  const chance = (p) => rng() < p;
  const int = (low, high) => low + Math.floor(rng() * (high - low + 1));
  let clock = START;
  const now = () => clock;
  const advance = (ms) => {
    clock += ms;
  };
  let tokenCounter = 0;
  const token = (prefix) => `${prefix}${++tokenCounter}`;
  const nonce = () => int(1, 2 ** 30);
  const log = [];
  const note = (line) => log.push(`#${log.length} t+${clock - START} ${line}`);

  const boardsDir = path.join(dir, `concurrency-${seed}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(boardsDir, { recursive: true });
  // The journal hook resolves "this author's write is in the journal" waiters (arrival order).
  const ingestWaiters = new Map();
  const api = createBoardApi({
    boardsDir,
    pollMs: 0,
    useFsWatch: false,
    ...(writeWaitMs ? { writeWaitMs } : {}),
    versionOptions: {
      now,
      testHooks: {
        onStep: (step, info) => {
          if (step === "after-ingest") {
            const waiter = ingestWaiters.get(info.branch.author);
            if (waiter) {
              ingestWaiters.delete(info.branch.author);
              waiter(info.branch);
            }
          }
        },
      },
    },
    mermaidOptions: { retryScheduleMs: [20] },
  });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const events = [];
  await readSse(base, events, controller.signal);

  const writes = [];
  const served = new Map(); // version -> canonical text the server handed out
  const busy = new Map(); // writer -> promise of its request in flight
  // A failed request must fail the seed where it is awaited, not crash the process meanwhile.
  const track = (name, promise) => {
    promise.catch(() => {});
    busy.set(name, promise);
    return promise;
  };
  let queuedCount = 0;

  const waitIngest = (author) => new Promise((resolve) => ingestWaiters.set(author, resolve));
  const quiesce = async () => {
    for (let round = 0; round < 3; round++) {
      await Promise.all([...busy.values()]);
      await api.versions.whenIdle();
    }
  };
  const getBoard = async () => {
    const response = await fetch(`${base}/api/board/${BOARD}`);
    assert.equal(response.status, 200, `GET ${BOARD}`);
    const text = await response.text();
    const version = response.headers.get("etag").replace(/"/g, "");
    served.set(version, text);
    return { version, scene: JSON.parse(text) };
  };
  // Issues a request whose branch arrives as `author`; returns once it is in the journal (or the
  // server answered without journaling it), with the response promise.
  const issue = async (author, request) => {
    const ingested = waitIngest(author);
    const responded = request().then(async (response) => ({ httpStatus: response.status, ...(await response.json()) }));
    const first = await Promise.race([ingested.then((branch) => ({ branch })), responded.then((answer) => ({ answer }))]);
    if (first.answer) ingestWaiters.delete(author);
    return { branch: first.branch ?? null, responded };
  };

  // ---- writers ----
  const human = { local: null, base: null, pending: new Map(), lastEditAt: null, added: [] };
  const jsonAgent = { reads: [], added: [] };
  const mermaidAgent = { reads: [], models: {}, added: { main: [], beta: [] } };

  const humanSave = async (reason) => {
    if (!human.pending.size) return;
    const changes = [...human.pending.values()];
    human.pending.clear();
    const write = { idx: writes.length, writer: "human", author: HUMAN, base: human.base, baseScene: human.baseScene, writtenAt: human.lastEditAt, changes, status: null };
    writes.push(write);
    const scene = { type: "excalidraw", version: 2, source: "xcld-sim", elements: human.local.elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} };
    const { responded } = await issue(HUMAN, () => fetch(`${base}/api/board/${BOARD}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...HUMAN_HEADERS, "If-Match": `"${human.base}"`, "X-Xcld-Edit-Age": String(Math.max(1, clock - human.lastEditAt)) },
      body: JSON.stringify(scene),
    }));
    note(`human save (${reason}) base=${short(human.base)} changes=${changes.map((change) => `${change.unitId}:${change.kind}${change.token ? `=${change.token}` : ""}`).join(",")}`);
    const done = responded.then((answer) => {
      assert.equal(answer.httpStatus, 200, `seed ${seed}: human PUT answered ${JSON.stringify(answer)}`);
      write.status = answer.merged ? "merged" : "fast-forward";
      write.version = answer.version;
      write.answer = answer;
      if (answer.merged) {
        human.local = answer.master;
        served.set(answer.version, canonicalText(answer.master));
      }
      human.base = answer.version;
      human.baseScene = structuredClone(human.local);
    });
    await track("human", done);
  };
  const humanReload = async () => {
    await humanSave("before reload");
    await quiesce();
    const read = await getBoard();
    human.local = read.scene;
    human.base = read.version;
    human.baseScene = structuredClone(read.scene);
    note(`human reload -> ${short(read.version)}`);
  };
  const humanEdit = (forced = null) => {
    const at = clock;
    const units = labeledUnits(human.local);
    const edits = [];
    if (forced) {
      edits.push(forced);
    } else if (chance(0.15) && human.added.length < 4) {
      edits.push({ add: true });
    } else if (chance(0.12) && human.added.some((id) => unitState(human.local, id).present)) {
      edits.push({ delete: pick(human.added.filter((id) => unitState(human.local, id).present)) });
    } else if (chance(0.3) && live(human.local.elements).some((element) => SETUP_ARROWS.includes(element.id))) {
      edits.push({ restyle: pick(live(human.local.elements).filter((element) => SETUP_ARROWS.includes(element.id)).map((element) => element.id)) });
    } else {
      for (let count = int(1, 2); count > 0; count--) edits.push({ relabel: pick(units) });
    }
    for (const edit of edits) {
      if (edit.add) {
        const id = `h${human.added.length + 1}`;
        const label = token("H");
        human.added.push(id);
        human.local = { ...human.local, elements: [...human.local.elements, ...unitElements(id, 40 + human.added.length * 220, 900, label, nonce())] };
        human.pending.set(id, { unitId: id, kind: "add", token: label });
      } else if (edit.delete) {
        human.local = { ...human.local, elements: markDeleted(human.local.elements, edit.delete, at) };
        human.pending.set(edit.delete, { unitId: edit.delete, kind: "delete" });
      } else if (edit.restyle) {
        // Excalidraw's properties panel: the arrow's own style changes and its version bumps.
        const patch = pick(ARROW_STYLES);
        human.local = { ...human.local, elements: human.local.elements.map((element) => (element.id === edit.restyle ? { ...element, ...patch, version: (element.version ?? 1) + 1, versionNonce: nonce(), updated: at } : element)) };
        const arrow = human.local.elements.find((element) => element.id === edit.restyle);
        human.pending.set(edit.restyle, { unitId: edit.restyle, kind: "style", style: Object.fromEntries(STYLE_KEYS.map((key) => [key, arrow[key] ?? null])) });
      } else {
        const label = edit.label ?? token("H");
        human.local = { ...human.local, elements: relabel(human.local.elements, edit.relabel, label, nonce(), at) };
        const before = human.pending.get(edit.relabel);
        human.pending.set(edit.relabel, { unitId: edit.relabel, kind: before?.kind === "add" ? "add" : "label", token: label });
      }
    }
    human.lastEditAt = at;
    note(`human edit ${edits.map((edit) => (edit.add ? "add" : edit.delete ? `delete ${edit.delete}` : edit.restyle ? `restyle ${edit.restyle} ${JSON.stringify(human.pending.get(edit.restyle)?.style)}` : `relabel ${edit.relabel}`)).join(", ")}`);
  };
  const humanCheckpoint = async () => {
    await humanSave("before Ctrl+S");
    const response = await fetch(`${base}/api/board/${BOARD}/checkpoint`, { method: "POST", headers: HUMAN_HEADERS });
    assert.equal(response.status, 200);
    note("human Ctrl+S");
  };

  const agentRead = async (agent, name) => {
    await quiesce();
    const read = await getBoard();
    agent.reads.push({ ...read, at: clock });
    note(`${name} read -> ${short(read.version)}`);
  };
  const chooseRead = (agent) => (agent.reads.length > 1 && chance(0.35) ? pick(agent.reads.slice(0, -1)) : agent.reads.at(-1));

  const settleAgentWrite = (name, write, responded) => responded.then(async (answer) => {
    write.answer = answer;
    if (answer.httpStatus === 202 && answer.status === "queued") {
      queuedCount += 1;
      write.status = "queued";
      write.branchId = answer.branchId;
      // Queued is safe: wait for the landing (the journal holds it).
      await api.versions.whenIdle();
      return;
    }
    assert.equal(answer.httpStatus, 200, `seed ${seed}: ${name} write answered ${JSON.stringify(answer)}`);
    write.status = answer.unchanged ? "unchanged" : "merged";
    write.version = answer.version;
    write.branchId = answer.branchId;
  });

  // `exclude`: units this write must not touch (the D8 scenario's contested and disjoint units).
  const jsonWrite = async ({ exclude = [] } = {}) => {
    if (!jsonAgent.reads.length) await agentRead(jsonAgent, "json");
    const read = chooseRead(jsonAgent);
    let elements = structuredClone(read.scene.elements);
    const changes = [];
    const units = labeledUnits(read.scene).filter((unit) => !exclude.includes(unit));
    if (chance(0.2) && jsonAgent.added.length < 4) {
      const id = `j${jsonAgent.added.length + 1}`;
      const label = token("J");
      jsonAgent.added.push(id);
      elements = [...elements, ...unitElements(id, 40 + jsonAgent.added.length * 220, 1100, label, nonce())];
      changes.push({ unitId: id, kind: "add", token: label });
    }
    const own = jsonAgent.added.filter((id) => unitState(read.scene, id).present && !exclude.includes(id));
    if (chance(0.1) && own.length) {
      const id = pick(own);
      elements = omit(elements, id);
      changes.push({ unitId: id, kind: "delete" });
    }
    for (let count = changes.length ? int(0, 1) : int(1, 3); count > 0; count--) {
      const id = pick(units.filter((unit) => !changes.some((change) => change.unitId === unit)));
      if (!id) break;
      const label = token("J");
      elements = relabel(elements, id, label, nonce(), clock);
      changes.push({ unitId: id, kind: "label", token: label });
    }
    const write = { idx: writes.length, writer: "json", author: JSON_AGENT, base: read.version, baseScene: read.scene, writtenAt: clock, changes, status: null };
    // Like an LLM re-sending the board it read: sometimes the bookkeeping of what it read is
    // dropped, set to null, or changed (none of which is an edit), and the origin stamp redone.
    if (chance(0.5)) {
      const fresh = new Set(changes.filter((change) => change.kind === "add").flatMap((change) => [change.unitId, `${change.unitId}-t`]));
      const mode = pick(["drop", "null", "perturb", "mixed"]);
      elements = elements.map((element) => (fresh.has(element.id) || !chance(0.7) ? element : perturbBookkeeping(element, mode === "mixed" ? pick(["drop", "null", "perturb"]) : mode, { nonce, at: clock })));
      write.perturbed = mode;
    }
    writes.push(write);
    const { responded } = await issue(JSON_AGENT, () => fetch(`${base}/api/branch/${BOARD}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: JSON_AGENT, base: read.version, writtenAt: clock, elements, appState: read.scene.appState }),
    }));
    note(`json write base=${short(read.version)}${read === jsonAgent.reads.at(-1) ? "" : " (stale read)"}${write.perturbed ? ` bookkeeping=${write.perturbed}` : ""} changes=${changes.map((change) => `${change.unitId}:${change.kind}${change.token ? `=${change.token}` : ""}`).join(",")}`);
    // After a write, only reads taken after it count (an agent re-reads before it builds on master).
    jsonAgent.reads = [];
    track("json", settleAgentWrite("json", write, responded));
    return write;
  };

  const mermaidWrite = async ({ forced = null } = {}) => {
    if (!mermaidAgent.reads.length) await agentRead(mermaidAgent, "mermaid");
    const read = forced?.read ?? chooseRead(mermaidAgent);
    const source = forced?.source ?? (chance(0.5) ? "main" : "beta");
    const model = cloneModel(mermaidAgent.models[source]);
    const changes = [];
    // Element ids: a `main` node keeps its Mermaid id, another source's is `<source>:<id>`.
    const idOf = (node) => (source === "main" ? node : `${source}:${node}`);
    if (forced) {
      for (const [node, label] of forced.relabels) {
        model.nodes.set(node, label);
        changes.push({ unitId: idOf(node), kind: "label", token: label });
      }
    } else {
      if (chance(0.2) && mermaidAgent.added[source].length < 3) {
        const node = `N${mermaidAgent.added[source].length + 1}`;
        const label = token("M");
        mermaidAgent.added[source].push(node);
        const from = pick([...model.nodes.keys()]);
        model.nodes.set(node, label);
        model.edges.push([from, node]);
        changes.push({ unitId: idOf(node), kind: "add", token: label });
      }
      const removable = mermaidAgent.added[source].filter((node) => model.nodes.has(node) && !changes.some((change) => change.unitId === idOf(node)));
      if (chance(0.1) && removable.length) {
        const node = pick(removable);
        model.nodes.delete(node);
        model.edges = model.edges.filter(([from, to]) => from !== node && to !== node);
        changes.push({ unitId: idOf(node), kind: "delete" });
      }
      for (let count = changes.length ? int(0, 1) : int(1, 2); count > 0; count--) {
        const node = pick([...model.nodes.keys()].filter((id) => !changes.some((change) => change.unitId === idOf(id))));
        if (!node) break;
        const label = token("M");
        model.nodes.set(node, label);
        changes.push({ unitId: idOf(node), kind: "label", token: label });
      }
    }
    const stale = forced ? true : chance(0.3);
    const writtenAt = forced?.writtenAt ?? (stale ? clock - int(2_000, 20_000) : clock);
    // Half the time the agent writes its edges as it read them on the board (read_board's Mermaid).
    const asRead = !forced && chance(0.5);
    const write = { idx: writes.length, writer: "mermaid", author: MERMAID_AGENT, base: read.version, baseScene: read.scene, writtenAt, changes, source, asRead, status: null };
    writes.push(write);
    const { responded } = await issue(MERMAID_AGENT, () => fetch(`${base}/api/mermaid/${BOARD}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: MERMAID_AGENT, base: read.version, writtenAt, mermaid: mermaidText(model, asRead ? { shown: read.scene, prefix: source === "main" ? "" : `${source}:` } : {}), source }),
    }));
    note(`mermaid write ${source}${asRead ? " (edges as read)" : ""} base=${short(read.version)}${read === mermaidAgent.reads.at(-1) ? "" : " (stale read)"} writtenAt=t+${writtenAt - START}${stale ? " (old)" : ""} changes=${changes.map((change) => `${change.unitId}:${change.kind}${change.token ? `=${change.token}` : ""}`).join(",")}`);
    mermaidAgent.reads = [];
    const done = settleAgentWrite("mermaid", write, responded).then(() => {
      // The source as the server now knows it (each source keeps its last applied Mermaid).
      mermaidAgent.models[source] = model;
      // A node the Mermaid kept as the human's canvas version is not a change of this write.
      const kept = new Set((write.answer.ops ?? []).filter((op) => op.op === "keep-canvas").map((op) => op.id));
      write.changes = write.changes.filter((change) => !kept.has(change.unitId));
    });
    track("mermaid", done);
    return write;
  };

  const waitLanded = async (pendingId) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const status = await (await fetch(`${base}/api/mermaid/${BOARD}?id=${pendingId}`)).json();
      if (status.status === "landed") return status;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`seed ${seed}: pending Mermaid write ${pendingId} never landed`);
  };

  let failure = null;
  let finalVersion = null;
  let overwrittenCount = 0;
  try {
    // ---- setup: the human's drawing, then two Mermaid sources laid out by the server's grid ----
    // Two hand-drawn units have nanoid-style ids with "-" (the upgrade path), and two units plus an arrow
    // are what a build before versions converted from Mermaid: converter ids, no stamps.
    const initial = [];
    const UNIT_IDS = ["_u0R-0JGWz1SmR9y9Ka", "u1", "u2-Hd-x", "u3"];
    for (let index = 0; index < 4; index++) initial.push(...unitElements(UNIT_IDS[index], index * 220, 0, token("U"), nonce()));
    const LEGACY_IDS = ["LEGACY_A", "LEGACY_B", "LEGACY_A_LEGACY_B"];
    initial.push(...unitElements("LEGACY_A", 0, 1300, token("U"), nonce()), ...unitElements("LEGACY_B", 300, 1300, token("U"), nonce()));
    for (const element of initial) {
      if (element.id === "LEGACY_A" || element.id === "LEGACY_B") element.boundElements = [...element.boundElements, { type: "arrow", id: "LEGACY_A_LEGACY_B" }];
    }
    initial.push({ id: "LEGACY_A_LEGACY_B", type: "arrow", x: 180, y: 1340, width: 120, height: 0, angle: 0, strokeColor: "#1971c2", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: { type: 2 }, seed: nonce(), version: 1, versionNonce: nonce(), isDeleted: false, boundElements: null, updated: START, link: null, locked: false, points: [[0, 0], [120, 0]], startBinding: { elementId: "LEGACY_A", focus: 0, gap: 1 }, endBinding: { elementId: "LEGACY_B", focus: 0, gap: 1 }, startArrowhead: null, endArrowhead: "arrow", elbowed: false });
    const created = await fetch(`${base}/api/board/${BOARD}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...HUMAN_HEADERS, "If-None-Match": "*" },
      body: JSON.stringify({ type: "excalidraw", version: 2, source: "xcld-sim", elements: initial, appState: { viewBackgroundColor: "#ffffff" }, files: {} }),
    });
    assert.equal(created.status, 200);
    await fetch(`${base}/api/board/${BOARD}/checkpoint`, { method: "POST", headers: HUMAN_HEADERS });
    for (const source of ["main", "beta"]) {
      const model = { nodes: new Map(["A", "B", "C"].map((node) => [node, token("M")])), edges: [["A", "B"], ["B", "C"]] };
      advance(100);
      const answer = await (await fetch(`${base}/api/mermaid/${BOARD}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author: MERMAID_AGENT, writtenAt: clock, mermaid: mermaidText(model), source }) })).json();
      assert.equal(answer.status, "needs-tab", JSON.stringify(answer));
      await waitLanded(answer.pendingId);
      await api.versions.whenIdle();
      mermaidAgent.models[source] = model;
    }
    advance(1000);
    await humanReload();
    const setupVersion = human.base;
    const setupScene = structuredClone(human.baseScene);
    note(`setup done at ${short(setupVersion)}`);
    advance(1000);

    // ---- random interleaving, with the D8 scenario once in the middle ----
    const d8Step = Math.floor(steps / 2) + int(-2, 2);
    let d8 = null;
    for (let step = 0; step < steps; step++) {
      advance(int(10, 1500));
      if (step === d8Step) {
        d8 = await runD8();
        continue;
      }
      const roll = rng();
      if (roll < 0.22) {
        await busy.get("human");
        humanEdit();
      } else if (roll < 0.34) {
        await busy.get("human");
        if (human.pending.size) await humanSave("autosave");
        else humanEdit();
      } else if (roll < 0.42) {
        await humanReload();
      } else if (roll < 0.45) {
        await humanCheckpoint();
      } else if (roll < 0.53) {
        await busy.get("json");
        await agentRead(jsonAgent, "json");
      } else if (roll < 0.72) {
        await busy.get("json");
        await jsonWrite();
      } else if (roll < 0.80) {
        await busy.get("mermaid");
        await agentRead(mermaidAgent, "mermaid");
      } else {
        await busy.get("mermaid");
        await mermaidWrite();
      }
    }
    await humanSave("final");
    await quiesce();

    // D8: the human edits a Mermaid node after the agent read; the agent's write, from that read and
    // with a write time before the human's edit, queues behind a JSON write and lands later.
    async function runD8() {
      await busy.get("mermaid");
      await busy.get("json");
      await agentRead(mermaidAgent, "mermaid");
      const read = mermaidAgent.reads.at(-1);
      const readAt = clock;
      const source = "main";
      const nodes = [...mermaidAgent.models[source].nodes.keys()].filter((node) => unitState(read.scene, node).present);
      const contested = nodes[0];
      const disjoint = nodes[1];
      advance(400);
      await humanReload();
      const humanLabel = token("H");
      humanEdit({ relabel: contested, label: humanLabel });
      await humanSave("D8");
      advance(300);
      const queueAhead = await jsonWrite({ exclude: [contested, disjoint] });
      const contestedLabel = token("M");
      const disjointLabel = token("M");
      const write = await mermaidWrite({ forced: { read, source, writtenAt: readAt + 50, relabels: [[contested, contestedLabel], [disjoint, disjointLabel]] } });
      note(`D8: ${source}:${contested} contested (human ${humanLabel} vs agent ${contestedLabel}), ${source}:${disjoint} disjoint (${disjointLabel}); queued behind json write #${queueAhead.idx}`);
      await quiesce();
      const after = await getBoard();
      return { write, contested, disjoint, humanLabel, contestedLabel, disjointLabel, after };
    }

    // ---- checks ----
    const final = await getBoard();
    finalVersion = final.version;
    const history = await openHistory({ stateDir: api.versions.stateDir, board: BOARD });
    const entries = history.entries;
    const losers = entries.flatMap((item) => (item.meta.overwritten ?? []).map((lost) => ({ ...lost, entry: item.entry })));
    overwrittenCount = losers.length;
    // SSE delivery can trail the last commit by a moment.
    for (let attempt = 0; attempt < 200 && !events.some((event) => event.version === final.version); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // (a) no silent loss.
    // Hand-drawn and legacy-converted shapes (setup) are never deleted, re-created or copied by a
    // Mermaid write: they are on master under their own ids (the human never deletes them), with
    // no `_2` copies, and no Mermaid source owns them.
    const finalIds = new Set(live(final.scene.elements).map((element) => element.id));
    for (const id of [...UNIT_IDS, ...LEGACY_IDS]) {
      assert.ok(finalIds.has(id), `seed ${seed}: setup shape ${id} is gone`);
      assert.equal(finalIds.has(`${id}_2`), false, `seed ${seed}: setup shape ${id} was copied`);
      assert.equal(live(final.scene.elements).find((element) => element.id === id).customData?.xcldOrigin?.mermaid ?? null, null, `seed ${seed}: ${id} was taken by a Mermaid source`);
    }
    const loserHas = (change, write) => losers.some((lost) => lost.unitId === change.unitId && (change.kind === "delete"
      ? lost.loser.author === write.author && lost.loser.writtenAt === write.writtenAt && (lost.loser.elements ?? []).length === 0
      : (lost.loser.elements ?? []).some((element) => element.type === "text" && textOf(element) === change.token)));
    const stateAfter = (change) => (change.kind === "delete" ? { present: false } : { present: true, label: change.token });
    const sameState = (state, expected) => state.present === expected.present && (!expected.present || state.label === expected.label);
    for (const write of writes) {
      assert.ok(write.status, `seed ${seed}: write #${write.idx} (${write.writer}) never answered`);
      for (const change of write.changes) {
        if (change.kind === "style") {
          const arrowNow = live(final.scene.elements).find((element) => element.id === change.unitId);
          if (sameStyle(arrowNow, change.style)) continue;
          if (losers.some((lost) => lost.unitId === change.unitId && lost.loser.author === write.author && (lost.loser.elements ?? []).some((element) => element.id === change.unitId && sameStyle(element, change.style)))) continue;
          const replaced = writes.find((later) => later.idx > write.idx && later.changes.some((other) => other.unitId === change.unitId) && sameStyle(live(later.baseScene?.elements).find((element) => element.id === change.unitId), change.style));
          if (replaced) continue;
          assert.fail(`seed ${seed}: silent loss: write #${write.idx} (${write.writer}, ${write.status}) styled ${change.unitId} ${JSON.stringify(change.style)}; master has ${JSON.stringify(arrowNow ? Object.fromEntries(STYLE_KEYS.map((key) => [key, arrowNow[key] ?? null])) : null)}, no overwritten record, no later write saw it`);
        }
        const expected = stateAfter(change);
        if (sameState(unitState(final.scene, change.unitId), expected)) continue;
        if (loserHas(change, write)) continue;
        const replacedBy = writes.find((later) => later.idx > write.idx && later.changes.some((other) => other.unitId === change.unitId) && sameState(unitState(later.baseScene, change.unitId), expected));
        if (replacedBy) continue;
        assert.fail(`seed ${seed}: silent loss: write #${write.idx} (${write.writer}, ${write.status}) set ${change.unitId} ${change.kind}${change.token ? ` "${change.token}"` : ""}; master has ${JSON.stringify(unitState(final.scene, change.unitId))}, no overwritten record, no later write saw it`);
      }
    }

    // (b) history rebuilds every entry; scenes match what the server handed out; every author turn
    // (a run of one author's commits in commit order) ends at an entry's version.
    const entryVersions = new Set();
    for (const item of entries) {
      if (item.meta.record === "none") continue;
      const scene = await history.sceneOf(item.meta.version);
      assert.ok(scene, `seed ${seed}: entry ${item.entry} does not rebuild`);
      const text = canonicalText(scene);
      assert.equal(contentHash(text), item.meta.version, `seed ${seed}: entry ${item.entry} rebuilds to another version`);
      if (served.has(item.meta.version)) assert.equal(text, served.get(item.meta.version), `seed ${seed}: entry ${item.entry} differs from what the server handed out`);
      entryVersions.add(item.meta.version);
    }
    const commits = [];
    for (const event of events) {
      if (event.name === BOARD && (!commits.length || commits.at(-1).version !== event.version)) commits.push({ author: event.author, version: event.version });
    }
    for (let index = 0; index < commits.length; index++) {
      const last = index === commits.length - 1 || commits[index + 1].author !== commits[index].author;
      if (last) assert.ok(entryVersions.has(commits[index].version), `seed ${seed}: the turn of ${commits[index].author} ending at ${short(commits[index].version)} has no history entry`);
    }
    for (const write of writes) {
      if (write.writer !== "human" && write.status === "merged") assert.ok(entryVersions.has(write.version), `seed ${seed}: agent write #${write.idx} (${short(write.version)}) has no history entry`);
    }
    assert.equal(commits.at(-1)?.version, final.version, `seed ${seed}: the last merged event is not the final master`);

    // (c) every loser is in a merged event (the banner) and in diff --since the end of the setup.
    const sameLoss = (left, right) => left.unitId === right.unitId && left.winner?.author === right.winner?.author && left.loser?.author === right.loser?.author && left.loser?.writtenAt === right.loser?.writtenAt;
    const announced = events.flatMap((event) => event.overwritten ?? []);
    const sinceSetup = await (await fetch(`${base}/api/diff/${BOARD}?since=${setupVersion}`)).json();
    assert.ok(Array.isArray(sinceSetup.overwritten), `seed ${seed}: diff --since answered ${JSON.stringify(sinceSetup).slice(0, 300)}`);
    for (const lost of losers) {
      assert.ok(announced.some((item) => sameLoss(item, lost)), `seed ${seed}: overwritten ${lost.unitId} (entry ${lost.entry}) was never in a merged event`);
      assert.ok(sinceSetup.overwritten.some((item) => sameLoss(item, lost)), `seed ${seed}: overwritten ${lost.unitId} (entry ${lost.entry}) is missing from diff --since`);
    }
    assert.equal(sinceSetup.overwritten.length, losers.length, `seed ${seed}: diff --since lists ${sinceSetup.overwritten.length} losers, history has ${losers.length}`);

    // (d) D8.
    if (d8) {
      const { write, contested, disjoint, humanLabel, contestedLabel, disjointLabel, after } = d8;
      assert.equal(unitState(after.scene, contested).label, humanLabel, `seed ${seed}: D8 contested unit lost the human's newer edit`);
      assert.equal(unitState(after.scene, disjoint).label, disjointLabel, `seed ${seed}: D8 disjoint edit did not apply`);
      const lost = losers.find((item) => item.unitId === contested && item.loser.author === MERMAID_AGENT && item.loser.writtenAt === write.writtenAt);
      assert.ok(lost, `seed ${seed}: D8 loser not kept in history`);
      assert.equal(lost.winner.author, HUMAN);
      assert.ok((lost.loser.elements ?? []).some((element) => textOf(element) === contestedLabel), `seed ${seed}: D8 loser lacks the agent's label`);
    }

    // (f) Bookkeeping is not an edit: a JSON write applies, and wins, only the units it changed,
    // however it re-sent the rest; and master keeps every element's bookkeeping.
    const jsonWrites = writes.filter((write) => write.writer === "json");
    for (const write of jsonWrites) {
      const own = new Set(write.changes.map((change) => change.unitId));
      for (const item of write.answer?.applied ?? []) {
        assert.ok(own.has(item.unitId), `seed ${seed}: json write #${write.idx}${write.perturbed ? ` (bookkeeping ${write.perturbed})` : ""} applied ${item.unitId}, which it didn't change`);
      }
    }
    for (const lost of losers) {
      if (lost.winner.author !== JSON_AGENT) continue;
      const write = jsonWrites.find((candidate) => candidate.writtenAt === lost.winner.writtenAt);
      assert.ok(write?.changes.some((change) => change.unitId === lost.unitId), `seed ${seed}: the json agent overwrote ${lost.unitId} (entry ${lost.entry}) without changing it`);
    }
    const setupById = new Map(live(setupScene.elements).map((element) => [element.id, element]));
    for (const element of live(final.scene.elements)) {
      for (const key of ["seed", "version", "versionNonce"]) {
        assert.equal(typeof element[key], "number", `seed ${seed}: master's ${element.id}.${key} is ${JSON.stringify(element[key])}`);
      }
      const original = setupById.get(element.id);
      if (original) {
        assert.equal(element.seed, original.seed, `seed ${seed}: master's ${element.id} lost its seed`);
        if (typeof original.index === "string") assert.equal(typeof element.index, "string", `seed ${seed}: master's ${element.id} lost its index`);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    controller.abort();
    await api.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (!failure) await rm(boardsDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
  if (failure) {
    const message = `concurrency seed ${seed} failed (rerun: node tests/concurrency.mjs --start ${seed} --seeds 1 --steps ${steps}; board kept in ${boardsDir}):\n${failure.message}\nsteps:\n  ${log.join("\n  ")}`;
    const error = new assert.AssertionError({ message });
    error.seed = seed;
    throw error;
  }
  const restyles = writes.reduce((sum, write) => sum + write.changes.filter((change) => change.kind === "style").length, 0);
  const asRead = writes.filter((write) => write.asRead).length;
  return { seed, finalVersion, writes: writes.length, restyles, asRead, queued: queuedCount, overwritten: overwrittenCount, ms: Date.now() - started };
};

/** Runs seeds [start, start + count) with `parallel` at a time; each seed twice when `twice` (D3). */
export const runSeeds = async ({ start = 1, count = 50, steps = DEFAULT_STEPS, parallel = 4, twice = true, writeWaitMs, onResult = () => {} } = {}) => {
  const results = [];
  const failures = [];
  let next = start;
  const worker = async () => {
    while (next < start + count) {
      const seed = next++;
      try {
        const runs = twice ? await Promise.all([runSeed(seed, { steps, writeWaitMs }), runSeed(seed, { steps, writeWaitMs })]) : [await runSeed(seed, { steps, writeWaitMs })];
        if (twice && runs[0].finalVersion !== runs[1].finalVersion) {
          throw new assert.AssertionError({ message: `concurrency seed ${seed}: D3 re-run gave another final master (${runs[0].finalVersion} vs ${runs[1].finalVersion})` });
        }
        results.push(runs[0]);
        onResult(runs[0]);
      } catch (error) {
        failures.push({ seed, error });
        onResult({ seed, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  return { results: results.sort((left, right) => left.seed - right.seed), failures: failures.sort((left, right) => left.seed - right.seed) };
};

const main = async (argv) => {
  const value = (flag, fallback) => {
    const at = argv.indexOf(flag);
    return at >= 0 ? Number(argv[at + 1]) : fallback;
  };
  const count = value("--seeds", 50);
  const start = value("--start", 1);
  const steps = value("--steps", DEFAULT_STEPS);
  const parallel = value("--parallel", 4);
  const twice = !argv.includes("--once");
  // --wait-ms 1: agents get `queued` almost every time (what a slow disk does) and wait for the landing.
  const writeWaitMs = argv.includes("--wait-ms") ? value("--wait-ms", undefined) : undefined;
  const began = Date.now();
  let done = 0;
  const { results, failures } = await runSeeds({
    start,
    count,
    steps,
    parallel,
    twice,
    writeWaitMs,
    onResult: (result) => {
      done += 1;
      if (result.error) console.log(`seed ${result.seed}: FAIL`);
      else if (done % 10 === 0 || count <= 10) console.log(`${done}/${count} seeds done (${((Date.now() - began) / 1000).toFixed(1)} s)`);
    },
  });
  const writes = results.reduce((sum, result) => sum + result.writes, 0);
  const queued = results.reduce((sum, result) => sum + result.queued, 0);
  const overwritten = results.reduce((sum, result) => sum + result.overwritten, 0);
  const restyles = results.reduce((sum, result) => sum + result.restyles, 0);
  const asRead = results.reduce((sum, result) => sum + result.asRead, 0);
  console.log(`concurrency: ${results.length}/${count} seeds passed (${start}..${start + count - 1}, ${steps} steps, ${twice ? "each run twice" : "once"}${writeWaitMs ? `, write wait ${writeWaitMs} ms` : ""}), ${writes} writes (${restyles} arrow restyles saved, ${asRead} Mermaid writes with edges as read), ${queued} queued, ${overwritten} overwritten units kept in history, ${((Date.now() - began) / 1000).toFixed(1)} s`);
  for (const { error } of failures) console.log(`\n${error.message}`);
  const { closeParser } = await import("../tools/mermaid-parse.mjs");
  await closeParser?.();
  process.exitCode = failures.length ? 1 : 0;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
