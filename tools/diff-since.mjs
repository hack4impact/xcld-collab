// `xcld diff <board> --since <version|time|author|snapshot>`: master against the board as it was at
// a point in its version history, plus every edit overwritten since then (the losers, which live
// only in history). Shared by the server (GET /api/diff), the CLI and the MCP `diff` tool.
//
// A `since` spec is one of:
//   author:<key or name>   since that author's last history entry (its own losses included)
//   snapshot:<label>       a pinned version (xcld snapshot); a bare label works too
//   version:<id prefix>    a version id (the board's ETag / read_board version), 4+ hex digits
//   time:<when>            an ISO time (2026-10-07T21:00Z) or a relative one (90s, 10m, 2h, 1d)
// A bare spec is tried as a snapshot label, then a version prefix, then a time.
//
// The point resolves to a history entry: its version is the "since" board, and the losers are the
// `overwritten` lists of the entries committed after it (for `author:`, from that entry on). An
// entry stands for a whole author turn, so a time inside a human's coalesced turn resolves to the
// entry before it, and the turn counts as "since".
import { authorLabeler } from "./author-label.mjs";
import { diffScenes, formatDiff } from "./diff.mjs";
import { describeUnlabeled, labelContext } from "./unit-label.mjs";

const HEX = /^[0-9a-f]{4,64}$/i;
const RELATIVE = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/i;
const UNIT_MS = { s: 1000, sec: 1000, secs: 1000, m: 60_000, min: 60_000, mins: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, d: 86_400_000, day: 86_400_000, days: 86_400_000 };

