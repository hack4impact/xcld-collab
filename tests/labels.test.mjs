// Labels for units without text and names for authors that share a display name (the lead's real
// check, 2026-10-08): the banner showed a bare element id ("rectangle 455hPNweELuTtqn7kYKT2", the
// merge's fallback for a rectangle the human drew without text) and "copilot-cli (agent) overwrote
// copilot-cli (agent)'s edit" for two sessions of one client.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addBannerItems, bannerDetails, bannerSummary, formatTime, mergeItems } from "../app/src/merge-banner.mjs";
import { authorLabeler, parseAuthor } from "../tools/author-label.mjs";
import { diffElements, formatDiff } from "../tools/diff.mjs";
import { diffSince, formatDiffSince } from "../tools/diff-since.mjs";
import { mergeBoard } from "../tools/merge.mjs";
import { describeUnlabeled, labelContext } from "../tools/unit-label.mjs";
import { formatHistoryEntry, formatMergedEvent } from "../tools/watch.mjs";

const RANDOM_ID = "455hPNweELuTtqn7kYKT2";
const box = (id, x, y, extra = {}) => ({ id, type: "rectangle", x, y, width: 180, height: 70, version: 1, isDeleted: false, ...extra });
const label = (id, containerId, text) => ({ id, type: "text", x: 0, y: 0, width: 10, height: 10, version: 1, isDeleted: false, containerId, text, originalText: text });
const arrow = (id, from, to, extra = {}) => ({ id, type: "arrow", x: 200, y: 35, width: 100, height: 0, points: [[0, 0], [100, 0]], version: 1, isDeleted: false, startBinding: from ? { elementId: from, focus: 0, gap: 5 } : null, endBinding: to ? { elementId: to, focus: 0, gap: 5 } : null, ...extra });
const board = () => [
  box("pay", 0, 0, { boundElements: [{ type: "text", id: "pay-t" }] }),
  label("pay-t", "pay", "Payments service"),
  box("fraud", 300, 0, { boundElements: [{ type: "text", id: "fraud-t" }] }),
  label("fraud-t", "fraud", "Fraud detection"),
  box("ledger", 0, 300, { boundElements: [{ type: "text", id: "ledger-t" }] }),
  label("ledger-t", "ledger", "Ledger v2"),
];

test("describeUnlabeled: arrows by their ends, other elements by the nearest labelled one", () => {
  const elements = [...board(), box("plain", 300, 300), arrow(RANDOM_ID, "pay", "fraud"), arrow("half", "pay", null), arrow("to-plain", "ledger", "plain"), box("frame", -50, -50, { width: 300, height: 200 })];
  const context = labelContext(elements);
  const find = (id) => elements.find((element) => element.id === id);
  assert.equal(describeUnlabeled(find(RANDOM_ID), context), 'unlabeled arrow from "Payments service" to "Fraud detection"');
  assert.equal(describeUnlabeled(find("half"), context), 'unlabeled arrow from "Payments service"');
  assert.equal(describeUnlabeled(find("to-plain"), context), 'unlabeled arrow from "Ledger v2" to an unlabeled rectangle');
  assert.equal(describeUnlabeled(box("near", 0, 420), context), 'unlabeled rectangle near "Ledger v2"');
  assert.equal(describeUnlabeled(find("frame"), context), 'unlabeled rectangle around "Payments service"');
  assert.equal(describeUnlabeled({ id: "x", type: "freedraw", x: 0, y: 0 }, labelContext([])), "unlabeled drawing");
  assert.equal(describeUnlabeled({ id: "x", type: "ellipse" }), "unlabeled ellipse");
});

test("merge labels: a unit without text is described, never named by its id; label text is kept as written", () => {
  const base = board();
  const branch = [...base, box(RANDOM_ID, 0, 420), arrow("a1", "pay", "fraud"), box("literal", 600, 0, { boundElements: [{ type: "text", id: "literal-t" }] }), label("literal-t", "literal", RANDOM_ID)];
  const result = mergeBoard({ base, master: base, branch, branchWrittenAt: 2, branchAuthor: "agent:copilot-cli#8cb0a4" });
  const byUnit = Object.fromEntries(result.applied.map((item) => [item.unitId, item]));
  assert.equal(byUnit[RANDOM_ID].label, 'unlabeled rectangle near "Ledger v2"');
  assert.equal(byUnit[RANDOM_ID].unlabeled, true);
  assert.equal(byUnit.a1.label, 'unlabeled arrow from "Payments service" to "Fraud detection"');
  assert.equal(byUnit.literal.label, RANDOM_ID, "an id-like label the writer typed stays as it is");
  assert.equal(byUnit.literal.unlabeled, undefined);
  for (const item of result.applied) {
    if (item.unlabeled) assert.ok(!item.label.includes(item.unitId), item.label);
  }
  // A deleted unit without text is described from where it was.
  const removed = mergeBoard({ base: branch, master: branch, branch: branch.filter((element) => element.id !== RANDOM_ID), branchWrittenAt: 3, branchAuthor: "x" });
  assert.deepEqual(removed.applied.map((item) => [item.label, item.kind]), [['unlabeled rectangle near "Ledger v2"', "deleted"]]);
});

