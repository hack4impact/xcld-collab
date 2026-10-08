// Slow-I/O diagnostics, always on. The commit pipeline times every file-system operation; one
// that takes at least the threshold (XCLD_SLOW_IO_MS, default 1000) is logged once as one line
// and kept in a bounded ring (the last 50) with counts and the max per stage since start, for
// GET /api/status. A queued write's answer names the slow operation (docs/DESIGN.md#performance).
import { performance } from "node:perf_hooks";

export const SLOW_IO_MS = 1000;
export const SLOW_IO_RECENT = 50;

export const slowIoThresholdFromEnv = (env = process.env) => {
  const value = Number(env.XCLD_SLOW_IO_MS);
  return Number.isFinite(value) && value > 0 ? value : SLOW_IO_MS;
};

// "journal.fsync" -> "journal fsync"; 4213 -> "4.2 s".
export const stageLabel = (stage) => String(stage).replace(/\./g, " ");
export const formatDuration = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

// The sentence a queued write's answer carries when a slow operation held it up.
export const slowIoMessage = (slow) => `disk is slow right now (${stageLabel(slow.stage)} ${slow.inFlight ? `${formatDuration(slow.ms)} so far` : formatDuration(slow.ms)}); your write is safe and queued`;

/**
 * @param {object} [options]
 * @param {number} [options.thresholdMs] An operation this slow or slower is recorded.
 * @param {number} [options.limit] How many recent slow operations are kept.
 * @param {() => number} [options.clock] Monotonic milliseconds (tests inject a fake one).
 * @param {() => number} [options.now] Wall clock for the ISO time of an event.
 * @param {(line: string) => void} [options.log]
 */
export function createSlowIoRecorder({
  thresholdMs = slowIoThresholdFromEnv(),
  limit = SLOW_IO_RECENT,
  clock = () => performance.now(),
  now = Date.now,
  log = (line) => console.warn(line),
} = {}) {
  const recent = [];
  const byStage = new Map();
  const inFlight = new Set();
  let count = 0;
  let maxMs = 0;

  const record = (stage, board, ms, endedAt) => {
    const rounded = Math.round(ms);
    count += 1;
    maxMs = Math.max(maxMs, rounded);
    const totals = byStage.get(stage) ?? { count: 0, maxMs: 0 };
    totals.count += 1;
    totals.maxMs = Math.max(totals.maxMs, rounded);
    byStage.set(stage, totals);
    const at = new Date(now()).toISOString();
    recent.push({ stage, board, ms: rounded, at, endedAt });
    if (recent.length > limit) {
      recent.shift();
    }
    log(`slow I/O: ${stage} took ${rounded} ms (board ${board ?? "-"}, ${at}, threshold ${thresholdMs} ms)`);
  };

  // Runs one file-system operation and records it when it was slow; the result or error passes
  // through. Costs two clock reads and a Set add/delete.
  const time = async (stage, board, fn) => {
    const op = { stage, board, start: clock() };
    inFlight.add(op);
    try {
      return await fn();
    } finally {
      inFlight.delete(op);
      const end = clock();
      if (end - op.start >= thresholdMs) {
        record(stage, board, end - op.start, end);
      }
    }
  };

  // Operations running now for at least the threshold.
  const stuck = () => {
    const at = clock();
    return [...inFlight].filter((op) => at - op.start >= thresholdMs).map((op) => ({ stage: op.stage, board: op.board, ms: Math.round(at - op.start), inFlight: true }));
  };

  /**
   * The slowest slow operation that ended after `mark` (a `clock()` reading) or is still running,
   * preferring `board`'s own; null when there was none. Why a write waited.
   */
  const worstSince = (mark, board = null) => {
    const candidates = [
      ...recent.filter((event) => event.endedAt > mark).map(({ stage, board: name, ms }) => ({ stage, board: name, ms, inFlight: false })),
      ...stuck(),
    ];
    const own = candidates.filter((event) => event.board === board);
    const pool = own.length ? own : candidates;
    return pool.reduce((worst, event) => (!worst || event.ms > worst.ms ? event : worst), null);
  };

  const snapshot = () => ({
    thresholdMs,
    count,
    maxMs,
    byStage: Object.fromEntries([...byStage].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([stage, totals]) => [stage, { ...totals }])),
    recent: recent.map(({ endedAt: _endedAt, ...event }) => event),
    inFlight: stuck(),
  });

  return { time, worstSince, snapshot, mark: clock, thresholdMs };
}
