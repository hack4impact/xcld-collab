// The merged banner (versions and merge, slice 5): what merged into the board, from whom, and
// which edits were overwritten. Pure, so the wording is unit-tested without a browser.
import { authorLabeler } from "../../tools/author-label.mjs";
import { authorKey } from "./identity.mjs";

export const MAX_BANNER_ITEMS = 100;

/**
 * @typedef {{ writtenAt?: number, author?: string | null }} Stamp
 * @typedef {{ unitId?: string, label: string, unlabeled?: boolean, kind?: string, styled?: string[] }} AppliedUnit
 * @typedef {{ unitId?: string, label: string, unlabeled?: boolean, winner?: Stamp, loser?: Stamp }} OverwrittenUnit
 * @typedef {{ type: "applied" | "overwritten" | "dropped", label: string, unlabeled?: boolean, at: number, who?: string,
 *   kind?: string, styled?: string[], winner?: string, loser?: string, whoKey?: string | null, winnerKey?: string | null,
 *   loserKey?: string | null, self?: { name: string, tabId: string } | null, mine?: "lost" | "won" | null }} BannerItem
 */

// A unit without label text comes as a description ("unlabeled arrow from "A" to "B""), shown as is.
const quote = (item) => (item.unlabeled ? String(item.label ?? "").trim() || "unlabeled element" : `"${String(item.label ?? "").replace(/\s+/g, " ").trim() || "element"}"`);

/**
 * Banner items for one merge: a `merged` SSE event, a save's answer, or the tab's own rebase of
 * edits made while a save was in flight (`dropped`). `self` is `{ name, tabId }`; this tab's own
 * applied changes are not listed (it made them). Items keep the author keys: the names are
 * worked out when the banner is shown, across every item in it (bannerSummary, bannerDetails).
 * @param {{ author?: string | null, applied?: AppliedUnit[], overwritten?: OverwrittenUnit[], dropped?: OverwrittenUnit[], at?: number }} merge
 * @param {{ name: string, tabId: string } | null} [self]
 * @returns {BannerItem[]}
 */
export const mergeItems = ({ author = null, applied = [], overwritten = [], dropped = [], at = Date.now() } = {}, self = null) => {
  const selfKey = self ? authorKey(self) : null;
  const me = self ? { name: self.name, tabId: self.tabId } : null;
  const label = authorLabeler([author, ...(overwritten ?? []).flatMap((unit) => [unit.winner?.author, unit.loser?.author])], { self: me });
  const unlabeled = (unit) => (unit.unlabeled ? { unlabeled: true } : {});
  /** @type {BannerItem[]} */
  const items = [];
  if (author !== selfKey) {
    for (const unit of applied ?? []) {
      items.push({ type: "applied", who: label(author), whoKey: author, self: me, kind: unit.kind, label: unit.label, ...unlabeled(unit), ...(unit.styled?.length ? { styled: unit.styled } : {}), at });
    }
  }
  for (const unit of overwritten ?? []) {
    const winner = unit.winner?.author ?? null;
    const loser = unit.loser?.author ?? null;
    items.push({
      type: "overwritten",
      label: unit.label,
      ...unlabeled(unit),
      winner: label(winner),
      loser: label(loser),
      winnerKey: winner,
      loserKey: loser,
      self: me,
      mine: selfKey && loser === selfKey ? "lost" : selfKey && winner === selfKey ? "won" : null,
      at,
    });
  }
  for (const unit of dropped ?? []) {
    items.push({ type: "dropped", label: unit.label, ...unlabeled(unit), at });
  }
  return items;
};

/**
 * @param {BannerItem[]} current
 * @param {BannerItem[]} next
 * @returns {BannerItem[]}
 */
export const addBannerItems = (current, next) => (next.length ? [...current, ...next].slice(-MAX_BANNER_ITEMS) : current);

// Names for every item, worked out together: two agent sessions of one client, or two tabs of
// one person, get their short ids ("copilot-cli#8cb0a4 (agent)") only when the banner holds both.
const named = (items) => {
  const keyed = items.filter((item) => "whoKey" in item || "winnerKey" in item || "loserKey" in item);
  if (!keyed.length) {
    return items;
  }
  const self = [...keyed].reverse().find((item) => item.self)?.self ?? null;
  const label = authorLabeler(keyed.flatMap((item) => [item.whoKey, item.winnerKey, item.loserKey]), { self });
  return items.map((item) => {
    if (item.type === "applied" && "whoKey" in item) {
      return { ...item, who: label(item.whoKey) };
    }
    if (item.type === "overwritten" && ("winnerKey" in item || "loserKey" in item)) {
      return { ...item, winner: label(item.winnerKey), loser: label(item.loserKey) };
    }
    return item;
  });
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * One line: what merged from whom, and how many units were overwritten.
 * @param {BannerItem[]} items
 * @returns {string}
 */
export const bannerSummary = (items) => {
  const parts = [];
  const byWho = new Map();
  for (const item of named(items)) {
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
export const bannerDetails = (items) => named(items).map((item) => {
  const when = formatTime(item.at);
  if (item.type === "applied") {
    return `${when} ${item.who} ${item.kind} ${quote(item)}${item.styled?.length ? `: ${item.styled.join(", ")}` : ""}`;
  }
  if (item.type === "overwritten") {
    if (item.mine === "lost") {
      return `${when} ${quote(item)}: your edit was overwritten by ${item.winner}'s newer edit. Yours is kept in version history.`;
    }
    if (item.mine === "won") {
      return `${when} ${quote(item)}: your newer edit overwrote ${item.loser}'s. Theirs is kept in version history.`;
    }
    return `${when} ${quote(item)}: ${item.winner} overwrote ${item.loser}'s edit, which is kept in version history.`;
  }
  return `${when} ${quote(item)}: an edit you made while saving was replaced by the merged board.`;
});
