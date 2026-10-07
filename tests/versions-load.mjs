// Versions load scenario and the end-to-end performance gate (lead, slice 3).
//
// One board, a simulated human tab saving through PUT /api/board about once a second, and
// three agents writing through POST /api/branch every 1-3 s, some on the same units. Latency
// is measured per write from submit to the merged answer, over HTTP against a running server.
// Not part of `node --test tests`: it runs for minutes.
//
//   node tests/versions-load.mjs --url http://127.0.0.1:3201 [--sizes 50,1500]
//     [--duration 120] [--min-writes 300] [--gate 450] [--out .scratch/load.json]
//
// Start the server with XCLD_TIMING=1 to also get per-stage timings (GET /api/timings).
// Exit code 1 when p95 at any size is above the gate.
//
// --mermaid: the board is a Mermaid-origin flowchart (shapes, labels and tree edges stamped with
// the Mermaid hash, as a tab conversion writes them), and a fourth writer sends Mermaid through
// POST /api/mermaid every 1-3 s (relabels, some on the hot units, and now and then a new node and
// edge). Its latency (parse + apply + commit, submit to answer) is reported on its own, and held
// to the same gate.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { generateKeyBetween } from "../tools/mermaid-apply.mjs";
import { mermaidSourceHash, stampMermaidHash } from "../tools/mermaid-hash.mjs";
import { arrow, makeBoard, mulberry32, shape } from "./merge-fixtures.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[index + 1]?.startsWith("--") ? "1" : all[index + 1] ?? "1"]] : pairs), []));
const url = (args.url ?? "http://127.0.0.1:3201").replace(/\/+$/, "");
const sizes = (args.sizes ?? "50,1500").split(",").map(Number);
const durationMs = Number(args.duration ?? 120) * 1000;
const minWrites = Number(args["min-writes"] ?? 300);
const gateMs = Number(args.gate ?? 450);
const seed = Number(args.seed ?? 7);
const mermaidMode = args.mermaid === "1";
const runId = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);

const AFTER_ANSWER = new Set(["post", "master", "archive"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
};
const summary = (values) => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), max: values.length ? Math.max(...values) : null });
const fmt = (value) => (value === null || value === undefined ? "-" : `${value.toFixed(1)}`);
const boardPath = (board) => board.split("/").map(encodeURIComponent).join("/");

// Small edits: move a shape (and its label), relabel, restyle.
const editUnits = (elements, rng, { hot, count, author }) => {
  const byId = new Map(elements.map((element) => [element.id, { ...element }]));
  const shapes = elements.filter((element) => /^s\d+$/.test(element.id));
  for (let n = 0; n < count; n++) {
    const pool = hot && rng() < 0.6 ? shapes.slice(0, 15) : shapes;
    const shape = byId.get(pool[Math.floor(rng() * pool.length)].id);
    const label = byId.get(`${shape.id}-t`);
    const kind = rng();
    if (kind < 0.5) {
      const dx = Math.round(rng() * 40) - 20;
      shape.x += dx;
      shape.version = (shape.version ?? 1) + 1;
      if (label) {
        label.x += dx;
        label.version = (label.version ?? 1) + 1;
      }
    } else if (kind < 0.8 && label) {
      label.text = label.originalText = `${shape.id} ${author} ${Math.floor(rng() * 1000)}`;
      label.version = (label.version ?? 1) + 1;
    } else {
      shape.strokeColor = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2"][Math.floor(rng() * 4)];
      shape.version = (shape.version ?? 1) + 1;
    }
  }
  return elements.map((element) => byId.get(element.id));
};

