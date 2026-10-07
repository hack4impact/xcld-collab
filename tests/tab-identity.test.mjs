import assert from "node:assert/strict";
import { test } from "node:test";
import { tabAuthor } from "../app/server/api.mjs";
import { parseAuthorKey } from "../app/server/versions.mjs";
import {
  FALLBACK_NAME,
  NAME_STORAGE_KEY,
  TAB_STORAGE_KEY,
  authorKey,
  describeAuthor,
  guardTabId,
  identityHeaders,
  isTabId,
  newTabId,
  normalizeAuthorName,
  readStoredName,
  readTabId,
  resolveAuthorName,
  storeName,
} from "../app/src/identity.mjs";
import { addBannerItems, bannerDetails, bannerSummary, formatTime, MAX_BANNER_ITEMS, mergeItems } from "../app/src/merge-banner.mjs";

const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
};

const self = { name: "Ada Lovelace", tabId: "tabA1" };

test("author names are normalized the way the server accepts them", () => {
  assert.equal(normalizeAuthorName("  Ada \n Lovelace\t"), "Ada Lovelace");
  assert.equal(normalizeAuthorName(""), null);
  assert.equal(normalizeAuthorName("   "), null);
  assert.equal(normalizeAuthorName(null), null);
  const long = normalizeAuthorName("x".repeat(150));
  assert.equal(long.length, 100);
  // A surrogate pair cut at the limit is dropped, not left half.
  const emoji = normalizeAuthorName(`${"x".repeat(99)}\u{1F600}`);
  assert.equal(emoji, "x".repeat(99));
  for (const name of ["Ada Lovelace", "José #2", "名前", long, emoji]) {
    assert.equal(parseAuthorKey(authorKey({ name, tabId: "t1" }))?.kind, "human", name);
  }
});

test("the tab id is per tab, kept across reloads, and replaced when invalid", () => {
  let counter = 0;
  const make = () => `tab${++counter}`;
  const session = memoryStorage();
  const first = readTabId(session, make);
  assert.equal(first, "tab1");
  assert.equal(readTabId(session, make), "tab1", "a reload of the same tab keeps its id");
  assert.equal(readTabId(memoryStorage(), make), "tab2", "another tab gets its own id");
  assert.equal(readTabId(memoryStorage({ [TAB_STORAGE_KEY]: "bad id!" }), make), "tab3");
  assert.equal(readTabId(null, make), "tab4", "no sessionStorage still yields an id");
  const generated = newTabId();
  assert.ok(isTabId(generated), generated);
  assert.notEqual(newTabId(), generated);
});

test("the name: a rename in this browser, else XCLD_AUTHOR_NAME, else anonymous", () => {
  const local = memoryStorage();
  assert.equal(resolveAuthorName({ stored: readStoredName(local), configured: "Ada Lovelace" }), "Ada Lovelace");
  assert.equal(storeName(local, "  Grace  Hopper "), "Grace Hopper");
  assert.equal(local.getItem(NAME_STORAGE_KEY), "Grace Hopper");
  assert.equal(resolveAuthorName({ stored: readStoredName(local), configured: "Ada Lovelace" }), "Grace Hopper");
  assert.equal(storeName(local, ""), null, "an empty rename forgets the stored name");
  assert.equal(local.getItem(NAME_STORAGE_KEY), null);
  assert.equal(resolveAuthorName({ stored: null, configured: "  " }), FALLBACK_NAME);
  assert.equal(resolveAuthorName(), FALLBACK_NAME);
});

test("identity headers round-trip through the server's tabAuthor", () => {
  for (const identity of [self, { name: "José #2", tabId: "x_y-1" }, { name: "名前", tabId: "z" }]) {
    const headers = Object.fromEntries(Object.entries(identityHeaders(identity)).map(([key, value]) => [key.toLowerCase(), value]));
    assert.equal(tabAuthor(headers), authorKey(identity));
  }
  // Two tabs of one person: the same name, distinct keys.
  assert.notEqual(authorKey({ name: "Ada", tabId: "t1" }), authorKey({ name: "Ada", tabId: "t2" }));
});

test("author keys read as people, relative to this tab", () => {
  assert.equal(describeAuthor("human:Ada Lovelace#tabA1", self), "you");
  assert.equal(describeAuthor("human:Ada Lovelace#tabB2", self), "Ada Lovelace (another tab)");
  assert.equal(describeAuthor("human:Grace#t9", self), "Grace");
  assert.equal(describeAuthor("agent:copilot-cli#a1b2c3", self), "copilot-cli (agent)");
  assert.equal(describeAuthor("cli:docs", self), "docs (CLI)");
  assert.equal(describeAuthor("external", self), "a direct file edit");
  assert.equal(describeAuthor("init", self), "the first snapshot");
  assert.equal(describeAuthor(null, self), "someone");
});

