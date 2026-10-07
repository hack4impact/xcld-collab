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
  what changed, by meaning rather than by pixel.

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

> **Still replaced by a tab:** Mermaid the server can't apply (a diagram type other than a
> flowchart, or a board with no shapes from Mermaid yet) is laid out by the open tab, which
> **replaces** the board. `xcld snapshot` first if the board has work on it.

## The loop with MCP tools

The `xcld-probe` MCP tools expose the same workflow without shell commands. For a new board,
the order matters:

1. The agent calls `write_mermaid` with the board path and a flat `flowchart TD`.
2. The agent calls `board_url` and gives you the returned localhost URL.
3. You open or keep open that URL. The browser consumes the Mermaid inbox, replaces the
   canvas with editable Excalidraw elements and autosaves the `.excalidraw` board.
4. The agent calls `read_board` to verify conversion, then `snapshot` before handing the
   board to you for review.
5. You edit the board in the localhost Excalidraw canvas and tell the agent when you are done.
6. The agent calls `diff` before changing anything, acts on every reported edit, and
   snapshots the next review baseline.

Calling `board_url` first is not creation: visiting that URL starts an empty unsaved canvas.
Keep the tab open and call `write_mermaid`; the tab will consume the inbox and replace the
blank canvas. Reload once if the watcher misses the update.

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
- **Don't use Ctrl+S or "Save to…".** That downloads a copy. The board already saves itself
  (see [Coming soon: versions](../README.md#coming-soon)).

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
  Snapshots are cheap, and `diff` always compares against the latest one.
- **Editing the same board as an agent works.** Your saves and the agent's writes are merged
  by the server: different shapes never clash, and when you both changed the same shape (or
  its label), the later change wins and the other one stays in version history. Agents should
  write with `write_board` (or `xcld write`), which reports what was overwritten. The canvas
  doesn't show a banner for merges yet; it shows "Board changed elsewhere; the server merged
  your edits" in the status line. To look at the history, copy it out with
  `docker exec xcld-collab xcld history export <board> --full` (every version as a file in
  `~/.excalidraw/exports/<board>/`).

## What doesn't work yet

- Diagram types other than flowcharts (sequence, class, ER, state).
- **Subgraphs are supported for flowcharts.** They convert to an editable container rectangle
  plus grouped child nodes/arrows, and `to-mermaid` writes them back as `subgraph … end`.
  Nested or heavily styled subgraphs should still be checked with `xcld diff`.
- Some Mermaid shapes. A cylinder `[(DB)]` and other special shapes arrive as plain
  rectangles. Rectangles, diamonds `{}` and circles `(())` are kept.
- Diagram direction. `to-mermaid` always writes `flowchart TD`.
- Browsing version history in the canvas, and merge on Mermaid re-import: see
  [Coming soon](../README.md#coming-soon).
