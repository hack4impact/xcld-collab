# User guide

How to draw, give feedback and loop with agents so everyone, human or model, reads the
board the same way. Read [Getting started](../README.md#getting-started) first.

## How it works

- A **board** is a file: `boards/<path>.excalidraw`. Open the board browser at
  `http://127.0.0.1:3100/`, or open a board at `http://127.0.0.1:3100/?board=<path>`.
- **You edit in the browser.** Changes save to the file about a second after you stop. The
  top bar says `Saved <path>.excalidraw`.
- **Agents edit files.** When the file changes on disk, the open tab reloads it within
  about a second.
- **Deleting a board on disk stops that tab's autosave.** Use its top-bar banner to restore
  from the tab or close it.
- **Mermaid merges into the board.** An agent writes Mermaid (MCP `write_mermaid`, `xcld
  write-mermaid`, or the file `boards/<path>.mmd`) and the server applies it to the board,
  keeping your layout, notes and colors; no tab needs to be open. A brand-new diagram is the
  exception: the open tab lays it out the first time.
- **Chat-widget drawings go in through the view inbox.** `open_in_canvas` writes
  `boards/<path>.view.json` from an Excalidraw MCP Apps checkpoint, and the open tab turns
  it into an editable board.
- **A board URL does not seed a diagram.** Opening `?board=<path>` without first writing an
  inbox starts an empty, unsaved canvas. The first real edit saves it.
- **Feedback comes out through `xcld diff`.** It compares the board with a snapshot and lists
  what changed, by meaning rather than by pixel. `xcld diff <board> --since <when>` compares
  with any point in version history and also lists every edit that was overwritten.
- **You and several agents can edit one board at the same time.** Writes merge; see
  [the walkthrough](#walkthrough-you-and-two-agents-on-one-board).

## The loop

1. **Agent proposes.** It writes `boards/myproject/arch.mmd`, with new or unapproved parts in light blue
   (see [conventions](#conventions)).
2. **You open the board:** <http://127.0.0.1:3100/?board=myproject/arch>. Opening it triggers the
   conversion.
3. **Agent snapshots** once `boards/myproject/arch.excalidraw` exists:
   `xcld snapshot myproject/arch`. This is the "before" picture.
4. **You mark it up**, using the conventions below.
5. **Agent diffs:** `xcld diff arch`. It acts on the list and asks about anything unclear.
6. **Agent updates the board,** with Mermaid (`write_mermaid`) or the board JSON
   (`write_board`). Both merge with what you drew: your notes stay, existing shapes keep their
   place, and a shape you both changed goes to whoever wrote last (the other version stays in
   history). Then the loop repeats from step 3.

> **Mermaid never replaces your drawing.** A diagram the server can't apply shape by shape (a
> new diagram, or a type other than a flowchart) is laid out by the open tab and **added** next
> to what is on the board: below it for `flowchart TD`, to the right for `LR` (an agent can ask
> for `below`, `right` or `near:<shape>`). Only an empty board takes the diagram's own layout as
> is. With no tab open, the server lays a flowchart out itself in a simple grid after about 2
> minutes. If you change a Mermaid shape (its label, color or position), your version stays
> until the agent's Mermaid changes that shape; then the agent's version wins and yours stays
> in version history, reported as overwritten.

## The loop with MCP tools

The `xcld-probe` MCP tools expose the same workflow without shell commands. For a new board,
the order matters:

1. The agent calls `write_mermaid` with the board path and a flat `flowchart TD`.
2. The agent calls `board_url` and gives you the returned localhost URL.
3. You open or keep open that URL. The browser lays the Mermaid out as editable Excalidraw
   elements and the server saves them as the agent's write. (Without a tab, the server lays it
   out itself after about 2 minutes; the agent can check with `mermaid_status`.)
4. The agent calls `read_board` to verify conversion, then `snapshot` before handing the
   board to you for review.
5. You edit the board in the localhost Excalidraw canvas and tell the agent when you are done.
6. The agent calls `diff` before changing anything, acts on every reported edit, and
   snapshots the next review baseline.

Calling `board_url` first is not creation: visiting that URL starts an empty unsaved canvas.
Keep the tab open and call `write_mermaid`; the tab lays the diagram out on the blank canvas.
Reload once if the watcher misses the update.

Several diagrams can share a board: the agent gives each one a `source` name (`write_mermaid`
`source`, default `main`). Each source only changes and deletes its own shapes, and writing the
same Mermaid again changes nothing.

### Edit a chat drawing in the canvas

Use this when the `excalidraw-probe` chat widget made a useful drawing, but you want the
persistent localhost canvas for review, or the widget says the host cannot open fullscreen
editing. The chat widget is experimental and off by default; see
[Chat widget (experimental)](../README.md#chat-widget-experimental) to opt in.

1. Ask the agent to copy the widget checkpoint id from the widget response or hint.
2. Choose an explicit destination board, for example `myproject/chat-architecture`.
3. The agent calls `open_in_canvas(checkpointId, board)`.
4. Open the returned URL. The browser consumes `boards/<path>.view.json`, saves
   `boards/<path>.excalidraw` and recenters on the imported drawing.
5. Continue the usual loop: the agent verifies with `read_board`, snapshots, you edit in
   the canvas, and the agent uses `diff` at handoff.

If the destination board already exists, `open_in_canvas` refuses unless the agent passes
`overwrite=true`. Snapshot or read the existing board before intentionally replacing it.

Use `excalidraw-probe` when you only need a transient diagram inside chat. Use `xcld-probe`
when the diagram must persist as a named board that a human can edit in the localhost canvas
and an agent can later read or diff.

## Conventions

These conventions are suggestions. The diff reports every change regardless, and the
agent interprets it. The example defaults live in
[`boards/examples/design-rules.csv`](../boards/examples/design-rules.csv); copy that file to
your own board folder and edit it when a project uses different meanings. A folder's
`design-rules.csv` replaces inherited rules for that folder and below.

| You want to say… | Do this in the canvas | The agent sees in `xcld diff` with the starter rules |
|---|---|---|
| "This is proposed, not agreed" (agent side) | Light-blue shape: stroke `#1971c2`, fill `#a5d8ff` | Shows up as colored nodes |
| **Approve** | Change the stroke to black and the fill to transparent | `Style: ~ node "Cache" strokeColor: #1971c2 -> #1e1e1e [approve → approved]` |
| **Reject** | Delete the proposed shape | `Nodes: - removed "Cache" [reject → rejected]` |
| **Comment / ask** | Free text next to the shape | `Notes: + added "why not Redis?" near "Cache" [note → note]` |
| **Question** | Yellow fill | `[question → question]` |
| **Optional / conditional** | Dashed or dotted arrow/outline | `[optional → optional]` |
| **Blocked** | Arrowhead ending in a bar | `[blocked → blocked]` |
| **Priority / hot path** | Extra-bold outline | `[priority → priority]` |
| **Out of scope** | Gray fill | `[out-of-scope → out-of-scope]` |
| **Belongs together** | Frame around boxes | `[group → group]` |
| **Rename** | Double-click the shape and edit its text | `Nodes: ~ relabeled "Cache" -> "Redis cache"` |
| **Reconnect** | Drag an arrow's end onto a different shape | `Edges: ~ rewired API --> Cache -> API --> DB` |

Use `xcld rules <board>` to brief an agent on the effective local conventions, and
`xcld check <board>` to list open check items such as unapproved light-blue proposals or
free notes that have not been crossed out/deleted.

**Canvas tips that keep the diff clean:**

- **Notes vs labels.** Double-click on *empty canvas* for a free note. Double-clicking a *shape*
  edits its label, which the diff reports as a rename.
- **Snap arrows to shapes.** Arrows count as connections only when their ends are attached (the
  shape highlights while you drag). Loose arrows are reported as unbound.
- **Move an arrow's end rather than redrawing it.** Deleting an arrow and drawing a new one shows
  up as removed + added, not rewired.
- **Notes attach to the nearest shape.** Put a note right next to the thing it's about.
- **Ctrl+S (Cmd+S) saves a checkpoint.** The board saves itself anyway; Ctrl+S marks a restore
  point in version history (see [below](#editing-at-the-same-time-as-agents)). Excalidraw's
  menu "Save to…" still downloads a copy.

## Prompts for your agent

Agents that support repository skills should use
[the xcld-collab skill](../.github/skills/xcld-collab/SKILL.md). The prompts below are for
clients that do not load repository skills.

Paste these into agent terminal (Copilot, Codex, Claude Code, OpenCode, etc.) from the `xcld-collab` folder.

**Set up the conventions (once per session):**

```text
We're using xcld-collab for diagrams. Boards live in ./boards; tools run with
`docker exec xcld-collab xcld <command>` (see docs/reference.md). Use one folder per
project, such as `boards/myproject/flow.mmd` and `?board=myproject/flow`.
Conventions: draw anything new or unapproved in light blue with
`classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2`.
Run `xcld rules myproject/flow` before drawing or interpreting feedback. When I change a
proposal's stroke to black, that means approved. A deleted proposal is rejected. Free text
near a node is a note; a line crossing the note means it is resolved.
Diff and act on my feedback before you write the board again; read it first and pass its
version as base.
```

**Propose a diagram:**

```text
Draw our request flow as a Mermaid flowchart in boards/myproject/flow.mmd, marking new parts as
`proposed`. Then open http://127.0.0.1:3100/?board=myproject/flow in my browser, wait until
boards/myproject/flow.excalidraw exists, run `xcld snapshot myproject/flow`, and tell me it's ready for review.
```

**Read my feedback:**

```text
I've marked up the myproject/flow board. Run `xcld diff myproject/flow`, summarize what I approved, rejected and
commented on, and propose what you'll change before changing anything.
```

**Export for a PR or doc:**

```text
Run `xcld to-mermaid myproject/flow` and put the result in docs/architecture.md as a mermaid code block.
```

Exporting often? Set `XCLD_AUTO_EXPORT=save` and point the agent at
`boards/.exports/myproject/flow.mmd`, which always matches the board. Which mode fits is
covered by the [decision tree](reference.md#saving-and-exporting).

## Habits worth keeping

- **Mermaid is the export, the board is the truth.** This is exceptionally important, and diverging from this habit
  will sour your user experience. Mermaid can't hold notes, positions or
  freehand. `to-mermaid` keeps notes as `%%` comments and colors as `style` lines, but layout
  is lost.
- **One folder per project.** For example, write `boards/myproject/flow.mmd` and open
  `?board=myproject/flow`. Board path segments allow letters, digits, `.`, `_` and `-`
  (e.g. `auth-flow`, `v2.data-model`).
- **Snapshot at every hand-off.** Each agent → human → agent switch is a natural point.
  Snapshots are cheap: `diff` compares against the latest one, and each snapshot is also a
  pinned version in history, so `diff --since <snapshot name>` finds any of them later
  (`xcld snapshot <board> --name review-1` picks the name).
- **Editing the same board as an agent works.** Your saves and the agent's writes are merged
  by the server: different shapes never clash, and when you both changed the same shape (or
  its label), the later change wins and the other one stays in version history. Agents should
  write with `write_board` (or `xcld write`), which reports what was overwritten. The canvas
  shows it in a banner; see [Editing at the same time as agents](#editing-at-the-same-time-as-agents).

## Editing at the same time as agents

- **"Author: <name>"** at the bottom of the canvas is who your edits are saved as. It starts
  as `XCLD_AUTHOR_NAME` (the build sets it from `git config user.name`). Click it to rename;
  Enter keeps the name, Esc cancels, and an empty name goes back to the default. This browser
  remembers it, and all its tabs use it. Each tab also has a hidden tab id (kept across
  reloads of that tab), so two of your tabs are two writers with the same name.
- **Your edits are saved before anything else is shown.** When an agent or another tab writes,
  your tab saves what you haven't saved yet, the server merges it, and the tab shows the
  merged board. You can keep dragging or typing meanwhile.
- **The banner** above your name lists what merged and from whom, e.g. "Merged from
  copilot-cli (agent): 1 added, 1 changed · 1 overwritten edit (1 of yours)". It doesn't take
  focus. **details** lists each change with its time; **×** dismisses it. When two sessions of
  one agent client (or two tabs with one name) appear on it, each gets its short id:
  "copilot-cli#8cb0a4 (agent) overwrote copilot-cli#5d1209 (agent)'s edit". A shape without
  text is described by where it is, e.g. `unlabeled arrow from "Payments service" to "Fraud
  detection"` or `unlabeled rectangle near "Ledger v2"`. Only real edits are listed: an agent
  that re-sends shapes it didn't change (even with Excalidraw's bookkeeping fields dropped or
  changed) doesn't claim them, and doesn't overwrite your edits with them.
- **Overwritten** means you and someone else changed the same shape (or its label) since you
  last had the same board, and the whole shape went to the later edit. "Your edit was
  overwritten by …" means theirs is on the board; "your newer edit overwrote …'s" means yours
  is. The losing version is kept in **version history only**: the canvas never puts it back by
  itself, and your tab never sends it again. To see what lost, run
  `docker exec xcld-collab xcld diff <board> --since 30m` (or `--since author:<your name>`):
  it lists each overwritten shape with who won, who lost and the losing label. For everything,
  copy the history out with `docker exec xcld-collab xcld history export <board>` (each entry's
  `.meta.json` lists the `overwritten` units with the losing elements), or `--full` for every
  version as a board.
- **"An edit you made while saving was replaced"** is rare: you changed a shape in the split
  second while a save was on its way, and the merge changed that same shape. The merged shape
  wins; that edit is not in history, so redo it if you still want it.
- **Ctrl+S** (Cmd+S) saves now and closes your current turn in version history: the status
  says "Saved checkpoint", or "No changes since the last checkpoint". Without Ctrl+S a turn
  closes by itself after 3 minutes without edits, or when someone else writes.

## Walkthrough: you and two agents on one board

You keep the canvas open while two agents work on the same board, one in Mermaid and one in
board JSON. Nothing needs to wait for anyone; this is what you see.

1. **Start from a pinned version.** With the board open at
   `http://127.0.0.1:3100/?board=myproject/arch`:

   ```powershell
   docker exec xcld-collab xcld snapshot myproject/arch --name kickoff
   docker exec xcld-collab xcld watch myproject/arch     # optional, in a second terminal
   ```

   `watch` prints a line for every merge and every history entry from now on.
2. **Give each agent its part.** For example, agent A: "Read `myproject/arch`, then add the
   caching layer as Mermaid source `cache` and rename *API* to *API gateway*." Agent B: "Read
   `myproject/arch`, then add a note box *Owner: payments team* next to *Ledger* and recolor
   *API* red, with `write_board`." Both edit *API*; everything else is disjoint.
3. **Keep drawing.** Rename *Ledger* to *Ledger v2* while they work. Your edits save as usual;
   when an agent's write lands, your tab saves first, then shows the merged board.
4. **Read the banner.** Each merge shows "Merged from copilot-cli (agent): …". Agent A's rename
   and agent B's recolor of *API* touch the same shape. If B read the board before A's rename
   landed, the two edits conflict: the later one takes the whole shape (label and color), and the
   banner says "1 overwritten edit" with who won. The losing agent's answer says the same
   ("overwritten by …"). If B read after A's write, B's recolor simply applies on top.
5. **Ask what happened**, at any time:

   ```powershell
   docker exec xcld-collab xcld diff myproject/arch --since kickoff
   ```

   This lists every change since the snapshot (the new cache shapes, the note, *Ledger v2*,
   *API*'s final label and color) and, under "Overwritten since then", the losing edit of
   *API* with its author and label. Nothing else is missing: if a shape changed and isn't
   listed as overwritten, the later writer had seen the earlier change.
6. **Agents check their own losses** the same way: `diff` with `since: "author:<their author
   key>"` (each write's answer names it; the skill tells them to) shows what changed since their last write, including
   their own edits that lost. They re-read the board and decide whether to write again.
7. **A `queued` answer is fine.** If the disk is slow (Docker Desktop on a busy machine), an agent
   may get `queued` instead of `merged` after 5 s. Its write is safe in the journal and lands
   shortly; the banner and `watch` show it when it does.

What goes to the later edit is always a whole shape with its label; edits to different shapes
never conflict. A Mermaid write that sat in a queue counts by when it was written, so it loses
to the edit you made after it.

## What doesn't work yet

- Diagram types other than flowcharts (sequence, class, ER, state).
- **Subgraphs are supported for flowcharts.** They convert to an editable container rectangle
  plus grouped child nodes/arrows, and `to-mermaid` writes them back as `subgraph … end`.
  Nested or heavily styled subgraphs should still be checked with `xcld diff`.
- Some Mermaid shapes. A cylinder `[(DB)]` and other special shapes arrive as plain
  rectangles. Rectangles, diamonds `{}` and circles `(())` are kept.
- Diagram direction. `to-mermaid` always writes `flowchart TD`.
- Browsing version history in the canvas: see [Coming soon](../README.md#coming-soon).
