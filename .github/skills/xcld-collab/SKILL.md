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

1. Call `write_mermaid` with the board path and Mermaid source.
2. Call `board_url` and give the returned localhost URL to the user.
3. The user opens or keeps open the URL so the browser converts the Mermaid inbox into
   editable Excalidraw elements.
4. Call `read_board` to verify that conversion produced the expected nodes and edges.
5. Call `snapshot` before asking the user to review the board.

Do not present `board_url` as board creation. Opening a URL before `write_mermaid` starts an
empty unsaved canvas; the first real edit saves it. If the tab is already open, call
`write_mermaid` while it remains open; the browser should replace the blank canvas. Ask the
user to reload once only if the watcher misses the update.

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
- Draw proposed or unapproved parts in light blue:
  `classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2`.

## Human review

After conversion succeeds, snapshot the board and tell the user it is ready. The user edits
the named board in the localhost Excalidraw canvas; those edits autosave to the board.

When the user says review is complete:

1. Call `diff` before changing the board.
2. Summarize and act on every semantic change or ask about ambiguous feedback.
3. Prefer updating the existing `.excalidraw` board when that capability is available.
4. If a Mermaid rewrite is necessary, do it only after diffing and incorporating the human
   feedback, because `write_mermaid` replaces the whole board.
5. Verify with `read_board`, then `snapshot` the next review baseline.

Never rewrite Mermaid merely to export the current board. `read_board` returns Mermaid, and
the CLI `xcld to-mermaid` or automatic exports are the non-destructive export paths.

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
  proposals or unresolved notes.

## Existing boards

- Use `list_boards` when the board path is unknown.
- Use `read_board` before proposing changes.
- Use `snapshot` at each agent-to-human handoff.
- Use `diff` at each human-to-agent handoff.
- Never assume a URL, a saved banner, or an existing file means the board contains diagram
  elements; verify its content with `read_board`.

See [the user guide](../../../docs/user-guide.md) for canvas conventions and
[the reference](../../../docs/reference.md) for commands and troubleshooting.
