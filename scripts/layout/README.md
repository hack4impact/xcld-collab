# Layout helpers

Small, stdlib-only Python helpers that tidy a board after a Mermaid write left it hard to read:
overlapping subgraph frames, nodes stacked in one tall column, and labels squeezed into narrow
lines. They work on the board's JSON offline and never talk to the server; you read the board
and write the result back with `xcld` (or the HTTP API), so the server merges your layout with
whatever people did meanwhile.

`xcld_layout.py` has three commands:

| Command | What it does |
|---|---|
| `widen` | Sets the width of chosen shapes and re-wraps each bound label from its `originalText`, then sizes the shape to the text. |
| `rows` | Lays frames (subgraph containers) and free nodes out in rows from a small spec, fits each frame around its nodes, redraws bound arrows as straight lines, and checks the result. |
| `align` | Moves the nodes of one frame to their partners' x (one under another), refits the frame, draws straight vertical connectors between the pairs, and checks the result. |

The checks (`rows`, `align`) report node/node overlap, frame/frame overlap, a node sitting on a
frame it isn't a member of, a member sticking out of its frame, and an arrow crossing a node.
Exit codes: `0` clean, `1` problems found (the output file is still written, so you can look at
it), `2` bad input. Requires Python 3.8+; no packages.

## The problem

- **The grid fallback.** A Mermaid write that no open tab picks up is laid out by the server
  itself after about 2 minutes, in a simple grid (`tools/mermaid-grid.mjs`): one row per rank,
  each row centered on its own. A long chain becomes a single tall column, and the subgraph
  containers, drawn around members that sit on different rows, can overlap each other or cover
  nodes that aren't their members.
- **Hard-wrapped labels.** A shape's label is a bound text element. `originalText` is the label
  as written; `text` is that label wrapped, with real line breaks, to the width of the shape it
  was laid out in. Making the shape wider in the JSON doesn't re-wrap `text`, so the label stays
  a narrow column inside a wide box. `widen` re-wraps from `originalText`.
- **Concurrent edits.** A layout write must go through the merge, with the version you read as
  its base, so a human's edits made meanwhile are merged rather than overwritten.

## Recipe

From the repo root, with the container running (default `http://127.0.0.1:3100`). The board
`sandbox/demo` and the file names are examples.

1. **Read** the board. Note its `version`; it is the base of your write.

   ```text
   docker exec xcld-collab xcld read sandbox/demo > read.json
   ```

   The helpers accept this output as is (also as UTF-16, which PowerShell 5.1 redirection
   writes), as well as a plain `.excalidraw` scene or a bare element array.

2. **Widen** the shapes that should be wider (spec below):

   ```text
   python -I scripts/layout/xcld_layout.py widen widen.json read.json step1.json
   ```

3. **Lay out** in rows. Adjust the spec until it exits `0`:

   ```text
   python -I scripts/layout/xcld_layout.py rows rows.json step1.json step2.json
   ```

4. **Align** (optional), e.g. put `src:C` (the only member of `src:FRAME2`) under `src:A`:

   ```text
   python -I scripts/layout/xcld_layout.py align step2.json step3.json src:FRAME2 src:C=src:A
   ```

5. **Write** the whole board back with the version from step 1 as the base, and read what was
   merged and overwritten in the answer:

   ```text
   docker cp step3.json xcld-collab:/tmp/relayout.json
   docker exec -e XCLD_AUTHOR=layout xcld-collab xcld write sandbox/demo /tmp/relayout.json --base <version>
   ```

   An unknown base (the version expired, or you never read through the server) is refused;
   read again and re-run the steps, they are deterministic.

6. **Snapshot** the result so you can diff against it later:

   ```text
   docker exec xcld-collab xcld snapshot sandbox/demo --name relayout-1
   ```

