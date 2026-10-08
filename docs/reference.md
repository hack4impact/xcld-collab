# Reference

Commands, formats and fixes. This page is written for humans and agents alike: paste it
into an agent's context as-is.

## Running `xcld`

`xcld` lives inside the container. From the `xcld-collab` folder:

```text
docker exec xcld-collab xcld <command> [args]      # or: docker compose exec canvas xcld ...
```

- **Board paths** resolve to `/boards/<path>.excalidraw` in the container, which is your
  `./boards` folder. A path can include folders, for example `myproject/demo`.
- **File paths** are container paths (`/boards/...`).
- **Exit codes:** 0 on success, 1 on any error. Errors print one line to stderr.
- **Writing:** `xcld write` and `xcld write-mermaid` (and MCP `write_board`, `write_mermaid`) go through the server at `XCLD_API_URL`
  (default `http://127.0.0.1:3100`, the canvas inside the same container). Name yourself with
  `docker exec -e XCLD_AUTHOR=docs-bot xcld-collab xcld write ...`; history then shows
  `cli:docs-bot`.

Engineers with Node 22 can skip Docker and run the same tools on the host:
`XCLD_BOARDS_DIR=boards node tools/cli.mjs <command>`. In PowerShell, set
`$env:XCLD_BOARDS_DIR='boards'` first.

## Saving and exporting

The board saves itself: `boards/<path>.excalidraw`, about a second after the last edit
in the browser. Whether Mermaid gets written *for you* is one switch,
`XCLD_AUTO_EXPORT`:

```text
XCLD_AUTO_EXPORT: do you want Mermaid written automatically?
│
├── No, I'll ask when I need it ─────────────────────► off
│     every save      boards/<path>.excalidraw
│     xcld snapshot   boards/.snapshots/<path>.<time>.excalidraw
│     Mermaid         on demand only: xcld to-mermaid <path>
│
└── Yes. When?
      │
      ├── At hand-offs (every xcld snapshot) ────────► snapshot   (default)
      │     everything in off, plus
      │     xcld snapshot   boards/.snapshots/<path>.<time>.mmd  (next to the .excalidraw)
      │     good for        comparing plain-text Mermaid between review rounds
      │
      └── Always current (every save) ───────────────► save
            everything in snapshot, plus
            every save      boards/.exports/<path>.mmd   (rewritten on each change)
            good for        docs and PRs that should always match the board
```

- **"Every save"** covers both your browser edits and agents editing the `.excalidraw`
  file on disk (picked up within `XCLD_WATCH_POLL_MS` plus a ~100 ms settle check).
- **The inbox is never exported to.** No mode writes `boards/<path>.mmd`: that file is the
  Mermaid inbox, which only Mermaid writes update (MCP `write_mermaid`, `xcld write-mermaid`,
  or writing the file). Exports live in dot-folders, which the board browser and `xcld list`
  ignore.
- **Cost:** an export takes about 0.05 ms for a small board and 2 ms for 500 nodes, so
  `save` is safe to leave on.
- **To change it**, put `XCLD_AUTO_EXPORT=save` (or `off`) in `.env` and run
  `docker compose up -d --wait`. Allowed values: `off`, `snapshot`, `save`, in any case.

## Design rules

Design rules are local conventions for a board folder. They add tags and instructions to the
diff, brief agents before they draw, and define "done" checks. They do **not** filter changes:
unmatched edits still appear in the semantic diff.

### Files and cascade

- Default file: `<boards>/design-rules.csv` (`/boards/design-rules.csv` in the container).
- Override the default path with `XCLD_DESIGN_RULES` (for example in `.env` or the process
  environment). In Docker Compose this path is interpreted inside the container, so use
  `/boards/...` for files in the mounted boards volume. Do not commit private registry or
  credential values into this file.
- A `design-rules.csv` in a boards subfolder replaces the inherited rules for that folder and
  everything below it. Nearest file wins; rules are not merged row-by-row.
- The shipped starter file is `boards/examples/design-rules.csv`, so it applies only to
  `boards/examples/`. Copy it to your own folder or to `boards/design-rules.csv` when you want
  defaults for other boards.

### CSV format

Blank lines and lines starting with `#` are ignored. Quoted fields can contain commas, CRLF and
LF are accepted, and a UTF-8 BOM is tolerated.

```csv
kind,rule_id,on,match,means,instruct
interpret,approve,restyled,was.strokeColor=#1971c2;strokeColor=#1e1e1e,approved,"Promote to agreed; keep it in the Mermaid source"
draw,proposed-style,,,proposed,"Draw new or unapproved parts with classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2"
check,open-proposals,,strokeColor=#1971c2,open proposal,"Not done while light-blue nodes remain"
export,export-mode,,,save,"Keep .exports/<path>.mmd current for this folder"
snapshot,on-agent-write,,,on,"Snapshot before every agent write"
```

| kind | on | match | means | instruct |
|---|---|---|---|---|
| `interpret` | change type: `added`, `removed`, `relabeled`, `rewired`, `restyled`, `moved` or `*` | predicates; `was.` reads the before-state | tag in the diff | legend text |
| `draw` | — | — | drawing value/style name | briefing text for agents |
| `check` | — | what is still open | label | why it blocks done |
| `export` | — | — | `off`, `snapshot` or `save` | note |
| `snapshot` | — | — | `on` or `off` | note |
| `protect` | — | predicates | label | parsed and reported as "not enforced yet"; enforcement waits for versions/merge |

### Match language

Predicates are joined with `;` (AND). Values can be OR-ed with `|`. Use `!=` for not-equal and
`*` for any present value. `was.<prop>` checks the before-state, so
`was.strokeColor=#1971c2;strokeColor=#1e1e1e` means light-blue changed to black, not merely
"is black now". Removed-item rules evaluate against the before-state.

| Property | Values |
|---|---|
| `type` | `rectangle`, `diamond`, `ellipse`, `text`, `arrow`, `line`, `freedraw`, `frame`, `magicframe`, `image`, `embeddable`, `iframe`, `stickynote` |
| `strokeColor`, `backgroundColor` | exact `#rrggbb` hex, normalized to lowercase. A malformed value gets a suggestion when an Excalidraw palette color is close |
| `strokeStyle` | `solid`, `dashed`, `dotted` |
| `strokeWidth` | `1`, `2`, `4`, `8` |
| `fillStyle` | `hachure`, `cross-hatch`, `solid`, `zigzag` |
| `roundness` | `round`, `sharp` (no corner rounding) |
| `startArrowhead`, `endArrowhead` | `none`, `arrow`, `bar`, `circle`, `circle_outline`, `triangle`, `triangle_outline`, `diamond`, `diamond_outline`, `cardinality_one`, `cardinality_many`, `cardinality_one_or_many`, `cardinality_exactly_one`, `cardinality_zero_or_one`, `cardinality_zero_or_many`. Legacy names (`dot`, `crowfoot_one`, `crowfoot_many`, `crowfoot_one_or_many`) are rejected: Excalidraw renames them when it loads a board |
| `elbowed` | `true`, `false` |
| `opacity` | `0` through `100` |
| `bound` *(derived)* | `true`, `false`; text inside a container or a line/arrow bound at either end |
| `frame` *(derived)* | frame label/id containing the element |
| `crosses` | `note`/`text`, an element type, or an element id. A `line`, `arrow` or `freedraw` element matches when one of its segments intersects the target element's bounding box. `crosses=note` means any free text note. |

