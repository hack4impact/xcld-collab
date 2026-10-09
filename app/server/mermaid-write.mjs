// Server-side Mermaid writes (versions and merge, slices 4b and 6a): parse the Mermaid, apply it
// to the board as it was at the writer's base, and commit the result through the versions
// pipeline as a `kind: "mermaid"` branch, so a Mermaid write merges like any other write.
//
//   prepare(board, { author, displayName?, base?, writtenAt?, source, sourceName?, position? })
//     -> { status: "submit", input, ops, hash, stages, hint? }  hand `input` to versions.submitBranch
//      | { status: "noop", hash, version }                      this source already has this Mermaid
//      | { status: "needs-tab", reason, hash, pending }         a pending write (see below)
//      | { status: "syntax-error", error }                      Mermaid's own message and line
//      | { status: "unknown-base", base, currentVersion }
//      | { status: "invalid", error }
//      | { status: "parser-unavailable", error }
//   listPending(board), statusOf(board, id), prepareTabLanding(board, id, { hash, elements, files })
//   settleLanding(record, submitted, via), syncInbox(board), fromFile(board), close()
//
// Named sources: every write names a source (default `main`). Each source keeps its own last
// applied Mermaid and hash (versions state `mermaidSources`), its element ids are prefixed
// (tools/mermaid-origin.mjs), and its deletes only touch its own shapes. The same document again
// is a no-op; an edited one applies only its differences; a different diagram under the same
// name is an edit of that source (the answer suggests a new name when most nodes would go).
//
// Pending writes. When a write can't be applied node by node (a board without this source's
// shapes, or a non-flowchart), it becomes a pending record in the state dir
// (<state>/mermaid-pending/<board>/<id>.json, fsynced) and the answer is 202 `needs-tab`:
// - an open tab converts it in memory and posts the shapes back (prepareTabLanding): they join
//   the board as a group placed clear of the drawing (tools/mermaid-group.mjs), never over it;
// - the server checks again at each step of the schedule (5 s, 15 s, 45 s after the write, and
//   nudges open tabs); at the last step (2 min) it lays a flowchart out itself, in a grid that
//   follows the direction (tools/mermaid-grid.mjs), placed the same way (tools/mermaid-place.mjs);
// - a non-flowchart can't be laid out without a tab: it stays pending ("waiting-for-tab");
// - the author and write time stay the writer's, whichever way it lands;
// - a server restart resumes every record from the journal; a record whose branch already
//   committed (the state names its id) is cleaned up, so nothing lands twice.
// `writtenAt` is when the Mermaid was written (the writer's clock, or the file's mtime), never
// the apply time, so a stale write loses to a newer edit of the same unit in the merge (D8).
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { splitBoardPath } from "../../tools/board-path.mjs";
import { applyMermaid, appliesOnBoard, boxOf } from "../../tools/mermaid-apply.mjs";
import { gridLayout, shiftBoxes } from "../../tools/mermaid-grid.mjs";
import { adoptConverted, obstacleBoxes, resolveNear } from "../../tools/mermaid-group.mjs";
import { mermaidSourceHash } from "../../tools/mermaid-hash.mjs";
import { withIdMap } from "../../tools/mermaid-ids.mjs";
import { ADOPTION_AUTHOR, legacyAdoption } from "../../tools/mermaid-legacy.mjs";
import { DEFAULT_SOURCE, isValidSourceName, originOf } from "../../tools/mermaid-origin.mjs";
import { parseFlowchart as defaultParseFlowchart } from "../../tools/mermaid-parse.mjs";
import { parsePosition, placeGroup } from "../../tools/mermaid-place.mjs";
import { parseAuthorKey, sortableId, writeFileAtomic } from "./versions.mjs";

// The inbox file's text: LF endings and one trailing newline, as write_mermaid always wrote it.
export const inboxText = (source) => String(source ?? "").replace(/\r\n?/g, "\n").replace(/\n?$/, "\n");