Over HTTP instead of `xcld` ([API reference](../../docs/reference.md#api)):

- `GET /api/board/<path>` returns the board with `ETag: "<version>"`. The version is the value
  **without** the quotes.
- `POST /api/branch/<path>` with `Content-Type: application/json` and
  `{ "base": "<version>", "author": "cli:layout", "elements": [ ...the whole board... ] }`.
  `author` must be an author key: `cli:<name>` or `agent:<name>#<id>`; a bare `agent:<name>`
  is refused with `400 invalid-author`. `displayName`, `appState` and `files` are optional.
  A `200` answer carries `version` (your next base), `applied` and `overwritten`; a `202`
  means queued (safe, lands later); `409 unknown-base` means read again.

## Spec formats

Ids below are made up. A node of the Mermaid source `main` keeps its Mermaid id (`A`); a node
of another source is `<source>:<id>` (`src:A`).

`widen.json`:

```json
{
  "widths": { "src:": 420, "src:C": 520 },
  "exclude": ["src:LEGEND"],
  "padX": 24,
  "padY": 30
}
```

- A key is an exact element id, or a prefix ending in `:` or `*` (`src:` is every shape of the
  source `src`; `src:step*` every id starting with `src:step`). An exact id wins over a prefix,
  a longer prefix over a shorter one.
- Prefix matches skip shapes whose label is top-aligned, i.e. subgraph containers (`rows`
  sizes those); name one exactly to widen it anyway. Only rectangles are widened.
- `padX` (total room beside the text) and `padY` (room above and below) are optional.

`rows.json`:

```json
{
  "rows": [
    [ { "frame": "src:FRAME1", "nodes": ["src:A", "src:B"] } ],
    [ { "frame": "src:FRAME2", "nodes": ["src:C"] } ],
    [ { "node": "src:D", "under": "src:B" } ]
  ],
  "partial": false,
  "origin": [40, 40]
}
```

- Rows stack top to bottom; items in a row go left to right.
- `{ "frame": id, "nodes": [...] }` lays the nodes left to right inside the frame and fits the
  frame (and its title) around them. List every member of the frame.
- `{ "node": id, "under": other }` places a free node; with `under`, at the x of `other`.
- Without `partial`, every shape on the board must be in the spec (otherwise `not in spec`),
  and every bound arrow is redrawn. With `"partial": true`, only the listed shapes move, only
  arrows touching them are redrawn, and the checks also catch a moved shape landing on one you
  left alone. In a partial spec, list a frame together with its members if you move them.
- Optional spacing: `gap` (50, between items and between nodes in a frame), `rowGap` (90),
  `pad` (30, frame padding) and `padTop` (50, room for the frame title).

## Gotchas

- **A layout write is a canvas edit.** Geometry counts as a change, and a shape and its label
  are one unit. If a human moved a shape, or edited its label, after the version you read, the
  later write takes the whole unit: your write can reset a small human move or undo a label
  edit. Read right before you lay out, keep the gap short, and check `overwritten` in the
  write's answer (`xcld write` prints it; `xcld diff <board> --since <version>` shows it later).
  The losing version stays in history.
- **Restyle trap.** Changing a node's `class` or `style` in the Mermaid counts as a Mermaid
  change to that node, so the write takes the whole unit, shape and label, and can wipe a
  human's inline annotations of that label. Never re-style a human-annotated node through
  Mermaid: keep its line byte-identical, or carry the human's exact current text in the label.
- **Widths are estimates.** Text width comes from a per-character estimate (the same table the
  server uses for Excalifont at 20px), not font metrics, so a line can render a little longer or
  shorter than planned. Keep `padX` as a margin, and check the board in a tab.
- **Write the whole board.** The helpers keep every element; elements left out of a write are
  deleted unless they were added after your base. Don't post a subset.
- **Arrows become straight.** Redrawn arrows are two-point straight lines between the shapes'
  borders; their stroke style is kept. Arrows that `partial` doesn't touch keep their routing.

## Test

```text
python -I scripts/layout/smoke_test.py
```

Builds a small board in memory (two overlapping frames, four nodes in one column, bound labels
and arrows), runs `widen`, `rows` and `align`, and checks the result with its own box
arithmetic. It doesn't start or call a server. It isn't part of `node --test tests`.