Open-note checks treat a free text note as resolved when a line/arrow/freedraw crosses it, or
when it is deleted.

**Where the values come from.** Excalidraw's own values (element types, stroke and fill
styles, stroke widths, roundness, arrowheads, palette) are generated from the pinned
Excalidraw commit into [`tools/rules-vocab.generated.mjs`](../tools/rules-vocab.generated.mjs),
whose header records the commit. `scripts/gen-rules-vocab.mjs` reads
`packages/element/src/types.ts` with the TypeScript type checker and `STROKE_WIDTH` /
`COLOR_PALETTE` from the built `@excalidraw/common`, and fails if any of them can't be read.

- The Docker build regenerates the file from the Excalidraw checkout it just built and ships
  that copy, so bumping the pin updates the vocabulary in the image. The build log prints a
  `NOTE` with the diff when the checked-in copy is stale.
- On the host, after `build.ps1 -Target vendor` and `npm install` in `app/`, run
  `node scripts/gen-rules-vocab.mjs` to regenerate it, or `--check` to verify it.
  `node --test tests` fails when the checked-in copy drifts from the generator output, and
  skips that comparison when the vendor packages aren't installed.
- Rule kinds, change types, `none`, `elbowed`/`bound` booleans, export and snapshot modes
  are xcld-collab's own vocabulary, in `tools/rules-vocab.mjs`.

### Commands and output

`xcld rules <board>` prints the effective briefing. Rules files are named relative to the boards
root; a file outside it (set with `XCLD_DESIGN_RULES`) keeps its full path. Captured from this
repo (some rows left out):

```text
> xcld rules examples/demo
Design rules for examples/demo: local defaults only; any folder can replace them with its own design-rules.csv.
Effective file: examples/design-rules.csv
Draw:
  - proposed-style: proposed — Draw new or unapproved parts with classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2 (examples/design-rules.csv)
  - direction: LR — Lay flowcharts out left to right (examples/design-rules.csv)
Interpret:
  - approve on restyled when was.strokeColor=#1971c2; strokeColor=#1e1e1e: approved — Promote to agreed; keep it in the Mermaid source (examples/design-rules.csv)
Check:
  - open-proposals when strokeColor=#1971c2: open proposal — Not done while light-blue nodes remain (examples/design-rules.csv)
```

`xcld rules check [board]` validates rules and exits 1 on bad CSV, unknown kind, unknown
property/value/operator, with file:line messages and close-match suggestions. `protect` rows
are warnings, not failures:

```text
> xcld rules check examples/demo
Design rules valid: 1 file(s), 0 warning(s).
```

`xcld check <board>` lists open items from `check` rows and exits 1 while any remain:

```text
> xcld check examples/demo
Design check found 2 open items for examples/demo:
  - open proposal: Versions (rectangle Versions) [open-proposals]
  - open proposal: Merge (rectangle Merge) [open-proposals]
```

It also warns, without failing, when a label's text contains a literal `<br>` (Mermaid
`<br/>` that was copied into the label instead of a line break):

```text
> xcld check sandbox/labels
WARNING: literal <br> in label text; the canvas shows the tag, not a line break. In Mermaid, put a real newline inside the quoted label instead of <br/>:
  - "GET /api<br>board" (text docCHOfcYpyge4CeOm6p- in rectangle get)

Design check passed for sandbox/labels: no open items.
```

Diff output gets short tags on matching changes and a deduped legend at the end:

```text
> xcld diff before.excalidraw after.excalidraw
Semantic diff /boards/sandbox/before.excalidraw -> /boards/sandbox/after.excalidraw
Style:
  ~ node "Cache" strokeColor: #1971c2 -> #1e1e1e (Cache)  [approve → approved]
Rule legend:
  [approve → approved] Promote to agreed; keep it in the Mermaid source
```

`--json` adds a `rules` array to each change (`scope` is the rules file, relative to the boards
root) and the effective `rulesFile`:

```json
"rules": [
  {
    "id": "approve",
    "means": "approved",
    "instruct": "Promote to agreed; keep it in the Mermaid source",
    "scope": "sandbox/design-rules.csv"
  }
]
```

If rules are invalid, `xcld diff` still prints the diff but begins with a warning block and skips
the bad rows. MCP diff responses include the same text/JSON diagnostics.

### MCP behavior

The `read_board` and `write_mermaid` tools include the effective design-rules briefing. The
`diff` tool includes rule tags, JSON `rules`, legends and invalid-rule warnings. The
`check_board` tool returns the same open-item data as `xcld check`. A `snapshot,on-agent-write`
rule with `means=on` snapshots an existing board before MCP `write_mermaid` applies Mermaid to
it; browser saves and CLI writes are not agent writes for this rule.

## Commands

### `xcld snapshot <board>`

