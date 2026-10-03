# xcld-collab — shared diagram workspace design (v0.3, 2026-10-02)

## Problem

Mermaid diagrams are easy for agents to generate but hard for humans to annotate.
Feedback ends up as prose ("move the cache before the API"), so neither humans nor
other agents can read it reliably. We want a shared canvas where humans and agents
edit the same diagram, and every change can be read back as a precise, semantic diff.

## Goals (v1)

- One container that teams and students run locally, the same on Windows, macOS and Linux.
- Mermaid flowchart → Excalidraw → human/agent edits → semantic diff → Mermaid flowchart.
- Works from Copilot CLI (terminal), VS Code, and a plain browser.
- No runtime egress for the canvas and `xcld` tools. Nothing is uploaded to excalidraw.com.
  **Exception:** the optional `excalidraw-mcp` widget still loads React/Excalidraw from
  `esm.sh`; resolving that is the part 3c network spike.

**Out of scope for v1:** sequence, class, ER and state diagrams (next), multi-user
collaboration, and hosted deployment.

## Architecture

```
host                                     container (127.0.0.1 only)
─────────────────────────────            ───────────────────────────────────────
default browser ── http :3100 ─────────▶ canvas app (Excalidraw @ pinned SHA,
  (renders, converts Mermaid,              self-hosted assets) + board API + SSE
   human annotates)                      xcld MCP tools over stdio
Copilot/Claude/Codex/OpenCode ─────────▶   (docker exec -i ... xcld mcp)
VS Code / MCP Apps hosts ── http :3001 ▶ excalidraw-mcp @ pinned SHA
agent shell ── reads/writes files ─┐       (export-to-excalidraw.com patched out)
                                   └──── ./boards  (bind mount, source of truth)
```

- **Boards are files.** `boards/<path>.excalidraw` is the source of truth,
  `boards/<path>.mmd` is the Mermaid inbox, and `boards/<path>.view.json` is the
  Excalidraw MCP checkpoint/view inbox. Any agent can take part by reading and writing
  files, with or without MCP.
- **Mermaid conversion happens in the host's default browser** through the mapped port.
  Mermaid needs a DOM, and this avoids putting headless Chromium in the image. When it
  needs a conversion or review, the agent opens the board with
  `Start-Process http://127.0.0.1:3100/?board=<path>`. Opening the tab is the handoff.
  Limitation: no conversion happens without an open tab.
- **Live sync.** The browser saves debounced edits through `PUT /api/board/:name`. A file
  watcher pushes on-disk (agent) changes to the browser over SSE. The last write wins.
  Each side ignores its own echoes by content hash.
  - **verified (2026-10-02):** `fs.watch` (inotify) gets **no events for host-side writes**
    through a Docker Desktop bind mount from Windows. Writes made inside the container do
    fire.
  - So the server also polls the mtime and size of each board file every
    `XCLD_WATCH_POLL_MS` ms (default 1000; 0 disables).
  - Both sources share one signature map, so each change is published once. Both behaviors
    are covered by `tests/api.test.mjs`, and the host-edit SSE event was verified end to end.
  - **Lead decision (2026-10-02):** if a known `.excalidraw` file disappears, the server
    waits 300 ms and re-checks before publishing one SSE `board` event with `kind:
    "deleted"`. That debounce lets editor-style delete+recreate writes settle. The open
    tab stops autosaving and shows a restore-or-close banner instead of recreating the file
    automatically; a later real recreate publishes the normal `kind: "board"` event.
  - **Lead decision (2026-10-02):** an empty board loaded from a first-time URL is not
    persisted until the user makes a real element edit. If an existing board has no live
    elements and a newer `.mmd` or `.view.json` inbox exists, the browser converts the inbox
    instead of treating the empty board as final.
  - `.view.json` files are indexed as the board name (for example `x.view.json` appears as
    `x`), publish SSE `kind: "view"`, and stay `viewPending` until a non-empty
    `.excalidraw` save is newer.
  - Board paths can now be nested, e.g. `boards/myproject/demo.excalidraw` and
    `?board=myproject/demo`. The poller walks recursively, skips dot-folders such as
    `.snapshots`, skips `node_modules`, and never follows symlinks. Folder depth is unlimited
    by default (`XCLD_MAX_DEPTH=0`) because the scan cost scales with file count, not the
    spelling depth of each file path; set `XCLD_MAX_DEPTH` to cap folder levels in very large
    workspaces.

