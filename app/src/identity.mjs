// The tab's author identity (versions and merge, slice 5). Every save is authored
// `human:<name>#<tabId>`: the name is shared by all of a person's tabs (remembered per
// browser), the tab id is hidden and unique per tab (stable across reloads of that tab).
// Random names and a server-checked unique name are for future shared servers, not here.

export const NAME_STORAGE_KEY = "xcld.authorName";
export const TAB_STORAGE_KEY = "xcld.tabId";
export const TAB_CHANNEL = "xcld-tab-ids";
export const FALLBACK_NAME = "anonymous";
const MAX_NAME_LENGTH = 100;
const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TAB_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A display name as the server accepts it (no control characters, at most 100 UTF-16 units), or null when empty. */
export const normalizeAuthorName = (value) => {
  let name = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (name.length > MAX_NAME_LENGTH) {
    name = name.slice(0, MAX_NAME_LENGTH).replace(/[\ud800-\udbff]$/, "").trim();
  }
  return name || null;
};

export const isTabId = (value) => typeof value === "string" && TAB_ID_PATTERN.test(value);

export const newTabId = (random = globalThis.crypto) => {
  const bytes = random.getRandomValues(new Uint8Array(10));
  return [...bytes].map((byte) => TAB_ID_ALPHABET[byte % TAB_ID_ALPHABET.length]).join("");
};

const read = (storage, key) => {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const write = (storage, key, value) => {
  try {
    if (value === null) {
      storage?.removeItem(key);
    } else {
      storage?.setItem(key, value);
    }
  } catch {}
};

/** This tab's id from sessionStorage, or a new one (stored). */
export const readTabId = (storage, make = newTabId) => {
  const stored = read(storage, TAB_STORAGE_KEY);
  if (isTabId(stored)) {
    return stored;
  }
  return replaceTabId(storage, make);
};

export const replaceTabId = (storage, make = newTabId) => {
  const id = make();
  write(storage, TAB_STORAGE_KEY, id);
  return id;
};

export const readStoredName = (storage) => normalizeAuthorName(read(storage, NAME_STORAGE_KEY));

/** Remembers a rename in this browser; an empty name forgets it (back to the default). */
export const storeName = (storage, name) => {
  const normalized = normalizeAuthorName(name);
  write(storage, NAME_STORAGE_KEY, normalized);
  return normalized;
};

/**
 * A rename in this browser wins, then `XCLD_AUTHOR_NAME` (GET /api/config), then "anonymous".
 * @param {{ stored?: string | null, configured?: string | null }} [input]
 * @returns {string}
 */
export const resolveAuthorName = ({ stored = null, configured = null } = {}) => normalizeAuthorName(stored) ?? normalizeAuthorName(configured) ?? FALLBACK_NAME;

export const authorKey = ({ name, tabId }) => `human:${name}#${tabId}`;

export const identityHeaders = ({ name, tabId }) => ({
  "X-Xcld-Author-Name": encodeURIComponent(name),
  "X-Xcld-Tab": tabId,
});

/** A readable name for an author key, relative to this tab (`self`: `{ name, tabId }`). */
export const describeAuthor = (key, self = null) => {
  const text = String(key ?? "");
  const human = /^human:(.+)#([A-Za-z0-9_-]+)$/.exec(text);
  if (human) {
    if (self && human[1] === self.name) {
      return human[2] === self.tabId ? "you" : `${human[1]} (another tab)`;
    }
    return human[1];
  }
  const agent = /^agent:(.+)#[A-Za-z0-9_.-]+$/.exec(text);
  if (agent) {
    return `${agent[1]} (agent)`;
  }
  const cli = /^cli:(.+)$/.exec(text);
  if (cli) {
    return `${cli[1]} (CLI)`;
  }
  if (text === "external") {
    return "a direct file edit";
  }
  if (text === "init") {
    return "the first snapshot";
  }
  return text || "someone";
};

/**
 * "Duplicate tab" copies sessionStorage, so two tabs can start with one id. A new tab announces
 * its id on a BroadcastChannel; a live tab holding the same id answers, and the new tab takes a
 * fresh one (`onTaken`). Returns a function that stops listening.
 */
export const guardTabId = ({ channel, getTabId, instance, onTaken }) => {
  const onMessage = (event) => {
    const data = event?.data;
    if (!data || typeof data !== "object" || data.tabId !== getTabId()) {
      return;
    }
    if (data.type === "hello" && data.instance !== instance) {
      channel.postMessage({ type: "taken", tabId: data.tabId, to: data.instance });
    } else if (data.type === "taken" && data.to === instance) {
      onTaken();
    }
  };
  channel.addEventListener("message", onMessage);
  channel.postMessage({ type: "hello", tabId: getTabId(), instance });
  return () => channel.removeEventListener("message", onMessage);
};
