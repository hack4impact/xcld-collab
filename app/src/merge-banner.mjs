// The merged banner (versions and merge, slice 5): what merged into the board, from whom, and
// which edits were overwritten. Pure, so the wording is unit-tested without a browser.
import { authorKey, describeAuthor } from "./identity.mjs";

export const MAX_BANNER_ITEMS = 100;

/**
 * @typedef {{ writtenAt?: number, author?: string | null }} Stamp
 * @typedef {{ unitId?: string, label: string, kind?: string }} AppliedUnit
 * @typedef {{ unitId?: string, label: string, winner?: Stamp, loser?: Stamp }} OverwrittenUnit
 * @typedef {{ type: "applied" | "overwritten" | "dropped", label: string, at: number, who?: string,
 *   kind?: string, winner?: string, loser?: string, mine?: "lost" | "won" | null }} BannerItem
 */

const quote = (label) => `"${String(label ?? "").replace(/\s+/g, " ").trim() || "element"}"`;

/**
 * Banner items for one merge: a `merged` SSE event, a save's answer, or the tab's own rebase of
 * edits made while a save was in flight (`dropped`). `self` is `{ name, tabId }`; this tab's own
 * applied changes are not listed (it made them).
 * @param {{ author?: string | null, applied?: AppliedUnit[], overwritten?: OverwrittenUnit[], dropped?: OverwrittenUnit[], at?: number }} merge
 * @param {{ name: string, tabId: string } | null} [self]
 * @returns {BannerItem[]}
 */
export const mergeItems = ({ author = null, applied = [], overwritten = [], dropped = [], at = Date.now() } = {}, self = null) => {
  const selfKey = self ? authorKey(self) : null;
  /** @type {BannerItem[]} */
  const items = [];
  if (author !== selfKey) {
    for (const unit of applied ?? []) {
      items.push({ type: "applied", who: describeAuthor(author, self), kind: unit.kind, label: unit.label, at });
    }
  }
  for (const unit of overwritten ?? []) {
    const winner = unit.winner?.author ?? null;
    const loser = unit.loser?.author ?? null;
    items.push({
      type: "overwritten",
      label: unit.label,
      winner: describeAuthor(winner, self),
      loser: describeAuthor(loser, self),
      mine: selfKey && loser === selfKey ? "lost" : selfKey && winner === selfKey ? "won" : null,
      at,
    });
  }
  for (const unit of dropped ?? []) {
    items.push({ type: "dropped", label: unit.label, at });
  }
  return items;
};

/**
 * @param {BannerItem[]} current
 * @param {BannerItem[]} next
 * @returns {BannerItem[]}
 */
export const addBannerItems = (current, next) => (next.length ? [...current, ...next].slice(-MAX_BANNER_ITEMS) : current);

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * One line: what merged from whom, and how many units were overwritten.
 * @param {BannerItem[]} items
 * @returns {string}
 */
export const bannerSummary = (items) => {
  const parts = [];
  const byWho = new Map();
  for (const item of items) {
    if (item.type === "applied") {
      const counts = byWho.get(item.who) ?? new Map();
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
      byWho.set(item.who, counts);
    }
  }
  const fromWho = [...byWho].map(([who, counts]) => `${who}: ${["added", "changed", "deleted"].filter((kind) => counts.has(kind)).map((kind) => `${counts.get(kind)} ${kind}`).join(", ")}`);
  if (fromWho.length) {
    parts.push(`Merged from ${fromWho.join("; ")}`);
  }
  const overwritten = items.filter((item) => item.type === "overwritten");
  if (overwritten.length) {
    const lost = overwritten.filter((item) => item.mine === "lost").length;
    parts.push(`${plural(overwritten.length, "overwritten edit")}${lost ? ` (${lost} of yours)` : ""}`);
  }
  const dropped = items.filter((item) => item.type === "dropped").length;
  if (dropped) {
    parts.push(`${plural(dropped, "edit")} replaced while saving`);
  }
  return parts.join(" · ");
};

export const formatTime = (at) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * One line per item, for "details".
 * @param {BannerItem[]} items
 * @returns {string[]}
 */
export const bannerDetails = (items) => items.map((item) => {
  const when = formatTime(item.at);
  if (item.type === "applied") {
    return `${when} ${item.who} ${item.kind} ${quote(item.label)}`;
  }
  if (item.type === "overwritten") {
    if (item.mine === "lost") {
      return `${when} ${quote(item.label)}: your edit was overwritten by ${item.winner}'s newer edit. Yours is kept in version history.`;
    }
    if (item.mine === "won") {
      return `${when} ${quote(item.label)}: your newer edit overwrote ${item.loser}'s. Theirs is kept in version history.`;
    }
    return `${when} ${quote(item.label)}: ${item.winner} overwrote ${item.loser}'s edit, which is kept in version history.`;
  }
  return `${when} ${quote(item.label)}: an edit you made while saving was replaced by the merged board.`;
});