## Image identity and build

- `build.ps1` / `build.sh` either read `pins.json` (`--pinned`, the default) or resolve
  branch HEADs with `git ls-remote` (`--latest`). They pass full SHAs in as build args.
  - The Dockerfile's `fetch-at-sha` fetches **exactly** that commit and fails if HEAD
    differs. The Dockerfile never clones "latest" itself, because the layer cache would
    silently serve stale commits.
- **Tag:** `<ours7>-<exc7>-<m2e7>-<mcp7>[-dirty]`, with fixed slots.
  - A component marked disabled in `pins.json` isn't built, and its slot is `0000000`. So
    phase B images are `<ours7>-<exc7>-<m2e7>-0000000`, and every tag has the same shape.
  - Identical inputs produce an identical tag.
  - The base image is pinned by digest in `pins.json`.
  - Full SHAs are stored as OCI labels and in `/opt/xcld-collab/manifest.json`.
  - Uncommitted changes in our repo add `-dirty` to the tag.
- **Multi-stage build** (`Dockerfile`):
  - `builder-base`: git plus yarn 1.22.22, installed with npm through the registry.
    Corepack's yarn download returned 404 through the internal proxy (measured on the first
    build), so corepack isn't used.
  - `excalidraw`: `yarn build:packages`, with each package packed to `/out/<pkg>.tgz`.
  - `mermaid-to-excalidraw`: fetched at the pinned SHA, then every
    `patches/mermaid-to-excalidraw/*.patch` is checked with `git apply --check` and applied
    before install/build. The build fails if any patch is stale.
  - `vendor`: the tarballs only. `build -Target vendor` exports them to `app/vendor/` for
    local app development.
  - `app`: our canvas, built against the vendor tarballs. npm `overrides` force
    Excalidraw's own `@excalidraw/*` and `mermaid-to-excalidraw` dependencies to the
    source builds.
  - `excalidraw-mcp`: fetches the pinned MCP Apps server, installs `pnpm@10.11.0` with npm
    through `with-registry`, applies versioned patches with `git apply --check`, installs
    with `pnpm install --frozen-lockfile`, and runs the upstream build.
  - `runtime`: Node 22 slim with built artifacts only: the bundled SPA, the server, the
    bundled `xcld mcp` stdio server, the tools, and the built `excalidraw-mcp` dist. No
    `node_modules` ship in it. It runs as non-root, has no git and no registry config,
    includes a healthcheck, and puts the `xcld` CLI on the PATH.
  - **Measured:** dropping the unused `node_modules` (265 MB, mostly `mermaid` and
    `@excalidraw`, already bundled into the 23 MB `dist`) cut the image from 719 MB.
