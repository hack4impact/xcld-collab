// Server-side Mermaid writes (versions and merge, slice 4b): parse the Mermaid, apply it to the
// board as it was at the writer's base, and commit the result through the versions pipeline as
// a `kind: "mermaid"` branch, so a Mermaid write merges like any other write and needs no tab.
//
//   prepare(board, { author, displayName?, base?, writtenAt?, source })
//     -> { status: "submit", input, ops, hash, stages }   hand `input` to versions.submitBranch
//      | { status: "needs-tab", reason, hash }            inbox written, `mermaid` SSE sent
//      | { status: "syntax-error", error }                Mermaid's own message and line
//      | { status: "unknown-base", base, currentVersion }
//      | { status: "invalid", error }
//      | { status: "parser-unavailable", error }
//   syncInbox(board)    rewrites boards/<board>.mmd to the last applied source, if it differs
//   fromFile(board)     a settled direct write to boards/<board>.mmd, as the `external` author
//
// - `base` absent or null: the current master. `writtenAt` is when the Mermaid was written (the
//   writer's clock, or the file's mtime), never the apply time, so a stale write loses to a newer
//   edit of the same unit in the merge (D8).
// - `previous` (which ids the apply may delete, and which styles Mermaid had set) is the Mermaid
//   the base was built from: the board's last applied source, else the .mmd on disk when the base
//   carries its hash (a tab conversion). When neither is known nothing is deleted, so a shape a
//   human duplicated from a Mermaid shape (it carries the same hash) is never removed.
// - A brand-new board, a board without Mermaid shapes and non-flowchart diagrams still need a
//   tab's full layout: the source goes to the inbox file and an open tab converts it.
import { promises as fs } from "node:fs";
import { performance } from "node:perf_hooks";
import { applyMermaid } from "../../tools/mermaid-apply.mjs";
import { mermaidSourceHash, recordedMermaidHashes } from "../../tools/mermaid-hash.mjs";
import { parseFlowchart as defaultParseFlowchart } from "../../tools/mermaid-parse.mjs";
import { parseAuthorKey, writeFileAtomic } from "./versions.mjs";

// The inbox file's text: LF endings and one trailing newline, as write_mermaid always wrote it.
export const inboxText = (source) => String(source ?? "").replace(/\r\n?/g, "\n").replace(/\n?$/, "\n");

// A previous Mermaid with no ids: nothing may be deleted and no style is reset.
const NO_PREVIOUS = Object.freeze({ ok: true, diagramType: "flowchart", direction: "TD", nodes: [], edges: [], subgraphs: [], classDefs: {} });
const PARSE_CACHE_LIMIT = 32;