const getBoard = async (board) => {
  const response = await fetch(`${url}/api/board/${boardPath(board)}`);
  if (!response.ok) throw new Error(`GET ${board}: ${response.status}`);
  const scene = await response.json();
  return { version: response.headers.get("etag").replace(/"/g, ""), elements: scene.elements };
};

// A flowchart of `size` elements (shapes, their labels and tree edges) and the board a tab would
// have converted it to: ids s<n>, labels s<n>-t, edges s<a>_s<b>. Mermaid refuses more than 500
// edges (maxEdges, in the tab too), so a large board has at most 450, leaving room to grow.
const mermaidText = (labels, edges) => `flowchart TD\n${[...labels].map(([id, label]) => `  ${id}["${label}"]`).join("\n")}\n${edges.map(([from, to]) => `  ${from} --> ${to}`).join("\n")}\n`;
const makeMermaidBoard = (size) => {
  const count = Math.max(2, Math.ceil(size / 3), Math.ceil((size - 450) / 2));
  const labels = new Map(Array.from({ length: count }, (_, n) => [`s${n}`, `Node ${n}`]));
  const edges = Array.from({ length: Math.max(1, Math.min(count - 1, size - 2 * count)) }, (_, n) => [`s${Math.floor(n / 3)}`, `s${n + 1}`]);
  const source = mermaidText(labels, edges);
  let index = null;
  const next = () => (index = generateKeyBetween(index, null));
  const elements = [];
  const byId = new Map();
  for (let n = 0; n < count; n++) {
    for (const element of shape(`s${n}`, next(), { x: (n % 25) * 220, y: Math.floor(n / 25) * 140, label: `Node ${n}`, textIndex: next() })) {
      elements.push(element);
      byId.set(element.id, element);
    }
  }
  for (const [from, to] of edges) {
    const item = arrow(`${from}_${to}`, next(), from, to);
    elements.push(item);
    for (const end of [from, to]) {
      byId.get(end).boundElements = [...byId.get(end).boundElements, { id: item.id, type: "arrow" }];
    }
  }
  return { source, labels, edges, elements: stampMermaidHash(elements, mermaidSourceHash(source)) };
};

const runSize = async (size) => {
  const board = `sandbox/load-${runId}-${size}`;
  const rng = mulberry32(seed + size);
  const flowchart = mermaidMode ? makeMermaidBoard(size) : null;
  const initial = flowchart ? flowchart.elements : makeBoard(size, rng);
  const created = await fetch(`${url}/api/branch/${boardPath(board)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author: "cli:load-seed", base: null, elements: initial }) });
  if (created.status !== 200) throw new Error(`seeding ${board}: ${created.status} ${await created.text()}`);
  if (flowchart) {
    // Record the source the board came from (nothing changes on the board).
    const recorded = await fetch(`${url}/api/mermaid/${boardPath(board)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author: "cli:load-seed", mermaid: flowchart.source }) });
    const answer = await recorded.json();
    if (recorded.status !== 200 || !answer.unchanged) throw new Error(`recording the Mermaid of ${board}: ${recorded.status} ${JSON.stringify(answer).slice(0, 300)}`);
  }
  if (args.timings !== "0") {
    await fetch(`${url}/api/timings?clear=1`).catch(() => {});
  }
  const samples = [];
  const errors = [];
  const started = performance.now();
  const done = () => performance.now() - started >= durationMs && samples.length >= minWrites;

  const human = async () => {
    const own = mulberry32(seed * 31 + size);
    let { version, elements } = await getBoard(board);
    while (!done()) {
      const next = editUnits(elements, own, { hot: true, count: 1 + Math.floor(own() * 2), author: "human" });
      const body = `${JSON.stringify({ type: "excalidraw", version: 2, source: "load", elements: next, appState: { viewBackgroundColor: "#ffffff" }, files: {} }, null, 2)}\n`;
      const t0 = performance.now();
      const response = await fetch(`${url}/api/board/${boardPath(board)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "If-Match": `"${version}"`, "X-Xcld-Author-Name": "Load%20Human", "X-Xcld-Tab": "tab1" },
        body,
      });
      const data = await response.json();
      const ms = performance.now() - t0;
      if (response.status === 200) {
        samples.push({ writer: "human", ms, merged: data.merged, at: t0 - started });
        version = data.version;
        elements = data.merged ? data.master.elements : next;
      } else {
        errors.push({ writer: "human", status: response.status, data });
        ({ version, elements } = await getBoard(board));
      }
      await sleep(Math.max(0, 1000 - ms));
    }
  };

  const agent = async (index) => {
    const own = mulberry32(seed * 97 + size * 13 + index);
    let { version, elements } = await getBoard(board);
    while (!done()) {
      await sleep(1000 + own() * 2000);
      if (done()) break;
      // Half the time the agent works from what it read earlier (a stale base the server merges).
      if (own() < 0.5) {
        ({ version, elements } = await getBoard(board));
      }
      const next = editUnits(elements, own, { hot: own() < 0.5, count: 1 + Math.floor(own() * 3), author: `agent${index}` });
      const t0 = performance.now();
      const response = await fetch(`${url}/api/branch/${boardPath(board)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: `agent:load-agent#a${index}`, base: version, writtenAt: Date.now(), elements: next }),
      });
      const data = await response.json();
      const ms = performance.now() - t0;
      if (response.status === 200) {
        samples.push({ writer: "agent", ms, merged: !data.fastForward, at: t0 - started });
        version = data.version;
        elements = next;
        // The merged board differs from what this agent sent when others wrote meanwhile.
        if (!data.fastForward) ({ version, elements } = await getBoard(board));
      } else {
        errors.push({ writer: "agent", status: response.status, data });
        ({ version, elements } = await getBoard(board));
      }
    }
  };

  // Writes Mermaid like an agent: its own source, relabeled and grown a little each time.
  const mermaidWriter = async () => {
    const own = mulberry32(seed * 131 + size);
    const labels = new Map(flowchart.labels);
    const edges = [...flowchart.edges];
    const nodes = [...labels.keys()];
    let { version } = await getBoard(board);
    let added = 0;
    while (!done()) {
      await sleep(1000 + own() * 2000);
      if (done()) break;
      if (own() < 0.5) {
        ({ version } = await getBoard(board));
      }
      const count = 1 + Math.floor(own() * 3);
      for (let n = 0; n < count; n++) {
        const pool = own() < 0.5 ? nodes.slice(0, 15) : nodes;
        const id = pool[Math.floor(own() * pool.length)];
        labels.set(id, `${id} mermaid ${Math.floor(own() * 1000)}`);
      }
      if (own() < 0.2) {
        const id = `m${added++}`;
        const from = nodes[Math.floor(own() * nodes.length)];
        labels.set(id, `New ${id}`);
        edges.push([from, id]);
        nodes.push(id);
      }
      const t0 = performance.now();
      const response = await fetch(`${url}/api/mermaid/${boardPath(board)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: "agent:load-mermaid#m1", base: version, writtenAt: Date.now(), mermaid: mermaidText(labels, edges) }),
      });
      const data = await response.json();
      const ms = performance.now() - t0;
      if (response.status === 200) {
        samples.push({ writer: "mermaid", ms, merged: !data.fastForward, at: t0 - started, ops: data.ops?.length ?? 0 });
        version = data.version;
      } else {
        errors.push({ writer: "mermaid", status: response.status, data });
        ({ version } = await getBoard(board));
      }
    }
  };

  await Promise.all([human(), agent(1), agent(2), agent(3), ...(flowchart ? [mermaidWriter()] : [])]);
  const wallMs = performance.now() - started;
  let stages = null;
  const timingsResponse = await fetch(`${url}/api/timings?clear=1`).catch(() => null);
  if (timingsResponse?.ok) {
    const { timings } = await timingsResponse.json();
    const mine = timings.filter((entry) => entry.board === board && (entry.status === "committed" || (entry.kind === "mermaid" && entry.status === "unchanged")));
    const writerOf = (entry) => (entry.kind === "mermaid" ? "mermaid" : entry.writer);
    stages = {};
    for (const writer of ["human", "agent", ...(flowchart ? ["mermaid"] : []), "all"]) {
      const entries = mine.filter((entry) => writer === "all" || writerOf(entry) === writer);
      const names = [...new Set(entries.flatMap((entry) => Object.keys(entry.stages)))];
      stages[writer] = Object.fromEntries(names.map((stage) => [stage, summary(entries.map((entry) => entry.stages[stage] ?? 0))]));
      // Stages before the answer; master, the journal removal and post-commit run after it.
      const total = entries.map((entry) => Object.entries(entry.stages).filter(([stage]) => !AFTER_ANSWER.has(stage)).reduce((sum, [, ms]) => sum + ms, 0));
      stages[writer].beforeAnswer = summary(total);
      stages[writer].mergeShare = entries.length ? entries.reduce((sum, entry) => sum + (entry.stages.merge ?? 0), 0) / total.reduce((sum, ms) => sum + ms, 0) : null;
    }
  }
  const latency = {
    human: summary(samples.filter((sample) => sample.writer === "human").map((sample) => sample.ms)),
    agent: summary(samples.filter((sample) => sample.writer === "agent").map((sample) => sample.ms)),
    ...(flowchart ? { mermaid: summary(samples.filter((sample) => sample.writer === "mermaid").map((sample) => sample.ms)) } : {}),
    all: summary(samples.map((sample) => sample.ms)),
  };
  return { size, board, wallMs, writes: samples.length, merged: samples.filter((sample) => sample.merged).length, errors, latency, stages };
};

const results = [];
for (const size of sizes) {
  console.log(`size ${size}: running ${durationMs / 1000}s / ${minWrites} writes against ${url} ...`);
  results.push(await runSize(size));
}

const lines = [];
lines.push(`Versions load scenario: 1 tab (PUT ~1/s) + 3 agents (POST every 1-3 s)${mermaidMode ? " + 1 Mermaid writer (POST /api/mermaid every 1-3 s)" : ""}, gate p95 <= ${gateMs} ms`);
lines.push("");
lines.push("| Size | Writer | Writes | p50 ms | p95 ms | p99 ms | max ms |");
lines.push("|---|---|---|---|---|---|---|");
for (const result of results) {
  for (const writer of ["human", "agent", "mermaid", "all"].filter((name) => result.latency[name])) {
    const item = result.latency[writer];
    lines.push(`| ${result.size} | ${writer} | ${item.n} | ${fmt(item.p50)} | ${fmt(item.p95)} | ${fmt(item.p99)} | ${fmt(item.max)} |`);
  }
}
for (const result of results) {
  lines.push("");
  lines.push(`Size ${result.size}: ${result.writes} writes in ${(result.wallMs / 1000).toFixed(0)} s, ${result.merged} merged (stale base), ${result.errors.length} errors.`);
  if (result.stages) {
    for (const writer of ["human", "agent", "mermaid"]) {
      const stages = result.stages[writer];
      if (!stages?.beforeAnswer?.n) continue;
      lines.push(`  ${writer} server stages (p50 / p95 ms), merge share ${(stages.mergeShare * 100).toFixed(1)}%:`);
      lines.push(`    ${Object.entries(stages).filter(([name]) => name !== "mergeShare").map(([name, value]) => `${name} ${fmt(value.p50)}/${fmt(value.p95)}`).join(", ")}`);
    }
  }
}
const pass = results.every((result) => result.latency.all.p95 !== null && result.latency.all.p95 <= gateMs);
lines.push("");
lines.push(`Gate p95 <= ${gateMs} ms at every size: ${pass ? "PASS" : "FAIL"}`);
console.log(lines.join("\n"));
if (args.out) {
  await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  await writeFile(args.out, `${JSON.stringify({ runId, url, gateMs, results }, null, 2)}\n`, "utf8");
}
process.exitCode = pass ? 0 : 1;