export class SinceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** A time spec as ms since the epoch: relative to `now` (10m, 2h) or absolute (ISO); null if neither. */
export const parseSinceTime = (text, now = Date.now()) => {
  const value = String(text ?? "").trim();
  const relative = RELATIVE.exec(value);
  if (relative) {
    return now - Number(relative[1]) * UNIT_MS[relative[2].toLowerCase()];
  }
  // A date-like string only: Date.parse accepts odd inputs such as "1".
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return null;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

/** Splits a spec into its kind and value; `auto` for a bare spec. */
export const parseSinceSpec = (spec) => {
  const value = String(spec ?? "").trim();
  if (!value) {
    throw new SinceError("invalid-since", "since is empty: pass a version id, a time (10m, 2h, an ISO time), author:<name> or a snapshot label");
  }
  const match = /^(author|snapshot|pin|version|time):(.*)$/i.exec(value);
  if (!match) {
    return { kind: "auto", value };
  }
  const kind = match[1].toLowerCase() === "pin" ? "snapshot" : match[1].toLowerCase();
  const rest = match[2].trim();
  if (!rest) {
    throw new SinceError("invalid-since", `${kind}: needs a value`);
  }
  return { kind, value: rest };
};

// `human:Ada#tab1` -> "Ada", `agent:copilot-cli#a1b2c3` -> "copilot-cli#a1b2c3", `cli:bot` -> "cli:bot".
export const authorLabel = (key) => {
  const text = String(key ?? "");
  const human = /^human:(.*)#[^#]*$/.exec(text);
  if (human) return human[1];
  const agent = /^agent:(.*)$/.exec(text);
  if (agent) return agent[1];
  return text || "unknown";
};

const authorMatches = (wanted, meta) => {
  const key = String(meta.author ?? "");
  const want = wanted.trim();
  const lower = want.toLowerCase();
  if (key === want || key.replace(/#[^#]*$/, "") === want) return true;
  const name = authorLabel(key);
  return [name, name.replace(/#[^#]*$/, ""), meta.displayName ?? ""].some((candidate) => candidate && candidate.toLowerCase() === lower);
};

const pinsOf = (meta) => (Array.isArray(meta.pins) ? meta.pins.map((pin) => pin.label) : meta.pinned ? [meta.pinned] : []);
const commitAt = (item) => Number(item.meta.lastCommitAt ?? item.meta.openedAt ?? 0);
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const textOf = (element) => String(element?.originalText ?? element?.text ?? "").replace(/\s+/g, " ").trim();

// What the losing version said: its texts, or for a unit without text a description of where it
// was (on the board as it is now), never a bare element id.
const loserLabels = (elements = [], board = []) => {
  const texts = elements.filter((element) => element?.type === "text").map(textOf).filter(Boolean);
  if (texts.length) return texts;
  const context = labelContext([...elements, ...board]);
  return elements.map((element) => describeUnlabeled(element, context));
};

const turnOf = (item) => ({
  entry: item.entry,
  author: item.meta.author,
  displayName: item.meta.displayName ?? authorLabel(item.meta.author),
  at: iso(commitAt(item)),
  version: item.meta.record === "none" ? null : item.meta.version,
  applied: (item.meta.applied ?? []).length,
  overwritten: (item.meta.overwritten ?? []).length,
  ...(item.open ? { open: true } : {}),
  ...(item.meta.record === "none" ? { unchanged: true } : {}),
  ...(pinsOf(item.meta).length ? { pins: pinsOf(item.meta) } : {}),
});

// The entries a spec can point at, and how the point was found.
const resolvePoint = async ({ history, spec, now, resolveVersion, currentVersion }) => {
  const { kind, value } = parseSinceSpec(spec);
  const entries = history.entries;
  const withVersion = entries.filter((item) => item.meta.record !== "none" && item.meta.version);
  const bySnapshot = () => {
    const pinned = withVersion.filter((item) => pinsOf(item.meta).includes(value));
    return pinned.length ? { kind: "snapshot", label: value, item: pinned.at(-1), inclusive: false } : null;
  };
  const byVersion = async () => {
    if (!HEX.test(value)) {
      return null;
    }
    const prefix = value.toLowerCase();
    const versions = [...new Set(withVersion.map((item) => item.meta.version).filter((version) => version.startsWith(prefix)))];
    if (versions.length > 1) {
      throw new SinceError("ambiguous-since", `version prefix ${value} matches ${versions.length} versions (${versions.map((version) => version.slice(0, 12)).join(", ")}); give more digits`);
    }
    if (versions.length === 1) {
      // The latest entry with that version (an unchanged write can repeat it).
      const item = withVersion.filter((candidate) => candidate.meta.version === versions[0]).at(-1);
      return { kind: "version", item, inclusive: false };
    }
    // A version that is not a history entry: an intermediate save of a human turn (folded into
    // the turn) that the server still holds as a base, because someone read it.
    if (resolveVersion && /^[0-9a-f]{64}$/i.test(value)) {
      const found = await resolveVersion(prefix);
      if (found?.scene) {
        const at = Number.isFinite(found.at) ? found.at : null;
        return { kind: "version", item: null, version: prefix, scene: found.scene, at, approximate: true, inclusive: true };
      }
    }
    if (currentVersion && currentVersion.startsWith(prefix)) {
      return { kind: "version", item: null, version: currentVersion, current: true, inclusive: false };
    }
    return null;
  };
  const byTime = () => {
    const at = parseSinceTime(value, now);
    if (at === null) {
      return null;
    }
    const before = withVersion.filter((item) => commitAt(item) <= at);
    return { kind: "time", at, item: before.at(-1) ?? null, empty: before.length === 0, inclusive: false };
  };
  const byAuthor = () => {
    const own = entries.filter((item) => authorMatches(value, item.meta));
    if (!own.length) {
      const authors = [...new Set(entries.map((item) => item.meta.author))].map(authorLabel);
      throw new SinceError("since-not-found", `no history entry by ${value} on ${history.board}${authors.length ? ` (authors: ${authors.join(", ")})` : ""}`);
    }
    const latest = own.reduce((best, item) => (commitAt(item) >= commitAt(best) ? item : best));
    return { kind: "author", author: latest.meta.author, item: latest, inclusive: true };
  };

  let point = null;
  if (kind === "author") point = byAuthor();
  else if (kind === "snapshot") point = bySnapshot();
  else if (kind === "version") point = await byVersion();
  else if (kind === "time") {
    point = byTime();
    if (!point) throw new SinceError("invalid-since", `not a time: ${value} (use 90s, 10m, 2h, 1d or an ISO time such as 2026-10-07T21:00:00Z)`);
  } else {
    point = bySnapshot() ?? await byVersion() ?? byTime();
  }
  if (!point) {
    const what = kind === "snapshot" ? `snapshot "${value}"` : kind === "version" ? `version ${value}` : `"${value}"`;
    throw new SinceError("since-not-found", `${what} is not in the history of ${history.board}. Use a version id (read_board / xcld read), a snapshot label (xcld snapshot), author:<name>, or a time (10m, 2h, an ISO time).`);
  }
  return { ...point, spec: String(spec).trim() };
};

/**
 * Master against the board at a point in its history, with the losers since then.
 * @param {object} input
 * @param {Awaited<ReturnType<import("./history.mjs").openHistory>>} input.history
 * @param {{ version: string | null, scene: { elements: object[] } }} input.master
 * @param {string} input.since
 * @param {number} [input.now]
 * @param {(version: string) => Promise<{ scene: object, at?: number } | null>} [input.resolveVersion]
 *   Finds a full version id that is not a history entry (the server's base store).
 * @param {{ board?: string, boardsDir?: string }} [input.diffOptions] Enables the design-rule tags.
 */
export const diffSince = async ({ history, master, since, now = Date.now(), resolveVersion, diffOptions = {} }) => {
  const point = await resolvePoint({ history, spec: since, now, resolveVersion, currentVersion: master.version });
  let item = point.item;
  let scene = point.scene ?? null;
  let version = point.version ?? item?.meta.version ?? null;
  let approximate = Boolean(point.approximate);
  if (point.current) {
    scene = master.scene;
  } else if (!scene && item && !point.empty) {
    scene = await history.sceneOf(item.meta.version).catch(() => null);
    if (!scene) {
      // The version was folded into a later save of a human turn (an unchanged write recorded
      // it): use the nearest earlier entry that still has its own version.
      const earlier = history.entries.filter((candidate) => candidate.meta.record !== "none" && candidate.meta.version && commitAt(candidate) <= commitAt(item) && candidate !== item);
      for (const candidate of earlier.reverse()) {
        scene = await history.sceneOf(candidate.meta.version).catch(() => null);
        if (scene) {
          version = candidate.meta.version;
          approximate = true;
          break;
        }
      }
    }
  }
  const sinceAt = point.kind === "time" ? point.at : point.at ?? (item ? commitAt(item) : null);
  // Entries after the point (for author:, the author's entry itself too). Without a time (a
  // base-store version of unknown age) every entry counts: more losers, never fewer.
  const window = history.entries.filter((candidate) => {
    if (point.current) return false;
    if (point.inclusive && candidate === item) return true;
    if (sinceAt === null) return true;
    return point.inclusive ? commitAt(candidate) >= sinceAt : commitAt(candidate) > sinceAt;
  });
  const overwritten = [];
  for (const candidate of window) {
    for (const lost of candidate.meta.overwritten ?? []) {
      const loser = lost.loser ?? {};
      const winner = lost.winner ?? {};
      overwritten.push({
        entry: candidate.entry,
        unitId: lost.unitId,
        label: lost.label,
        ...(lost.unlabeled ? { unlabeled: true } : {}),
        elementIds: lost.elementIds ?? [],
        winner: { author: winner.author ?? null, side: winner.side ?? null, writtenAt: winner.writtenAt ?? null },
        loser: {
          author: loser.author ?? null,
          side: loser.side ?? null,
          writtenAt: loser.writtenAt ?? null,
          deleted: Array.isArray(loser.elements) && loser.elements.length === 0,
          labels: loserLabels(loser.elements, master.scene?.elements ?? []),
          ...(Array.isArray(loser.elements) && loser.elements.length && !loser.elements.some((element) => element?.type === "text" && textOf(element)) ? { unlabeled: true } : {}),
        },
      });
    }
  }
  const short = (value) => (value ? value.slice(0, 12) : "empty board");
  const authors = [...new Set(history.entries.map((candidate) => candidate.meta.author).filter(Boolean))];
  const authorName = authorLabeler(authors);
  const diff = await diffScenes(scene?.elements ?? [], master.scene?.elements ?? [], { old: `${history.board}@${short(version)}`, new: `${history.board}@${short(master.version)} (current)` }, { ...diffOptions, authorName });
  return {
    board: history.board,
    current: master.version,
    since: {
      spec: point.spec,
      kind: point.kind,
      version,
      entry: item?.entry ?? null,
      at: iso(sinceAt),
      ...(point.kind === "author" ? { author: point.author } : {}),
      ...(point.label ? { label: point.label } : {}),
      ...(item ? { by: item.meta.author } : {}),
      ...(point.empty ? { emptyBoard: true } : {}),
      ...(approximate ? { approximate: true } : {}),
    },
    turns: window.map(turnOf),
    // Every author in the board's history, so names that need a session or tab id get one.
    authors,
    diff,
    overwritten,
  };
};

const clock = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "?");

/** Text for people and agents: the point, the turns since, the semantic diff, then the losers. */
export const formatDiffSince = (result) => {
  const { since } = result;
  // One labeler for the whole answer: two sessions of one agent client (or two tabs of one
  // person) get their short ids, e.g. copilot-cli#8cb0a4 (agent).
  const who = authorLabeler([
    ...(result.authors ?? []),
    since.author,
    since.by,
    ...result.turns.map((turn) => turn.author),
    ...result.overwritten.flatMap((item) => [item.winner.author, item.loser.author]),
  ]);
  const quoted = (text, unlabeled) => (unlabeled ? text : `"${text}"`);
  const what = since.kind === "author"
    ? `${who(since.author)}'s last entry`
    : since.kind === "snapshot"
      ? `snapshot "${since.label}"`
      : since.kind === "time"
        ? `${since.spec}`
        : `version ${since.version?.slice(0, 12) ?? "?"}`;
  const at = since.at ? ` (${clock(Date.parse(since.at))} UTC)` : "";
  const lines = [`Since ${what}${at}: ${since.emptyBoard ? "an empty board (before the first entry)" : `version ${since.version ? since.version.slice(0, 12) : "?"}`}${since.approximate ? " (approximate: that exact version is folded into a turn; compared from the nearest one kept)" : ""}.`];
  if (result.turns.length) {
    const counts = new Map();
    for (const turn of result.turns) counts.set(who(turn.author), (counts.get(who(turn.author)) ?? 0) + 1);
    lines.push(`${result.turns.length} history entr${result.turns.length === 1 ? "y" : "ies"} since: ${[...counts].map(([name, count]) => `${name} ${count}`).join(", ")}.`);
  } else {
    lines.push("No history entries since then.");
  }
  lines.push(formatDiff(result.diff));
  if (result.overwritten.length) {
    lines.push(`Overwritten since then (${result.overwritten.length}); each losing edit is kept in history only, nothing re-applies it:`);
    for (const item of result.overwritten) {
      const lost = item.loser.deleted ? "a delete" : quoted(item.loser.labels.join(" / "), item.loser.unlabeled);
      lines.push(`  ! ${quoted(item.label, item.unlabeled)} (${item.unitId}): ${who(item.loser.author)}'s edit (${lost}, written ${clock(item.loser.writtenAt)}) lost to ${who(item.winner.author)} (written ${clock(item.winner.writtenAt)}) [entry ${item.entry}]`);
    }
  } else {
    lines.push("Nothing overwritten since then.");
  }
  return lines.join("\n");
};
