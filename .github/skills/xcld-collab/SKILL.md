---
name: xcld-collab
description: Create and revise persistent xcld-collab architecture diagrams through xcld-probe. Use when a user wants a named Mermaid-backed board that remains editable in the localhost Excalidraw canvas, or asks an agent to read, snapshot, diff, or update human diagram feedback.
---

# xcld-collab

Use `xcld-probe` for persistent human-agent diagram collaboration. Use
`excalidraw-probe` only for a transient diagram rendered inside chat. That chat widget is
experimental and off by default; if its tools are not available, use `xcld-probe`.

## New board

Follow this order:

1. Call `write_mermaid` with the board path and Mermaid source (no `base` for a new board).
   It answers `status: "needs-tab"` with a `pendingId`: a new diagram needs a layout once,
   from a browser tab or (after about 2 minutes without one) from the server's simple grid.
2. Call `board_url` and give the returned localhost URL to the user.
3. The user opens or keeps open the URL so the browser lays the Mermaid out as editable
   Excalidraw elements (saved as your write). Without a tab, `mermaid_status` says when the
   server's grid layout lands.
4. Call `read_board` to verify that conversion produced the expected nodes and edges.
5. Call `snapshot` before asking the user to review the board.

Do not present `board_url` as board creation. Opening a URL before `write_mermaid` starts an
empty unsaved canvas; the first real edit saves it. If the tab is already open, call
`write_mermaid` while it remains open; the browser lays it out on the blank canvas. Ask the
user to reload once only if the watcher misses the update.

After that first layout, Mermaid writes to the board don't need a tab: the server applies them.

A board that already has a drawing keeps it: a new diagram is **added** as a group next to it
(below for `flowchart TD`, right of it for `LR`; pass `position`: `below`, `right` or
`near:<id>` to choose). For a second, separate diagram on the same board, pass a new
`source` name (default `main`): each source only changes and deletes its own shapes. Reusing a
source name edits that diagram; the result's `hint` suggests a new name when your write would
delete most of it. Writing the same Mermaid again is a no-op.

## Edit a chat drawing in the canvas

When a user wants to edit a drawing created by the `excalidraw-probe` chat widget, or the
widget says the host cannot open the editor:

1. Get the checkpoint id from the widget response or its hint.
2. Choose an explicit destination board path with the user or from the current task context.
3. Call `open_in_canvas` with `checkpointId` and `board`. Do not omit `board`.
4. If it refuses because the board exists, snapshot/read the existing board first; retry with
   `overwrite=true` only when replacing it is intentional.
5. Give the returned URL to the user or open it. The canvas consumes
   `boards/<path>.view.json`, saves `boards/<path>.excalidraw`, recenters, then the normal
   review loop (`read_board`, `snapshot`, `diff`) applies.

## Mermaid input

- Use `flowchart TD`.
- Use flowcharts only. `subgraph … end` converts to editable shapes and round-trips through
  `read_board`; keep nesting shallow.
- Give nodes stable, meaningful IDs.
- To break a label across lines, put a **real newline inside the quoted label**
  (`\n` in the JSON string you pass to `write_mermaid`). Never use `<br/>` or `<br>`: the
  converter copies the tag into the label, and the canvas shows it as text. `check_board`
  warns about any label that still contains one.
- Draw proposed or unapproved parts in light blue:
  `classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2`.

## Human review

After conversion succeeds, snapshot the board and tell the user it is ready. The user edits
the named board in the localhost Excalidraw canvas; those edits autosave to the board.

When the user says review is complete:

1. Call `diff` before changing the board.
2. Summarize and act on every semantic change or ask about ambiguous feedback.
3. Update the existing board with `write_mermaid` or `write_board` (next section). Both merge
   with the human's edits; neither replaces the board.
4. Verify with `read_board`, then `snapshot` the next review baseline.

Never rewrite Mermaid merely to export the current board. `read_board` returns Mermaid, and
the CLI `xcld to-mermaid` or automatic exports are the non-destructive export paths.

## Editing a board in parallel

Parallel editing is supported: the server merges writes, and the human and other agents may be
drawing on the same board while you write. Always:

1. **Read → base → write.** `read_board`, keep its `version`, and pass it as `base` to
   `write_board` or `write_mermaid`. Never write from memory of an older read without a base.
2. **Handle `queued`.** `status: "queued"` means the server has your write safely in its journal
   and merges it as soon as it can (usually a slow disk). Don't send it again. Call
   `read_board` before you build on it; your change shows up once it lands.
