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
`notes` (`added`/`removed`/`changed`), `styles`, `moves`.

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
- `to-mermaid` always writes `flowchart TD`, because the board stores positions, not a direction.
- Other arrowheads, such as circle, bar or triangle, are written as the nearest equivalent
  and noted in a `%%` comment.

## Files

| Path | What it is |
|---|---|
| `boards/<path>.excalidraw` | The board. Standard Excalidraw JSON that excalidraw.com can open too |
| `boards/examples/` | Example boards, **tracked in git**. Copy them before editing, e.g. into `boards/sandbox/`. Everything else in `boards/` is gitignored, and board edits never make the image tag `-dirty` |
| `boards/<path>.mmd` | Mermaid inbox. An open tab on `<path>` converts it and **replaces** the board |
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
- `GET /api/view/<path>` returns the raw `boards/<path>.view.json` inbox.
- `GET /api/events` publishes `event: board` with `kind: "board"`, `"mermaid"`, `"view"` or
  `"deleted"`.

## MCP

There are two MCP entry points in the image:

1. **`xcld mcp`** is the primary agent tools server. It speaks MCP over stdio, so clients
   launch it with `docker exec -i xcld-collab xcld mcp`. It adds no port and uses the same
   board volume as the canvas. It is enabled by default.
2. **`excalidraw-mcp`** is the optional MCP Apps chat-widget UI service. Compose serves it
   only when the `widget` profile is enabled, at `http://127.0.0.1:3001/mcp`, for hosts that
   render MCP Apps widgets, such as VS Code and Claude Desktop. Its `export_to_excalidraw`
   upload flow and Excalidraw Plus menu link are patched out at build time.

### `xcld mcp` tools

All board paths are validated with the same rules as `xcld` board paths. Tool errors are
returned as MCP tool errors (`isError: true`) with the CLI's friendly messages.

Every tool description repeats the working conventions: snapshot before human review, diff
after, never rewrite a board's `.mmd` before diffing and acting on feedback because that
re-import replaces the board, use light blue for proposed parts
(`classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2`), and use flowcharts only
(subgraphs are fine).

| Tool | Inputs | Output |
|---|---|---|
| `list_boards` | optional `folder` | Same JSON shape as `xcld list --json`: `{ boards, folders }` |
| `read_board` | `board`, optional `format` = `mermaid` (default), `json` or `both` | Mermaid text, Excalidraw JSON, or both |
| `write_mermaid` | `board`, `mermaid` | Writes `boards/<path>.mmd`, creates folders, and returns the file path, browser URL and replacement reminder |
| `snapshot` | `board` | Same as `xcld snapshot`: snapshot path and, unless `XCLD_AUTO_EXPORT=off`, Mermaid twin path |
| `diff` | either `board`, or `from` + `to`; optional `format` = `text` (default) or `json` | Same semantic diff as `xcld diff` |
| `board_url` | `board` | `XCLD_PUBLIC_URL/?board=<path>`, defaulting to `http://127.0.0.1:3100/?board=<path>` |
| `open_in_canvas` | `checkpointId`, required `board`, optional `overwrite` = `false` | Writes `boards/<path>.view.json` from an Excalidraw MCP checkpoint and returns the canvas URL |

Host development:

```powershell
cd app
npm install
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

**VS Code** — documentation format verified from VS Code docs; `code` was installed, but
the widget was not rendered in a real chat session on this machine.

`.vscode/mcp.json`:

```json
{
  "servers": {
    "xcld": {
      "type": "stdio",
      "command": "docker",
      "args": ["exec", "-i", "xcld-collab", "xcld", "mcp"]
    },
    "xcld-excalidraw-ui": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp"
    }
  }
}
```

### Excalidraw MCP Apps UI service

The chat widget starts by default: it's the second service, named `mcp`, from the same image,
under the `widget` Compose profile, which the build seeds as `COMPOSE_PROFILES=widget` in `.env`.
When it renders, the widget loads React/Excalidraw from esm.sh (#9). For canvas only, with no
outside requests, set `COMPOSE_PROFILES=` (empty) in `.env` and run `docker compose up -d --wait`. The primary `xcld mcp` stdio tools still run through `docker exec -i
xcld-collab xcld mcp` in the canvas container.

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
