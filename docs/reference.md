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
  file on disk (picked up within `XCLD_WATCH_POLL_MS`).
- **The inbox is never written.** No mode writes `boards/<path>.mmd`, because writing it
  would replace the board. Exports live in dot-folders, which the board browser and
  `xcld list` ignore.
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
rule with `means=on` snapshots an existing board before MCP `write_mermaid` writes a new inbox
Mermaid file; browser saves and CLI writes are not agent writes for this rule.

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
| `boards/<path>.mmd` | Mermaid inbox. An open tab on `<path>` converts it and **replaces** the board. The converted elements record a hash of this Mermaid (`customData.xcldMermaidHash`), so `xcld list` and the board browser show `mermaid pending` / "Mermaid waiting to convert" exactly when the `.mmd` content differs from what the board was converted from, or the board is missing or empty. That survives a fresh clone or checkout; boards converted before the hash existed fall back to "the `.mmd` is newer than the board" |
| `boards/<path>.view.json` | View inbox from `open_in_canvas`. An open tab on `<path>` converts it into the board; `xcld list` shows `view pending` until a non-empty board save is newer |
| `boards/.snapshots/<folder>/<leaf>.<timestamp>.excalidraw` | Snapshots from `xcld snapshot`; flat boards still use `boards/.snapshots/<name>.<timestamp>.excalidraw` |
| `boards/.snapshots/<folder>/<leaf>.<timestamp>.mmd` | The snapshot's Mermaid twin. Written unless `XCLD_AUTO_EXPORT=off` |
| `boards/.exports/<path>.mmd` | Always-current Mermaid of each board. Only with `XCLD_AUTO_EXPORT=save` |
| `.env` | Written by the build (`XCLD_IMAGE`, `XCLD_TAG`; `XCLD_UID`/`XCLD_GID` on Linux). Your settings go here too |

**Board paths:** one or more segments joined by `/`. Each segment uses letters, digits, `.`,
`_` and `-`, starts with a letter or digit, and is at most 100 characters. Empty segments,
leading/trailing `/`, backslashes, `.hidden`, `..` and total paths over 512 characters are
rejected. `XCLD_MAX_DEPTH=0` (the default) allows unlimited folders; otherwise it limits folder
levels.

## API

- `GET /api/boards` returns `{ boards, folders }` with board paths, folder/leaf names, board,
  Mermaid and view-inbox presence, pending states and last modified time.
- `GET /api/board/<path>` returns the board JSON with `ETag: "<sha256 of the file on disk>"`,
  or 404 `{"error":"board-not-found"}`.
- `PUT /api/board/<path>` (`Content-Type: application/json`) writes the board and returns
  `{ ok: true, hash }` plus the new `ETag`. Saves based on an old board are rejected:

  | Header | Saves when | Otherwise |
  |---|---|---|
  | `If-Match: "<hash>"` | the file on disk still hashes to `<hash>` | 409 |
  | `If-None-Match: *` | the board doesn't exist yet | 409 |
  | neither | always: **unguarded**, the last write wins (kept for scripts) | — |

  The server hashes the file on disk at save time, so direct file writes by agents count, not
  just API saves. A 409 body is `{"error":"stale-save","currentHash":"<sha256>"}`
  (`currentHash` is `null` when the board is gone). Weak `W/` tags never match; a bare hash
  without quotes is accepted. The canvas always sends one of the two headers; on 409 it
  re-applies your unsaved edits to the newer board and saves again (see
  [Design](DESIGN.md)).

  ```text
  > curl -si http://127.0.0.1:3100/api/board/sandbox/guard
  HTTP/1.1 200 OK
  ETag: "b6747c4c3549441bcc2c69173d47b35af6f24d8e745a97c6b470552ffb9dd342"
  > # an agent rewrites boards/sandbox/guard.excalidraw, then:
  > curl -si -X PUT -H "Content-Type: application/json" -H 'If-Match: "b6747c4c…"' --data-binary @board.json http://127.0.0.1:3100/api/board/sandbox/guard
  HTTP/1.1 409 Conflict
  ETag: "fe99bb1e46997e8d9a4afbaaebc7fc9c9f6c3a2f26c639ab721cc3e2314b50fd"
  {"error":"stale-save","currentHash":"fe99bb1e46997e8d9a4afbaaebc7fc9c9f6c3a2f26c639ab721cc3e2314b50fd"}
  ```

- `GET /api/view/<path>` returns the raw `boards/<path>.view.json` inbox.
- `GET /api/events` publishes `event: board` with `kind: "board"`, `"mermaid"`, `"view"` or
  `"deleted"`.

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
after, never rewrite a board's `.mmd` before diffing and acting on feedback because that
re-import replaces the board, read the board's design-rules briefing, use light blue for
proposed parts (`classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2`), use
flowcharts only (subgraphs are fine), and break labels with a real newline inside the quoted
label, never `<br/>`.