- **Registry**, first match wins: `-Registry`, then `$XCLD_NPM_REGISTRY`, then the user's
  global `npm config get registry` (when it isn't public npm), then public npm.
  - So internal machines use the proxy automatically, and students get public npm.
  - The URL is a build arg seen only by builder stages; it never reaches the runtime image
    or the repo.
  - Credentials, if ever needed, go through BuildKit `--secret id=npmrc`.
  - **verified:** both upstream `yarn.lock` files hard-code `registry.yarnpkg.com`
    (2,266 entries in excalidraw). `with-registry --rewrite yarn.lock` rewrites them inside
    the builder stage when a registry is set. The internal proxy serves standard
    `<pkg>/-/<file>.tgz` paths, including scoped packages, without credentials.
- **Determinism (accepted by the lead, 2026-10-02): semi-deterministic by design.**
  - Deterministic:
    - The upstream build stages, which use each project's frozen `yarn.lock` at the pinned SHA.
    - The vendor tarballs.
    - The base image, pinned by digest.
  - Semi-deterministic: the app stage. Its third-party dependencies (Excalidraw's runtime
    deps, React, Vite) are resolved at build time within the semver ranges declared at
    those SHAs. They therefore map *semi-deterministically* to the tag and stay configurable.
  - What a tag guarantees is "same source", not "same bytes". Two builds with the same tag
    made weeks apart can differ in `node_modules`, within those ranges.
  - The resolved tree is recorded in `/opt/xcld-collab/resolved-deps.json`, so drift can be
    diffed after the fact.
  - If a class ever needs byte-identical images, commit a lockfile per `pins.json` set.
- **Linux bind mounts:** the container runs as `node` (uid 1000). The build scripts print a
  `docker run -u $(id -u):$(id -g)` command so boards stay writable. Docker Desktop on
  Windows/macOS doesn't need this.

## Phasing

- **Running:** `compose.yaml` (lead decision, 2026-10-02) replaced the per-OS start
  scripts. The build scripts compute the tag and write `XCLD_IMAGE`/`XCLD_TAG` to a
  gitignored `.env`, plus `XCLD_UID`/`XCLD_GID` on Linux. `docker compose up -d --wait`
  reads them. The `excalidraw-mcp` MCP Apps chat widget is under the `widget` profile. The build
  scripts seed `COMPOSE_PROFILES=widget` in `.env` once, so the widget starts **by default**
  (lead decision, 2026-10-03). An existing value is never overwritten; `COMPOSE_PROFILES=`
  (empty) runs the canvas only, with zero runtime egress.
  `container_name` is overridable (`XCLD_CONTAINER`, `XCLD_MCP_CONTAINER`) so parallel smoke
  projects do not collide with the default `xcld-collab` container.
- **User docs:** `README.md` (getting started, coming soon), `docs/user-guide.md`
  (conventions, loop, prompts) and `docs/reference.md` (CLI, mapping, troubleshooting).
  Their example output is captured from real runs.
- **Example boards (lead, 2026-10-02):** `boards/examples/` is tracked; the rest of
  `boards/` is gitignored, and `.gitkeep` was removed. The quickstart copies
  `examples/demo.mmd` to `boards/sandbox/`, so learners never edit tracked files.
  - The build scripts' dirty check excludes `boards/` (`git status -- . ':(exclude)boards'`).
    Boards never enter the image, so editing an example must not mark the tag `-dirty`.
- **Public repo:** `Hack4Impact/xcld-collab` (lead, 2026-10-02; was `jfathi/xcld-collab`).
- **Auto-export (lead, 2026-10-02):** `XCLD_AUTO_EXPORT=off|snapshot|save`, default
  `snapshot` (`tools/export.mjs`).
  - `snapshot`: each `xcld snapshot` also writes `<leaf>.<time>.mmd`.
  - `save`: also keeps `boards/.exports/<path>.mmd` current on every PUT and every on-disk
    board change.
  - **Measured cost:** 0.05 ms per export for 41 elements, 2.2 ms for 1,499.
  - **Hard rule:** never write `boards/<path>.mmd`, the inbox. Exports stay in dot-folders,
    which the walker skips.
  - **Note:** library modules imported by the server (`to-mermaid`, `diff`, `snapshot`) must
    not start with a `#!` line. Vite bundles its config with esbuild, which rejects a shebang
    that isn't at the start of the bundle (found in the first build with auto-export).

- **Phase B (built):** canvas + board API + `xcld` tools (`diff`, `to-mermaid`, `snapshot`,
  list) and auto-export.
- **Part 3a (built):** `xcld mcp`, the primary tools server for Copilot CLI, Claude Code,
  Codex and OpenCode. It is bundled at build time with esbuild and runs over stdio, usually
  as `docker exec -i xcld-collab xcld mcp`.
- **Part 3b (built, on by default):** `excalidraw-mcp` at its pinned SHA as a second HTTP
  service for MCP Apps hosts. It is profile-gated (`widget`), and the build seeds that profile,
  so it runs by default (lead, 2026-10-03; it was opt-in on 2026-10-02). Opting out is one line
  in `.env`. Issue #9 (moving the widget's JS off esm.sh) is still open. Its
  upload/export flow is patched out; checkpoints persist under the boards volume through
  `TMPDIR=/boards/.xcld/mcp-checkpoints`.
- **Part 3b bridge (built):** `open_in_canvas(checkpointId, board, overwrite=false)` and
  `xcld open-in-canvas` read a required, validated checkpoint id from
  `XCLD_MCP_CHECKPOINTS`, drop widget pseudo-elements (`cameraUpdate`, `restoreCheckpoint`,
  `delete`), write `boards/<path>.view.json`, and refuse to replace an existing board unless
  overwrite is explicit. The canvas converts full Excalidraw elements with `restoreElements`
  and skeleton elements with `convertToExcalidrawElements({ regenerateIds: false })`, then
  recenters.
- **Part 3c (not built):** decide the widget network boundary collaboratively.

## Data boundary

- Ports are published as `127.0.0.1:<port>` only. Inside the container, servers bind
  `0.0.0.0` so the published port can reach them.
- `excalidraw-mcp`'s `export_to_excalidraw` (POST to `json.excalidraw.com`) is removed
  by a versioned patch applied at build time. The build fails if the patch doesn't apply.
  The widget's export button (`mcp-app.tsx`) and the `plus.excalidraw.com` menu link are
  removed by the same patch.
- Excalidraw fonts/assets are served from the image (`EXCALIDRAW_ASSET_PATH`). **verified:** a
  font is served over HTTP as `font/woff2`.
- **Open: the canvas bundle (first build) still contains upstream external endpoints.**
  - These are `excalidraw.com` links and constants, firebase config constants, and an
    `esm.sh` asset fallback that should be unused because the asset path is set. The static
    scan can't tell which of these fetch at runtime.
  - Next step: a manual browser session with DevTools → Network, exercising library browse,
    export and the help menu. If any of them fetch, remove the menu entries or patch them.
- **MCP widget CDN (verified, `excalidraw-mcp@157aa23`).** The widget leaves React and
  Excalidraw 0.18.0 out of its bundle and loads them from `https://esm.sh` at runtime
  (`vite.config.ts` externals; CSP `resourceDomains` in `server.ts:650`).
  - **Decision (lead, 2026-10-02):** leave this as upstream for parts 3a/3b, with the
    service behind the `widget` Compose profile (on by default since 2026-10-03). Part 3c / issue #9 will later
    decide between serving those dependencies from our container and inlining them into the
    widget. The exact switch points are a new patch under `patches/excalidraw-mcp/` that
    changes `vite.config.ts` (`rollupOptions.external` / `output.paths`) and `src/server.ts`
    (`resourceDomains` / `connectDomains`).
  - Test the VS Code and Claude Desktop widget sandboxes in part 3c. If they block localhost
    loads, inline everything into the widget's single HTML file.
- **Widget edit fallback (2026-10-02):** when `requestDisplayMode({mode:"fullscreen"})`
  returns a different mode or throws, the upstream widget remains inline and shows a
  dismissible hint with the checkpoint id and copy button. Hosts that support fullscreen
  editing keep the unchanged path.
- **DNS rebinding:** ports are bound to `127.0.0.1` on the host. The MCP Apps service binds
  `0.0.0.0` inside the container so Docker port publishing can reach it. No cheap
  `createMcpExpressApp` allowed-hosts option was verified in this pass, so host-header
  enforcement is an open hardening item for the network spike.
- Publishing gate: the lead approves every PR that goes from the internal clone to the
  public GitHub repo.

## Agent loop

1. The agent writes `boards/x.mmd` (or edits `x.excalidraw`) and runs `snapshot x`.
2. The agent opens the board in the browser. The human annotates.
3. The agent runs `diff x` (changes since the last snapshot). Output is text, or `--json`
   for other agents.
4. The agent acts on the feedback, updates the board, and runs `to-mermaid x` for docs/PRs.
   Anything Mermaid can't express is emitted as `%%` comments, never dropped.

## Round trip: Mermaid ⇄ Excalidraw

Excalidraw can express more than a Mermaid flowchart, so the round trip is lossy in one
direction. The design question is what we do about that loss.

### Forward: Mermaid → Excalidraw (verified in source)

- `mermaid-to-excalidraw@7849b48` uses the Mermaid node ID as the element ID
  (`converter/types/flowchart.ts:184`). It also keeps subgraphs, `classDef`/`style`
  colors and dashed/thick edge styles.
- **Subgraph patch (verified 2026-10-02):** Mermaid 11 renders subgraph SVG groups with the
  render ID prefixed (`<renderId>-G`) while `diagram.db.getSubGraphs()` returns the raw ID
  (`G`). Upstream `parser/flowchart.ts` queried only `[id='G']`, threw `SubGraph element not
  found`, and `parseMermaid.ts` fell back to `graphImage`. The local patch falls back to the
  `-<id>` suffix on Mermaid cluster elements, so subgraphs convert to editable container
  rectangles with `subgraph_group_<id>` group IDs.
- **But** Excalidraw's `convertToExcalidrawElements` swaps in random IDs by default
  (`packages/element/src/transform.ts:591`). We must call it with
  `{ regenerateIds: false }`, or every conversion breaks ID stability.
- Edge IDs are `${start}_${end}` (`flowchart.ts:281`). Two parallel edges between the same
  nodes collide, so we need a suffix for disambiguation.

### Reverse: Excalidraw → Mermaid

Three tiers of content:

| Tier | Examples | Handling |
|---|---|---|
| Maps cleanly | Shaped nodes, bound arrows and labels, frames/groups → `subgraph`, colors → `style`, dashed/thick arrows | Convert |
| Not expressible | Free-text notes, freehand strokes, unbound arrows, images, positions/layout | `%%` comment (current) or structured `%% xcld:` comment (option C) |
| Ambiguous | Arrow pointing at another arrow, a note overlapping two nodes | Comment, plus a warning in the diff |

### The real issue: re-import

When the agent edits the `.mmd` and re-converts, the human's layout and notes are wiped.
Options:

- **A. One-way out.** After the first import, `.excalidraw` is the source of truth and Mermaid
  is a derived export. The agent edits the board, never the `.mmd`. This is the simplest
  option, but agents prefer writing Mermaid.
- **B. Merge on re-import.** Reconcile by stable ID:
  - Existing nodes keep their position, style and attached notes.
  - New nodes get the converter's layout.
  - Deleted nodes are removed, and any notes anchored to them are flagged rather than dropped.
- **C. Annotations in Mermaid.** Emit non-expressible content as structured comments
  (`%% xcld:note n_valid "validate schema"`) and re-hydrate them on import. Positions
  are still lost.

**Decision (lead, 2026-10-02): B + C in v1.** Re-import merges by stable ID, and
structured `%% xcld:` comments carry annotations through Mermaid.

## Annotation convention — free-form by default, local design rules

- **Default: free-form.** Every change is relayed in the semantic diff, and the model
  interprets it.
- **Optional local conventions:** `design-rules.csv` files supply meaning and
  instructions. A file at a narrower scope overrides a broader one:
  1. board: `boards/<path>.design-rules.csv`
  2. workspace: `boards/.xcld/design-rules.csv`
  3. user: `~/.xcld-collab/design-rules.csv`

  These files are user-local and are never baked into the image.
- **Relay:** each change in the diff that matches a rule is tagged with the rule's meaning and
  instruction. Unmatched changes are still relayed free-form, so nothing is filtered out.

### Schema (agreed)

```csv
rule_id,on,match,means,instruct
red-note,added,type=text;strokeColor=#e03131,feedback,"Change request for the nearest node; propose a fix before editing"
strike,removed,type=*,rejected,"Human removed this; do not re-add without asking"
yellow-fill,restyled,backgroundColor=#ffec99,question,"Answer in a note next to the node"
dashed-edge,added,type=arrow;strokeStyle=dashed,proposed,"Proposed connection; confirm before adding to the Mermaid source"
blocked,*,type=arrow;endArrowhead=bar,blocked,"Flow is blocked here; explain why or remove"
plain-line,added,type=line|freedraw;bound=false,emphasis,"Human is pointing at something; ask what if unclear"
```

- `on` is one of: `added`, `removed`, `relabeled`, `rewired`, `restyled`, `moved` or `*`.
- `match` is a list of predicates separated by `;` (all must hold), evaluated on the element's
  state after the change.
- When several rules match, all are relayed, ordered by scope (board first) and then by row.

Relay example:

```
+ added note "validate schema edge" near "Valid?"  [red-note → feedback]
  instruct: Change request for the nearest node; propose a fix before editing
```

### Match vocabulary

The property names and values are Excalidraw's own (`packages/element/src/types.ts`), so
a rule always means exactly what the user sees in the style panel.

**v1: property predicates.** Operators are `=`, `!=`, `|` (any of) and `*` (any value).

| Property | Values | Notes |
|---|---|---|
| `type` | `rectangle`, `diamond`, `ellipse`, `text`, `arrow`, `line`, `freedraw`, `frame`, `image` | `line` = no arrowheads by default; `freedraw` = pen strokes |
| `strokeColor`, `backgroundColor` | hex, e.g. `#e03131` | Exact match on the palette value |
| `strokeStyle` | `solid`, `dashed`, `dotted` | Lines, arrows and shape outlines |
| `strokeWidth` | `1`, `2`, `4` | Thin, bold and extra bold in the UI |
| `fillStyle` | `hachure`, `cross-hatch`, `solid`, `zigzag` | |
| `startArrowhead`, `endArrowhead` | `none`, `arrow`, `bar`, `dot`, `circle`, `circle_outline`, `triangle`, `triangle_outline`, `diamond`, `diamond_outline`, plus crow's-foot variants | `none` means null |
| `elbowed` | `true`, `false` | Elbow vs. straight/curved arrows |
| `opacity` | `0`–`100` | |
| `bound` *(derived)* | `true`, `false` | Arrow/line bound at either end, or text inside a container |
| `frame` *(derived)* | frame name | Element sits inside the named frame |

**v2: relational and fuzzy predicates.** These need geometry or interpretation, not just a
property lookup:

- `near=<node>`, `inside=<shape>`: proximity or containment.
- `points_to=<node>`: endpoint proximity for **unbound** arrows/lines.
- `crosses=<node|edge>`: a strike-through line drawn over something, e.g. "delete this".
- `encircles=<nodes>`: a pen loop around a group, e.g. "these belong together".
- `color=red`: color families instead of exact hex values.
- `label~=<regex>`: text match.
- Transitions: `strokeStyle:solid->dashed`, e.g. "a solid edge made dashed = demote to optional".

### Line and arrow styles in the Mermaid round trip

Mermaid flowchart edges have equivalents for some styles:

| Excalidraw | Mermaid |
|---|---|
| Solid arrow | `-->` |
| No arrowhead | `---` |
| Dashed or dotted | `-.->` |
| Extra-bold stroke | `==>` |
| Arrowheads on both ends | `<-->` |
| `circle` / `bar` head | `--o` / `--x` (nearest equivalent; flagged as approximate) |

Everything else (colors per edge, elbows, triangle/diamond heads) goes into `%% xcld:` comments
so the merge on re-import (option B + C) can restore it.

## Evidence so far

- **verified:** in upstream `excalidraw-mcp@157aa23`, the edit summary sent back to the
  model (`edit-context.ts`) covers adds, removes and moves. It does **not** report text
  changes on existing elements or arrow rewiring.
- **verified:** upstream `mermaid-to-excalidraw@7849b48` natively supports flowchart,
  sequence, class, ER and state diagrams. Other types fall back to an image.
- **verified:** the throwaway prototype in `spike-b/` builds with npm via the internal
  proxy, and its lockfile has no registry URLs.
  - Its `diff` correctly reported a relabel, rewire, deletion, recolor and added note on
    *hand-written* fixtures.
  - **Not yet tested on real converter output.**
  - Known defects: doubled `n_n_` node IDs and a truncated note ID in `to-mermaid`.
- **decided:** the repo is MIT-licensed, copyright Hack4Impact, with a NOTICE crediting
  all three upstreams (`excalidraw-mcp` declares MIT in `package.json` but has no LICENSE
  file).

## Decisions — sign-off checklist

Signed off by the lead, 2026-10-02:

1. **Repo and image.** Public repo **`Hack4Impact/xcld-collab`**, MIT license (copyright
   Hack4Impact) plus NOTICE. Image tag `xcld-collab:<ours7>-<exc7>-<m2e7>-<mcp7>`, with
   disabled slots set to `0000000`.
2. **Re-import.** B + C: merge by stable ID, with annotations carried in `%% xcld:` comments.
3. **Annotations.** Free-form by default. Local `design-rules.csv` conventions use the schema
   above: v1 property predicates (including line, arrow and arrowhead styles), with
   v2 relational and fuzzy predicates.
4. **Merge conflicts.** When the agent deletes or rewrites a node the human annotated since the
   last snapshot, the change is not applied. It is flagged in the diff, and the human is asked.
5. **Reproducibility.**
   - `build --pinned` reads a committed `pins.json` of known-good SHAs. This is the default
     for team and class use.
   - `build --latest` is for development.
6. **Ports.** 3100 (canvas) and 3001 (MCP), localhost only, overridable.
7. **Runtime.** Docker Desktop or the docker CLI. Base image `node:22-slim`.
8. **Canvas app.** Consumes `packages/excalidraw` built from source at the pinned SHA.

Review later (not v1):

- **Semantic edit read-back** in the `excalidraw-mcp` widget (upstream PR candidate).
- **v2 match predicates** (see "Match vocabulary").
