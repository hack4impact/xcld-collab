import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_STEPS, runSeeds } from "./concurrency.mjs";

// The concurrency acceptance test (tests/concurrency.mjs): a human tab, a JSON agent and a Mermaid
// agent on one board, interleaved at random by a seeded scheduler. 50 seeds, each run twice (D3),
// 24 steps per seed (about 15 writes), 4 seeds at a time: about 40 s here. Long mode:
//   node tests/concurrency.mjs --seeds 1000            (or CI: workflow_dispatch concurrency_seeds)
const needsParser = { skip: !existsSync(path.resolve("tools", "mermaid-parse.bundle.mjs")) && "Run cd app; npm ci; npm run build first (Mermaid parser bundle)." };

const report = (failures) => failures.map(({ error }) => error.message).join("\n\n");

test(`concurrency acceptance: 50 seeds x ${DEFAULT_STEPS} steps, each twice, no silent loss, history, losers, D8, D3`, needsParser, async () => {
  const { results, failures } = await runSeeds({ start: 1, count: 50, parallel: 4 });
  assert.equal(failures.length, 0, report(failures));
  assert.equal(results.length, 50);
  // The scenario must actually contend: units overwritten (and kept) across the seeds.
  assert.ok(results.reduce((sum, result) => sum + result.overwritten, 0) > 50, "the seeds produced too few conflicts to mean anything");
});

test("concurrency acceptance with every agent write answering `queued` (a stalled disk): same guarantees", needsParser, async () => {
  const { results, failures } = await runSeeds({ start: 101, count: 5, parallel: 5, writeWaitMs: 1 });
  assert.equal(failures.length, 0, report(failures));
  assert.ok(results.reduce((sum, result) => sum + result.queued, 0) > 10, "expected queued answers");
});
