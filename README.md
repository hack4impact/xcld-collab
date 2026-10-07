# xcld-collab

A shared whiteboard for you and your coding agents. Agents draw (usually as Mermaid),
you mark up the drawing in a real canvas ([Excalidraw](https://excalidraw.com)), and the
agent reads your changes back as a precise list: "relabeled X", "rewired A → B",
"added note near Y". No more describing diagram feedback in prose.

Everything runs locally in one Docker container. Boards are plain files in `./boards`, so
any agent that can read and write files can join in.

> Status: prototype. Flowcharts only. See [Coming soon](#coming-soon).

## Getting started

### You need

- **Docker**: Docker Desktop (Windows/macOS) or Docker Engine with the Compose plugin
  (Linux). Check it with `docker compose version`.
- **git**.
- **Windows:** PowerShell (5.1 or 7). **macOS/Linux:** bash and `jq`.

### 1. Build

```powershell
git clone https://github.com/Hack4Impact/xcld-collab
cd xcld-collab
.\build.ps1          # macOS/Linux: ./build.sh
```

The first build compiles Excalidraw from source, so go get a coffee. Rebuilds reuse the cache.
The build ends with `.env updated (XCLD_TAG=...)`; that's how Compose knows which image to run.

Builds install the app from the committed `app/package-lock.json` (`npm ci`), which is the
reproducible default. If your environment can only use a private npm registry and the locked
build fails there, `.\build.ps1 -NoLockfile` (`./build.sh --no-lockfile`, or
`XCLD_NO_LOCKFILE=1`) resolves `package.json` ranges instead; its tag ends in `-nolock`.

#### Or: use the prebuilt image

> Available after the public release. Until then the image is private and
> `docker compose pull` fails with `denied`; build from source as above.

Every push to `main` that changes the image publishes a multi-arch image (linux/amd64 and
linux/arm64) to `ghcr.io/hack4impact/xcld-collab`, so you can skip the build. You still need
the clone (for `compose.yaml` and `boards/`). Create `.env` next to `compose.yaml`:

```dotenv
XCLD_IMAGE=ghcr.io/hack4impact/xcld-collab
XCLD_TAG=latest
COMPOSE_PROFILES=widget
# Linux only, so boards stay writable: your `id -u` / `id -g`
# XCLD_UID=1000
# XCLD_GID=1000
# Linux only: run `mkdir -p ~/.excalidraw/history ~/.excalidraw/exports` first (Docker would
# create them owned by root), and keep version history there instead of in the xcld-state volume:
# XCLD_HISTORY=cache
```

```powershell
docker compose pull
```

Then continue with step 2. `latest` follows `main`; set `XCLD_TAG` to a full
`<ours7>-<exc7>-<m2e7>-<mcp7>` tag to stay on one build. Running `build.ps1` / `build.sh`
later points `.env` back at your local build.

### 2. Start

```powershell
docker compose up -d --wait
```

`--wait` returns once the workspace is healthy. This starts the canvas only, with no outside
requests. The chat widget is [experimental and opt-in](#chat-widget-experimental).

### 3. Draw something

Open the board browser at <http://127.0.0.1:3100/>. `examples/demo` is a ready-made drawing
you can look around in.

To see the full loop, make your own copy of its Mermaid source and open that. Examples are
checked into git, so work on copies:

```powershell
New-Item -ItemType Directory -Force boards\sandbox | Out-Null
Copy-Item boards\examples\demo.mmd boards\sandbox\demo.mmd
# macOS/Linux: mkdir -p boards/sandbox && cp boards/examples/demo.mmd boards/sandbox/
```

Open <http://127.0.0.1:3100/?board=sandbox/demo>. Your browser turns the Mermaid into an
editable drawing and saves it as `boards/sandbox/demo.excalidraw`. Move things, relabel,
recolor, add notes. Every change saves automatically.

### 4. Ask what changed

```powershell
docker exec xcld-collab xcld snapshot sandbox/demo     # remember this version
# ...edit the drawing in the browser...
docker exec xcld-collab xcld diff sandbox/demo         # what changed since the snapshot
docker exec xcld-collab xcld to-mermaid sandbox/demo   # the drawing as Mermaid again
docker exec xcld-collab xcld open-in-canvas <checkpointId> sandbox/from-chat
docker exec -i xcld-collab xcld mcp                    # optional: MCP tools over stdio
```

Opening this repo in VS Code offers the `xcld` tools server from `.vscode/mcp.json`. For
Copilot CLI, Claude Code, Codex and OpenCode, see the
[client configs in the reference](docs/reference.md).

That's the whole default loop. Your agent runs those same commands; `xcld mcp` is the stdio
tools server inside the canvas container and does not need the chat widget.

### Chat widget (experimental)

The image also contains the upstream Excalidraw MCP Apps chat widget, which draws diagrams
inside chat in hosts that render MCP Apps, such as VS Code. It is **experimental and off by
default**:

- **It sends requests outside your machine.** When it renders, the widget loads React,
  React DOM, Excalidraw 0.18.0 and morphdom, plus Excalidraw's CSS and some fonts, from
  `https://esm.sh`. Attempts to serve that JavaScript locally rendered a blank diagram in VS
  Code ([#9](../../issues/9)).
- **Known font errors.** The VS Code webview console can show font Content-Security-Policy
  errors; affected UI text falls back to a system font
  ([#7](../../issues/7)).

To opt in:

1. Add `COMPOSE_PROFILES=widget` to `.env` and run `docker compose up -d --wait`. This
   starts a second service, `mcp`, at <http://127.0.0.1:3001/mcp>.
2. Add the widget server to `.vscode/mcp.json` (or your user `mcp.json`) next to `xcld`:
   `"excalidraw": { "type": "http", "url": "http://127.0.0.1:3001/mcp" }`.

If a host cannot open the widget editor, the widget shows its checkpoint id; use
`open-in-canvas` (or MCP `open_in_canvas`) with an explicit board path to move the drawing
into the persistent canvas.

To opt out again, remove `widget` from `COMPOSE_PROFILES` in `.env`, then run
`docker compose --profile widget down` followed by `docker compose up -d --wait`.

### Stop

```powershell
docker compose down
```

Boards stay in `./boards`, and version history stays where it lives
([see below](#where-history-lives)); `docker compose down -v` also deletes the `xcld-state`
volume, which holds the history on Windows and macOS. Only `boards/examples/` is tracked in
git; everything else you create there is gitignored. Nothing leaves your machine: the canvas is served from
`127.0.0.1` only, and fonts and assets come from the container. The one exception is the
[experimental chat widget](#chat-widget-experimental), which is off unless you opt in.

### Environment Settings


| Setting | Default | What it does |
|---|---|---|
| `XCLD_PORT` | `3100` | Port on `127.0.0.1` |
| `XCLD_MCP_PORT` | `3001` | Host port for the experimental chat widget service at `/mcp` (only with `COMPOSE_PROFILES=widget`) |
| `XCLD_CONTAINER` | `xcld-collab` | Canvas container name. Override when running multiple Compose projects side by side |
| `XCLD_MCP_CONTAINER` | `xcld-mcp` | Chat widget service container name |
| `XCLD_BOARDS` | `./boards` | Boards folder. Relative paths are relative to `compose.yaml`, so use an absolute path for a folder in another repo |
| `XCLD_WATCH_POLL_MS` | `1000` | How often the server checks for file changes |
| `XCLD_MAX_DEPTH` | `0` | Nested board folder limit; `0` means unlimited |
| `XCLD_AUTO_EXPORT` | `snapshot` | When Mermaid is written for you: `off`, `snapshot` (each `xcld snapshot` also writes a `.mmd`) or `save` (also keeps `boards/.exports/<path>.mmd` current). See the [decision tree](docs/reference.md#saving-and-exporting) |
| `XCLD_DESIGN_RULES` | `<boards>/design-rules.csv` | Optional path to the default design rules CSV (inside Docker, use `/boards/...`). A folder's own `design-rules.csv` still replaces the inherited defaults for boards below it |
| `XCLD_PUBLIC_URL` | `http://127.0.0.1:${XCLD_PORT}` | URL returned by MCP `board_url`; Compose sets this for the canvas service |
| `XCLD_AUTHOR_NAME` | your `git config user.name`, else your OS user | The canvas's default author name in version history. The build writes it into `.env` once and never overwrites it; edit it there |
| `XCLD_TIMING` | unset | `1` records per-stage commit timings at `GET /api/timings` (for profiling, see `tests/versions-load.mjs`) |
| `XCLD_CACHE_DIR` | `~/.excalidraw` | A folder on your machine. `xcld history export` writes to `exports/` in it; on Linux it also holds version history (`history/`). Must be a path; on Linux, writable by you. See [where history lives](#where-history-lives) |
| `XCLD_HISTORY` | Linux: `cache`; Windows/macOS: `volume` | **Advanced.** Where version history lives: `volume` (the Docker volume `xcld-state`) or `cache` (`XCLD_CACHE_DIR/history/`). The build writes the default for your OS once and never overwrites it. `cache` on Windows/macOS is slow |
| `COMPOSE_PROFILES` | unset (canvas only, no outside requests) | `widget` also starts the [experimental chat widget](#chat-widget-experimental), which loads JavaScript from esm.sh. The build never writes or changes this line; builds before the widget became opt-in added `COMPOSE_PROFILES=widget`, and the build prints a notice while it is there |

Put these in `.env` next to `compose.yaml`, then run `docker compose up -d --wait` again.

## Where next

- **[User guide](docs/user-guide.md):** the recommended way to draw, give feedback and
  work with agents.
- **[Reference](docs/reference.md):** every `xcld` command, the Mermaid mapping, and
  troubleshooting.
- **[Agent skill](.github/skills/xcld-collab/SKILL.md):** the safe MCP workflow for
  creating, reviewing and revising boards.
- **[Design](docs/DESIGN.md):** how it works and why, for contributors.

## Working in parallel

The server merges writes instead of letting the last one win. The tab's saves, agents'
`write_board` and `write_mermaid` (MCP), `xcld write` and `xcld write-mermaid` (CLI), and
direct edits of a board or `.mmd` file all go through one commit pipeline:

- Every write names the version it started from (`base`). The server merges it with
  anything committed since. A shape and its label edited on both sides go to the later
  write, and the other side's version is kept in history and reported as overwritten.
- Every change is kept: version history keeps one entry per author turn (a person's autosaves
  fold into one restore point until someone else writes, 3 minutes pass or a checkpoint). Each
  entry stores only what changed, with a full copy every 20 entries: 100 small turns on a
  1,500-element board take about 1 MB. See [where history lives](#where-history-lives).
- A slow merge never drops a write: after 5 s an agent gets `queued`, and the write lands
  later.
- **Mermaid merges too, with no tab open.** The server applies an agent's Mermaid to the
  board: your layout, notes and colors stay, existing shapes keep their place, new nodes go
  next to a connected one, and only shapes that came from Mermaid are ever removed (a copy you
  made of one never is). Several agents can write Mermaid to the same board at once. Only a
  brand-new diagram still needs an open tab to lay it out the first time.

Still coming for the tab (versions and merge, slice 5): your name and tab in the corner, a
banner listing what was merged or overwritten, and saving before accepting a reload. Until
then the tab saves as one shared author and applies a merged board without a banner.

### Where history lives

One folder on your machine, `XCLD_CACHE_DIR` (default `~/.excalidraw`), holds what you can
open: exports, and on Linux the history itself.

| Host | Version history | `xcld history export` writes to |
|---|---|---|
| **Linux** | `~/.excalidraw/history/` | `~/.excalidraw/exports/<board>/` |
| **Windows, macOS** (Docker Desktop) | the Docker volume `xcld-state` | `~/.excalidraw/exports/<board>/` |

- **Windows and macOS:** history stays in a Docker volume because Docker Desktop folder mounts
  are too slow for the write path. **`docker compose down -v` deletes the volume and all
  version history.** `docker compose down` keeps it.
- **Linux:** the build creates the folders as you and sets `XCLD_UID`/`XCLD_GID`, so the
  container can write them.
- **Move the folder** with `XCLD_CACHE_DIR=<path>` in `.env`. **Advanced:** `XCLD_HISTORY`
  picks where history lives, `volume` or `cache` (the folder). The build writes the default
  for your OS once and never overwrites a value you set.
- **Copy a board's history out** of either place to `~/.excalidraw/exports/<board>/`:

  ```powershell
  docker exec xcld-collab xcld history export myproject/demo          # as stored: checkpoints + deltas
  docker exec xcld-collab xcld history export myproject/demo --full   # every version as an .excalidraw file
  ```

  See [the reference](docs/reference.md#xcld-history-export-board---to-dir---full---json).
- **An older `.env`** with `XCLD_STATE_DIR` or `XCLD_EXPORT_DIR` (from development builds)
  still works: the build prints a notice and adds the matching `XCLD_HISTORY` /
  `XCLD_CACHE_DIR`. It doesn't delete your lines.

## Coming soon

These are designed but **not built yet**. Don't rely on them.

- **Version browsing.** History is recorded and `xcld history export` copies it out (see
  above); `xcld diff --since` and snapshots as pinned versions come next. Ctrl+S /
  Excalidraw's "Save to…" still downloads a separate copy.
- **More diagram types:** sequence, class, ER, state.

## Development

```powershell
.\build.ps1 -Target vendor    # upstream packages built from source, into app\vendor
cd app; npm ci; npm run dev   # npm ci installs exactly app/package-lock.json
node --test tests             # from the repo root
```

`app/package-lock.json` is committed with public npm URLs only. If you change dependencies
(or `pins.json`, which changes the vendor tarballs), rebuild `app\vendor`, then run
`npm install` and `npm run lockfile:public` in `app/` and commit the lockfile.
npm writes your registry's URLs into the lockfile, so after **any** `npm install <pkg>`
through a private registry, run `npm run lockfile:public` before committing.
`npm run lockfile:public -- --check` exits non-zero if any URL isn't public npm, and
`tests/lockfile.test.mjs` runs the same check. `npm ci` rejects stale vendor tarballs.
Installing through a mirror is fine: npm fetches the same tarballs from your configured
registry.

Optional: `scripts/install-hooks.sh` (Windows: `scripts\install-hooks.ps1`) adds a gitleaks
pre-commit hook with the same `.gitleaks.toml` rules CI enforces on `main`; it also rejects a staged
`app/package-lock.json` that names a non-public registry. CI runs only
after merge to `main` (see `.github/workflows/`).

## License

MIT, © 2026 Hack4Impact. Bundles Excalidraw, mermaid-to-excalidraw and (later)
excalidraw-mcp, all MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
