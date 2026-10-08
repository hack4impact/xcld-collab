// `xcld watch <board>`: prints, as they happen, every merge on a board (the SSE `merged` event the
// tab's banner is built from) and every new or changed history entry (one per author turn). For
// the lead's real check (scripts/real-check/README.md): nothing should change on the board
// without a line here.
import { apiUrl, boardHistory } from "./board-client.mjs";
import { authorLabel } from "./diff-since.mjs";

const clock = (ms) => new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().slice(11, 23);
const quote = (text) => JSON.stringify(String(text ?? ""));
const list = (items, limit = 6) => `${items.slice(0, limit).join(", ")}${items.length > limit ? `, +${items.length - limit} more` : ""}`;

/** One line for a `merged` event (also an unchanged write that only lost units). */
export const formatMergedEvent = (event, at = Date.now()) => {
  const applied = (event.applied ?? []).map((item) => `${item.kind} ${quote(item.label)}`);
  const lost = (event.overwritten ?? []).map((item) => `${quote(item.label)}: ${authorLabel(item.loser?.author)} lost to ${authorLabel(item.winner?.author)}`);
  return `${clock(at)} MERGED  ${event.name} v${String(event.version ?? "").slice(0, 12)} by ${authorLabel(event.author)}: ${applied.length ? `applied ${list(applied)}` : "nothing applied"}${lost.length ? `; OVERWRITTEN ${list(lost)}` : ""}${event.unbound?.length ? `; unbound ${event.unbound.length} arrow end(s)` : ""}`;
};

/** One line for a history entry (a turn). `change` says why it is printed (new, grew, closed). */
export const formatHistoryEntry = (entry, change = "new") => {
  const state = entry.open ? "open" : `closed by ${entry.closedBy ?? "?"}`;
  const pins = entry.pins?.length ? ` pinned ${entry.pins.map(quote).join(", ")}` : "";
  const lost = (entry.overwritten ?? []).map((item) => `${quote(item.label)} (${authorLabel(item.loser?.author)} lost to ${authorLabel(item.winner?.author)})`);
  return `${clock(entry.lastCommitAt)} HISTORY ${change.padEnd(6)} ${entry.entry} ${entry.record === "none" ? "(no new version)" : `v${String(entry.version ?? "").slice(0, 12)}`} by ${entry.displayName ?? authorLabel(entry.author)} [${entry.author}], ${state}, ${entry.coalescedCount ?? 1} save(s), ${(entry.applied ?? []).length} applied${lost.length ? `, overwritten: ${list(lost)}` : ""}${pins}`;
};

const entryKey = (entry) => `${entry.version}|${entry.coalescedCount}|${entry.lastCommitAt}|${entry.open ? "open" : entry.closedBy}|${(entry.overwritten ?? []).length}|${(entry.pins ?? []).join(",")}`;

/**
 * Streams the board's merges and history to `out` until `signal` aborts. `json` prints one JSON
 * object per line instead (`{ type: "merged" | "history", ... }`).
 */
export const watchBoard = async (board, { out = (line) => console.log(line), signal, json = false, pollMs = 2000 } = {}) => {
  const seen = new Map();
  const emit = (type, data, text) => out(json ? JSON.stringify({ type, ...data }) : text);
  const refreshHistory = async (quiet = false) => {
    let data;
    try {
      data = await boardHistory(board);
    } catch {
      return;
    }
    for (const entry of data.entries ?? []) {
      const key = entryKey(entry);
      const before = seen.get(entry.entry);
      if (before === key) continue;
      seen.set(entry.entry, key);
      if (!quiet) {
        const change = before === undefined ? "new" : entry.open ? "grew" : "closed";
        emit("history", { change, ...entry }, formatHistoryEntry(entry, change));
      }
    }
    return data;
  };
  const initial = await refreshHistory(true);
  const entries = initial?.entries ?? [];
  if (!json) {
    out(`Watching ${board} on ${apiUrl()}: ${entries.length} history entr${entries.length === 1 ? "y" : "ies"} so far${entries.length ? `, last: ${entries.at(-1).entry} by ${entries.at(-1).displayName ?? authorLabel(entries.at(-1).author)}` : ""}. Ctrl+C to stop.`);
  }
  const poll = setInterval(() => void refreshHistory(), pollMs);
  try {
    while (!signal?.aborted) {
      try {
        const response = await fetch(`${apiUrl()}/api/events`, { signal });
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          for (let index = buffer.indexOf("\n\n"); index >= 0; index = buffer.indexOf("\n\n")) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const type = /^event: (.*)$/m.exec(block)?.[1];
            const raw = /^data: (.*)$/m.exec(block)?.[1];
            if (!type || !raw) continue;
            let data;
            try {
              data = JSON.parse(raw);
            } catch {
              continue;
            }
            if (data.name !== board) continue;
            if (type === "merged") {
              emit("merged", data, formatMergedEvent(data));
              await refreshHistory();
            } else if (type === "mermaid-write") {
              emit("mermaid-write", data, `${clock(Date.now())} MERMAID ${board} ${data.status ?? ""} ${data.id ?? data.pendingId ?? ""}${data.via ? ` via ${data.via}` : ""}`.trimEnd());
            } else if (type === "board" && data.kind === "mermaid") {
              emit("mermaid-pending", data, `${clock(Date.now())} MERMAID ${board}: a Mermaid write is waiting for a layout`);
            }
          }
        }
      } catch (error) {
        if (signal?.aborted) break;
        if (!json) out(`${clock(Date.now())} (event stream: ${error?.cause?.code ?? error.message}; reconnecting)`);
      }
      if (!signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    clearInterval(poll);
  }
};
