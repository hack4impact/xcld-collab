// D5 measurement: merge time for 1,500-element boards. Not part of `node --test tests`.
//   node tests/merge-bench.mjs [runs=30] [size=1500]
// Each run uses a fresh seeded board with a realistic mix (shapes with bound text, bound
// arrows, some arrow labels, free notes) and a tab-like and an agent-like edit script.
import { mergeBoard } from "../tools/merge.mjs";
import { editBoard, makeBoard, mulberry32 } from "./merge-fixtures.mjs";

const runs = Number(process.argv[2]) || 30;
const size = Number(process.argv[3]) || 1500;

const scenarios = [
  { name: "10% per side (typical)", changed: 0.1, fastForward: false },
  { name: "fast-forward, 10% changed", changed: 0.1, fastForward: true },
  { name: "50% per side (heavy)", changed: 0.5, fastForward: false },
];

const percentile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];

console.log(`node ${process.version}, ${runs} runs per scenario, ${size} elements`);
for (const scenario of scenarios) {
  const times = [];
  let conflicts = 0;
  // One untimed warm-up run, then the measured runs.
  for (let run = 0; run <= runs; run++) {
    const rng = mulberry32(10_000 + run);
    const base = makeBoard(size, rng);
    // An edit touches about two elements, so ops = changed * size / 2.
    const ops = Math.round((scenario.changed * size) / 2);
    const human = editBoard(base, mulberry32(run * 31 + 1), { author: "human", ops, tabLike: true });
    const agent = editBoard(base, mulberry32(run * 31 + 2), { author: "agent", ops, tabLike: false });
    const masterMeta = Object.fromEntries(base.map((element) => [element.id, { writtenAt: 1000, author: "seed" }]));
    const started = performance.now();
    const result = mergeBoard({ base, master: scenario.fastForward ? base : human, branch: agent, branchWrittenAt: 3000, branchAuthor: "agent#p1", masterMeta });
    const elapsed = performance.now() - started;
    if (run > 0) {
      times.push(elapsed);
      conflicts += result.overwritten.length;
    }
  }
  times.sort((left, right) => left - right);
  const format = (value) => `${value.toFixed(2)} ms`;
  console.log(`${scenario.name}: median ${format(percentile(times, 0.5))}, p95 ${format(percentile(times, 0.95))}, max ${format(times.at(-1))}, overwritten units/run ${(conflicts / runs).toFixed(1)}`);
}
