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
  **Exception:** the optional, experimental `excalidraw-mcp` widget (off by default) still
  loads React/Excalidraw from `esm.sh` when enabled; resolving that is the part 3c network
  spike (issue #9).

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
  watcher pushes on-disk (agent) changes to the browser over SSE.
  Each side ignores its own echoes by content hash.
  - **Stale-save guard** (an interim step before versions + merge). `GET` returns the sha256
    of the file as an `ETag`; the tab sends the hash its scene is based on as `If-Match`
    (`If-None-Match: *` for a new board). The server re-hashes the file on disk at `PUT` time,
    so a direct agent write counts too, and answers `409 {error:"stale-save", currentHash}`
    when it moved. A per-board lock makes check-and-write atomic between tabs. `PUT` without
    either header is unguarded (last write wins) for scripts.
  - On 409 the tab fetches the board, re-applies its unsaved edits per element id against
    the base it last loaded or saved (`app/src/reconcile.mjs`): a side that changed an element
    since the base wins; if both changed it, the higher Excalidraw `version` wins and a tie
    goes to the tab; an untouched element the other side removed stays removed. It shows
    "Board changed elsewhere; your edits were re-applied" and saves again, up to 3 retries,
    then reports an error. A reload that arrives while the tab has unsaved edits merges the
    same way, and the debounced save reads the latest canvas. This closes the old window
    where a pending autosave wrote the pre-reload scene over an agent's write.
  - Not Excalidraw's `reconcileElements`: it has no base, so an agent edit that doesn't bump
    `version` loses to the tab's untouched copy, and an element left out of the file comes
    back. Agents writing JSON rarely bump versions.
  - Still upcoming: true parallel editing (every save a version, merges you can inspect).
    Two edits of the same element still keep only one of them.
  - **verified (2026-10-02):** `fs.watch` (inotify) gets **no events for host-side writes**
    through a Docker Desktop bind mount from Windows. Writes made inside the container do
    fire.
  - So the server also polls the mtime and size of each board file every
    `XCLD_WATCH_POLL_MS` ms (default 1000; 0 disables).
  - Both sources share one signature map, so each change is published once. Both behaviors
    are covered by `tests/api.test.mjs`, and the host-edit SSE event was verified end to end.
  - A change is published only once the file has settled: same signature after a short
    re-check (`min(XCLD_WATCH_POLL_MS, 100)` ms) and, for JSON files, content that parses, so
    a non-atomic (truncate-then-write) host write is never announced half-written.
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
  - **`mermaidPending` compares content, not mtimes.** A fresh clone or checkout sets mtimes
    in arbitrary order, so "the `.mmd` is newer" was wrong for checked-in boards. When a tab
    converts `x.mmd`, it stamps every converted element with
    `customData.xcldMermaidHash` (`tools/mermaid-hash.mjs`, shared by the canvas and the
    index; BOM, CRLF and trailing whitespace are normalized). Excalidraw keeps element
    `customData` through restore, edits and saves (**verified 2026-10-06** in a browser:
    convert, reload, edit, save). Pending = no board, no live elements, or no live element
    carries the hash of the current `.mmd`. Boards with no stamp keep the mtime rule.
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
- **Tag:** `<ours7>-<exc7>-<m2e7>-<mcp7>[-nolock][-dirty]`, with fixed slots.
  - A component marked disabled in `pins.json` isn't built, and its slot is `0000000`. So
    phase B images are `<ours7>-<exc7>-<m2e7>-0000000`, and every tag has the same shape.
  - Identical inputs produce an identical tag.
  - The base image is pinned by digest in `pins.json`.
  - Full SHAs are stored as OCI labels and in `/opt/xcld-collab/manifest.json`.
  - Uncommitted changes in our repo add `-dirty` to the tag.
  - Lockfile opt-out builds (below) add `-nolock`.
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
  - `app`: our canvas, built against the vendor tarballs with `npm ci` from the committed
    `app/package-lock.json`. npm `overrides` force Excalidraw's own `@excalidraw/*` and
    `mermaid-to-excalidraw` dependencies to the source builds.
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
  - `app/package-lock.json` is committed with `https://registry.npmjs.org/` URLs only; the
    app stage rewrites it the same way (`with-registry --rewrite package-lock.json`). A
    lockfile generated through a mirror records the mirror's URLs, so
    `npm run lockfile:public` (`app/scripts/public-lockfile.mjs`) swaps the registry base
    back (same tarball path, same `integrity`), and `tests/lockfile.test.mjs` fails on any
    other host.
- **Determinism (accepted by the lead, 2026-10-02; app stage locked 2026-10-06).**
  - Deterministic:
    - The upstream build stages, which use each project's frozen `yarn.lock` at the pinned SHA.
    - The vendor tarballs. **verified:** a `--no-cache` rebuild produced byte-identical
      tarballs.
    - The base image, pinned by digest.
    - The app stage: `npm ci` installs exactly `app/package-lock.json` (lockfileVersion 3),
      and fails if it disagrees with `package.json`.
  - The lockfile records each vendor tarball's `integrity`, so it belongs to one `pins.json`
    set. **verified:** `npm ci` fails with `EINTEGRITY` on a mismatched vendor tarball. After
    changing pins (or dependencies), rebuild `app/vendor`, run `npm install` and
    `npm run lockfile:public` in `app/`, and commit both files together.
  - **Opt-out (`-NoLockfile` / `--no-lockfile` / `XCLD_NO_LOCKFILE=1`):** for environments
    such as an internal npm proxy where the locked install can't be used. The app stage skips the
    lockfile and runs `npm install --no-package-lock` against `package.json` ranges (the old
    semi-deterministic behaviour); the tag gets `-nolock`. Locked builds stay the default.
  - The resolved tree is still recorded in `/opt/xcld-collab/resolved-deps.json`.
- **CI and published image** (`.github/workflows/`). Hack4Impact cost rule: workflows run
  only on push to `main` (after merge) or manual dispatch; there are no `pull_request`
  triggers and no required status checks.
  - `ci.yml`: gitleaks (pinned 8.30.1 binary, checksum-verified, `.gitleaks.toml`) and a
    GitHub-noreply author/committer email check over `main`'s full history on every push.
    When build, app or test inputs change, it also runs `build.sh` (image and vendor), the app
    build, `node --test tests`, and a Compose smoke (`/healthz` 200, `xcld list`).
  - `image.yml`: takes the tag and build args from `build.sh --dry-run`, so the scheme can't
    drift. It builds `linux/amd64` and `linux/arm64` on native runners
    (`ubuntu-24.04-arm`: free on public repositories, billed per minute below the x64 rate
    on private ones), pushes by digest, and publishes one multi-arch index as
    `ghcr.io/hack4impact/xcld-collab:<tag>` and `:latest`. `XCLD_ARM64_BUILD=qemu` (repository
    variable) switches arm64 to QEMU on an x64 runner, which is several times slower.
  - The repository allows only GitHub-owned actions, so `image.yml` drives buildx, `docker login`
    and QEMU (Ubuntu's `qemu-user-static`) from the runner's CLI. Its layer cache lives in the
    same package as `:buildcache-amd64` / `:buildcache-arm64`; images carry no provenance or SBOM
    attestations, so build arguments never reach published metadata.
- **Linux bind mounts:** the container runs as `node` (uid 1000). The build scripts print a
  `docker run -u $(id -u):$(id -g)` command so boards stay writable. Docker Desktop on
  Windows/macOS doesn't need this.

## Phasing

- **Running:** `compose.yaml` (lead decision, 2026-10-02) replaced the per-OS start
  scripts. The build scripts compute the tag and write `XCLD_IMAGE`/`XCLD_TAG` to a
  gitignored `.env`, plus `XCLD_UID`/`XCLD_GID` on Linux. `docker compose up -d --wait`
  reads them. The `excalidraw-mcp` MCP Apps chat widget is under the `widget` profile and is
  **experimental and off by default** (lead decision, 2026-10-06; it was seeded on by the
  build from 2026-10-03). The build scripts no longer write `COMPOSE_PROFILES`; the default is
  canvas only, with zero runtime egress. Opt in with `COMPOSE_PROFILES=widget` in `.env`. A
  line seeded by an earlier build is left alone (the build never rewrites a user's choice) and
  the build prints a one-line notice while it enables the widget.
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
- **Part 3b (built, experimental, opt-in):** `excalidraw-mcp` at its pinned SHA as a second HTTP
  service for MCP Apps hosts. It is profile-gated (`widget`) and off by default (lead,
  2026-10-06; opt-in on 2026-10-02, seeded on by the build 2026-10-03 to 2026-10-06). The
  shipped `.vscode/mcp.json` lists only `xcld`, because an `excalidraw` entry fails to connect
  while the profile is off. Issues #9 (moving the widget's JS off esm.sh) and #7 (font CSP
  errors) are still open. Its
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
    service behind the `widget` Compose profile (experimental and off by default since 2026-10-06). Part 3c / issue #9 will later
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
- **Label line breaks (verified 2026-10-06 in a browser):** a real newline inside a quoted
  label becomes a real line break in the element's `originalText`; `<br/>` is copied
  literally (`originalText` was `GET /api<br>board`). The agent docs and MCP tool
  descriptions say "newline, never `<br/>`", and `xcld check` / `check_board` warn on any
  `originalText` containing `<br`.

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

## Merge rules

**Status (2026-10-06):** the merge module `tools/merge.mjs` is built and tested; the server
doesn't call it yet. The branch store, per-board queue and commit pipeline come next, then
the write API, the tab and the concurrency test. Today the board is still turn-taking with the
stale-save guard.

Every writer (tab, MCP, CLI, a direct file write) produces a branch: its full scene plus the
master version it started from (the base) and when it was written. One merge runs at a time
per board: `mergeBoard({ base, master, branch, branchWrittenAt, branchAuthor, masterMeta })`
returns the new master plus `meta`, `applied`, `overwritten` and `unbound`. It is pure: no
I/O, no clock, the same inputs give the same output, and it runs in Node and in the browser.

| Rule | Behavior |
|---|---|
| Identity | The Excalidraw element id. Mermaid node ids survive conversion, so they match. |
| Changed | Compared by content against the base, ignoring `version`, `versionNonce`, `updated` and arrow back-references in `boundElements`. Agents that don't bump versions are fine. A tombstone (`isDeleted`) and an absent element both mean deleted. |
| Units | A container and its bound text are one unit (an arrow and its label too), found through `containerId` on any side. Groups (`groupIds`) and frames are **not** units: grouped elements merge one by one, so editing two shapes of one subgraph on two sides doesn't conflict. |
| One side changed a unit | That side's version is taken. Master still equal to the base is a fast-forward. |
| Both sides changed a unit | **The later write takes the whole unit.** Master's time for a unit is the latest `writtenAt` in `masterMeta` of its elements (the write that last set each one); the branch's is `branchWrittenAt`. A stale queued write therefore loses to a newer edit of the same unit (D8). Equal times: the greater author key wins, then the greater content, so the result never depends on which side was merged first. The loser's elements are returned in `overwritten`. |
| Deletion vs edit | Same rule: a later edit brings the whole unit back; a later deletion removes it. |
| Arrows | An arrow whose bound target is gone after the merge is kept with that end unbound, and reported in `unbound`. Deleting a shape unbinds its arrows, and that unbinding counts as part of the deletion, so if a later write keeps the shape, its arrows stay bound. A binding to an element the writer's own board doesn't have counts as unbound. |
| Back-references | The `boundElements` arrow entries of each element are rebuilt from the merged arrows: entries for arrows that no longer bind are dropped, entries either side listed for arrows that still bind are kept. |
| Versions | A merged element that differs from master's copy gets a `version` above every known copy, with a deterministic `versionNonce`. An element with master's exact content stays master's object. |
| Z-order | With a fractional `index` on every element, elements sort by it (ties by id). Otherwise master's order holds (the branch's on a fast-forward), and elements only the branch has follow their nearest preceding branch neighbor. |
| Tombstones | Not written to master; `meta` keeps the time and author of a deletion. |
| `files`, `appState` | Image files: the union of both sides by file id. `appState`: per key, a branch change since the base wins. |
| Write times | `meta` maps every element id to `{ writtenAt, author }` of the write that last set it. The commit step stores it and passes it back as `masterMeta` on the next merge. |

The D3 property test (`tests/merge.test.mjs`) runs 60 seeded pairs of edit scripts, one
tab-like (version bumps, tombstones, unbinding on delete) and one agent-like (no bumps,
deletion by omission). It checks that repeated runs and shuffled input arrays give identical
results, that merging A then B equals B then A, and that every change is either in the result
or reported as overwritten. `node tests/merge-bench.mjs` measures D5.

## Annotation convention — free-form by default, local design rules

**Implemented in the design-rules v1 spike (2026-10-03).** Deferred: `protect`
enforcement waits for versions/merge, v2 relational/fuzzy predicates remain out of scope
except `crosses=`, and deterministic linter vocabulary generation is tracked as issue #6.

- **Default: free-form.** Every change is relayed in the semantic diff, and the model
  interprets it.
- **Optional local conventions:** `design-rules.csv` files supply meaning and
  instructions. A file at a narrower scope overrides a broader one:
  1. default: `boards/design-rules.csv`, or the path in `XCLD_DESIGN_RULES`
  2. folder: `boards/<folder>/design-rules.csv`

  The nearest folder file replaces the inherited rules for that folder and below. Rules are
  not merged row-by-row. The starter file is intentionally scoped to
  `boards/examples/design-rules.csv`, so repository defaults remain a user choice.
- **Relay:** each change in the diff that matches a rule is tagged with the rule's meaning and
  instruction. Unmatched changes are still relayed free-form, so nothing is filtered out.
- **Agent briefing:** `xcld rules <board>` plus MCP `read_board`/`write_mermaid` include the
  effective draw, interpret and check rules.
- **Checks and policy:** `xcld check <board>` and MCP `check_board` list open items. `export`
  rows override `XCLD_AUTO_EXPORT` per folder, and `snapshot,on-agent-write` snapshots before
  MCP agent writes.

### Schema (agreed)

```csv
kind,rule_id,on,match,means,instruct
interpret,approve,restyled,was.strokeColor=#1971c2;strokeColor=#1e1e1e,approved,"Promote to agreed; keep it in the Mermaid source"
interpret,note,added,type=text;bound=false,note,"A description, question or requested change for the nearest node; ask if unclear"
draw,proposed-style,,,proposed,"Draw new or unapproved parts with classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2"
check,open-proposals,,strokeColor=#1971c2,open proposal,"Not done while light-blue nodes remain"
export,export-mode,,,save,"Keep .exports/<path>.mmd current for this folder"
snapshot,on-agent-write,,,on,"Snapshot before every agent write"
```

- `on` is one of: `added`, `removed`, `relabeled`, `rewired`, `restyled`, `moved` or `*`.
- `match` is a list of predicates separated by `;` (all must hold), evaluated on the element's
  state after the change. Prefix with `was.` to read the before-state. `removed` rules match
  against the before-state.
- `protect` rows parse and warn "not enforced yet (deferred until versions/merge)" but do not
  fail validation.
- When several rules match, all are relayed in file row order.

Relay example:

```
+ added "validate schema edge" near "Valid?"  [note → note]
Rule legend:
  [note → note] A description, question or requested change for the nearest node; ask if unclear
```

### Match vocabulary

The property names and values are Excalidraw's own (`packages/element/src/types.ts`), so
a rule always means exactly what the user sees in the style panel. They are generated from
the pinned commit into `tools/rules-vocab.generated.mjs` (issue #6; see the reference's
design-rules section), not maintained by hand.

**v1: property predicates.** Operators are `=`, `!=`, `|` (any of) and `*` (any value).
`was.` transitions are implemented. `crosses=` is the only v1 geometric predicate because
open notes are resolved by drawing a line/arrow/freedraw across them.

| Property | Values | Notes |
|---|---|---|
| `type` | `rectangle`, `diamond`, `ellipse`, `text`, `arrow`, `line`, `freedraw`, `frame`, `magicframe`, `image`, `embeddable`, `iframe`, `stickynote` | `line` = no arrowheads by default; `freedraw` = pen strokes |
| `strokeColor`, `backgroundColor` | hex, e.g. `#e03131` | Exact match on the palette value, normalized to lowercase |
| `strokeStyle` | `solid`, `dashed`, `dotted` | Lines, arrows and shape outlines |
| `strokeWidth` | `1`, `2`, `4`, `8` | Excalidraw's `STROKE_WIDTH` (thin, medium, bold, extraBold) |
| `fillStyle` | `hachure`, `cross-hatch`, `solid`, `zigzag` | |
| `roundness` | `round`, `sharp` | `sharp` = `roundness: null` |
| `startArrowhead`, `endArrowhead` | `none`, `arrow`, `bar`, `circle`, `circle_outline`, `triangle`, `triangle_outline`, `diamond`, `diamond_outline`, `cardinality_one`, `cardinality_many`, `cardinality_one_or_many`, `cardinality_exactly_one`, `cardinality_zero_or_one`, `cardinality_zero_or_many` | `none` means null; legacy `dot`/`crowfoot_*` are rejected because Excalidraw renames them on load |
| `elbowed` | `true`, `false` | Elbow vs. straight/curved arrows |
| `opacity` | `0`–`100` | |
| `bound` *(derived)* | `true`, `false` | Arrow/line bound at either end, or text inside a container |
| `frame` *(derived)* | frame name | Element sits inside the named frame |
| `crosses` *(geometric)* | `note`/`text`, element type, or element id | For line/arrow/freedraw segment intersection with target bounding boxes |

**v2: relational and fuzzy predicates.** These need geometry or interpretation, not just a
property lookup:

- `near=<node>`, `inside=<shape>`: proximity or containment.
- `points_to=<node>`: endpoint proximity for **unbound** arrows/lines.
- `crosses=<node|edge>` beyond the v1 `crosses=note`/basic target support: richer strike-through semantics.
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