test("diff: a node without text reads as a description, and a description that changes is no relabel", () => {
  const before = board();
  const after = [...before, box(RANDOM_ID, 0, 420), arrow("a1", RANDOM_ID, "ledger")];
  const diff = diffElements(before, after);
  assert.deepEqual(diff.nodes.added.map((item) => [item.label, item.unlabeled]), [['unlabeled rectangle near "Ledger v2"', true]]);
  const text = formatDiff(diff);
  assert.match(text, /\+ added unlabeled rectangle near "Ledger v2" \(455hPNweELuTtqn7kYKT2\)/);
  assert.match(text, /\+ added \(unlabeled rectangle\) --> Ledger v2 \(a1\)/);
  const moved = after.map((element) => (element.id === "ledger-t" ? { ...element, text: "Ledger v3", originalText: "Ledger v3" } : element));
  assert.deepEqual(diffElements(after, moved).nodes.relabeled.map((item) => item.id), ["ledger"], "only the real relabel");
  const named = after.map((element) => (element.id === RANDOM_ID ? { ...element, boundElements: [{ type: "text", id: "n-t" }] } : element)).concat(label("n-t", RANDOM_ID, "Cache"));
  assert.match(formatDiff(diffElements(after, named)), /~ relabeled \(no label\) -> "Cache"/);
});

test("authorLabeler: the short session or tab id only when it tells two authors apart", () => {
  assert.deepEqual(parseAuthor("agent:copilot-cli#8cb0a4"), { kind: "agent", name: "copilot-cli", id: "8cb0a4" });
  const one = authorLabeler(["agent:copilot-cli#8cb0a4", "human:Javid Fathi#HF60ekw4fU"]);
  assert.equal(one("agent:copilot-cli#8cb0a4"), "copilot-cli (agent)");
  assert.equal(one("human:Javid Fathi#HF60ekw4fU"), "Javid Fathi");
  const two = authorLabeler(["agent:copilot-cli#8cb0a4", "agent:copilot-cli#5d1209", "agent:vscode#8cb0a4", "cli:docs"]);
  assert.equal(two("agent:copilot-cli#8cb0a4"), "copilot-cli#8cb0a4 (agent)");
  assert.equal(two("agent:copilot-cli#5d1209"), "copilot-cli#5d1209 (agent)");
  assert.equal(two("agent:vscode#8cb0a4"), "vscode (agent)", "another client name needs no id");
  assert.equal(two("cli:docs"), "docs (CLI)");
  const long = authorLabeler(["agent:bot#abcdef01", "agent:bot#abcdef02"]);
  assert.equal(long("agent:bot#abcdef01"), "bot#abcdef01 (agent)", "ids that share 6 characters get longer");
  const tabs = authorLabeler(["human:Ada#tabA1", "human:Ada#tabB2", "human:Grace#t9"]);
  assert.equal(tabs("human:Ada#tabA1"), "Ada#tabA1");
  assert.equal(tabs("human:Grace#t9"), "Grace");
  const self = { name: "Ada", tabId: "tabA1" };
  const relative = authorLabeler(["human:Ada#tabA1", "human:Ada#tabB2"], { self });
  assert.equal(relative("human:Ada#tabA1"), "you");
  assert.equal(relative("human:Ada#tabB2"), "Ada (another tab)", "one other tab: no id");
  const crowded = authorLabeler(["human:Ada#tabA1", "human:Ada#tabB2", "human:Ada#tabC3"], { self });
  assert.equal(crowded("human:Ada#tabC3"), "Ada#tabC3 (another tab)");
  assert.equal(authorLabeler([], { agentIds: true })("agent:copilot-cli#8cb0a4"), "copilot-cli#8cb0a4 (agent)");
  assert.equal(one(null), "someone");
  assert.equal(one("external"), "a direct file edit");
});

test("banner: two sessions of one agent client are told apart, across merges too; unlabeled units read plainly", () => {
  const at = Date.UTC(2026, 9, 8, 16, 30, 0);
  const self = { name: "Javid Fathi", tabId: "HF60ekw4fU" };
  const first = mergeItems({ author: "agent:copilot-cli#5d1209", applied: [{ unitId: "q", label: "Kafka topic", kind: "changed" }], at }, self);
  const second = mergeItems({
    author: "agent:copilot-cli#8cb0a4",
    applied: [{ unitId: RANDOM_ID, label: 'unlabeled arrow from "Payments service" to "Fraud detection"', unlabeled: true, kind: "added" }],
    overwritten: [{ unitId: "api", label: "API gateway", winner: { author: "agent:copilot-cli#8cb0a4", writtenAt: 2 }, loser: { author: "agent:copilot-cli#5d1209", writtenAt: 1 } }],
    at,
  }, self);
  const items = addBannerItems(first, second);
  assert.equal(bannerSummary(items), "Merged from copilot-cli#5d1209 (agent): 1 changed; copilot-cli#8cb0a4 (agent): 1 added · 1 overwritten edit");
  const details = bannerDetails(items).map((line) => line.slice(formatTime(at).length + 1));
  assert.deepEqual(details, [
    'copilot-cli#5d1209 (agent) changed "Kafka topic"',
    'copilot-cli#8cb0a4 (agent) added unlabeled arrow from "Payments service" to "Fraud detection"',
    '"API gateway": copilot-cli#8cb0a4 (agent) overwrote copilot-cli#5d1209 (agent)\'s edit, which is kept in version history.',
  ]);
  assert.equal(bannerSummary(first), "Merged from copilot-cli (agent): 1 changed", "one session alone needs no id");
});