test("a duplicated tab (same id copied into sessionStorage) takes a fresh id", () => {
  const listeners = new Set();
  // A BroadcastChannel delivers to every other channel object, never to the sender.
  const channel = () => {
    const self = {
      handlers: [],
      addEventListener: (_type, handler) => self.handlers.push(handler),
      removeEventListener: (_type, handler) => {
        self.handlers = self.handlers.filter((item) => item !== handler);
      },
      postMessage: (data) => {
        for (const other of listeners) {
          if (other !== self) other.handlers.forEach((handler) => handler({ data: structuredClone(data) }));
        }
      },
    };
    listeners.add(self);
    return self;
  };
  let originalId = "same1";
  let copyId = "same1";
  let otherId = "other";
  let originalTaken = 0;
  guardTabId({ channel: channel(), getTabId: () => originalId, instance: "i1", onTaken: () => { originalTaken++; originalId = "fresh0"; } });
  guardTabId({ channel: channel(), getTabId: () => otherId, instance: "i3", onTaken: () => { otherId = "never"; } });
  guardTabId({ channel: channel(), getTabId: () => copyId, instance: "i2", onTaken: () => { copyId = "fresh1"; } });
  assert.equal(copyId, "fresh1", "the newcomer moves");
  assert.equal(originalId, "same1", "the tab that was there first keeps its id");
  assert.equal(originalTaken, 0);
  assert.equal(otherId, "other");
});

test("the banner lists what merged from whom and every overwritten unit", () => {
  const at = Date.UTC(2026, 9, 7, 12, 0, 0);
  const agentWrite = mergeItems({
    author: "agent:copilot-cli#a1b2c3",
    applied: [
      { unitId: "a", label: "Cache", kind: "added" },
      { unitId: "b", label: "API", kind: "changed" },
      { unitId: "c", label: "rectangle c", kind: "added" },
    ],
    overwritten: [
      { unitId: "b", label: "API", winner: { author: "agent:copilot-cli#a1b2c3", writtenAt: 2 }, loser: { author: "human:Ada Lovelace#tabA1", writtenAt: 1 } },
    ],
    at,
  }, self);
  const tabWrite = mergeItems({
    author: "human:Ada Lovelace#tabB2",
    applied: [{ unitId: "d", label: "Queue", kind: "deleted" }],
    overwritten: [
      { unitId: "e", label: "DB", winner: { author: "human:Ada Lovelace#tabB2", writtenAt: 3 }, loser: { author: "cli:docs", writtenAt: 1 } },
    ],
    at,
  }, self);
  const ownSave = mergeItems({
    author: "human:Ada Lovelace#tabA1",
    applied: [{ unitId: "f", label: "mine", kind: "added" }],
    overwritten: [
      { unitId: "g", label: "Auth", winner: { author: "human:Ada Lovelace#tabA1", writtenAt: 5 }, loser: { author: "agent:copilot-cli#a1b2c3", writtenAt: 4 } },
    ],
    dropped: [{ unitId: "h", label: "Note" }],
    at,
  }, self);
  assert.equal(ownSave.some((item) => item.type === "applied"), false, "this tab's own changes are not news");
  const items = addBannerItems(addBannerItems(agentWrite, tabWrite), ownSave);
  assert.equal(
    bannerSummary(items),
    "Merged from copilot-cli (agent): 2 added, 1 changed; Ada Lovelace (another tab): 1 deleted · 3 overwritten edits (1 of yours) · 1 edit replaced while saving",
  );
  const details = bannerDetails(items).map((line) => {
    assert.ok(line.startsWith(`${formatTime(at)} `), line);
    return line.slice(formatTime(at).length + 1);
  });
  assert.deepEqual(details, [
    "copilot-cli (agent) added \"Cache\"",
    "copilot-cli (agent) changed \"API\"",
    "copilot-cli (agent) added \"rectangle c\"",
    "\"API\": your edit was overwritten by copilot-cli (agent)'s newer edit. Yours is kept in version history.",
    "Ada Lovelace (another tab) deleted \"Queue\"",
    "\"DB\": Ada Lovelace (another tab) overwrote docs (CLI)'s edit, which is kept in version history.",
    "\"Auth\": your newer edit overwrote copilot-cli (agent)'s. Theirs is kept in version history.",
    "\"Note\": an edit you made while saving was replaced by the merged board.",
  ]);
  assert.equal(bannerSummary([]), "");
  const many = addBannerItems([], Array.from({ length: MAX_BANNER_ITEMS + 5 }, (_, index) => ({ type: "dropped", label: `n${index}`, at })));
  assert.equal(many.length, MAX_BANNER_ITEMS);
  assert.equal(many[0].label, "n5", "the oldest items go first");
});

test("a write that lost every change still reaches the banner (overwritten only)", () => {
  const items = mergeItems({
    author: "agent:copilot-cli#a1b2c3",
    applied: [],
    overwritten: [{ unitId: "u", label: "Cache", winner: { author: "human:Ada Lovelace#tabA1", writtenAt: 9 }, loser: { author: "agent:copilot-cli#a1b2c3", writtenAt: 1 } }],
  }, self);
  assert.equal(bannerSummary(items), "1 overwritten edit");
  assert.match(bannerDetails(items)[0], /"Cache": your newer edit overwrote copilot-cli \(agent\)'s\. Theirs is kept in version history\.$/);
});
