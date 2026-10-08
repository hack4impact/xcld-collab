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
- **A new Mermaid diagram is laid out in the host's default browser** through the
  mapped port. The full layout needs a real page, and this avoids putting headless Chromium in
  the image. When it needs a conversion or review, the agent opens the board with
  `Start-Process http://127.0.0.1:3100/?board=<path>`. Opening the tab is the handoff; with no
  tab, the server lays the diagram out itself in a simple grid after about 2 minutes
  ([Mermaid ingestion](#mermaid-ingestion-slice-6a)). Every later Mermaid write to that board is
  applied by the server, with no tab ([Server-side Mermaid apply](#server-side-mermaid-apply)).
- **Live sync.** The browser saves debounced edits through `PUT /api/board/:name`. A file
  watcher pushes on-disk (agent) changes to the browser over SSE.
  Each side ignores its own echoes by content hash.
  - **Saves merge** (versions and merge, slice 3). `GET` returns the board's version (the
    sha256 of the file) as the `ETag`. The tab sends the version its scene is based on as
    `If-Match` (`If-None-Match: *` for a new board). The server commits every save through the
    [versions pipeline](#versions-storage-and-commit-pipeline):
    - a save based on the current version is a fast-forward;
    - one based on an older version the server knows is **merged** with what was written since
      ([rules](#merge-rules)), and the merged board comes back in the answer (`merged: true`,
      `master`);
    - only an unknown base is 409.

    The board's commit queue serializes saves. `PUT` without either header is unguarded (the
    last write wins) for scripts.
  - **The tab's side (slice 5, `app/src/App.tsx`, `identity.mjs`, `tab-merge.mjs`,
    `merge-banner.mjs`):**
    - **Identity.** Every save sends `X-Xcld-Author-Name` and `X-Xcld-Tab`, so the author key
      is `human:<name>#<tabId>`. The name is a rename remembered in `localStorage` (shared by
      the browser's tabs, kept in sync by the `storage` event), else `XCLD_AUTHOR_NAME` from
      `GET /api/config` (the first load waits for it), else `anonymous`. The tab id is random,
      in `sessionStorage`, so it survives reloads of that tab. "Duplicate tab" copies
      `sessionStorage`, so a new tab announces its id on a `BroadcastChannel` and takes a fresh
      one if a live tab answers that it holds it. No random names and no server-checked unique
      names: those are for future shared servers.
    - **Save before reload** (lead, 2026-10-06; no blocking server hook). On a `board` event, or
      a `merged` event from another author whose version isn't the tab's base, the tab (in its
      one-at-a-time queue) saves its unsaved edits first, with the base they started from; the
      server merges and answers with master, which the tab shows. With nothing unsaved it just
      loads master. Saves send `X-Xcld-Edit-Age` (ms since the last edit), so the save's write
      time is the human's last edit, not the debounced save's arrival.
    - **After a merged answer, master is the new base.** Each save keeps an exact copy of what
      it sent (Excalidraw edits elements in place). Edits made while the save was in flight are
      merged onto master with `tools/merge.mjs` (base: the sent copy), master winning any unit
      both changed. So an edit of this tab that lost is never sent again (its only route back to
      master), and losers stay in history only. An in-flight edit replaced that way is listed
      on the banner ("replaced while saving"); it was never a write, so it isn't in history.
    - **Restore isn't an edit.** The canvas shows elements through Excalidraw's restore, which
      fills in defaults (an agent's minimal JSON gains a seed, colors, an index). A save sends
      every element the tab hasn't touched since the server sent it (same version stamp)
      exactly as the server wrote it, and after a merged answer a unit the merge left as sent
      keeps the tab's own copy. Otherwise a fill-in would read as this tab's edit and could beat
      a concurrent agent edit of a shape the human never touched.
    - **The banner** (non-modal, `role="status"`, its buttons don't take focus) folds every
      merge since it was dismissed into one line, "Merged from <who>: n added, n changed · n
      overwritten edits (k of yours)", plus details per unit with the winner and loser. It
      reads the `merged` SSE events of other authors (including writes that lost every change:
      `applied` empty, master unchanged, no reload) and this tab's own save answers.
    - **Ctrl+S / Cmd+S** (a capture-phase listener, so Excalidraw's "Save to…" download never
      opens) saves now, then `POST /api/board/<path>/checkpoint` closes the tab's open history
      entry; "Saved checkpoint", or "No changes since the last checkpoint".
  - **Offline fallback, 409 only** (the server doesn't know the base, e.g. it expired): the tab
    fetches the board and merges its unsaved edits onto it with `tools/merge.mjs` against the
    base it last loaded, the tab winning a unit both changed, then saves on the new base (up to
    3 retries). The client-side re-apply that slice 3 ran before every reload
    (`app/src/reconcile.mjs`) is retired: the server merges.
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
    elements and a Mermaid write or a newer `.view.json` inbox is waiting, the browser converts
    it instead of treating the empty board as final.
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
    carries the hash of the current `.mmd`. Boards with no stamp keep the mtime rule. The
    server's board list (`GET /api/boards`) also counts a `.mmd` the server applied as not
    pending, even when it changed nothing on the board.
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

- Version data (history, journal, images) stays local: in `~/.excalidraw/history/` on Linux,
  in the `xcld-state` Docker volume on Windows/macOS (`XCLD_HISTORY`), or `boards/.xcld/`
  without compose. Nothing is sent anywhere.
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

1. The agent writes Mermaid with `write_mermaid` (or the board JSON with `write_board`) and runs
   `snapshot x`. Both merge with what the human drew meanwhile.
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
**Status (2026-10-07):** B is built: a Mermaid write is applied on the server and merged
([Server-side Mermaid apply](#server-side-mermaid-apply)). C is not built yet.


## Merge rules

**Status (2026-10-07):** the merge module `tools/merge.mjs`, the server's commit pipeline and
the write API are built: tab saves, `POST /api/branch` (MCP `write_board`, `xcld write`),
Mermaid writes (`POST /api/mermaid`: MCP `write_mermaid`, `xcld write-mermaid`, slice 4b) and
direct file writes all merge, and the tab saves before it reloads, with its author overlay and the
merged banner (slice 5). The concurrency test comes next.

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

**D5 budget (lead, 2026-10-06):** the merge step alone stays at **p95 ≤ 250 ms** for a
1,500-element board. Measured at about 20–35 ms median and 35–75 ms p95 on a loaded machine.
The test guard in `tests/merge.test.mjs` stays generous (2 s for one run).

**Known limitation:** moving a shape in Excalidraw also rewrites its bound arrows' points,
but an arrow is its own unit. When the shape's move wins and a newer edit of the arrow (say,
its label) also wins, the arrow keeps its old points and can look detached until someone
touches it. It is reported as overwritten. Tracked in issue #27.

### Server-side Mermaid apply

Versions and merge (Wave 2) applies a Mermaid write to the board on the server, so it
doesn't need an open tab. **Status (2026-10-07):** built and wired in (slice 4a: parser and
apply; slice 4b: the write path below). `xcld mermaid-apply --dry-run` previews an apply.

- **Parse with Mermaid itself.** `tools/mermaid-parse.mjs` runs the same Mermaid version as
  the tab's converter. Mermaid needs a DOM even to load (DOMPurify), so it runs in a
  **worker thread** that installs jsdom's `window`/`document` as globals in its own isolate;
  the server's own globals stay untouched. The worker is `tools/mermaid-parse.bundle.mjs`, one
  esbuild file with jsdom, Mermaid and the converter's label/style helpers, built by
  `npm run build`. The runtime image still ships no `node_modules`.
- **Warm-up.** `warmUp()` starts the worker in the background, once, and `status()` reports
  `cold | warming | ready | failed` with timings. Parses requested during warm-up wait for it.
  Importing Mermaid from `node_modules` took over 40 s; the bundle loads in about a second
  (container numbers are in the PR that added it). A missing bundle reports `failed`
  instead of crashing.
- **Apply.** `tools/mermaid-apply.mjs` `applyMermaid({ master, parsed, hashOfSource, now,
  previous })` is pure: it returns the new elements, a list of ops, and `needsTabLayout`.
  - Identity: a node id is the element id (the tab converts with `regenerateIds: false`);
    ids that `to-mermaid` rewrote map back to the original shape. An edge matches an arrow
    already bound start → end, then the converter's id (`A_B`, `A_B_2`, ...).
  - Existing shapes keep their position and size. Labels change in the shape's own bound
    text, which re-wraps; the shape grows taller only if the text no longer fits.
    `classDef`/`class`/`style` colors, shape type, edge style and subgraph membership
    follow the Mermaid. A style that the Mermaid doesn't mention is left alone, unless
    `previous` (the Mermaid the board came from) shows that Mermaid had set it.
  - **Only Mermaid-origin elements of the written source are ever deleted**: those whose
    origin (`customData.xcldOrigin`, or `xcldMermaidHash` for `main` on older boards) names the
    source. Human notes, human arrows, human shapes and other sources' shapes never are; an
    arrow left pointing at a deleted shape is kept, unbound. With `previous`, only ids that
    Mermaid had can be deleted.
  - New shapes go next to a connected neighbour, in the flowchart's direction. They avoid
    every live element's bounding box, and the placement is deterministic. New edges are
    straight bound arrows; a parallel edge bows around the first one. New subgraphs wrap
    their members, and existing ones grow to hold new members.
  - Changed and new elements get the new Mermaid hash and a version bump; untouched ones
    keep theirs, so a merge sees only real changes.
- **Still needs a layout:** a board with no shapes of the written source (new, or an image
  fallback) and non-flowchart diagrams return `needsTabLayout: true`; the write becomes a
  pending write ([Mermaid ingestion](#mermaid-ingestion-slice-6a)). Placement is local, not a full
  re-layout, so straight arrows can cross shapes. Text widths are estimated (Node has no
  font metrics); Excalidraw centers bound text, so that only affects wrapping.
- **Conventions are tested against the real converter.** `tests/fixtures/mermaid-apply-*.excalidraw`
  are tab conversions captured in headless Chromium (`tests/browser`, `--app`). The tests
  compare every field that decides rendering, except position and size.

#### The write path (slice 4b)

`app/server/mermaid-write.mjs`, called by `POST /api/mermaid/<path>` and by the file watcher
(`tests/mermaid-write.test.mjs`):

1. **Parse** the source (`parseFlowchart`, waiting for the warm-up the server starts at boot).
   A syntax error is 400 with Mermaid's message and line; nothing is written.
2. **Read the board at the writer's base:** `readVersion(base)`, or the current master when
   `base` is absent or `null`. An unknown base is 409.
3. **Find `previous`**, the Mermaid the base was built from. It decides which ids may be
   deleted and which styles Mermaid had set. Candidates, first match wins:
   1. the board's last applied source (`readMermaid`), if the base carries its hash;
   2. the `.mmd` on disk, if the base carries its hash (a board a tab converted);
   3. the last applied source, if there is one (it may have changed nothing on the board);
   4. none: **nothing is deleted** and the answer says `deletesSkipped`.

   So a human's Ctrl+D copy of a Mermaid shape, which carries the same hash under a new id, is
   never deleted.
4. **Apply** with `now = writtenAt`: the time the writer wrote the Mermaid (its own clock, or
   the file's mtime), never the apply time. Changed elements carry it as `updated`, and the
   merge stamps it in `masterMeta`, so a stale `.mmd` loses to a newer human edit of the same
   unit, and its other changes still apply (D8).
5. **Commit** with `submitBranch(board, { kind: "mermaid", base, writtenAt, elements, ops,
   mermaid: { source, hash } })` and answer like `POST /api/branch`: 200 `merged` or, after
   5 s, 202 `queued` (journaled, never dropped). The answer adds `ops` and `hash`. When the
   apply changes nothing, `elements: null` records only the source (`unchanged: true`), so the
   board stops showing "Mermaid pending".
6. **The inbox file** `boards/<path>.mmd` is then rewritten with the last applied source, in
   commit order (one write at a time per board; left alone when it only differs in line endings
   or trailing whitespace). It stays the human-readable "last Mermaid written to this board"
   and the source a later write can use as `previous`. `GET /api/mermaid/<path>` sends
   `X-Xcld-Mermaid-Applied: 1` for an applied inbox, and the tab doesn't convert it.
7. **Pending writes:** a brand-new board, a board without shapes of the written source, and
   non-flowcharts answer 202 `needs-tab` with a `pendingId`. An open tab lays the diagram out and
   it **joins** the board as a group; nothing is replaced (see below).

**Direct writes to the inbox.** When the watcher sees a settled `boards/<path>.mmd` that isn't
the last applied source of `main` (and isn't what the board was converted from), it applies it the
same way as the `external` author, written at the file's mtime. Parse errors and an unavailable
parser fall back to the `mermaid` event, so an open tab shows the error as before.

**Parser speed.** Mermaid's `FlowDB.addVertex` deep-copies the whole Mermaid config for every
labeled node (about 0.4 ms each, 85% of a 500-node parse). The parser bundle fetches it once
per diagram instead (`app/scripts/build-mermaid.mjs`; the build fails if Mermaid's code
changes). A 525-node, 450-edge flowchart parses in about 95 ms instead of 312 ms. Mermaid's own
limit of 500 edges (`maxEdges`, the same in the tab) applies.

**Mermaid is not pinned (lead, 2026-10-07).** `tests/mermaid-ci.test.mjs`, part of the suite CI
runs on main, fails when the installed Mermaid stops working with the patch or the parser:
(a) the bundle carries the patch marker (`this.config = this.xcldConfig ??= getConfig()`, once);
(b) one parse's config never carries over to the next (with the worker's site config changed
between parses, `maxEdges` takes effect per diagram, both ways; diagrams with different
`%%{init}%%` directives also parse independently. Mermaid 11 applies no directive in
`getDiagramFromText`, and `maxEdges` is a secure key a directive can't set, so the test drives
the site config through a test-only `configure` message to the worker);
(c) the parse output apply relies on (nodes, edges, subgraphs, classes) keeps its shape; and
(d) the installed Mermaid version is printed in the test output and must match the bundle's.
A manual CI run (`workflow_dispatch` with `mermaid_latest`) installs the latest Mermaid 11.x in
place of the locked one and runs these checks plus the parse and apply tests, to catch drift
early. **If they fail, pinning Mermaid in `app/package.json` is the fallback.**

### Mermaid ingestion (slice 6a)

Decided by the lead on 2026-10-07 (board `sandbox/mermaid-inbox-merge`); built in
`app/server/mermaid-write.mjs` with `tools/mermaid-origin.mjs`, `mermaid-place.mjs`,
`mermaid-grid.mjs` and `mermaid-group.mjs` (`tests/mermaid-ingest.test.mjs`,
`tests/mermaid-place.test.mjs`).

- **The inbox merges instead of replacing.** A Mermaid write the server can't apply node by
  node becomes a **pending write**: a record in the state dir
  (`<state>/mermaid-pending/<path>/<id>.json`, fsynced before the answer). An open tab gets the
  `mermaid` SSE event, reads `GET /api/mermaid/<path>?pending`, converts each write **in
  memory** with the real converter, and posts the shapes to
  `POST /api/mermaid/<path>?layout=<id>`. The server namespaces and stamps them, places them as
  a group clear of the drawing, and commits them as a `kind: "mermaid"` branch whose **author is
  the agent that wrote the Mermaid** and whose `writtenAt` is **the write's time** (the writer's
  clock, or the `.mmd` mtime for a direct write). Hand-drawn shapes stay. Only an **empty board**
  (no live elements) keeps the converter's coordinates, i.e. the layout becomes the board.
  Converted shapes carry the same stamps as server-applied ones, so the next `write_mermaid`
  applies on the server with no tab.
- **Placement** (`tools/mermaid-place.mjs`, shared by the tab path and the grid fallback):
  `write_mermaid` takes an optional `position`: `below`, `right` or `near:<elementOrNodeId>`.
  Without one, the diagram's direction decides: TD/TB (and BT) **below** the drawing, LR/RL **to
  the right**, centered on the drawing's bounding box, 120 px away. `near` tries right, below,
  left, then above the element, sliding outward until the group is clear of every live element
  by 40 px; an unknown element falls back to the default and the op says so. Deterministic.
- **No tab open.** The answer is still 202 `needs-tab`, with `pendingId`, `pending.layoutAt` and
  the schedule. The server checks again **5 s, 15 s and 45 s** after the write (did a tab land it?
  if not, the `mermaid` event goes out again for tabs opened since), and at **2 min** it lays a
  flowchart out itself (`tools/mermaid-grid.mjs`): one row per rank for TD (columns for LR,
  reversed for BT/RL), ranks by longest path with cycle back edges ignored, subgraph members
  next to each other in a rank, then `applyMermaid({ layout })` draws the shapes, straight bound
  arrows and subgraph containers (groups) with the usual conventions. Same author and
  `writtenAt` as the tab path. The schedule is `MERMAID_RETRY_SCHEDULE_MS` (offsets from the
  write), overridable with `mermaidOptions.retryScheduleMs` or `XCLD_MERMAID_RETRY_MS`. A
  **non-flowchart** can't be laid out without a tab: after the schedule it stays pending as
  `waiting-for-tab`.
- **Status.** `GET /api/mermaid/<path>?id=<pendingId>` (MCP `mermaid_status`, `xcld
  mermaid-status [--wait]`) answers `pending` (with `nextAttemptAt`, `layoutAt`), `landing`,
  `landed` (`via`: `tab`, `grid`, or `server` when the source appeared meanwhile and the write
  applied node by node; `version`), `superseded` (a newer write of the same source replaced a
  write still pending) or `waiting-for-tab`. On landing, SSE `mermaid-write` carries the same.
- **Restart.** The records are the journal: on start every record is re-armed on its schedule
  (from its original receive time). A record whose landing branch already committed (the
  source's state names its `pendingId`) is dropped, so nothing lands twice; landing commits
  through the normal branch journal, so nothing is lost either.
- **Named sources.** A write names a source (`source`, default `main`; a letter, then up to 39
  letters, digits, `_` or `-`). Per source the state keeps the last applied Mermaid and hash
  (`mermaidSources`; `main` is also kept as `mermaid` for older readers). **Element ids:** `main`
  keeps the Mermaid id (boards converted before named sources work unchanged); any other source
  uses `<source>:<nodeId>` (edges `<source>:<start>_<end>`, subgraph groups
  `subgraph_group_<source>:<id>`). A source matches, updates and **deletes only its own shapes**
  (by origin); `to-mermaid` rewrites `:` to `_`. The **identical document again is a no-op** (200,
  `noop: true`, no commit). An edited one applies only its differences. A **different diagram
  under the same name** is an edit of that source; when it would delete most of the source's
  nodes and subgraphs, the answer carries `hint.suggestSource` (e.g. `diagram-2`). The inbox
  file `boards/<path>.mmd` is source `main` only.
- **Dual origin.** Every Mermaid-converted element carries `customData.xcldOrigin`:
  `mermaid: { source, nodeId, hash }`, `canvas: { author, at } | null` (the last canvas edit) and
  `active: "mermaid" | "canvas"` (and still `xcldMermaidHash`). The commit step stamps it on
  every non-Mermaid write (tab saves, `write_board`, CLI): an element changed against the
  writer's base gets `canvas` active; one that only lacks the stamps (a tab that never saw them)
  keeps the base's, so it **survives tab saves**; a new element is kept as sent (a human's copy
  of a Mermaid shape has its own id, which no Mermaid write matches or deletes). Direct file
  writes keep their exact bytes and
  aren't stamped. A Mermaid write leaves a canvas-active node alone while **its Mermaid
  definition is unchanged** since the previous source (op `keep-canvas`), and doesn't bring back
  a node or edge deleted on the canvas. **A write that changes the node wins** (last writer takes
  all): Mermaid is active again, and the canvas version goes to history as **overwritten**
  (loser = the canvas author and time), reported in the answer, the banner and the entry's meta.
  `to-mermaid` adds `%% Active origin of <id>: canvas edit by <name> (over Mermaid main:A)` and
  `%% Mermaid source <name>: ...` comments; `diff` tags changes with their active origin.

## Versions storage and commit pipeline

**Status (2026-10-07):** built (`app/server/versions.mjs`) and wired into the server, with the
write API (`POST /api/branch`), tab saves that merge, identities, MCP/CLI writes through
the server, history v2 (change-only entries), Mermaid writes through the same pipeline
(slice 4b, `POST /api/mermaid`), and the tab's side (slice 5: author overlay, banner, save before
reload, Ctrl+S checkpoints). Still to come: the 50-seed concurrency test.

**Where it lives** (lead, 2026-10-07: one setting). The user-facing setting is the cache
folder, `XCLD_CACHE_DIR`, a host path (default `~/.excalidraw`) that compose bind-mounts at
`/xcld-cache`. `xcld history export` always writes `<cache>/exports/<board>/`. Where the
versions data (the "state dir" below) lives is the advanced `XCLD_HISTORY`, which the build
writes for the OS into `.env` once and never overwrites:

| Host | Default `XCLD_HISTORY` | History folder | Why |
|---|---|---|---|
| Linux | `cache` | `<cache>/history/` (in the container `/xcld-cache/history`) | Bind mounts are native and fast. The build creates `<cache>`, `exports/` and `history/` as you and sets `XCLD_UID`/`XCLD_GID`, so the container can write them; the server warns at start when it can't. |
| Windows, macOS (Docker Desktop) | `volume` | the named Docker volume `xcld-state` (`/xcld-state`) | Every file operation on a Docker Desktop bind mount is a slow round trip. Measured on Windows with history on a bind mount: the gate **fails** (p95 6.5 s / 4.2 s, 71 errors; a journal write p50 about 180 ms vs 5–11 ms on the volume). `docker compose down -v` deletes the volume. |

Compose can't pick a mount by value, so it mounts both the cache folder and the volume (the
volume stays empty with `cache`) and passes `XCLD_HISTORY`; the server and `xcld` resolve the
state dir from it (`tools/storage.mjs`). `tests/compose-state.test.mjs` checks both modes with
`docker compose config`. The state dir has the layout below, so on Linux a board's entries are
in `<cache>/history/history/<path>/`. Without `XCLD_HISTORY` (a server run outside compose) it
is `boards/.xcld/`, a dot folder that the watcher, the board list and the exports ignore. On the
first start with another state dir, data under `boards/.xcld/` is copied over once (the old
copy stays; a large history takes a while, during which writes wait). `xcld history export`
copies a board's history out (below).

An earlier development build used `XCLD_STATE_DIR` (a volume name or a host folder) and
`XCLD_EXPORT_DIR` (the export folder). Compose no longer reads them; the build keeps their
lines, prints a one-line notice and adds the mapped settings when they're missing: a folder
`XCLD_STATE_DIR` gives `XCLD_HISTORY=cache` in that folder, a volume name `volume`, and
`XCLD_EXPORT_DIR` (else a folder `XCLD_STATE_DIR`) gives `XCLD_CACHE_DIR`
(`tests/build-env.test.mjs`).

| Path | Holds |
|---|---|
| `branches/<path>/<authorKeySafe>.<id>.json` | The journal: one file per write not yet committed. `{ id, board, author, displayName, base, writtenAt, receivedAt, kind: "json" \| "mermaid", elements, appState?, fileRefs?, template?, ops?, mermaid?, legacy? }`. `id` sorts by arrival time. |
| `history/<path>/<UTC>-<authorKeySafe>.delta.json.gz` | One entry per author turn, as a **delta** against the version the entry started from (history v2, below). |
| `history/<path>/<…>.excalidraw.gz` | Or the entry as a full **checkpoint** record. |
| `history/<path>/<…>.excalidraw` | An entry written before history v2: a full record, read as a checkpoint. |
| `history/<path>/<…>.meta.json` | `{ version, author, displayName, base, parents, applied, overwritten, coalescedCount, closedBy, openedAt, lastCommitAt, lastBranchId, kind, record, depth, pinned?, pinnedAt? }`. An open (human) entry's meta lives in the state until it closes. `record: "none"` marks a meta-only entry (below). |
| `state/<path>.json` | Per board, the commit point: the committed `version`, `masterMeta` (element id → `{ writtenAt, author }`, fed to `mergeBoard`), `last` (the last commit), `open` (the open entry's meta), `mermaid` (the last applied Mermaid source), `records` (record format), `depth` (deltas from the nearest checkpoint to the current version's entry). |
| `bases/<path>/<version>.excalidraw` | The base store: versions that left the server and could otherwise be folded away (full records). |
| `files/<path>/<fileId>.<hash16>.json` | Images (`files` entries), stored once per board. |

- **History v2: change-only entries** (lead, 2026-10-07; `tools/history.mjs`).
  - A **delta** stores what the turn changed against its parent, the version the entry
    started from (the entry before it): the added and changed elements, deletions as
    tombstones (`deleted` ids), the element order as runs of the parent's elements plus the
    new ones, `appState` only when it changed, and the scene's other top-level fields. A
    coalesced human entry rewrites its delta against the same parent each save.
  - A **checkpoint** is the whole board. One is written for a board's first entry, every 20
    entries (`checkpointEvery`), for an entry whose parent can't be read, and when a version
    is pinned (`checkpoint(board, { pin: label })` rewrites the current entry as a
    checkpoint; snapshots as pinned versions will call it). So a version is rebuilt from the
    nearest checkpoint plus **at most 19 deltas**.
  - Both are gzipped JSON. Rebuilt versions are byte-identical to what was committed (they
    hash to their id); the property test checks that for every version.
  - **Migration:** entries from slices 2 and 3 are full records and stay valid as
    checkpoints. A state without `depth` makes the next entry a checkpoint. An open pre-v2
    entry is rewritten as a checkpoint on its next save.
  - **Size, measured** (`node tests/history-size.mjs`: 100 turns at 1,500 elements with
    Excalidraw-like random ids and seeds, about 5 changed elements per turn, human turns of two
    coalesced saves and agent turns that read first): **history 140 MB before, 1.11 MB
    after** (six checkpoints 0.69 MB, 95 deltas 0.11 MB, metas 0.31 MB); bases 69 MB before,
    0 after. With the merge-test fixture elements (fixed seeds, short ids): 130 MB → 0.56 MB.
- **Records.** A base record (and a pre-v2 history record) is the scene with `files` emptied
  plus `"xcld": { schema: 2, version, files: [[fileId, key]] }`; v2 history records carry
  `"xcld": { schema: 3, record, version, parent?, depth, files }`. Images are restored from
  `files/` on read. Ten saves of a board with a 1 MB image add about 1 MB, not 10 MB
  (tested).
- Slice-2 records embedded images. On load, records over 32 KB are migrated (each one is
  replaced atomically, and both layouts stay readable).
- Master stays `boards/<path>.excalidraw`, with images inline.
- **A version id is the sha256 of master's bytes**, the same hash the `ETag` already carries.
  The commit step writes master in Excalidraw's own layout (two-space JSON), so a tab save
  keeps its exact text and hash.
- **Losers stay in history only** (lead, 2026-10-07). An overwritten unit's losing elements
  are kept in the entry meta's `overwritten`, surfaced by the `merged` SSE event (summary, for
  the banner) and by `xcld history export`. Nothing re-applies them: the merge only reports
  them, records hold only committed versions, and a loser never gets a version id, so it
  can't be opened as a canvas version. A write whose every change lost leaves master as it
  is; its losers fold into the author's open entry, or go into a **meta-only entry**
  (`record: "none"`, `closedBy: "unchanged"`, the version it lost against, no record file),
  and the `merged` event still goes out. Tested: random sessions never bring a loser back
  unless a writer sends it again.
- **`xcld history export <board> [--to <dir>] [--full]`** reads the state dir directly
  (`XCLD_HISTORY`), next to a running server. The default writes the records as stored,
  decompressed (`<entry>.checkpoint.json`, `<entry>.delta.json`, `<entry>.meta.json`,
  `files/`); `--full` writes every entry rebuilt as `<entry>.excalidraw` (images inline).
  Both write `index.json`. The default destination is `<cache>/exports/<board>`: compose
  mounts the host's cache folder (`XCLD_CACHE_DIR`) at `/xcld-cache` and passes its host path,
  so `docker exec xcld-collab xcld history export <board>` lands in
  `~/.excalidraw/exports/<board>/` on the host and says so. It refuses any destination in the
  state dir (also through a second path to the same folder).

**Author keys** (lead, 2026-10-06/07):

| Key | Who |
|---|---|
| `human:<name>#<tabId>` | A tab, from its `X-Xcld-Author-Name` and `X-Xcld-Tab` headers. Without them: `human:<XCLD_AUTHOR_NAME or anonymous>#legacy` |
| `agent:<clientName>#<processId>` | `xcld mcp`: MCP `clientInfo.name`, plus 6 hex chars generated once per process, so two sessions of one client differ |
| `cli:<XCLD_AUTHOR>` | `xcld write`; default `cli:cli`. `POST /api/branch` without an author is `cli:api` |
| `external` | A direct write to the master file |
| `init` | The first snapshot of a board that existed before versions, taken on its first read or write |

Equal write times go to the greater key.

The pipeline, per write:

1. **Ingest (Hook 0).** Check the board path, author key, kind, element ids and files. Stamp
   `receivedAt` (and `writtenAt`, if the writer didn't send one; a tab's `X-Xcld-Edit-Age` makes it
   `receivedAt` minus that age, capped at 10 min). Store new images, then write
   the branch file atomically, with an fsync. From here the write is never dropped.
2. **Per-board FIFO queue.** One commit runs per board at a time, in submit order. Different
   boards commit in parallel.
3. **Commit (Hook 2), the only writer of master.**
   - First, adopt any direct write to master (see below). Master's signature (inode, mtime,
     size) tells whether it changed, without reading it.
   - Then fast-forward if master still equals the branch's base; otherwise run `mergeBoard`
     against the base. A fast-forward keeps the writer's own scene.
   - A base that doesn't resolve returns `unknown-base` (409). So does a base on a board that
     was deleted since. Identical content returns `unchanged` and writes nothing.
   - **Write order:**
     1. the history record and meta, in parallel;
     2. `state/<path>.json`, with an fsync: **the commit point, and the writer gets its
        answer here**;
     3. master;
     4. the branch file is deleted.

     The board's queue waits for steps 3 and 4 before the next commit, and GET serves the
     committed text meanwhile. Branches aren't archived: their content is the history record,
     and an overwritten loser's elements are kept in the entry's `overwritten`.
   - **I/O errors are retried**, the commit and the master write alike, with backoff: 0.5, 1,
     2 and 4 s, then every 10 s. The write stays in the journal, the board's queue waits, and
     other boards carry on. `GET /api/status` shows `pending` per board and `failing`
     commits.
4. **Post-commit (Hook 3), after master is written.**
   - An SSE `merged` event `{ name, version, author, applied, overwritten, unbound }`, without
     the loser elements.
   - If master's bytes changed: the usual `board` event and the export and rules hooks.

**Write API** (`app/server/api.mjs`):
- **`POST /api/branch/<path>`** waits up to `WRITE_WAIT_MS` (5 s; `writeWaitMs` in tests) for
  the commit. It answers 200 `merged`, or 202 `queued` with the branch id once the write is
  journaled (never before).
- **`PUT /api/board/<path>`**, the tab, has these semantics (lead Q1):
  - `If-Match` naming the current version: a fast-forward.
  - `If-Match` naming an older version the server knows: **merges**, and returns 200 with
    `merged: true` and the merged master. The tab applies it (it rebases edits made since
    the save, or shows the master as is for an inbox conversion).
  - An unknown base: 409.
  - `If-None-Match: *` starts from an empty board.
  - No header: unguarded.
  - `X-Xcld-Edit-Age` (ms since the tab's last edit): the branch's `writtenAt`, see Ingest.
- **`POST /api/board/<path>/checkpoint`** (Ctrl+S): `checkpoint(board, { author })` for the caller's
  author key (from its identity headers; none: any author). Answers `{ ok, closed, entry, version }`.
- `GET /api/config` exposes `XCLD_AUTHOR_NAME`, which the build seeds from
  `git config user.name` (or the OS user) and never overwrites.

**Coalescing (lead Q2).**
- A human's consecutive commits fold into the open entry; `coalescedCount` counts them.
- The entry closes, with `closedBy` recording why, when:
  - another human commits (`author`);
  - an agent, CLI or external write merges (`agent-merge`);
  - 3 minutes pass with no commit (`idle`, a timer that `close()` cancels);
  - Ctrl+S in the tab (`POST .../checkpoint`, `checkpoint`); it closes only the caller's own entry;
  - the board file is deleted (`deleted`).
- Agent, CLI and external writes never coalesce: each is its own entry, closed at once
  (`agent-write`, or `init`).
- On restart, an open entry past the idle limit is closed.

**Base retention.**
- A version handed out may come back as a base. Coalescing overwrites the open entry, so the
  version it held would vanish. Versions in closed entries stay resolvable from history.
- A version is copied into the base store when:
  - it is read through `GET /api/board` (its ETag), `readMaster` or `readVersion` while it
    isn't a closed entry. MCP `read_board` and `xcld read` read through GET;
  - or a fold would drop it while another queued branch references it. Queued branches
    hold a reference count, from ingest until their commit.
- Copies are kept 24 hours after the last hand-out (`baseTtlMs`), never while referenced or
  current. A copy of a version that becomes a closed history entry is dropped as soon as the
  closing state is durable: history resolves it. The GC runs on load and at most every 10
  minutes per board.
- Base copies are full, uncompressed records (choice, 2026-10-07): they are written on the GET
  path and short-lived, so no delta or gzip work is added there.
- The last 8 versions per board are also kept in memory. That is a bonus, not a guarantee:
  after a restart only the disk counts.
- This is not history pruning (#23).

**Crash recovery (D2).** The branch files are the journal.
- On start, every remaining branch is re-queued, oldest `writtenAt` first.
- A branch whose id is `state.last.branchId` already committed: it is only deleted. If master
  doesn't match the committed version while that branch file still exists, master is rolled
  forward from the history record.
- A crash before the state write replays the commit from the same state, to the same entry
  name, so nothing is applied twice.
- `tests/versions.test.mjs` kills a real process at each step, for a new delta entry, a
  coalesced delta entry and a commit on a checkpoint boundary, then checks that every version
  still rebuilds. The steps are: after ingest, mid-history, after the state write (the answer),
  after master, and before the journal removal.

**External writes.**
- When the watcher sees a settled master that differs from the last committed version, it
  queues an adoption: the file becomes an `external` branch on the last committed version,
  with its mtime as the write time. That is a fast-forward, and master is left as written.
- Every commit also checks master first, so a write the watcher hasn't seen yet is adopted
  before it can be merged over.
- A direct write that lands while a commit runs is journaled as an `external` branch on the
  version it overwrote, and merged right after.
- A deleted master leaves history in place, and the next write starts a new board.
- Files that don't parse, or have elements without ids, aren't adopted. They are logged and
  replaced by the next commit.
- A master read on a Docker Desktop bind mount right after the file was replaced can come back
  short (seen under load). Reads retry until the JSON parses.

**Interfaces used by server-side Mermaid writes (slice 4b)** (`api.versions`, stable):
- `submitBranch(board, { author, displayName?, base, writtenAt?, kind?: "json" | "mermaid", elements | null, appState?, files?, template?, ops?, mermaid?: { source, hash } }, { onIngested?, source?, stages? })`
  resolves to `{ status, version, fastForward, applied, overwritten, unbound, scene, branchId, finished, post, timings? }`.
  - `status` is `committed`, `unchanged`, `unknown-base`, `invalid`, or `queued` after
    `close()`.
  - `onIngested(branchId)` fires once the write is journaled. `finished` resolves when
    master is on disk; `post` when SSE and export ran.
  - `kind: "mermaid"` with `mermaid: { source, hash }` records the applied source per board
    (`readMermaid`). `elements: null` records it without changing master.
  - `writtenAt` should be when the `.mmd` was written, not when it was applied (D8).
  - `stages` adds the caller's own timings (a Mermaid write's `parse`, `read`, `apply`) to the
    commit's timing log (`XCLD_TIMING=1`), which also records the branch `kind`.
- `readVersion(board, version)` → `{ version, text, scene }` (pins the version);
  `readMaster(board)` → the same for the current master; `readMermaid(board)` (from memory once the board is loaded) →
  `{ source, hash, author, writtenAt, appliedAt, branchId, version }` or null.
- Also: `readState(board)` (now with `depth`), `checkpoint(board, { pin?, author? })` (a `pin`
  label makes the current version a full checkpoint and labels its meta; with `author`, only that
  author's open entry is closed), `adoptExternal(board)`,
  `status()`, `timings()`, `whenIdle()`.
- A `status: "unchanged"` result can carry `overwritten` (every change lost); its `post`
  still sends the `merged` event.

## Performance

**Gate (lead, slice 3, release-blocking):** with one board, a simulated tab saving through
`PUT` about once a second, and three agents writing through `POST /api/branch` every 1–3 s
(some on the same units), the end-to-end write latency (submit to merged answer, over HTTP
against the running container) has **p95 ≤ 450 ms** at both 50 and 1,500 elements. The lead
wants it near 250 ms for now and eventually 100 ms.

Reproduce it with `XCLD_TIMING=1 docker compose up -d --wait`, then
`node tests/versions-load.mjs --url http://127.0.0.1:3100`. The script runs 2 minutes and at
least 300 writes per size, prints p50/p95/p99 per writer and per-stage timings, and exits 1
above the gate. It is not part of `node --test tests`.

Measured on a Windows 11 host with Docker Desktop (WSL 2): 300 writes per size, 2 min each,
p50 / p95 / p99 in ms.

| Step | 50 elements | 1,500 elements |
|---|---|---|
| Before tuning (all versions files on the bind mount) | 336 / 1273 / 1592 | 739 / 1265 / 1453 |
| Fewer file operations (mkdir cache, master signature, meta at close, journal removal after the answer, recent versions in memory) | 202 / 933 / 1221 | 429 / 941 / 1470 |
| Answer at the commit point, history files in parallel | 139 / 648 / 810 | 291 / 773 / 1410 |
| Same code, versions data on a named volume (compose default) | **40 / 108 / 142** | **141 / 326 / 457** |

**History v2 re-run** (2026-10-07, image `037755c`, volume storage, same host and scenario).
The host was slower on fsync that day than in the runs above (journal p50 about 19 ms at 50
elements vs 6), so the old image was re-measured in between, on the same day:

| Run | 50 elements | 1,500 elements | Gate |
|---|---|---|---|
| v2, run 1 | 63 / 408 / 1565 | 136 / 336 / 1072 | pass |
| v2, run 2 | 62 / 139 / 229 | 132 / 239 / 294 | pass |
| Slice 3 without v2 (`70451ec`), same day | 58 / 103 / 191 | 139 / **511** / 1300 | **fail** (journal p95 up to 426 ms) |
| v2, run 3 (final image) | **61 / 109 / 176** | **126 / 228 / 296** | pass |

The history stage at 1,500 elements is unchanged within noise (p50 / p95 ms): 3.7–4.4 /
10.1–10.8 in run 3, against 4.8 / 10.2 before v2 and 4.4–4.7 / 8.5–13.4 for the old image the
same day. A delta replaces a 1.3 MB write with a few KB, but on the volume that write was cheap
already; computing it costs about 0.3 ms when the merge kept master's element objects and 2.8 ms
when every element is a freshly parsed object (a fast-forward), and gzipping a checkpoint (every
20th entry) about 7 ms. The tails come from the journal and state fsyncs, which v2 keeps (#30).
History on a Docker Desktop **bind mount** fails the gate (measured: p95 6.5 s / 4.2 s, 71
errors), hence the per-OS default.

Final run, per writer (p50 / p95 / p99 ms):

| Size | Tab (PUT) | Agents (POST) |
|---|---|---|
| 50 | 42 / 106 / 149 | 38 / 108 / 142 |
| 1,500 | 150 / 318 / 435 | 133 / 395 / 466 |

**Where the time goes**, at 1,500 elements, final run, p50 / p95 ms:
- **Before the answer:**
  - CPU: receive (upload and `JSON.parse` of the request) 20–30 / 48–86; merge 23 / 42;
    serialize 6 / 17; respond 4 / 7.
  - I/O: journal 14–16 / 40–44; history 7 / 23–32; state 7 / 13–16; master signature 3.5 / 8.
  - Queue wait 0 / 94–185.
  - Merge share of the server time before the answer: 18.5% (4% at 50 elements).
- **After the answer:** master write 64 / 151–181 (the bind mount); journal removal 1; SSE
  and export 2.5 / 6.
- At 50 elements the time before the answer is mostly I/O: about 16 of 20 ms p50.

**CPU profile** (`node --cpu-prof` of a second server process inside the container, with the
load client in the same container; profiles kept out of git):

| Size | Wall | Idle (waiting on I/O and timers) | GC | Top self time |
|---|---|---|---|---|
| 50 | 122 s | 96.9% | 0.1% | fs calls (open, write, close, rename, stat): no function above 0.2% |
| 1,500 | 130 s | 77.8% | 1.3% | `canonicalText` (`JSON.stringify` of the board) 2.4%, merge `sameFields` 2.0%, request `JSON.parse` in `handle` 1.9%, `mergeBoard` 1.7%, sha256 `update` 1.4% |

By total time at 1,500: `commitBranch` 10.0%, `mergeBoard` 6.2% (`changedIds` 3.1%),
`writeFileAtomic` 2.5%, `canonicalText` 2.4%. That is about 95 ms of server CPU per write,
including agents' GETs.

**Optimizations, ranked by measured effect.** Done in this slice:

| # | Change | Effect | Risk |
|---|---|---|---|
| 1 | Versions data on a named volume (`XCLD_HISTORY=volume`) | p95 648 → 108 (50), 773 → 326 (1,500) | `docker compose down -v` deletes it. Since history v2 the default is per OS: `<cache>/history/` on Linux, the volume on Docker Desktop |
| 2 | Answer at the commit point; master, journal removal, SSE and export after | Takes the master write (p50 30–64, p95 106–181 ms) out of the answer | A file reader may see the previous master for tens of ms; GET serves the committed text. Durability unchanged (D2) |
| 3 | Fewer file operations: mkdir cache, master signature instead of two reads, open entry meta at close, history files in parallel, stat from the write handle | p95 1270 → 933 → 648 on the bind mount (with #2) | Low |
| 4 | Recent versions and master in memory; GET from memory while master is unchanged | Stale-base reads 45 → 0 ms p50 at 1,500; no half-written reads | Low |

Next steps toward 250 ms, then 100 ms (not done):

| # | Idea | Expected saving | Risk |
|---|---|---|---|
| 5 | Delta writes: send `base` plus the changed elements, not the whole board | Receive 20–30 ms p50, 50–86 p95; a smaller journal; half the merge compare. The largest step toward 100 ms | Medium: a new request shape; the journal keeps the delta |
| 6 | Group commit: merge all writes queued for a board in memory, and write one state and one master | The queue-wait tail (p95 94–185 ms) | Medium: per-write failure handling |
| 7 | `masterMeta` as an append log instead of rewriting the map in the state | 2–3 ms, less GC | Low |
| 8 | Tab merge responses carry the changed elements, not the whole master | Respond 4–7 ms plus the tab's parse | Low (slice 5) |
| 9 | Skip the journal fsync, or share one fsync with the state write | 5–10 ms at 1,500 | **Durability on power loss** (not on a process kill): needs the lead's call |
| — | Skipping the content compare when `version`/`versionNonce` match the base | — | Rejected: agents don't bump versions, so their edits would be lost |
| — | A cheaper version id than sha256 of the whole master | 6 ms | Rejected: the ETag contract |

### Mermaid writes (slice 4b)

`node tests/versions-load.mjs --url … --mermaid` runs the same scenario on a board that came from
Mermaid (shapes, labels and tree edges with the Mermaid hash, at most 450 edges because Mermaid
refuses more than 500), plus a fourth writer that sends its own Mermaid through
`POST /api/mermaid` every 1–3 s: 1–3 relabels per write (half on the 15 hot units the tab and
agents also edit) and a new node and edge on one write in five. The Mermaid writer's latency
(submit to answer: parse, apply and commit) is reported on its own and counts toward the gate.

Measured 2026-10-07, image `bde31f4`, volume storage, the same Windows 11 host (journal fsync
p50 about 18–37 ms that day), 2 min per size, p50 / p95 / p99 ms:

| Run | 50 elements | 1,500 elements | Gate |
|---|---|---|---|
| Gate scenario (no Mermaid writer) | 65 / 285 / 822 | 126 / 233 / 325 | pass |
| With the Mermaid writer, all writes | 65 / 159 / 290 | 143 / 293 / 386 | pass |
| Mermaid writes alone (58 and 51 writes) | **74 / 189 / 290** | **245 / 386 / 501** | pass |

Mermaid write stages at 1,500 elements, p50 / p95 ms: parse 88 / 120, read the base 5 / 114
(it waits for the board's queue), apply 40 / 53, then the usual commit (journal 35 / 69, merge
17 / 23, state 18 / 29); before the answer 225 / 375. At 50 elements: parse 16 / 21, apply 1 / 2,
before the answer 58 / 170. Without the parser bundle's FlowDB fix
([above](#server-side-mermaid-apply)) the parse at 1,500 elements was 344 / 393 ms
(measured on the host before the fix).

Next for Mermaid writes (not done): read a recent base from memory without waiting for the
queue (read p95 114 → about 5 ms); parse the previous Mermaid only once per board (it is cached
after the first write, so this matters only after a restart); profile the apply (40 ms at
1,500 elements).

### Mermaid ingestion (slice 6a)

Measured 2026-10-07 on image `a8c2be1` (volume storage, the same Windows 11 host), 2 min per
size, p95 ms of all writes: gate scenario **89.5 / 211.5** (50 / 1,500 elements), with the
Mermaid writer **107.5 / 365.9**: both pass. The Mermaid writes alone were 121.8 / **492.8**
(parse 88 / 123, read 6 / 191, apply 45 / 56, before the answer 258 / 475), above slice 4b's 386:
the apply now also checks each node's canvas origin and Mermaid definition (about +4 ms in an
in-process benchmark at 1,500 elements), and with 51 writes the p95 is the third-slowest one.
The gate counts all writes. That day several other runs of both modes hit 39–77 s pauses in
the file-system stages (journal, state, master; merge and apply stayed normal), also in the
plain gate scenario where none of the new code runs; those runs failed and were repeated.

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