| Tool | Inputs | Output |
|---|---|---|
| `list_boards` | optional `folder` | Same JSON shape as `xcld list --json`: `{ boards, folders }` |
| `read_board` | `board`, optional `format` = `mermaid` (default), `json` or `both` | Mermaid text, Excalidraw JSON, or both, plus the effective design-rules briefing |
| `write_mermaid` | `board`, `mermaid` | Writes `boards/<path>.mmd`, creates folders, returns the file path, browser URL, replacement reminder and design-rules briefing; snapshots first when `snapshot,on-agent-write` is on |
| `snapshot` | `board` | Same as `xcld snapshot`: snapshot path and, unless `XCLD_AUTO_EXPORT=off`, Mermaid twin path |
| `diff` | either `board`, or `from` + `to`; optional `format` = `text` (default) or `json` | Same semantic diff as `xcld diff`, including tags/legend/warnings |
| `check_board` | `board` | Same open-item result and `<br>` label warnings as `xcld check` |
| `board_url` | `board` | `XCLD_PUBLIC_URL/?board=<path>`, defaulting to `http://127.0.0.1:3100/?board=<path>` |
| `open_in_canvas` | `checkpointId`, required `board`, optional `overwrite` = `false` | Writes `boards/<path>.view.json` from an Excalidraw MCP checkpoint and returns the canvas URL |

Host development:

```powershell
cd app
npm ci
npm run build      # creates gitignored tools/mcp.bundle.mjs
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
| `required variable XCLD_TAG is missing a value` | No build yet, or `.env` deleted | Run `.\build.ps1` / `./build.sh`, then `docker compose up -d --wait` |
| `Bind for 127.0.0.1:3100 failed: port is already allocated` | Something else is using 3100 | Put `XCLD_PORT=3200` in `.env`, run `docker compose up -d --wait`, then use `http://127.0.0.1:3200` |
| `No snapshots found for <board>` | `diff <board>` needs a "before" picture | `xcld snapshot <board>`, edit, then `diff` |
| `Board not found: <board>` | The board file doesn't exist yet | Open `http://127.0.0.1:3100/?board=<board>` (it converts `<board>.mmd` if present), or check the path |
| The board opens but the canvas is empty | The URL was opened before an inbox was written | Call MCP `write_mermaid`, `open_in_canvas`, or write an inbox while the tab stays open. The browser replaces the blank canvas; reload once if it misses the update |
| The agent wrote `<board>.mmd` but nothing appeared | Conversion runs in the browser | Open (or keep open) a tab on `?board=<board>` |
| Widget **Edit** does nothing in VS Code | The host refused the widget's fullscreen editor | Ask your assistant to call `open_in_canvas` with the checkpoint id shown in the widget hint and an explicit board path, then open the returned canvas URL |
| The diagram came in as a picture you can't edit, and the top bar says "came in as a picture" | The converter couldn't parse it into shapes; the exact error is in the browser console (F12) | Simplify unsupported Mermaid syntax or have the agent rewrite the `.mmd` as a flowchart using supported shapes |
| My notes disappeared | The `.mmd` was rewritten, which replaces the board | Restore from `boards/.snapshots/` (copy the latest over `boards/<board>.excalidraw`). See the warning in the [user guide](user-guide.md#the-loop) |
| The top bar says "Board changed elsewhere; your edits were re-applied" | An agent or another tab saved the board while you had unsaved edits | Nothing to do: your edits were merged onto the newer board and saved. Check the shapes you both touched |
| "Save failed: the board kept changing elsewhere (3 retries)" | Something rewrites the board faster than the tab can merge | Stop the other writer, then make any edit to retry; your edits are still in the tab |
| A script's `PUT /api/board/...` gets 409 `stale-save` | Its `If-Match` hash is not the file on disk any more | `GET` the board again and resend with the new `ETag`, or drop `If-Match` for an unguarded write |
| The browser doesn't show the agent's edit | The tab missed the update | Wait a second (the server checks every `XCLD_WATCH_POLL_MS`), then reload the page. The top bar shows `SSE disconnected; retrying...` while reconnecting |
| I deleted a board but it came back | An open tab used to autosave its in-memory copy after the file was removed | The tab now stops autosaving and shows `This board was deleted on disk.` Choose **Restore from this tab** to write the current canvas back, or **Close** to return to the board browser |
| The browser shows an invalid-board banner | The `?board=` path is invalid | Fix the path in the URL or open <http://127.0.0.1:3100/> and choose a board |
| Linux: `permission denied` writing boards | The container user doesn't match yours | Rerun `./build.sh` (it writes `XCLD_UID`/`XCLD_GID` to `.env`), then `docker compose up -d --wait` |
| Ctrl+S downloads a file | Excalidraw's own "Save to…" | Ignore it. The board saves itself (see the top bar) |
| `docker exec` says the container isn't running | Workspace stopped | `docker compose up -d --wait` |
| `container xcld-collab is unhealthy` right after changing `.env` | A setting has an invalid value, e.g. `XCLD_AUTO_EXPORT=always` | `docker compose logs canvas` names the bad value. Fix `.env` (`off`, `snapshot` or `save`), then `docker compose up -d --wait` |
| No `boards/.exports/` folder | Only `XCLD_AUTO_EXPORT=save` writes it | Set it in `.env` and restart. See [Saving and exporting](#saving-and-exporting) |
| Diff shows "removed + added" instead of "rewired" | The arrow was deleted and redrawn | Drag the existing arrow's end instead |

Still stuck? `docker compose logs canvas` shows the server log.