3. **Check what you lost.** Every write result names your author key ("Written as
   agent:<client>#<id>"). Before your next change, and when the user asks what happened, call
   `diff` with `board` and `since: "author:<that key>"`: it lists what changed since your last
   write and every overwritten unit, yours included, with who won and the losing label. If your
   edit lost to a newer human edit, tell the user and ask before redoing it; don't silently
   write it again.
4. **Snapshot with a name** at a hand-off (`snapshot` with `name`): the version is pinned, and
   `diff` with `since: "<name>"` compares against it later.

"Overwritten" means two writers changed the same shape (or its label) without seeing each
other's change; the later edit, by write time, took the whole shape. The loser is kept in
version history only and nothing puts it back by itself.

**With Mermaid** (`write_mermaid`):

1. Call `read_board` (Mermaid is the default format) and keep its `version`.
2. Edit that Mermaid: keep the node ids (a node id is the shape's id on the board), relabel,
   restyle, add or remove nodes and edges. **Leave edge forms you didn't mean to change exactly
   as `read_board` gave them:** don't normalise `-.-`, `===`, `<==>`, `--o` and the like to `-->`,
   and keep edge ids and their `e1@{ curve: linear }` / `curve: step` lines (straight and elbow
   arrows). Each of those is the human's style; rewriting it changes the arrow. A `%% Canvas-only
   style` comment lists what Mermaid can't show (dotted vs dashed, widths, triangle heads); the
   board keeps it whatever you write.
3. Call `write_mermaid` with the whole Mermaid and `base` = that `version`. Without `base` it
   applies to the board as it is now.
4. The server applies it on the board: existing shapes keep their position and the human's
   notes, arrows and shapes stay; new nodes are placed next to a connected node; only shapes
   and arrows of the same Mermaid source are ever deleted. A shape the human edited keeps the
   human's version (op `keep-canvas`) until your Mermaid changes that shape; then yours wins
   and the human's version is reported in `overwritten` (tell the user). The result lists `ops` (what your
   Mermaid changed), `applied`, `overwritten` and the new `version`, as for `write_board`.
   `status: "queued"` means the merge took longer than 5 s; the write is safe. "Disk is slow right
   now (journal fsync 4.2 s)" means a busy disk on the user's machine; tell the user, don't retry.
5. A syntax error is refused with its line; nothing is written. Non-flowchart diagrams, and
   boards with no shapes of your source yet, answer `needs-tab`: open `board_url`, or for a
   flowchart wait for the server's layout (`mermaid_status` with the `pendingId`).

**With Excalidraw JSON** (`write_board`):

1. Call `read_board` with `format: "json"` and keep its `version`.
2. Change the elements: keep every element id, keep bound text with its container
   (`containerId`) and arrows bound with `startBinding`/`endBinding`. Don't "tidy" arrows and
   lines you aren't changing: keep their `strokeStyle`, `strokeWidth`, `roundness`, `elbowed`,
   arrowheads and points as you read them.
3. Call `write_board` with the **whole board** and `base` = that `version`. Elements you leave
   out are deleted; elements others added after your `version` are kept.
4. Read the result. `overwritten` lists units you and someone else both changed: the later
   write won. If it says someone else's edit won, tell the user rather than redoing it.
   `queued` means the merge took longer than 5 s; the write is safe (if it says the disk is slow,
   tell the user; don't write the same change again). Read the board again
   before writing on top of it. The user's canvas shows each of your writes on a banner under
   your MCP client name, with anything overwritten either way.
5. For your next write, use the returned `version` as `base`. If a write is refused with an
   unknown base, call `read_board` again.

Never write `boards/<path>.excalidraw` or `boards/<path>.mmd` directly with file tools: it works
(the server adopts the board file, or applies the Mermaid file, as an `external` write), but it
carries no author and no base, so concurrent edits can't be attributed.

## Design rules

Boards can have local conventions in `design-rules.csv` (the nearest folder's file wins;
`boards/examples/` ships an example). Every rule is a **local default** that the user can
override in their own folder's file; follow it, but don't treat it as fixed.

- `read_board` and `write_mermaid` include the effective **briefing**: how to draw (e.g.
  proposals in light blue, layout direction), what edits mean, and what "done" means. Read it
  before drawing.
- `diff` tags matching changes `[rule → meaning]` and lists each instruction once in a legend.
  Act on the instruction; changes with no tag are still feedback to interpret.
- If `diff` or `read_board` starts with a **WARNING** block, a rule is invalid and was
  skipped. Tell the user which one.
- Call `check_board` before you call a board done. It lists open items, such as remaining
  proposals or unresolved notes, and warns about labels with a literal `<br>`.

## Existing boards

- Use `list_boards` when the board path is unknown.
- Use `read_board` before proposing changes.
- Use `snapshot` at each agent-to-human handoff (it returns the pinned `label` and `version`).
- Use `diff` at each human-to-agent handoff: without `since` against the latest snapshot, or
  with `since` (a snapshot label, a version, `author:<key>`, or a time like `30m`).
- Never assume a URL, a saved banner, or an existing file means the board contains diagram
  elements; verify its content with `read_board`.

See [the user guide](../../../docs/user-guide.md) for canvas conventions and
[the reference](../../../docs/reference.md) for commands and troubleshooting.