// When the server checks a pending write again, after it was written: the last step lays it out.
export const MERMAID_RETRY_SCHEDULE_MS = Object.freeze([5_000, 15_000, 45_000, 120_000]);

/** XCLD_MERMAID_RETRY_MS="5000,15000,45000,120000" overrides the schedule (tests, demos). */
export const retryScheduleFromEnv = (env = process.env) => {
  const values = String(env.XCLD_MERMAID_RETRY_MS ?? "").split(",").map((value) => value.trim()).filter(Boolean).map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  return values.length ? values.sort((left, right) => left - right) : [...MERMAID_RETRY_SCHEDULE_MS];
};

// A previous Mermaid with no ids: nothing may be deleted and no style is reset.
const NO_PREVIOUS = Object.freeze({ ok: true, diagramType: "flowchart", direction: "TD", nodes: [], edges: [], subgraphs: [], classDefs: {} });
const PARSE_CACHE_LIMIT = 32;
const FINISHED_LIMIT = 500;
const RECORD_SCHEMA = 1;
const SHAPE_TYPES = new Set(["rectangle", "diamond", "ellipse"]);

const isLive = (element) => element && !element.isDeleted;
const ownsShapes = (elements, source) => (elements ?? []).some((element) => isLive(element) && SHAPE_TYPES.has(element.type) && originOf(element)?.mermaid?.source === source);
const recordedHashesOf = (elements, source) => new Set((elements ?? [])
  .filter((element) => isLive(element) && originOf(element)?.mermaid?.source === source)
  .map((element) => originOf(element).mermaid.hash)
  .filter(Boolean));
// The answer's view of a pending record (no internal fields).
const publicRecord = (record) => ({
  id: record.id,
  board: record.board,
  source: record.source,
  hash: record.hash,
  author: record.author,
  writtenAt: record.writtenAt,
  receivedAt: record.receivedAt,
  reason: record.reason,
  position: record.position ?? null,
  flowchart: record.flowchart,
  status: record.landing ? "landing" : record.waiting ? "waiting-for-tab" : "pending",
  attempts: record.attempts ?? 0,
  nextAttemptAt: record.nextAttemptAt ?? null,
  layoutAt: record.flowchart ? record.layoutAt ?? null : null,
});
const overwrittenFrom = (canvasOverwritten, author, writtenAt) => canvasOverwritten.map((item) => ({
  unitId: item.unitId,
  label: item.label,
  ...(item.unlabeled ? { unlabeled: true } : {}),
  elementIds: item.elementIds,
  winner: { side: "branch", author, writtenAt },
  loser: { side: "master", ...item.loser },
}));