export function createMermaidWriter({
  versions,
  inboxPath,
  parseFlowchart = defaultParseFlowchart,
  onInboxWritten = () => {},
  publishInbox = () => {},
}) {
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
    parseCache.set(hash, parsed);
    if (parseCache.size > PARSE_CACHE_LIMIT) {
      parseCache.delete(parseCache.keys().next().value);
    }
    return parsed;
  };

  const readInbox = async (name) => {
    try {
      return await fs.readFile(inboxPath(name), "utf8");
    } catch {
      return null;
    }
  };

  // One inbox write at a time per board, so the file ends up as the last applied source.
  const inboxChains = new Map();
  const serialize = (name, job) => {
    const run = (inboxChains.get(name) ?? Promise.resolve()).then(job);
    const chained = run.catch(() => {});
    inboxChains.set(name, chained);
    void chained.then(() => {
      if (inboxChains.get(name) === chained) {
        inboxChains.delete(name);
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

  const toTab = async (name, source, hash, reason) => {
    await serialize(name, () => writeInbox(name, source));
    publishInbox(name);
    return { status: "needs-tab", reason, hash };
  };

  // The Mermaid the base was built from (see the header).
  const previousFor = async (name, baseElements) => {
    const recorded = recordedMermaidHashes(baseElements);
    const stored = (await versions.readMermaid(name))?.source ?? null;
    const onDisk = await readInbox(name);
    const candidates = [stored, onDisk].filter((source) => typeof source === "string" && source.trim());
    const source = candidates.find((candidate) => recorded.has(mermaidSourceHash(candidate))) ?? stored;
    if (!source) {
      return { parsed: NO_PREVIOUS, known: false };
    }
    const parsed = await parseCached(source);
    return parsed?.ok ? { parsed, known: true } : { parsed: NO_PREVIOUS, known: false };
  };

  const prepare = async (name, { author, displayName, base, writtenAt, source }) => {
    if (!parseAuthorKey(author)) {
      return { status: "invalid", error: "invalid-author" };
    }
    if (typeof source !== "string" || !source.trim()) {
      return { status: "invalid", error: "mermaid-required" };
    }
    if (base !== undefined && base !== null && typeof base !== "string") {
      return { status: "invalid", error: "invalid-base" };
    }
    if (writtenAt !== undefined && writtenAt !== null && !(typeof writtenAt === "number" && Number.isFinite(writtenAt))) {
      return { status: "invalid", error: "invalid-writtenAt" };
    }
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
    const at = await time("read", async () => (base === undefined || base === null ? versions.readMaster(name) : versions.readVersion(name, base)));
    if (!at) {
      if (base !== undefined && base !== null) {
        return { status: "unknown-base", base, currentVersion: (await versions.readState(name)).version };
      }
      return toTab(name, text, hash, "new board");
    }
    if (parsed.unsupported) {
      return toTab(name, text, hash, `unsupported diagram type: ${parsed.diagramType}`);
    }
    let previous;
    try {
      previous = await time("parse", () => previousFor(name, at.scene.elements));
    } catch (error) {
      return { status: "parser-unavailable", error: error.message };
    }
    const now = typeof writtenAt === "number" ? writtenAt : Date.now();
    const applied = await time("apply", async () => applyMermaid({ master: at.scene, parsed, hashOfSource: hash, now, previous: previous.parsed }));
    if (applied.error) {
      return { status: "syntax-error", error: applied.error };
    }
    if (applied.needsTabLayout) {
      return toTab(name, text, hash, applied.reason);
    }
    return {
      status: "submit",
      hash,
      ops: applied.ops,
      previousKnown: previous.known,
      stages,
      input: {
        author,
        displayName,
        base: at.version,
        writtenAt: now,
        kind: "mermaid",
        // Nothing to change: record the applied source only, so "Mermaid pending" clears.
        elements: applied.ops.length ? applied.elements.filter((element) => !element.isDeleted) : null,
        ops: applied.ops,
        mermaid: { source: text, hash },
      },
    };
  };

  // After a commit: the inbox file shows the last applied Mermaid (a human-readable export).
  const syncInbox = (name) => serialize(name, async () => {
    const applied = await versions.readMermaid(name);
    return applied?.source ? writeInbox(name, applied.source) : false;
  });

  // A settled direct write to the inbox (an agent or editor writing files). Already applied, or
  // the source the board was converted from: nothing to do.
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
    if (state.version !== null && state.mermaid?.hash === hash) {
      return { status: "applied", hash };
    }
    const master = state.version !== null ? await versions.readMaster(name) : null;
    if (master && master.scene.elements.some((element) => !element.isDeleted) && recordedMermaidHashes(master.scene.elements).has(hash)) {
      return { status: "applied", hash };
    }
    const prepared = await prepare(name, { author: "external", base: master?.version ?? null, writtenAt: stat.mtimeMs, source });
    if (prepared.status !== "submit") {
      if (prepared.status === "syntax-error" || prepared.status === "parser-unavailable") {
        // As before server-side apply: an open tab tries the conversion and shows the error.
        publishInbox(name);
      }
      return prepared;
    }
    const result = await versions.submitBranch(name, prepared.input, { source: "mermaid-file", stages: prepared.stages });
    await syncInbox(name);
    return { ...result, ops: prepared.ops };
  };

  return { prepare, syncInbox, fromFile, inboxText };
}
