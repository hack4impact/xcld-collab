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
- **Mermaid goes in through the inbox.** An agent writes `boards/<path>.mmd`, and the open
  tab converts it into the board. A board opened for the first time converts too.
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
6. **Agent updates the board.** Either it edits the `.excalidraw` directly, or it rewrites the
   `.mmd` (read the warning first). Then the loop repeats from step 3.

> **Warning: rewriting the `.mmd` replaces the whole board.** Your layout, notes and colors
> on that board are lost until [merge on re-import](../README.md#coming-soon) ships. Make
> sure the agent has run `xcld diff` and acted on your feedback *before* it rewrites the
> Mermaid. To keep a copy, `xcld snapshot` first.

## Conventions

These conventions are suggestions. The diff reports every change regardless, and the
agent interprets it. Agree on them once and tell your agent (prompt below).

| You want to say… | Do this in the canvas | The agent sees in `xcld diff` |
|---|---|---|
| "This is proposed, not agreed" (agent side) | Light-blue shape: stroke `#1971c2`, fill `#a5d8ff` | Shows up as colored nodes |
| **Approve** | Change the stroke to black and the fill to transparent | `Style: ~ node "Cache" strokeColor: #1971c2 -> #1e1e1e` |
| **Reject** | Delete the shape | `Nodes: - removed "Cache"` |
| **Comment / ask** | Free text next to the shape | `Notes: + added "why not Redis?" near "Cache"` |
| **Request a change** | Red free text next to the shape | Same as a comment; say "red = must fix" in your prompt |
| **Rename** | Double-click the shape and edit its text | `Nodes: ~ relabeled "Cache" -> "Redis cache"` |
| **Reconnect** | Drag an arrow's end onto a different shape | `Edges: ~ rewired API --> Cache -> API --> DB` |

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

Note for initial release: skills/instructions will be included with excalidraw-mcp spike.

Paste these into agent terminal (Copilot, Codex, Claude Code, OpenCode, etc.) from the `xcld-collab` folder.

**Set up the conventions (once per session):**

```text
We're using xcld-collab for diagrams. Boards live in ./boards; tools run with
`docker exec xcld-collab xcld <command>` (see docs/reference.md). Use one folder per
project, such as `boards/myproject/flow.mmd` and `?board=myproject/flow`.
Conventions: draw anything new or unapproved in light blue with
`classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2`.
When I change a node's stroke to black, that means approved. A deleted node is rejected.
Free text near a node is a comment; red text is a change request.
Never rewrite a .mmd until you've diffed and acted on my feedback.
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
- **Don't edit the same board at the same moment as an agent.** The last write wins.

## What doesn't work yet

- Diagram types other than flowcharts (sequence, class, ER, state).
- **Subgraphs.** A flowchart with `subgraph … end` comes in as one uneditable picture, and the
  top bar warns you. This is verified at the pinned mermaid-to-excalidraw. Until it's fixed,
  ask agents for flat flowcharts and put the group in the label instead, e.g.
  `API["Run: server"]`.
- Some Mermaid shapes. A cylinder `[(DB)]` and other special shapes arrive as plain
  rectangles. Rectangles, diamonds `{}` and circles `(())` are kept.
- Diagram direction. `to-mermaid` always writes `flowchart TD`.
- Version history, merge on re-import and design rules: see
  [Coming soon](../README.md#coming-soon).
