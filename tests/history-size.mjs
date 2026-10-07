// History size measurement (lead, history v2): a session of human and agent turns on one board,
// then the bytes the versions state dir holds. Not part of `node --test tests`.
//
//   node tests/history-size.mjs [--elements 1500] [--turns 100] [--changes 5] [--fixture]
//     [--store app/server/versions.mjs] [--dir .scratch/history-size] [--json]
//
// Turns alternate: a human turn is two autosaves (coalesced into one entry) changing about
// `changes` elements in all; an agent turn reads the board, then writes `changes` changed
// elements. Elements look like Excalidraw's (random ids, seeds and nonces) unless --fixture.
// `--store` points at another version store module, e.g. an older commit's, to compare.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeBoard, mulberry32 } from "./merge-fixtures.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[index + 1]?.startsWith("--") ? "1" : all[index + 1] ?? "1"]] : pairs), []));
const elements = Number(args.elements ?? 1500);
const turns = Number(args.turns ?? 100);
const changes = Number(args.changes ?? 5);
const storeModule = path.resolve(args.store ?? "app/server/versions.mjs");
const root = path.resolve(args.dir ?? path.join(".scratch", "history-size"), `run-${Date.now()}`);
const rng = mulberry32(11);
const int = (max) => Math.floor(rng() * max);

const realistic = (board) => {
  const ids = new Map(board.map((element) => [element.id, randomBytes(15).toString("base64url")]));
  return JSON.parse(JSON.stringify(board), (key, value) => (typeof value === "string" && ids.has(value) ? ids.get(value) : value))
    .map((element) => ({ ...element, seed: int(2 ** 31), versionNonce: int(2 ** 31), updated: 1_790_000_000_000 + int(1e9) }));
};

const edit = (scene, count) => {
  const next = scene.slice();
  for (let n = 0; n < count; n++) {
    const index = int(next.length);
    const element = next[index];
    next[index] = { ...element, x: element.x + int(40) - 20, version: (element.version ?? 1) + 1, versionNonce: int(2 ** 31), updated: Date.now() };
  }
  return next;
};

const bytesIn = async (folder) => {
  let total = 0;
  let blocks = 0;
  let files = 0;
  let names = [];
  try {
    names = await readdir(folder, { recursive: true });
  } catch {
    return { bytes: 0, allocated: 0, files: 0 };
  }
  for (const name of names) {
    const info = await stat(path.join(folder, name));
    if (info.isFile()) {
      total += info.size;
      // Space taken on a filesystem with 4 KiB blocks (ext4 in the Docker Desktop VM).
      blocks += Math.ceil(info.size / 4096) * 4096;
      files += 1;
    }
  }
  return { bytes: total, allocated: blocks, files };
};

const { createVersionStore } = await import(pathToFileURL(storeModule).href);
await mkdir(root, { recursive: true });
const stateDir = path.join(root, "state");
let clock = 1_790_000_000_000;
const store = createVersionStore({ boardsDir: path.join(root, "boards"), stateDir, now: () => clock });
const HUMAN = "human:Size Human#tab1";
const AGENT = "agent:size-agent#a1";
let scene = makeBoard(elements, rng);
if (!args.fixture) {
  scene = realistic(scene);
}
const seeded = await store.submitBranch("size/board", { author: "cli:seed", base: null, writtenAt: clock, elements: scene });
let version = seeded.version;
const started = Date.now();
for (let turn = 0; turn < turns; turn++) {
  clock += 10_000;
  if (turn % 2 === 0) {
    const first = Math.ceil(changes / 2);
    for (const count of [first, changes - first]) {
      scene = edit(scene, count);
      const result = await store.submitBranch("size/board", { author: HUMAN, base: version, writtenAt: clock, elements: scene, appState: { viewBackgroundColor: "#ffffff" } });
      version = result.version;
      clock += 1000;
    }
  } else {
    const read = await store.readMaster("size/board");
    scene = edit(read.scene.elements, changes);
    const result = await store.submitBranch("size/board", { author: AGENT, base: read.version, writtenAt: clock, elements: scene });
    version = result.version;
  }
}
await store.whenIdle();
await store.close();
const elapsedMs = Date.now() - started;
const parts = {};
for (const folder of ["history", "bases", "files", "state", "branches"]) {
  parts[folder] = await bytesIn(path.join(stateDir, folder));
}
// History bytes by file kind: v2 checkpoints and deltas, pre-v2 full records, metas.
const kinds = { checkpoint: 0, delta: 0, full: 0, meta: 0 };
for (const name of await readdir(path.join(stateDir, "history"), { recursive: true }).catch(() => [])) {
  const info = await stat(path.join(stateDir, "history", name));
  if (info.isFile()) {
    const kind = name.endsWith(".excalidraw.gz") ? "checkpoint" : name.endsWith(".delta.json.gz") ? "delta" : name.endsWith(".meta.json") ? "meta" : "full";
    kinds[kind] += info.size;
  }
}
const total = Object.values(parts).reduce((sum, part) => sum + part.bytes, 0);
const result = { store: path.relative(process.cwd(), storeModule), elements, turns, changes, elementsKind: args.fixture ? "fixture" : "realistic", elapsedMs, history: parts.history, historyByKind: kinds, bases: parts.bases, total, parts };
await rm(root, { recursive: true, force: true, maxRetries: 5 });
const mb = (value) => `${(value / 1024 / 1024).toFixed(2)} MB`;
console.log(args.json ? JSON.stringify(result, null, 2) : [
  `store ${result.store}: ${turns} turns at ${elements} ${result.elementsKind} elements, ~${changes} changed per turn (${(elapsedMs / 1000).toFixed(1)} s)`,
  `  history ${mb(parts.history.bytes)} in ${parts.history.files} files (${mb(parts.history.allocated)} in 4 KiB blocks); bases ${mb(parts.bases.bytes)}; files ${mb(parts.files.bytes)}; state ${mb(parts.state.bytes)}; total ${mb(total)}`,
  `  history by kind: checkpoints ${mb(kinds.checkpoint)}, deltas ${mb(kinds.delta)}, full (pre-v2) ${mb(kinds.full)}, metas ${mb(kinds.meta)}`,
].join("\n"));