Copies the board to `boards/.snapshots/<board>.<timestamp>.excalidraw` and prints the path.
Nested boards mirror their folders, e.g.
`boards/.snapshots/myproject/demo.<timestamp>.excalidraw`. Unless `XCLD_AUTO_EXPORT=off`,
it also writes the Mermaid twin `<timestamp>.mmd` alongside and prints that path too (see
[Saving and exporting](#saving-and-exporting)). Take one at every hand-off. `diff`
compares against the latest one.

```text
> xcld snapshot examples/demo
/boards/.snapshots/examples/demo.20261003T001424894Z.excalidraw
/boards/.snapshots/examples/demo.20261003T001424894Z.mmd
```

### `xcld diff <board> [--json]`

Shows what changed between the latest snapshot and the board now.

```text
> xcld diff sandbox/demo
Semantic diff /boards/.snapshots/sandbox/demo.20261002T235936310Z.excalidraw -> /boards/sandbox/demo.excalidraw
Nodes:
  ~ relabeled "Fix input" -> "Fix the input" (Fix)
Style:
  ~ node "Process" strokeColor: #1e1e1e -> #e03131 (Process)
```

A new shape connected by a new arrow looks like this:

```text
Nodes:
  + added rectangle "Hello Claude!" (CcwKLFGrMWXqS3nMOLBvM)
Edges:
  + added Fix input --> Hello Claude! (vSSrxAAAN2cal_q5g_WiQ)
  - removed Fix input --> Receive request (Fix_Req)
```

Sections appear only when something changed. Otherwise the output is
`No semantic changes detected.`

| Section | Lines | Meaning |
|---|---|---|
| `Nodes` | `+ added <type> "<label>"`, `- removed "<label>"`, `~ relabeled "<old>" -> "<new>"` | Shapes: rectangle, diamond, ellipse |
| `Edges` | `+ added A --> B`, `- removed A --> B`, `~ rewired <old> -> <new>`, `~ label <edge>: "<old>" -> "<new>"` | Arrows attached to shapes at both ends. Labels appear as `A --Yes--> B` |
| `Notes` | `+ added "<text>" near "<node>"`, `- removed`, `~ changed` | Free text not inside a shape, matched to the nearest node |
| `Style` | `~ node "<label>" <property>: <old> -> <new>` | `strokeColor`, `backgroundColor`, `fillStyle`, `strokeStyle`, `strokeWidth`, `roughness`, `opacity` |
| `Moves` | `~ node "<label>": <old geometry> -> <new geometry>` | Position or size changes |

The ID in parentheses at the end of each line is the element ID. For shapes that came from
Mermaid, it's the Mermaid node ID (`Fix`, `Req`), so agents can map it straight back to source.

`--json` prints the same data as an object: `files`, `nodes`
(`added`/`removed`/`relabeled`), `edges` (`added`/`removed`/`rewired`/`relabeled`),
`notes` (`added`/`removed`/`changed`), `styles`, `moves`. Each change also has `rules: []`
or matching rule objects when a design rule applies.

### `xcld rules <board>`

Prints the effective design-rules briefing for the board: draw conventions, interpret tags and
check rules, with the file each rule came from.

### `xcld rules check [board]`

Validates either the files that can apply to a board, or every discovered rules file when no
board is supplied. Exits 0 when valid and 1 on errors.

### `xcld check <board>`

Runs `check` rules against the current board. Exits 0 when no items are open and 1 when open
items remain, so scripts can gate hand-offs on it. Labels containing a literal `<br>` get a
`WARNING` block but don't change the exit code.

### `xcld list [folder] [--json]`

Lists boards, including nested folders. The optional `folder` filters to that folder and
children. `--json` prints the same shape as `GET /api/boards`.

```text
> xcld list
myproject/demo   board+mmd (mermaid pending)   2026-10-02 15:46
chat/imported   view (view pending)   2026-10-02 16:10
2 boards
```

### `xcld diff <a.excalidraw> <b.excalidraw> [--json]`

Compares any two files: two snapshots, or a snapshot and a board. Each argument is a file
path or a board name.

### `xcld to-mermaid <board|file>`

Prints the board as a Mermaid flowchart.

```text
> xcld to-mermaid style-check
flowchart TD
  API["API"]
  Cache["Cache layer"]
  DB["Database"]
  API --> Cache
  Cache --> DB
  style Cache fill:#a5d8ff,stroke:#1971c2,color:#1971c2
```

Free-text notes come out as comments, e.g.
`%% Free text note_schema near n_valid (108px): Human note: validate schema edge`.

### `xcld read <board>`

Reads the board through the running server (`XCLD_API_URL`, default
`http://127.0.0.1:3100`) and prints `{ board, version, scene }`. Pass `version` as `--base`
to `xcld write`. If the server isn't reachable it reads the file and says so (`warning`);
that version may then be refused as an unknown base.

### `xcld write <board> <file.excalidraw|-> --base <version|none> [--json]`

Writes a board through `POST /api/branch`, so the server merges it with everything written
since `--base` instead of overwriting (`none` for a new board). The file (or stdin with `-`)
is an `.excalidraw` scene or a bare element array, and it is the **whole board**. The author is
`cli:<XCLD_AUTHOR>` (default `cli:cli`). Prints what was merged and overwritten, or that the
write was queued (safe, lands later); exits 1 when nothing was written (bad input, unknown
base, server down).

### `xcld write-mermaid <board> <file.mmd|-> [--base <version>] [--source <name>] [--position below|right|near:<id>] [--json]`

Writes Mermaid through `POST /api/mermaid`: the server parses it, applies it to the board as it
was at `--base` (without `--base`: the board as it is now) and merges the result like any other
write ([how](DESIGN.md#server-side-mermaid-apply)). The author is `cli:<XCLD_AUTHOR>`, the write
time is now. `--source` names the diagram on the board (default `main`; see
[named sources](DESIGN.md#mermaid-ingestion-slice-6a)), and `--position` says where a diagram
that isn't on the board yet goes (default: below for TD, right for LR). Prints what changed, or
that the write was queued. A diagram that isn't on the board yet (a new board or source, or a
non-flowchart) prints `Pending on …` with its pending id: an open tab lays it out and it joins
the board next to the existing drawing; without a tab the server lays a flowchart out itself
after about 2 minutes. Exits 1 on a syntax error (with its line), an unknown base, a bad
`--source`/`--position` or a server that isn't reachable.

```text
> docker exec -i -e XCLD_AUTHOR=docs-bot xcld-collab xcld write-mermaid sandbox/flow - < next.mmd
Merged into sandbox/flow: version e7b798b33424…, 4 change(s) applied. Pass version as base on your next write. Changes: relabel node A: "Start" -> "Start here"; add node E (rectangle) after D at 166,504; add edge D_E: D -> E.
```

### `xcld mermaid-status <board> <pendingId> [--wait] [--json]`

Where a pending Mermaid write is: `pending` (and when the server lays it out itself), `landing`,
`landed` (by a tab, by the server's grid, or node by node; with the version), `superseded` (a
newer write of the same source replaced it) or `waiting-for-tab` (a non-flowchart). `--wait`
polls every second until it is no longer pending.

```text
> docker exec xcld-collab xcld mermaid-status sandbox/flow 01M4CB4AZ30001FW9NAJ3P
Pending on sandbox/flow (source "main"): an open tab lays it out; if none does, the server lays it out in a grid at 16:31:05 UTC.
```

### `xcld history export <board> [--to <dir>] [--full] [--json]`

Copies a board's version history out of the history folder (`XCLD_HISTORY`: the `xcld-state`
volume on Windows/macOS, `~/.excalidraw/history/` on Linux). It reads the files directly, so it
works while the server runs, and with the server stopped.

- **Default:** the history as stored, decompressed: `<entry>.checkpoint.json` (a full board),
  `<entry>.delta.json` (what that turn changed: `added`, `modified`, `deleted`), the images
  under `files/`.
- **`--full`:** every entry rebuilt as `<entry>.excalidraw`, a board you can open in
  Excalidraw (images inline).
- Both write `<entry>.meta.json` (author, times, `applied`, and `overwritten`: the edits that
  lost, with their elements) and `index.json` (entries in order).
- **Where:** `--to <dir>` (a path as `xcld` sees it), else `<cache>/exports/<board>`. Compose
  mounts the host's cache folder (`XCLD_CACHE_DIR`, default `~/.excalidraw`) at `/xcld-cache`,
  so from the host:

```text
> docker exec xcld-collab xcld history export sandbox/demo
Exported 12 history entries of sandbox/demo (1 checkpoint, 11 deltas) to /xcld-cache/exports/sandbox/demo
On the host: ~/.excalidraw/exports/sandbox/demo
```

  Running the image without that mount, the export stays in the container's `/xcld-cache`;
  copy it out with `docker cp xcld-collab:/xcld-cache/exports/sandbox/demo ./demo-history`.
- It refuses a destination in the history folder, also when reached through another path.
  Exits 1 when the board has no history.

### `xcld open-in-canvas <checkpointId> <board> [--overwrite]`

Bridges a drawing from the Excalidraw MCP Apps chat widget into the persistent canvas. It
reads `<checkpointId>.json` from `XCLD_MCP_CHECKPOINTS` (default:
`/boards/.xcld/mcp-checkpoints/excalidraw-mcp-checkpoints`), drops widget pseudo-elements
such as `cameraUpdate`, writes `boards/<board>.view.json`, and prints the canvas URL.

`board` is required. The command refuses to target an existing
`boards/<board>.excalidraw` unless `--overwrite` is passed; snapshot or read the board first.

```text
> xcld open-in-canvas cb545782f1f048efb0 myproject/chat-flow
{
  "path": "/boards/myproject/chat-flow.view.json",
  "url": "http://127.0.0.1:3100/?board=myproject/chat-flow",
  "checkpointId": "cb545782f1f048efb0",
  "board": "myproject/chat-flow",
  "elements": 6,
  "reminder": "Open or keep open the canvas URL; an open tab converts this view inbox into the board."
}
```

### `xcld mermaid-apply --dry-run <board|file> <file.mmd> [--json]`

Preview only: prints what the server-side Mermaid apply would change on the board, without a
browser and without writing anything (see [Design](DESIGN.md#server-side-mermaid-apply)). It
parses with Mermaid's own parser, so the first call in a process takes a second or two.

```text
> xcld mermaid-apply --dry-run sandbox/flow next.mmd
relabel node A: "Start" -> "Start here"
add node E (ellipse) after D at 183,504
add edge D_E: D -> E
3 changes (dry run, nothing written).
```

A board with no shapes from Mermaid yet prints `Needs a tab: …`: a write of it becomes a pending
write that a tab (or, after about 2 minutes, the server's grid) lays out. To write, use
`xcld write-mermaid` or MCP `write_mermaid`.

### `xcld help`

Prints usage.

## Mermaid ⇄ board mapping

| Mermaid | Board (Excalidraw) | Back to Mermaid |
|---|---|---|
| `A[text]` | rectangle | `A["text"]` |
| `A{text}` | diamond | `A{"text"}` |
| `A((text))` | ellipse | `A(("text"))` |
| Other shapes, e.g. `A[(db)]` | rectangle | `A["db"]` (shape lost) |
| `subgraph … end` | editable container rectangle; child nodes/arrows share `subgraph_group_<id>` | `subgraph <id>["title"] … end` |
| `A --> B` | arrow attached at both ends | `A --> B` |
| `A -->|label| B` | arrow with label | `A -->|"label"| B` |
| `A --- B` | line, no arrowheads | `A --- B` |
| `A -.-> B` | dashed arrow (dotted too) | `A -.-> B` |
| `A ==> B` | extra-bold arrow | `A ==> B` |
| `A <--> B` | arrowheads at both ends | `A <--> B` |
| `classDef` / `style` colors | stroke, fill and text colors | `style A fill:…,stroke:…,color:…` |
| — | free text note | `%% Free text <id> near <node> (<distance>px): <text>` |
| — | loose arrow, not attached | `%% Unbound arrow …` |
| — | freehand, image, etc. | `%% Unsupported element …` |

- Node IDs survive the round trip. Labels use what you typed, not the canvas's line wrapping.
- **Line breaks in labels:** put a real newline inside the quoted label (through MCP
  `write_mermaid`, that's `\n` inside the JSON string). The canvas shows two lines:

  ```text
  flowchart TD
    api["PUT /api/board
  api.mjs:362"]
  ```

  `<br/>` and `<br>` are **not** converted: the canvas shows the tag as text, and
  `xcld check` / MCP `check_board` warn about it. `to-mermaid` joins the lines with a space.
- `to-mermaid` always writes `flowchart TD`, because the board stores positions, not a direction.
- Other arrowheads, such as circle, bar or triangle, are written as the nearest equivalent
  and noted in a `%%` comment.

## Files

| Path | What it is |
|---|---|
| `boards/<path>.excalidraw` | The board. Standard Excalidraw JSON that excalidraw.com can open too |
| `boards/examples/` | Example boards, **tracked in git**. Copy them before editing, e.g. into `boards/sandbox/`. Everything else in `boards/` is gitignored, and board edits never make the image tag `-dirty` |
| `boards/<path>.mmd` | Mermaid inbox: the last Mermaid written to the board. A Mermaid write (MCP `write_mermaid`, `xcld write-mermaid`, `POST /api/mermaid`) is applied on the server and merged into the board; the server then rewrites this file with it. Writing the file directly works too (applied as `external`, written at the file's mtime). A write the server can't apply node by node (a new board, a board without Mermaid shapes, or a non-flowchart) is laid out by an open tab on `<path>` and **joins** the board as a group next to the drawing (only an empty board takes the layout as is), or, for a flowchart, by the server in a simple grid after about 2 minutes. This file is the source `main`; other named sources live in the server's state only. A tab's converted elements record a hash of this Mermaid (`customData.xcldMermaidHash`), so `xcld list` and the board browser show `mermaid pending` / "Mermaid waiting to convert" exactly when the `.mmd` content differs from what the board was converted from, or the board is missing or empty. That survives a fresh clone or checkout; boards converted before the hash existed fall back to "the `.mmd` is newer than the board" |
| `boards/<path>.view.json` | View inbox from `open_in_canvas`. An open tab on `<path>` converts it into the board; `xcld list` shows `view pending` until a non-empty board save is newer |
| `boards/.snapshots/<folder>/<leaf>.<timestamp>.excalidraw` | Snapshots from `xcld snapshot`; flat boards still use `boards/.snapshots/<name>.<timestamp>.excalidraw` |
| `boards/.snapshots/<folder>/<leaf>.<timestamp>.mmd` | The snapshot's Mermaid twin. Written unless `XCLD_AUTO_EXPORT=off` |
| `boards/.exports/<path>.mmd` | Always-current Mermaid of each board. Only with `XCLD_AUTO_EXPORT=save` |
| History folder: `~/.excalidraw/history/` on Linux (`XCLD_HISTORY=cache`), the `xcld-state` Docker volume on Windows/macOS (`XCLD_HISTORY=volume`) | Version data the server keeps: `history/<path>/` (one entry per author turn: a person's consecutive saves fold into one entry until someone else writes, 3 minutes pass or a checkpoint; each entry is a gzipped delta of what changed, `<UTC>-<author>.delta.json.gz`, or every 20th a full checkpoint, `.excalidraw.gz`, plus `.meta.json`), `files/<path>/` (images, stored once), and the write journal, commit state and kept bases (`branches/`, `state/`, `bases/`). Don't edit it; read it with `xcld history export`. On Windows/macOS `docker compose down -v` deletes it. Without `XCLD_HISTORY` (running the server outside compose) it is `boards/.xcld/` |
| `~/.excalidraw/exports/<board>/` (`XCLD_CACHE_DIR`, mounted at `/xcld-cache`) | Where `xcld history export` writes |
| `.env` | Written by the build (`XCLD_IMAGE`, `XCLD_TAG`; `XCLD_AUTHOR_NAME` and `XCLD_HISTORY` once; `XCLD_UID`/`XCLD_GID` on Linux). Your settings go here too. An older `XCLD_STATE_DIR` / `XCLD_EXPORT_DIR` line is no longer read: the build maps it to `XCLD_HISTORY` / `XCLD_CACHE_DIR` and leaves it in place |

**Board paths:** one or more segments joined by `/`. Each segment uses letters, digits, `.`,
`_` and `-`, starts with a letter or digit, and is at most 100 characters. Empty segments,
leading/trailing `/`, backslashes, `.hidden`, `..` and total paths over 512 characters are
rejected. `XCLD_MAX_DEPTH=0` (the default) allows unlimited folders; otherwise it limits folder
levels.

## API

- `GET /api/boards` returns `{ boards, folders }` with board paths, folder/leaf names, board,
  Mermaid and view-inbox presence, pending states and last modified time.
- `GET /api/board/<path>` returns the board JSON with `ETag: "<version>"`, or 404
  `{"error":"board-not-found"}`. A **version** is the sha256 of master's bytes. The server
  keeps a version it handed out resolvable as a base (24 h after the last read), so read
  through it before you write.
- `POST /api/branch/<path>` (`Content-Type: application/json`) is how agents and scripts
  write: `{ author?, displayName?, base, writtenAt?, kind: "json", elements, appState?, files? }`.
  Send the **whole board** you want; elements you leave out are deleted, unless they were
  added after your `base`. `base` is the version you read (`null` for a new board). The
  server merges your write with everything committed since `base`
  ([rules](DESIGN.md#merge-rules)) and waits up to 5 s for the commit:

  | Status | Body | Meaning |
  |---|---|---|
  | 200 | `{ status: "merged", version, fastForward, applied, overwritten, unbound, branchId }` | Committed. Use `version` as your next `base` |
  | 202 | `{ status: "queued", branchId, base, message, slowIo? }` | Safely in the journal, committed later; never dropped. `message` says why; during a disk stall `slowIo` (`{ stage, board, ms, inFlight }`) names the slow file operation, e.g. "disk is slow right now (journal fsync 4.2 s); your write is safe and queued" |
  | 400 | `{ error }`, e.g. `base-required`, `invalid-author`, `invalid-elements` | Not written |
  | 409 | `{ error: "unknown-base", base, currentVersion }` | The server doesn't know `base` (expired, or never read through it). Read again |

  `author` is an author key: `agent:<client>#<id>`, `cli:<name>` (default `cli:api`), or
  `human:<name>#<tab>`. `overwritten` lists units both sides changed, with `winner` and
  `loser` (`side`, `author`, `writtenAt`); the losing version stays in history.

  ```text
  > curl -s -X POST -H "Content-Type: application/json" --data-binary @post.json http://127.0.0.1:3100/api/branch/sandbox/guard
  {"status":"merged","version":"448894bb02a9…","fastForward":true,"applied":[{"unitId":"b","label":"ellipse b","kind":"added","elementIds":["b"]}],"overwritten":[],"unbound":[],"branchId":"01M4ASRFXA00RZMK0DQ02F"}
  ```

- `PUT /api/board/<path>` (`Content-Type: application/json`) is the canvas's save. It sends
  the version it started from:

  | Header | Result |
  |---|---|
  | `If-Match: "<version>"`, the current version | Saved as sent (a fast-forward): 200 `{ ok, hash, version, merged: false, applied, overwritten, unbound }` |
  | `If-Match: "<version>"`, an older version the server knows | **Merged** with what was written since: 200 with `merged: true` and the merged board in `master`, which the tab shows |
  | `If-Match` with a version the server doesn't know (or only weak `W/` tags) | 409 `{"error":"unknown-base","currentHash":"<version>"}`; also when the board was deleted since (`currentHash: null`) |
  | `If-None-Match: *` | Starts from an empty board: creates it, or merges into a board created meanwhile |
  | neither | **Unguarded**: overwrites whatever master is (kept for scripts). Prefer `POST /api/branch` |

  `hash` and the `ETag` are the new version. The canvas identifies itself with
  `X-Xcld-Author-Name` (percent-encoded UTF-8) and `X-Xcld-Tab` (`[A-Za-z0-9_-]`); without
  them a save is authored `human:<XCLD_AUTHOR_NAME or anonymous>#legacy`. It also sends
  `X-Xcld-Edit-Age` (ms since its last edit, capped at 10 min): the save's write time, which
  decides who wins an [overwritten](DESIGN.md#merge-rules) unit, is then the time of that
  edit rather than the time the debounced save arrived.

  ```text
  > curl -si -X PUT -H "Content-Type: application/json" -H 'If-Match: "6ca666afdf75…"' -H "X-Xcld-Author-Name: Ada%20Lovelace" -H "X-Xcld-Tab: tab1" --data-binary @board.json http://127.0.0.1:3100/api/board/sandbox/guard
  HTTP/1.1 200 OK
  ETag: "7e05b8e2f8ded474f2e6358733db7b896e6d931548f074dbb41e6cb1f9e72a20"
  {"ok":true,"hash":"7e05b8e2f8de…","version":"7e05b8e2f8de…","merged":true,"applied":[{"unitId":"a","label":"rectangle a","kind":"changed","elementIds":["a"]}],"overwritten":[],"unbound":[],"master":{"type":"excalidraw",…}}
  > curl -si -X PUT -H "Content-Type: application/json" -H 'If-Match: "0000"' --data-binary @board.json http://127.0.0.1:3100/api/board/sandbox/guard
  HTTP/1.1 409 Conflict
  {"error":"unknown-base","currentHash":"7e05b8e2f8ded474f2e6358733db7b896e6d931548f074dbb41e6cb1f9e72a20"}
  ```

- `POST /api/board/<path>/checkpoint` (Ctrl+S in the canvas) closes the caller's open history
  entry, so its turn becomes one restore point now instead of after 3 minutes idle. Send the
  same `X-Xcld-Author-Name` and `X-Xcld-Tab` as the saves: only that author's open entry is
  closed (without them, any open entry is). The answer is `{ ok, closed, entry, version }`;
  `closed: false` means nothing changed since the last checkpoint. 404 if the board doesn't
  exist. Only `POST` takes the `/checkpoint` suffix, so a board named `<path>/checkpoint` still
  works with `GET` and `PUT`.

  ```text
  > curl -si -X POST -H "X-Xcld-Author-Name: Ada%20Lovelace" -H "X-Xcld-Tab: tab1" http://127.0.0.1:3100/api/board/sandbox/guard/checkpoint
  HTTP/1.1 200 OK
  {"ok":true,"closed":true,"entry":"20261007T220328.449Z-human_Ada_Lovelace_tab1","version":"660b905aec1d…"}
  > curl -s -X POST -H "X-Xcld-Author-Name: Ada%20Lovelace" -H "X-Xcld-Tab: tab1" http://127.0.0.1:3100/api/board/sandbox/guard/checkpoint
  {"ok":true,"closed":false,"entry":null,"version":"660b905aec1d…"}
  ```

- `GET /api/config` returns `{ authorName, writeWaitMs, timing }` (`authorName` is
  `XCLD_AUTHOR_NAME`, the canvas's default author name).
- `GET /api/status` returns `{ ok, pending, failing, slowIo }`: writes waiting in the journal per
  board, commits waiting on a retry after a disk error (retried with backoff 0.5, 1, 2, 4,
  then every 10 s; the board's other writes wait, other boards don't), and slow file
  operations. `slowIo` is `{ thresholdMs, count, maxMs, byStage, recent, inFlight }`: every file
  operation of the commit pipeline that took `XCLD_SLOW_IO_MS` (default 1000) or longer since the
  server started, by stage (`<kind>.<op>`, e.g. `journal.fsync`, `state.rename`, `master.write`:
  `{ count, maxMs }`), the last 50 as `{ stage, board, ms, at }`, and those running that long now.
  Each one is also logged once (`docker compose logs canvas`).
- `GET /api/timings[?clear=1]` (only with `XCLD_TIMING=1`) returns per-stage timings of recent
  commits.
- `POST /api/mermaid/<path>` (`Content-Type: application/json`) writes Mermaid:
  `{ author?, displayName?, base?, writtenAt?, mermaid, source?, position? }`. The server parses it, applies it to
  the board as it was at `base` (absent or `null`: the current board), and commits the result
  like `POST /api/branch`, waiting up to 5 s ([how](DESIGN.md#server-side-mermaid-apply)).
  `writtenAt` (ms since the epoch, default: when the server received it) is when the Mermaid was
  written: a stale write loses to a newer edit of the same shape. `source` names the diagram on
  the board (default `main`); `position` (`below`, `right`, `near:<id>`) places a diagram that
  isn't on the board yet ([Mermaid ingestion](DESIGN.md#mermaid-ingestion-slice-6a)).

  | Status | Body | Meaning |
  |---|---|---|
  | 200 | `{ status: "merged", version, fastForward, applied, overwritten, unbound, branchId, ops, hash, source, unchanged?, deletesSkipped?, hint? }` | Committed. `ops` lists what the Mermaid changed on the board (`keep-canvas`: a human's edit kept because this Mermaid doesn't change that node). `unchanged: true`: the board already matched, only the Mermaid was recorded. `deletesSkipped: true`: the server doesn't know which Mermaid the board came from, so nothing was deleted. `hint.suggestSource`: the write deleted most of the source; a new source name would have kept both diagrams. `overwritten` includes the canvas edits this write replaced |
  | 200 | `{ status: "merged", noop: true, unchanged: true, version, hash, source }` | This source already has exactly this Mermaid; nothing was written |
  | 202 | `{ status: "queued", branchId, base, message, slowIo?, ops, hash }` | Safely in the journal, committed later; never dropped. `message` and `slowIo` as for `POST /api/branch` |
  | 202 | `{ status: "needs-tab", reason, hash, source, pendingId, pending, retryScheduleMs }` | A new board, a board without shapes of this source, or a non-flowchart: a pending write. An open tab lays it out and it joins the board as a group (only an empty board keeps the converter's layout as is); otherwise the server checks again at 5 s, 15 s and 45 s and lays a flowchart out itself in a grid at 2 min (`pending.layoutAt`). The author and write time stay the writer's |
  | 400 | `{ error: "mermaid-syntax-error", message, line, column }`, or `mermaid-required`, `invalid-author`, `invalid-source`, `invalid-position` | Not written |
  | 409 | `{ error: "unknown-base", base, currentVersion }` | Read again |
  | 503 | `{ error: "mermaid-parser-unavailable", message }` | The server's Mermaid parser didn't load; nothing was written |

- `GET /api/mermaid/<path>?pending` lists the pending writes of a board
  (`{ pending: [{ id, source, hash, mermaid, author, writtenAt, status, layoutAt, ... }] }`),
  for an open tab to lay out. A `boards/<path>.mmd` that nothing applied yet becomes a write
  (author `external`) first.
- `POST /api/mermaid/<path>?layout=<pendingId>` with `{ hash, elements, files? }`: a tab's
  in-memory conversion of that write (`elements` as `convertToExcalidrawElements` makes them).
  The server namespaces and stamps them, places them clear of the drawing and commits them as
  the write's author at its write time; the answer is like a write's, plus `pendingId`, `via`
  and `placement` (`keep`, `below`, `right`, `near`, `replace`). 409 `{ error: "not-pending",
  status }` when it already landed or was superseded.
- `GET /api/mermaid/<path>?id=<pendingId>` is the write's status: `pending`, `landing`,
  `landed` (`via` tab, grid or server, `version`), `superseded` or `waiting-for-tab`; 404 for an
  unknown id.

- `GET /api/mermaid/<path>` returns the raw `boards/<path>.mmd` inbox, with
  `X-Xcld-Mermaid-Applied: 1` when the server has already applied it to the board (the canvas
  then doesn't convert it).
- `GET /api/view/<path>` returns the raw `boards/<path>.view.json` inbox.
- `GET /api/events` publishes `event: board` with `kind: "board"`, `"mermaid"` (a pending
  Mermaid write a tab can lay out, with its `id` and `source`), `"mermaid-applied"` (a Mermaid
  write that left the board as it was), `"view"` or `"deleted"`; `event: mermaid-write`
  `{ name, id, source, status: "landed", via, version, author, writtenAt }` when a pending write
  lands; and `event: merged` `{ name, version, author, applied, overwritten, unbound }`
  after every commit, also after a write whose every change lost (`applied` empty, master
  unchanged, `overwritten` lists what lost).

## MCP

There are two MCP entry points in the image:

1. **`xcld mcp`** is the primary agent tools server. It speaks MCP over stdio, so clients
   launch it with `docker exec -i xcld-collab xcld mcp`. It adds no port and uses the same
   board volume as the canvas. It is enabled by default.
2. **`excalidraw-mcp`** is the **experimental**, opt-in MCP Apps chat-widget UI service. It
   is off by default. Compose serves it only when the `widget` profile is enabled, at
   `http://127.0.0.1:3001/mcp`, for hosts that render MCP Apps widgets, such as VS Code and
   Claude Desktop. Its `export_to_excalidraw` upload flow and Excalidraw Plus menu link are
   patched out at build time. See [the widget section](#excalidraw-mcp-apps-ui-service-experimental).

### `xcld mcp` tools

All board paths are validated with the same rules as `xcld` board paths. Tool errors are
returned as MCP tool errors (`isError: true`) with the CLI's friendly messages.

Every tool description repeats the working conventions: snapshot before human review, diff
after, read the board first and pass its version as `base` when writing (the server merges
your write with the human's and other agents' edits), read the board's design-rules briefing, use light blue for
proposed parts (`classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2`), use
flowcharts only (subgraphs are fine), and break labels with a real newline inside the quoted
label, never `<br/>`.

| Tool | Inputs | Output |
|---|---|---|
| `list_boards` | optional `folder` | Same JSON shape as `xcld list --json`: `{ boards, folders }` |
| `read_board` | `board`, optional `format` = `mermaid` (default), `json` or `both` | Reads through the board server: Mermaid text, Excalidraw JSON, or both, the board's `version` (pass it as `base` to `write_board` or `write_mermaid`), and the effective design-rules briefing. Falls back to the file with a `warning` when the server is down |
| `write_board` | `board`, `base` (version from `read_board`, `null` for a new board), `elements` (the whole board), optional `appState`, `files` | Writes through `POST /api/branch` as `agent:<MCP client name>#<process id>`; returns `status` (`merged` or `queued`), `version`, `applied`, `overwritten`. Errors (unknown base, bad input) are tool errors |
| `write_mermaid` | `board`, `mermaid`, optional `base` (version from `read_board`; absent: the board as it is now), `source` (the diagram's name on the board, default `main`), `position` (`below`, `right` or `near:<id>`, for a diagram that isn't on the board yet) | Writes through `POST /api/mermaid` as `agent:<MCP client name>#<process id>`, with this process's clock as the write time: the server applies the Mermaid to the board and merges it. Returns `status` (`merged`, `queued`, or `needs-tab` with a `pendingId` for a diagram that isn't on the board yet: open `url`, or the server lays a flowchart out after about 2 minutes), `version`, `applied`, `overwritten`, `ops`, `source`, `noop` (this exact Mermaid was already applied), `hint` (a new source name, when the write deleted most of its source), `url` and the design-rules briefing; snapshots first when `snapshot,on-agent-write` is on. A syntax error (with its line), an unknown base, a bad `source` or `position`, or a server that isn't reachable are tool errors; nothing is written |
| `mermaid_status` | `board`, `pendingId` | Where a pending write is: `pending` (with `layoutAt`), `landing`, `landed` (`via` tab, grid or server, `version`), `superseded` or `waiting-for-tab` |
| `snapshot` | `board` | Same as `xcld snapshot`: snapshot path and, unless `XCLD_AUTO_EXPORT=off`, Mermaid twin path |
| `diff` | either `board`, or `from` + `to`; optional `format` = `text` (default) or `json` | Same semantic diff as `xcld diff`, including tags/legend/warnings |
| `check_board` | `board` | Same open-item result and `<br>` label warnings as `xcld check` |
| `board_url` | `board` | `XCLD_PUBLIC_URL/?board=<path>`, defaulting to `http://127.0.0.1:3100/?board=<path>` |
| `open_in_canvas` | `checkpointId`, required `board`, optional `overwrite` = `false` | Writes `boards/<path>.view.json` from an Excalidraw MCP checkpoint and returns the canvas URL |

Host development:

```powershell
cd app
npm ci
npm run build      # creates gitignored tools/mcp.bundle.mjs and tools/mermaid-parse.bundle.mjs
cd ..
$env:XCLD_BOARDS_DIR='boards'
node tools/cli.mjs mcp
```

### Client configuration snippets

Use the container name you actually started. For parallel smoke tests in this repo, set
`XCLD_CONTAINER=xcld-w3` and use `xcld-w3` below.

**GitHub Copilot CLI** — documentation format verified from GitHub Docs; not connected
through Copilot CLI on this machine. Protocol was tested separately with the MCP server.

`%USERPROFILE%\.copilot\mcp-config.json` or a trusted repo `.mcp.json`:

```json
{
  "mcpServers": {
    "xcld": {
      "type": "local",
      "command": "docker",
      "args": ["exec", "-i", "xcld-collab", "xcld", "mcp"],
      "tools": ["*"]
    }
  }
}
```

Or add it from a terminal:

```powershell
copilot mcp add xcld -- docker exec -i xcld-collab xcld mcp
```

**Claude Code** — documentation format verified from Anthropic docs; `claude` was not
installed here.

```powershell
claude mcp add --transport stdio xcld -- docker exec -i xcld-collab xcld mcp
```

Project `.mcp.json` equivalent:

```json
{
  "mcpServers": {
    "xcld": {
      "command": "docker",
      "args": ["exec", "-i", "xcld-collab", "xcld", "mcp"]
    }
  }
}
```

**Codex CLI** — documentation-only here; `codex` was not installed.

`%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.xcld]
command = "docker"
args = ["exec", "-i", "xcld-collab", "xcld", "mcp"]
enabled = true
```

**OpenCode** — documentation format verified from OpenCode docs; `opencode` was not
installed here.

`opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "xcld": {
        "type": "local",
        "command": ["docker", "exec", "-i", "xcld-collab", "xcld", "mcp"]
      }
    }
  }
}
```

**VS Code**: verified in a real VS Code chat (2026-10-02/03): the `xcld` tools work, and the
experimental widget rendered with the profile enabled. The repo ships `.vscode/mcp.json` with
the `xcld` tools server only, so opening the repo in VS Code offers it without starting
anything extra. To use it in every window, add the same entry to your user `mcp.json`.

`.vscode/mcp.json`:

```json
{
  "servers": {
    "xcld": {
      "type": "stdio",
      "command": "docker",
      "args": ["exec", "-i", "xcld-collab", "xcld", "mcp"]
    }
  }
}
```

The `excalidraw` widget server is not in the shipped file because its service is off by
default, and VS Code would report a failed connection for it. After you opt in to the
[experimental widget](#excalidraw-mcp-apps-ui-service-experimental), add it next to `xcld`:

```json
    "excalidraw": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp"
    }
```

### Excalidraw MCP Apps UI service (experimental)

The chat widget is **experimental and off by default**. It's the second service, named `mcp`,
from the same image, under the `widget` Compose profile. Known issues:

- When it renders, the widget loads React, React DOM, Excalidraw 0.18.0 and morphdom from
  `https://esm.sh`, so enabling it adds runtime egress
  ([#9](../../../issues/9)).
- The VS Code webview console can show font Content-Security-Policy errors; affected UI text
  falls back to a system font ([#7](../../../issues/7)).

To opt in, add `COMPOSE_PROFILES=widget` to `.env`, run `docker compose up -d --wait`, and add
the `excalidraw` server to your `mcp.json` (above). The build never writes or changes
`COMPOSE_PROFILES`. Builds from before the widget became opt-in seeded
`COMPOSE_PROFILES=widget`; while that line is there the build prints a notice, and you can
remove `widget` from it to go back to canvas only. To stop a running widget service, run
`docker compose --profile widget down`, then `docker compose up -d --wait`. The primary
`xcld mcp` stdio tools don't need the widget; they run through `docker exec -i xcld-collab
xcld mcp` in the canvas container.

When enabled, the service is:

```text
http://127.0.0.1:3001/mcp
```

It is upstream `excalidraw-mcp` at the pinned SHA in `pins.json`, patched during the Docker
build. Checkpoints use `TMPDIR=/boards/.xcld/mcp-checkpoints`, so user edits survive service
restarts and the dot-folder stays hidden from the board browser and `xcld list`.

**Network status:** when enabled, the widget currently loads React, React DOM, Excalidraw and
morphdom from `https://esm.sh` through upstream Vite externals and the MCP Apps CSP; this is
issue #9 / the widget network spike. Fonts come from the canvas container's
`/excalidraw-assets/` endpoint. Do **not** claim the widget is zero-egress yet. The switch
points are the excalidraw-mcp build patch for `vite.config.ts` (`rollupOptions.external` /
`output.paths`) and `src/server.ts` (`resourceDomains` / `connectDomains`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `required variable XCLD_TAG is missing a value` | No build yet, or `.env` deleted | Run `.\build.ps1` / `./build.sh`, then `docker compose up -d --wait`. Or set `XCLD_IMAGE`/`XCLD_TAG` for the [prebuilt image](../README.md#or-use-the-prebuilt-image) |
| `Bind for 127.0.0.1:3100 failed: port is already allocated` | Something else is using 3100 | Put `XCLD_PORT=3200` in `.env`, run `docker compose up -d --wait`, then use `http://127.0.0.1:3200` |
| `No snapshots found for <board>` | `diff <board>` needs a "before" picture | `xcld snapshot <board>`, edit, then `diff` |
| `Board not found: <board>` | The board file doesn't exist yet | Open `http://127.0.0.1:3100/?board=<board>` (it converts `<board>.mmd` if present), or check the path |
| The board opens but the canvas is empty | The URL was opened before an inbox was written | Call MCP `write_mermaid`, `open_in_canvas`, or write an inbox while the tab stays open. The browser lays it out on the blank canvas; reload once if it misses the update |
| The agent wrote `<board>.mmd` but nothing appeared | A brand-new board (or a non-flowchart) is laid out by the browser | Open (or keep open) a tab on `?board=<board>`. On an existing board the server applies it; check `docker compose logs canvas` for a parse error |
| Widget **Edit** does nothing in VS Code | The host refused the widget's fullscreen editor | Ask your assistant to call `open_in_canvas` with the checkpoint id shown in the widget hint and an explicit board path, then open the returned canvas URL |
| The diagram came in as a picture you can't edit, and the top bar says "came in as a picture" | The converter couldn't parse it into shapes; the exact error is in the browser console (F12) | Simplify unsupported Mermaid syntax or have the agent rewrite the `.mmd` as a flowchart using supported shapes |
| My notes disappeared | `open_in_canvas` with `overwrite` replaced the board with a view inbox. (Mermaid writes don't replace a board: they only change their own source's shapes; a canvas edit they overwrite is in history) | Restore from version history (`xcld history export <board> --full`) or `boards/.snapshots/` (copy the latest over `boards/<board>.excalidraw`) |
| The top bar says "Board changed elsewhere; your edits were re-applied" | The server no longer knew the version your tab started from (409, e.g. after a day without reads), so the tab merged your unsaved edits onto the board itself and saved | Nothing to do. Check the shapes you both touched; the banner lists any that were overwritten |
| The banner says an edit of yours was overwritten | You and someone else changed the same shape (or its label) and theirs was later | Theirs is on the board; yours is in version history (`xcld history export <board>`, the entry's `.meta.json`). Redo it if it should win. See the [user guide](user-guide.md#editing-at-the-same-time-as-agents) |
| "Save failed: the board kept changing elsewhere (3 retries)" | Something rewrites the board faster than the tab can merge | Stop the other writer, then make any edit to retry; your edits are still in the tab |
| Writes take seconds; an agent gets `Queued: disk is slow right now (journal fsync 4.2 s); your write is safe and queued`; its edits reach the canvas late | A **disk stall**: something else writes heavily to the same disk, such as other containers, image builds (`build.ps1`, `docker build`) or a large copy. On Docker Desktop every container and volume shares one VM disk, so a busy neighbour stalls the server's fsyncs for seconds | Nothing is lost: each write is in the journal and lands when the disk catches up. Check `curl -s http://127.0.0.1:3100/api/status`: `slowIo.count`, `slowIo.byStage` (which operation, e.g. `journal.fsync`) and `slowIo.recent` (when); the log has one `slow I/O:` line per slow operation (`docker compose logs canvas`). Pause the heavy job, or don't build images while you work in the canvas. Slow on a quiet machine too: check the host disk (free space, antivirus scanning Docker's disk image) |
| A write gets 409 `unknown-base` | Its base version isn't known to the server: it expired (24 h after the last read), it was never read through the server, or the board was deleted | Read the board again (`GET /api/board`, MCP `read_board`, `xcld read`) and resend with that version as base |
| The browser doesn't show the agent's edit | The tab missed the update | Wait a second (the server checks every `XCLD_WATCH_POLL_MS`), then reload the page. The top bar shows `SSE disconnected; retrying...` while reconnecting |
| I deleted a board but it came back | An open tab used to autosave its in-memory copy after the file was removed | The tab now stops autosaving and shows `This board was deleted on disk.` Choose **Restore from this tab** to write the current canvas back, or **Close** to return to the board browser |
| The browser shows an invalid-board banner | The `?board=` path is invalid | Fix the path in the URL or open <http://127.0.0.1:3100/> and choose a board |
| Linux: `permission denied` writing boards | The container user doesn't match yours | Rerun `./build.sh` (it writes `XCLD_UID`/`XCLD_GID` to `.env`), then `docker compose up -d --wait` |
| Ctrl+S opens a download | An older canvas; the current one turns Ctrl+S into a checkpoint ("Saved checkpoint") | Reload the tab. Excalidraw's menu "Save to…" still downloads a copy on purpose |
| `docker exec` says the container isn't running | Workspace stopped | `docker compose up -d --wait` |
| `container xcld-collab is unhealthy` right after changing `.env` | A setting has an invalid value, e.g. `XCLD_AUTO_EXPORT=always` | `docker compose logs canvas` names the bad value. Fix `.env` (`off`, `snapshot` or `save`), then `docker compose up -d --wait` |
| No `boards/.exports/` folder | Only `XCLD_AUTO_EXPORT=save` writes it | Set it in `.env` and restart. See [Saving and exporting](#saving-and-exporting) |
| Diff shows "removed + added" instead of "rewired" | The arrow was deleted and redrawn | Drag the existing arrow's end instead |

Still stuck? `docker compose logs canvas` shows the server log.