test("diff --since and watch name two sessions of one client apart", () => {
  const A = "agent:copilot-cli#5d1209";
  const B = "agent:copilot-cli#8cb0a4";
  const at = "2026-10-08T16:30:00.000Z";
  const result = {
    current: "f".repeat(64),
    since: { spec: "kickoff", kind: "snapshot", label: "kickoff", version: "a".repeat(64), at },
    turns: [{ author: A }, { author: B }, { author: B }],
    authors: [A, B, "human:Javid Fathi#HF60ekw4fU"],
    diff: { files: {}, nodes: { added: [], removed: [], relabeled: [] }, edges: { added: [], removed: [], rewired: [], relabeled: [] }, notes: { added: [], removed: [], changed: [] }, styles: [], moves: [] },
    overwritten: [{ entry: "e1", unitId: RANDOM_ID, label: "unlabeled rectangle near \"Ledger v2\"", unlabeled: true, winner: { author: B, writtenAt: 2 }, loser: { author: A, writtenAt: 1, labels: ["unlabeled rectangle near \"Ledger\""], unlabeled: true } }],
  };
  const text = formatDiffSince(result);
  assert.match(text, /3 history entries since: copilot-cli#5d1209 \(agent\) 1, copilot-cli#8cb0a4 \(agent\) 2\./);
  assert.match(text, /! unlabeled rectangle near "Ledger v2" \(455hPNweELuTtqn7kYKT2\): copilot-cli#5d1209 \(agent\)'s edit \(unlabeled rectangle near "Ledger", written .*\) lost to copilot-cli#8cb0a4 \(agent\)/);
  const line = formatMergedEvent({ name: "rc", version: "abc", author: B, applied: [{ kind: "added", label: 'unlabeled arrow from "A" to "B"', unlabeled: true }], overwritten: [{ label: "API", winner: { author: B }, loser: { author: A } }] }, Date.UTC(2026, 9, 8, 16, 30));
  assert.match(line, /by copilot-cli#8cb0a4 \(agent\): applied added unlabeled arrow from "A" to "B"; OVERWRITTEN "API": copilot-cli#5d1209 \(agent\) lost to copilot-cli#8cb0a4 \(agent\)/);
  const humans = formatHistoryEntry({ entry: "e2", version: "abc", author: "human:Ada#t1", open: true, lastCommitAt: 1, overwritten: [{ label: "x", winner: { author: "human:Ada#t1" }, loser: { author: "human:Ada#t2" } }] }, "new", ["human:Ada#t1", "human:Ada#t2"]);
  assert.match(humans, /by Ada#t1 \[human:Ada#t1\].*"x" \(Ada#t2 lost to Ada#t1\)/);
  assert.match(formatHistoryEntry({ entry: "e3", version: "abc", author: "human:Ada#t1", lastCommitAt: 1 }, "new", ["human:Ada#t1"]), /by Ada \[human:Ada#t1\]/);
});

test("diff --since names canvas authors in origin tags the same way", async () => {
  const origin = (author) => ({ xcldMermaidHash: "m1-a", xcldOrigin: { mermaid: { source: "main", nodeId: "pay", hash: "m1-a" }, canvas: { author, at: 1 }, active: "canvas" } });
  const before = board();
  const after = before.map((element) => (element.id === "pay" ? { ...element, x: 40, customData: origin("agent:copilot-cli#8cb0a4") } : element));
  const entries = [
    { entry: "e1", meta: { author: "cli:seed", version: "a".repeat(64), lastCommitAt: 1 } },
    { entry: "e2", meta: { author: "agent:copilot-cli#5d1209", version: "b".repeat(64), lastCommitAt: 2 } },
    { entry: "e3", meta: { author: "agent:copilot-cli#8cb0a4", version: "c".repeat(64), lastCommitAt: 3 } },
  ];
  const history = { board: "rc", entries, sceneOf: async () => ({ elements: before }) };
  const result = await diffSince({ history, master: { version: "c".repeat(64), scene: { elements: after } }, since: "version:aaaa" });
  assert.equal(result.diff.moves[0].origin, 'canvas edit by copilot-cli#8cb0a4 (agent) (over Mermaid main:pay)');
  assert.deepEqual(result.authors, ["cli:seed", "agent:copilot-cli#5d1209", "agent:copilot-cli#8cb0a4"]);
});