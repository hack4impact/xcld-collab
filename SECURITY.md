# Security policy

## Supported versions

xcld-collab has no releases yet. Only the `main` branch (and images built from it) gets
security fixes. If you run an older build, rebuild from the latest `main` before reporting.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem.

Report it privately through GitHub private vulnerability reporting: the repository's
**Security** tab → **Report a vulnerability**, or
https://github.com/hack4impact/xcld-collab/security/advisories/new.

Include what you can:

- what an attacker can do, and what they need (local process, web page in your browser,
  network access, a crafted board or Mermaid file, ...);
- steps to reproduce, with the commit or image tag (`docker exec xcld-collab cat
  /opt/xcld-collab/manifest.json`);
- whether the optional chat widget (`COMPOSE_PROFILES=widget`) was running.

We aim to acknowledge reports within a week. This is a volunteer-maintained student
project, so fixes land on `main` on a best-effort basis; we credit reporters in the fix
unless you ask us not to.

## Scope

xcld-collab is a **local, single-user tool**. Its threat model is a developer's own
machine.

In scope:

- **The canvas container** (board browser, canvas, `/api/*`, and the `xcld` CLI and MCP
  tools). Compose publishes it on `127.0.0.1` only; inside the container the server binds
  `0.0.0.0` so Docker can reach it. The server rejects requests whose `Host` header is not
  `localhost`, `127.0.0.1` or `[::1]` (DNS rebinding), and only the static
  `/excalidraw-assets/` fonts are served with CORS. Board reads and writes have no
  authentication: any process or user that can reach `127.0.0.1:<port>` on your machine can
  read and change boards. That is by design; report anything that lets a remote web page
  or another machine do the same.
- **Board path handling.** Board names are validated against a strict path grammar; a path
  that escapes the boards folder is a vulnerability.
- **Files the tools read** (`.excalidraw`, `.mmd`, `.view.json`, `design-rules.csv`) when
  they come from someone else, for example a cloned repo.
- **The build** (`build.ps1`, `build.sh`, `Dockerfile`): upstream sources are fetched at
  pinned commit SHAs (`pins.json`) and patched with the files under `patches/`.

Known, accepted behavior (not vulnerabilities on their own):

- **The optional chat widget loads JavaScript from `esm.sh`.** When the `widget` Compose
  profile is enabled, the upstream excalidraw-mcp widget fetches React and Excalidraw from
  `https://esm.sh` at render time, so that third-party CDN is trusted. Leave the profile off
  (`COMPOSE_PROFILES=` in `.env`) for a canvas that makes no outside requests. The widget
  service (`127.0.0.1:3001`) does not enforce the `Host` header yet; that hardening is an
  open item. See the [data boundary](docs/DESIGN.md#data-boundary) for the details.
- Upstream Excalidraw, mermaid-to-excalidraw and excalidraw-mcp are built from source.
  Vulnerabilities in their own code should go to those projects; tell us too if xcld-collab
  makes one reachable.
- `npm audit` findings in build-time and dev-server dependencies that never ship in the
  runtime image. The runtime image contains the pre-bundled canvas, the Node server and
  tools (Node built-ins, plus the MCP SDK bundled into `tools/mcp.bundle.mjs`) and the
  excalidraw-mcp build; it has no `node_modules`.
