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

### 2. Start

```powershell
docker compose up -d --wait
```

`--wait` returns once the workspace is healthy.

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
docker exec -i xcld-collab xcld mcp                    # optional: MCP tools over stdio
```

That's the whole loop. Your agent runs those same commands.

The image also runs the upstream Excalidraw MCP Apps UI as a second Compose service at
<http://127.0.0.1:3001/mcp> for hosts that render MCP Apps.

### Stop

```powershell
docker compose down
```

Boards stay in `./boards`. Only `boards/examples/` is tracked in git; everything else you
create there is gitignored. Nothing leaves your machine: the canvas is served from
`127.0.0.1` only, and fonts and assets come from the container.

### Environment Settings


| Setting | Default | What it does |
|---|---|---|
| `XCLD_PORT` | `3100` | Port on `127.0.0.1` |
| `XCLD_MCP_PORT` | `3001` | Host port for the Excalidraw MCP Apps UI service at `/mcp` |
| `XCLD_CONTAINER` | `xcld-collab` | Canvas container name. Override when running multiple Compose projects side by side |
| `XCLD_MCP_CONTAINER` | `xcld-mcp` | MCP UI service container name |
| `XCLD_BOARDS` | `./boards` | Boards folder. Relative paths are relative to `compose.yaml`, so use an absolute path for a folder in another repo |
| `XCLD_WATCH_POLL_MS` | `1000` | How often the server checks for file changes |
| `XCLD_MAX_DEPTH` | `0` | Nested board folder limit; `0` means unlimited |
| `XCLD_AUTO_EXPORT` | `snapshot` | When Mermaid is written for you: `off`, `snapshot` (each `xcld snapshot` also writes a `.mmd`) or `save` (also keeps `boards/.exports/<path>.mmd` current). See the [decision tree](docs/reference.md#saving-and-exporting) |
| `XCLD_PUBLIC_URL` | `http://127.0.0.1:${XCLD_PORT}` | URL returned by MCP `board_url`; Compose sets this for the canvas service |

Put these in `.env` next to `compose.yaml`, then run `docker compose up -d --wait` again.

## Where next

- **[User guide](docs/user-guide.md):** the recommended way to draw, give feedback and
  work with agents.
- **[Reference](docs/reference.md):** every `xcld` command, the Mermaid mapping, and
  troubleshooting.
- **[Agent skill](.github/skills/xcld-collab/SKILL.md):** the safe MCP workflow for
  creating, reviewing and revising boards.
- **[Design](docs/DESIGN.md):** how it works and why, for contributors.

## Coming soon

These are designed but **not built yet**. Don't rely on them.

- **Merge on re-import.** Today, when an agent rewrites `boards/<name>.mmd`, the board is
  **replaced**, and your layout and notes on it are lost. The planned version keeps your
  edits and merges the agent's changes by node ID.
- **Versions.** Today, Ctrl+S / Excalidraw's "Save to…" downloads a separate copy and isn't
  how the board saves. Planned: every save becomes a version in `boards/.history/`, tagged
  with who made it (your tab or a named agent), plus `xcld versions` and
  `xcld diff --since`.
- **Design rules.** A local `design-rules.csv` that tells agents what your conventions mean,
  e.g. "red text = change request", tagging each change in the diff.
- **More diagram types:** sequence, class, ER, state.

## Development

```powershell
.\build.ps1 -Target vendor    # upstream packages built from source, into app\vendor
cd app; npm install; npm run dev
node --test tests             # from the repo root
```

## License

MIT, © 2026 Hack4Impact. Bundles Excalidraw, mermaid-to-excalidraw and (later)
excalidraw-mcp, all MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