export function createMermaidWriter({
  versions,
  inboxPath,
  pendingDir = path.join(versions.stateDir ?? ".", "mermaid-pending"),
  parseFlowchart = defaultParseFlowchart,
  retryScheduleMs = retryScheduleFromEnv(),
  onInboxWritten = () => {},
  publishInbox = () => {},
  publishLanded = () => {},
  afterLanded = () => {},
}) {
  const schedule = [...retryScheduleMs].sort((left, right) => left - right);
  const parseCache = new Map();
  const parseCached = async (source) => {
    const hash = mermaidSourceHash(source);
    if (parseCache.has(hash)) {
      const parsed = parseCache.get(hash);
      parseCache.delete(hash);
      parseCache.set(hash, parsed);
      return parsed;
    }
    const parsed = await parseFlowchart(source);
    // `%% xcld:id` comments, whichever parser is in use (tools/mermaid-ids.mjs).
    const withIds = withIdMap(parsed, source);
    parseCache.set(hash, withIds);
    if (parseCache.size > PARSE_CACHE_LIMIT) {
      parseCache.delete(parseCache.keys().next().value);
    }
    return withIds;
  };

  const readInbox = async (name) => {
    try {
      return await fs.readFile(inboxPath(name), "utf8");
    } catch {
      return null;
    }
  };

  // One inbox or pending-record change at a time per board.
  const chains = new Map();
  const serialize = (name, job) => {
    const run = (chains.get(name) ?? Promise.resolve()).then(job);
    const chained = run.catch(() => {});
    chains.set(name, chained);
    void chained.then(() => {
      if (chains.get(name) === chained) {
        chains.delete(name);
      }
    });
    return run;
  };
  const writeInbox = async (name, source) => {
    const text = inboxText(source);
    const current = await readInbox(name);
    // The same Mermaid (up to line endings and trailing whitespace) stays as its writer left it.
    if (current !== null && mermaidSourceHash(current) === mermaidSourceHash(text)) {
      return false;
    }
    const written = await writeFileAtomic(inboxPath(name), text, { stat: true });
    await onInboxWritten(name, written);
    return true;
  };

  // --- pending records ------------------------------------------------------------------------
  const pending = new Map();
  const finished = new Map();
  const timers = new Map();
  let closed = false;
  const recordPath = (record) => path.join(pendingDir, ...splitBoardPath(record.board), `${record.id}.json`);
  const finish = (record, outcome) => {
    pending.delete(record.id);
    clearTimeout(timers.get(record.id));
    timers.delete(record.id);
    finished.set(record.id, { id: record.id, board: record.board, source: record.source, hash: record.hash, ...outcome });
    while (finished.size > FINISHED_LIMIT) finished.delete(finished.keys().next().value);
  };
  const dropFile = (record) => fs.rm(recordPath(record), { force: true }).catch(() => {});
  const pendingFor = (name, source) => [...pending.values()].filter((record) => record.board === name && record.source === source);

  // A newer write of the same source replaces a pending one that isn't landing yet.
  const supersede = async (name, source, byId) => {
    for (const record of pendingFor(name, source)) {
      if (record.landing) continue;
      finish(record, { status: "superseded", by: byId });
      await dropFile(record);
    }
  };

  // The next step: `step` after a check, or (new or resumed record) the first one still ahead.
  const arm = (record, step = null) => {
    if (closed || !pending.has(record.id) || record.landing) return;
    clearTimeout(timers.get(record.id));
    if (step === null) {
      const elapsed = Date.now() - record.receivedAt;
      step = schedule.findIndex((offset) => offset > elapsed);
      if (step < 0) step = schedule.length - 1;
    }
    step = Math.min(step, schedule.length - 1);
    // After a failed landing (an I/O error, the board deleted under it), retry with backoff.
    const retryAt = record.failures ? Date.now() + Math.min(60_000, 1000 * 2 ** (record.failures - 1)) : 0;
    const at = Math.max(record.receivedAt + schedule[step], retryAt);
    record.nextAttemptAt = Math.max(at, Date.now());
    record.layoutAt = record.receivedAt + schedule.at(-1);
    const timer = setTimeout(() => {
      timers.delete(record.id);
      void attempt(record, step).catch((error) => console.warn(`pending Mermaid ${record.id} for ${record.board}: ${error.message}`));
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    timers.set(record.id, timer);
  };

  // One step of the schedule: did a tab pick it up? If not, nudge open tabs again, or (last
  // step) lay a flowchart out on the server.
  const attempt = async (record, step) => {
    if (closed || !pending.has(record.id) || record.landing) return;
    record.attempts = Math.max(record.attempts ?? 0, step + 1);
    if (await alreadyLanded(record)) return;
    if (step < schedule.length - 1) {
      publishInbox(record.board, { id: record.id, source: record.source });
      arm(record, step + 1);
      return;
    }
    if (!record.flowchart) {
      // A sequence diagram and the like: only a tab can lay it out. It waits for one.
      record.waiting = true;
      record.nextAttemptAt = null;
      publishInbox(record.board, { id: record.id, source: record.source });
      return;
    }
    const prepared = await prepareLanding(record, "grid", null);
    if (prepared.error) {
      record.landing = false;
      console.warn(`laying out pending Mermaid ${record.id} for ${record.board} failed: ${prepared.error}`);
      return;
    }
    await settleLanding(record, versions.submitBranch(record.board, prepared.input, { source: "mermaid-grid", stages: prepared.stages }), prepared.via, prepared);
  };

  // The commit that landed this record may be in the state already (a restart after the branch
  // was journaled): then the record is done.
  const alreadyLanded = async (record) => {
    const sources = await versions.readMermaidSources(record.board).catch(() => ({}));
    const landed = Object.values(sources ?? {}).find((entry) => entry?.pendingId === record.id);
    if (!landed) return false;
    finish(record, { status: "landed", via: "journal", version: landed.version ?? null, branchId: landed.branchId ?? null });
    await dropFile(record);
    return true;
  };

  const createPending = async (name, { author, displayName, text, hash, writtenAt, sourceName, position, reason, parsed }) => serialize(name, async () => {
    const receivedAt = Date.now();
    const record = {
      schema: RECORD_SCHEMA,
      id: sortableId(receivedAt),
      board: name,
      source: sourceName,
      hash,
      mermaid: text,
      author,
      ...(displayName ? { displayName } : {}),
      writtenAt,
      receivedAt,
      position: position ?? null,
      reason,
      flowchart: Boolean(parsed?.ok),
      direction: parsed?.ok ? String(parsed.direction ?? "TD") : "TD",
    };
    await supersede(name, sourceName, record.id);
    await writeFileAtomic(recordPath(record), `${JSON.stringify(record)}\n`, { sync: true });
    pending.set(record.id, record);
    if (sourceName === DEFAULT_SOURCE) {
      await writeInbox(name, text);
    }
    publishInbox(name, { id: record.id, source: sourceName });
    arm(record, 0);
    return record;
  });

  // The Mermaid the base was built from, for one source (see the header of slice 4b).
  const previousFor = async (name, sourceName, baseElements) => {
    const recorded = recordedHashesOf(baseElements, sourceName);
    const stored = (await versions.readMermaidSources(name))?.[sourceName]?.source ?? null;
    const onDisk = sourceName === DEFAULT_SOURCE ? await readInbox(name) : null;
    const candidates = [stored, onDisk].filter((source) => typeof source === "string" && source.trim());
    const source = candidates.find((candidate) => recorded.has(mermaidSourceHash(candidate))) ?? stored;
    if (!source) {
      return { parsed: NO_PREVIOUS, known: false };
    }
    const parsed = await parseCached(source);
    return parsed?.ok ? { parsed, known: true } : { parsed: NO_PREVIOUS, known: false };
  };

  // A name for a new source, when a write would delete most of a source's nodes.
  const suggestSource = async (name, sourceName) => {
    const used = new Set([...Object.keys((await versions.readMermaidSources(name)) ?? {}), ...[...pending.values()].filter((record) => record.board === name).map((record) => record.source)]);
    const stem = sourceName === DEFAULT_SOURCE ? "diagram" : sourceName.replace(/-\d+$/, "");
    for (let index = 2; ; index += 1) {
      const candidate = `${stem}-${index}`.slice(0, 40);
      if (!used.has(candidate)) return candidate;
    }
  };

  const validate = ({ author, base, writtenAt, source, sourceName, position }) => {
    if (!parseAuthorKey(author)) return "invalid-author";
    if (typeof source !== "string" || !source.trim()) return "mermaid-required";
    if (base !== undefined && base !== null && typeof base !== "string") return "invalid-base";
    if (writtenAt !== undefined && writtenAt !== null && !(typeof writtenAt === "number" && Number.isFinite(writtenAt))) return "invalid-writtenAt";
    if (sourceName !== undefined && sourceName !== null && !isValidSourceName(sourceName)) return "invalid-source";
    if (parsePosition(position ?? undefined).error) return "invalid-position";
    return null;
  };

  const prepare = async (name, { author, displayName, base, writtenAt, source, sourceName, position }) => {
    const invalid = validate({ author, base, writtenAt, source, sourceName, position });
    if (invalid) {
      return { status: "invalid", error: invalid };
    }
    sourceName = sourceName ?? DEFAULT_SOURCE;
    position = position || null;
    const text = inboxText(source);
    const hash = mermaidSourceHash(text);
    const stages = {};
    const time = async (stage, fn) => {
      const started = performance.now();
      try {
        return await fn();
      } finally {
        stages[stage] = (stages[stage] ?? 0) + performance.now() - started;
      }
    };
    let parsed;
    try {
      parsed = await time("parse", () => parseCached(text));
    } catch (error) {
      return { status: "parser-unavailable", error: error.message };
    }
    if (!parsed?.ok && !parsed?.unsupported) {
      return { status: "syntax-error", error: parsed?.error ?? { message: "no parse result" } };
    }
    // The same document again: nothing to do (the hash record of the source).
    const sources = await time("read", () => versions.readMermaidSources(name));
    const applied = sources?.[sourceName];
    if (applied?.hash === hash && applied.version) {
      return { status: "noop", hash, version: (await versions.readState(name)).version, source: sourceName };
    }
    const waiting = pendingFor(name, sourceName).find((record) => record.hash === hash);
    if (waiting) {
      return { status: "needs-tab", reason: waiting.reason, hash, pending: publicRecord(waiting) };
    }
    const at = await time("read", async () => (base === undefined || base === null ? versions.readMaster(name) : versions.readVersion(name, base)));
    if (!at && base !== undefined && base !== null) {
      return { status: "unknown-base", base, currentVersion: (await versions.readState(name)).version };
    }
    const now = typeof writtenAt === "number" ? writtenAt : Date.now();
    const toPending = async (reason) => {
      const record = await createPending(name, { author, displayName, text, hash, writtenAt: now, sourceName, position, reason, parsed });
      return { status: "needs-tab", reason, hash, pending: publicRecord(record) };
    };
    const live = (at?.scene.elements ?? []).filter(isLive);
    if (!at || !live.length) {
      return toPending("new board");
    }
    if (parsed.unsupported) {
      return toPending(`unsupported diagram type: ${parsed.diagramType}`);
    }
    if (!appliesOnBoard({ elements: at.scene.elements, parsed, source: sourceName })) {
      const anyMermaid = live.some((element) => SHAPE_TYPES.has(element.type) && originOf(element)?.mermaid);
      return toPending(anyMermaid || sourceName !== DEFAULT_SOURCE ? `board has no shapes from Mermaid source ${sourceName}` : "board has no Mermaid-origin shapes");
    }
    let previous;
    try {
      previous = await time("parse", () => previousFor(name, sourceName, at.scene.elements));
    } catch (error) {
      return { status: "parser-unavailable", error: error.message };
    }
    const result = await time("apply", async () => applyMermaid({ master: at.scene, parsed, hashOfSource: hash, now, previous: previous.parsed, source: sourceName }));
    if (result.error) {
      return { status: "syntax-error", error: result.error };
    }
    if (result.needsTabLayout) {
      return toPending(result.reason);
    }
    await serialize(name, () => supersede(name, sourceName, null));
    const deletedNodes = result.ops.filter((op) => op.op === "delete" && op.kind === "node").length;
    const before = previous.parsed.nodes.length + previous.parsed.subgraphs.length;
    const hint = previous.known && before >= 2 && deletedNodes * 2 > before
      ? await suggestSource(name, sourceName).then((suggested) => ({
          deletes: deletedNodes,
          of: before,
          suggestSource: suggested,
          message: `This write deletes ${deletedNodes} of the ${before} nodes and subgraphs of source "${sourceName}": a different diagram under the same source name replaces it. To keep both, write the new diagram with source "${suggested}".`,
        }))
      : null;
    return {
      status: "submit",
      hash,
      ops: result.ops,
      previousKnown: previous.known,
      stages,
      source: sourceName,
      ...(hint ? { hint } : {}),
      input: {
        author,
        displayName,
        base: at.version,
        writtenAt: now,
        kind: "mermaid",
        // Nothing to change: record the applied source only, so "Mermaid pending" clears.
        elements: result.ops.some((op) => op.op !== "keep-canvas" && op.op !== "skip") ? result.elements.filter(isLive) : null,
        ops: result.ops,
        mermaid: { source: text, hash, name: sourceName },
        overwritten: overwrittenFrom(result.canvasOverwritten, author, now),
      },
    };
  };

  // How a pending record lands: node by node if the source has appeared on the board since,
  // else as a group (the tab's layout, or the server's grid), placed clear of the drawing.
  const prepareLanding = async (record, via, converted) => {
    if (record.landing) return { error: "already-landing" };
    record.landing = true;
    clearTimeout(timers.get(record.id));
    try {
      const stages = {};
      const started = performance.now();
      const master = await versions.readMaster(record.board);
      const elements = master?.scene.elements ?? [];
      const position = parsePosition(record.position ?? undefined);
      let result;
      let placement = null;
      let how = via;
      const parsedRecord = record.flowchart ? await parseCached(record.mermaid).catch(() => null) : null;
      if (parsedRecord?.ok && appliesOnBoard({ elements, parsed: parsedRecord, source: record.source })) {
        const previous = await previousFor(record.board, record.source, elements);
        result = applyMermaid({ master: master.scene, parsed: parsedRecord, hashOfSource: record.hash, now: record.writtenAt, previous: previous.parsed, source: record.source });
        how = "server";
      } else if (converted) {
        const parsed = parsedRecord?.ok ? parsedRecord : null;
        const adopted = adoptConverted({ master: elements, converted: converted.elements, source: record.source, hash: record.hash, now: record.writtenAt, position, direction: record.direction, parsed });
        result = { elements: adopted.elements, ops: adopted.ops, canvasOverwritten: [] };
        placement = adopted.placement;
      } else {
        const parsed = await parseCached(record.mermaid);
        if (!parsed?.ok) return { error: "not a flowchart" };
        const grid = gridLayout(parsed);
        const nearElement = position.kind === "near" ? resolveNear(elements, position.ref, record.source) : null;
        placement = placeGroup({ obstacles: obstacleBoxes(elements), group: grid.bbox, direction: parsed.direction, position, nearBox: nearElement ? boxOf(nearElement) : null });
        result = applyMermaid({ master: elements, parsed, hashOfSource: record.hash, now: record.writtenAt, previous: null, source: record.source, layout: shiftBoxes(grid.boxes, placement.dx, placement.dy) });
      }
      stages.layout = performance.now() - started;
      return {
        via: how,
        stages,
        ops: result.ops,
        placement,
        input: {
          author: record.author,
          displayName: record.displayName,
          base: master?.version ?? null,
          writtenAt: record.writtenAt,
          kind: "mermaid",
          elements: result.elements.filter(isLive),
          ...(converted?.files && Object.keys(converted.files).length ? { files: converted.files } : {}),
          ops: result.ops,
          mermaid: { source: record.mermaid, hash: record.hash, name: record.source, pendingId: record.id },
          overwritten: overwrittenFrom(result.canvasOverwritten ?? [], record.author, record.writtenAt),
        },
      };
    } catch (error) {
      record.landing = false;
      record.failures = (record.failures ?? 0) + 1;
      arm(record);
      return { error: error.message };
    }
  };

  // After the landing branch is submitted: the record is done once the branch is committed (or
  // safely journaled and queued). A refused landing (the board was deleted under it) goes back
  // to the schedule.
  const settleLanding = (record, submitted, via, prepared = {}) => submitted.then(async (result) => {
    if (["committed", "unchanged", "queued"].includes(result?.status)) {
      finish(record, { status: "landed", via, version: result.version ?? null, branchId: result.branchId ?? null, placement: prepared.placement?.placement ?? null });
      await dropFile(record);
      if (record.source === DEFAULT_SOURCE) {
        await syncInbox(record.board);
      }
      publishLanded(record.board, { ...finished.get(record.id), author: record.author, writtenAt: record.writtenAt });
      await afterLanded(record.board, result);
      return result;
    }
    record.landing = false;
    record.failures = (record.failures ?? 0) + 1;
    arm(record);
    return result;
  }, (error) => {
    record.landing = false;
    record.failures = (record.failures ?? 0) + 1;
    arm(record);
    throw error;
  });

  /** An open tab's in-memory conversion of a pending record, as a branch input for the API. */
  const prepareTabLanding = async (name, id, { hash, elements, files } = {}) => {
    const record = pending.get(id);
    if (!record || record.board !== name) {
      const done = finished.get(id) ?? await statusOf(name, id);
      return { error: "not-pending", status: done?.status ?? "unknown" };
    }
    if (hash !== record.hash) return { error: "hash-mismatch", status: "pending" };
    if (!Array.isArray(elements) || !elements.every((element) => element && typeof element.id === "string" && element.id)) {
      return { error: "invalid-elements", status: "pending" };
    }
    const prepared = await prepareLanding(record, "tab", { elements, files: files && typeof files === "object" ? files : {} });
    if (prepared.error) return { error: prepared.error, status: record.landing ? "landing" : "pending" };
    return { ...prepared, record };
  };

  const listPending = async (name) => {
    // A Mermaid inbox on disk that nothing applied yet (a fresh clone) becomes a write first.
    await fromFile(name).catch(() => null);
    return [...pending.values()].filter((record) => record.board === name).sort((left, right) => left.receivedAt - right.receivedAt).map((record) => ({ ...publicRecord(record), mermaid: record.mermaid }));
  };

  const statusOf = async (name, id) => {
    const record = pending.get(id);
    if (record && record.board === name) return publicRecord(record);
    const done = finished.get(id);
    if (done && done.board === name) return done;
    const sources = await versions.readMermaidSources(name).catch(() => ({}));
    for (const [source, entry] of Object.entries(sources ?? {})) {
      if (entry?.pendingId === id) return { id, board: name, source, hash: entry.hash, status: "landed", via: "journal", version: entry.version ?? null, branchId: entry.branchId ?? null };
    }
    return null;
  };

  // After a commit: the inbox file shows the last applied Mermaid of `main` (a readable export).
  const syncInbox = (name) => serialize(name, async () => {
    const appliedMain = await versions.readMermaid(name);
    return appliedMain?.source ? writeInbox(name, appliedMain.source) : false;
  });

  // Upgrade migration (tools/mermaid-legacy.mjs). A `main` inbox left by a build before
  // versions, whose tab converted it and replaced the board with unstamped shapes, is not a new
  // diagram: written before versions first recorded the board, on a board with a drawing but no
  // record of `main` (no applied source, no main shapes). It is adopted, never applied: the
  // shapes its conversion made become source `main`, and it becomes main's last applied Mermaid.
  // Returns null when the inbox isn't such a leftover.
  const adopting = new Map();
  const adoptLegacyInbox = async (name, { state, master, writtenAt, source, hash }) => {
    if (state.mermaidSources?.[DEFAULT_SOURCE] || state.mermaid) return null;
    const current = master ?? await versions.readMaster(name);
    if (!current || !current.scene.elements.some(isLive) || ownsShapes(current.scene.elements, DEFAULT_SOURCE)) return null;
    const startedAt = await versions.historyStartedAt(name);
    if (startedAt !== null && writtenAt > startedAt) return null;
    if (adopting.has(name)) return adopting.get(name);
    const job = (async () => {
      const parsed = await parseCached(source).catch(() => null);
      const { adopt, count } = parsed?.ok ? legacyAdoption({ elements: current.scene.elements, parsed, writtenAt }) : { adopt: {}, count: 0 };
      const result = await versions.submitBranch(name, {
        author: ADOPTION_AUTHOR,
        base: current.version,
        writtenAt,
        kind: "mermaid",
        elements: null,
        ops: [{ op: "adopt", count }],
        mermaid: { source, hash, name: DEFAULT_SOURCE },
        ...(count ? { adopt } : {}),
      }, { source: "mermaid-adopt" });
      return { status: "adopted", hash, adopted: count, version: result.version ?? null, commit: result.status };
    })();
    adopting.set(name, job);
    try {
      return await job;
    } finally {
      adopting.delete(name);
    }
  };

  // A settled direct write to the inbox (an agent or editor writing files), as source `main`.
  // Already applied, the source the board was converted from, or already pending: nothing to do.
  // A leftover from before versions is adopted instead (adoptLegacyInbox).
  const fromFile = async (name) => {
    let stat;
    let source;
    try {
      stat = await fs.stat(inboxPath(name));
      source = await fs.readFile(inboxPath(name), "utf8");
    } catch {
      return { status: "gone" };
    }
    const hash = mermaidSourceHash(source);
    const state = await versions.readState(name);
    if (state.version !== null && (state.mermaidSources?.main?.hash ?? state.mermaid?.hash) === hash) {
      return { status: "applied", hash };
    }
    if (pendingFor(name, DEFAULT_SOURCE).some((record) => record.hash === hash)) {
      return { status: "pending", hash };
    }
    const master = state.version !== null ? await versions.readMaster(name) : null;
    if (master && master.scene.elements.some(isLive) && recordedHashesOf(master.scene.elements, DEFAULT_SOURCE).has(hash)) {
      return { status: "applied", hash };
    }
    const writtenAt = Math.round(stat.mtimeMs);
    const legacy = await adoptLegacyInbox(name, { state, master, writtenAt, source, hash });
    if (legacy) {
      return legacy;
    }
    // Whole milliseconds, like every other writtenAt: Linux mtimeMs can carry float noise
    // (…122.999), which would break exact write-time comparisons and ties.
    const prepared = await prepare(name, { author: "external", base: master?.version ?? null, writtenAt, source });
    if (prepared.status !== "submit") {
      if (prepared.status === "syntax-error" || prepared.status === "parser-unavailable") {
        // An open tab tries the conversion and shows the error.
        publishInbox(name, {});
      }
      return prepared;
    }
    const result = await versions.submitBranch(name, prepared.input, { source: "mermaid-file", stages: prepared.stages });
    await syncInbox(name);
    return { ...result, ops: prepared.ops };
  };

  // Restart: every journaled record comes back on its schedule (its write time is kept).
  const resume = async () => {
    const found = [];
    const walk = async (dir) => {
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith(".tmp")) {
          await fs.rm(full, { force: true }).catch(() => {});
        } else if (entry.name.endsWith(".json")) {
          try {
            const record = JSON.parse(await fs.readFile(full, "utf8"));
            if (record?.schema === RECORD_SCHEMA && record.id && typeof record.board === "string" && recordPath(record) === full) found.push(record);
          } catch {
            console.warn(`unreadable pending Mermaid ${full}; left in place`);
          }
        }
      }
    };
    await walk(pendingDir);
    found.sort((left, right) => left.receivedAt - right.receivedAt);
    for (const record of found) {
      if (closed || pending.has(record.id)) continue;
      pending.set(record.id, record);
      if (await alreadyLanded(record)) continue;
      arm(record);
    }
    return found.length;
  };
  const ready = resume().catch((error) => console.warn(`resuming pending Mermaid writes failed: ${error.message}`));

  const close = () => {
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  return { prepare, prepareTabLanding, settleLanding, listPending, statusOf, syncInbox, fromFile, inboxText, ready, close, schedule };
}
