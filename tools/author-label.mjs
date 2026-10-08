// Readable author names for the merged banner, `diff --since` and `xcld watch` (versions and
// merge). Author keys: `human:<name>#<tab>`, `agent:<client>#<session>`, `cli:<name>`, `external`,
// `init`. Display names are not unique: two Copilot CLI sessions are both `copilot-cli`, and all of
// a person's tabs share their name. So a label adds the short session (or tab) id only when it
// tells two authors in the same message apart: `copilot-cli#8cb0a4 (agent)`, `Ada#tabB2`.
// Pure, no Node imports: the tab bundles it too.

const SHORT_ID = 6;

/** `{ kind, name, id }` for an author key; kind is human, agent, cli, external, init or unknown. */
export const parseAuthor = (key) => {
  const text = String(key ?? "");
  let match = /^human:(.+)#([A-Za-z0-9_-]+)$/.exec(text);
  if (match) return { kind: "human", name: match[1], id: match[2] };
  match = /^agent:(.+)#([A-Za-z0-9_.-]+)$/.exec(text);
  if (match) return { kind: "agent", name: match[1], id: match[2] };
  match = /^cli:(.+)$/.exec(text);
  if (match) return { kind: "cli", name: match[1], id: null };
  if (text === "external" || text === "init") return { kind: text, name: text, id: null };
  return { kind: "unknown", name: text, id: null };
};

// The shortest prefixes, at least SHORT_ID characters, that tell `ids` apart.
const shortIds = (ids) => {
  const unique = [...new Set(ids)];
  const out = new Map();
  for (const id of unique) {
    let length = Math.min(SHORT_ID, id.length);
    while (length < id.length && unique.some((other) => other !== id && other.startsWith(id.slice(0, length)))) {
      length++;
    }
    out.set(id, id.slice(0, length));
  }
  return out;
};

/**
 * A labeler for the authors of one message (a banner, a `diff --since` answer, a watch session).
 * Humans read as their display name ("you" for `self`, the tab showing a banner, and
 * "<name> (another tab)" for its other tabs), agents as "<client> (agent)", CLI writers as
 * "<name> (CLI)". The short session or tab id is added when `keys` hold another author of the same
 * kind and name with a different id. `agentIds: true` always adds agents' ids (a stream, where a
 * later line can't disambiguate an earlier one).
 * @param {Iterable<string | null | undefined>} keys Every author key in the message.
 * @param {{ self?: { name: string, tabId: string } | null, agentIds?: boolean }} [options]
 * @returns {(key: string | null | undefined) => string}
 */
export const authorLabeler = (keys, { self = null, agentIds = false } = {}) => {
  const groups = new Map();
  const groupOf = (author) => `${author.kind}\u0000${author.name}`;
  const isSelf = (author) => Boolean(self) && author.kind === "human" && author.name === self.name && author.id === self.tabId;
  for (const key of keys) {
    if (key === null || key === undefined) continue;
    const author = parseAuthor(key);
    if (author.id === null || isSelf(author)) continue;
    const ids = groups.get(groupOf(author)) ?? new Set();
    ids.add(author.id);
    groups.set(groupOf(author), ids);
  }
  const shortened = new Map([...groups].map(([group, ids]) => [group, shortIds(ids)]));
  return (key) => {
    if (key === null || key === undefined || key === "") return "someone";
    const author = parseAuthor(key);
    if (isSelf(author)) return "you";
    const ids = groups.get(groupOf(author));
    const ambiguous = author.id !== null && ((ids && (ids.size > 1 || !ids.has(author.id))) || (author.kind === "agent" && agentIds));
    const tag = ambiguous ? `#${shortened.get(groupOf(author))?.get(author.id) ?? author.id.slice(0, SHORT_ID)}` : "";
    if (author.kind === "human") {
      return self && author.name === self.name ? `${author.name}${tag} (another tab)` : `${author.name}${tag}`;
    }
    if (author.kind === "agent") return `${author.name}${tag} (agent)`;
    if (author.kind === "cli") return `${author.name} (CLI)`;
    if (author.kind === "external") return "a direct file edit";
    if (author.kind === "init") return "the first snapshot";
    return author.name || "someone";
  };
};
