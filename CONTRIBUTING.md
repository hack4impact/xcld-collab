# Contributing to xcld-collab

Thanks for helping. xcld-collab is a small, local tool, so the bar is simple: keep changes
focused, prove they work on a real run, and publish nothing you wouldn't put on a public
repo.

## Dev loop

You need Docker (with Compose), git, Node.js 22, and on macOS/Linux bash and `jq`.

1. **Build upstream packages once.** Excalidraw and mermaid-to-excalidraw are built from
   source at the commits in `pins.json`:

   ```powershell
   .\build.ps1 -Target vendor      # macOS/Linux: ./build.sh --target vendor
   ```

   This writes the tarballs to `app/vendor/`. Don't bump `pins.json` in an unrelated PR.

2. **Build the app.** The tests import the bundled MCP server (`tools/mcp.bundle.mjs`), so
   build before testing:

   ```powershell
   cd app
   npm ci                          # installs exactly app/package-lock.json
   npm run build                   # or `npm run dev` for the canvas with hot reload
   cd ..
   ```

   After `npm install <pkg>` through a private registry, run `npm run lockfile:public`
   before committing so the lockfile only names public npm.

3. **Run the tests** from the repo root:

   ```powershell
   node --test tests
   ```

   `node --test tests` runs only `tests/index.mjs`. **Import every new `*.test.mjs` file
   there**, or it is silently skipped. Browser checks under `tests/browser/` are manual; see
   their README.

4. **Try the real thing.** Build the image and start it:

   ```powershell
   .\build.ps1                     # macOS/Linux: ./build.sh
   docker compose up -d --wait
   ```

   To run a second copy next to one you already use, give it its own ports, container names
   and Compose project, and remove it afterwards:

   ```powershell
   $env:XCLD_PORT=3171; $env:XCLD_MCP_PORT=3172
   $env:XCLD_CONTAINER='xcld-dev'; $env:XCLD_MCP_CONTAINER='xcld-dev-mcp'
   docker compose -p xcld-dev up -d --wait
   docker compose -p xcld-dev down
   ```

If you use an npm proxy, configure it in your user-level npm config or pass it to the build
(`-Registry` / `--registry`). Never commit registry URLs or `.npmrc` changes, and never turn
off TLS verification.

## Before you open a pull request

- **CI runs only after merge to `main`.** Pull requests get no CI, so run the focused tests
  for your change locally (and the full `node --test tests` when you touch shared code) and
  say in the PR what you ran.
- **Commit with your GitHub noreply email**
  (`<id>+<username>@users.noreply.github.com`, see GitHub → Settings → Emails). Set it for
  this repo only: `git config user.email <noreply address>`. CI on `main` fails on any
  commit whose author or committer email is not a noreply address;
  `scripts/check-commit-emails.sh origin/main..` runs the same check on your branch.
- **Scan for secrets.** `scripts/install-hooks.sh` (Windows: `scripts\install-hooks.ps1`)
  installs a gitleaks pre-commit hook that uses the repo's `.gitleaks.toml`, the same rules
  CI enforces on `main`. Install it once per clone.
- **Use LF line endings** (`.gitattributes` handles it; `git diff --check` should be clean).
- **Performance-sensitive changes** (the commit pipeline, merge, Mermaid apply): run the load
  gate locally against your container started with `XCLD_TIMING=1`, plain and with `--mermaid`:

  ```powershell
  node tests/versions-load.mjs --url http://127.0.0.1:3100 --gate 450
  node tests/versions-load.mjs --url http://127.0.0.1:3100 --gate 450 --mermaid
  ```

  Run it on a **quiet machine**: no image builds and no other disk-heavy containers at the same
  time. On Docker Desktop every container shares one disk, and a busy neighbour stalls the
  server's fsyncs for seconds (`--noise` reproduces that on purpose). If a run fails, read its
  slow-I/O lines first: slow `journal.fsync` or `state.fsync` operations mean a busy disk, not
  your change. **The gate of record is the Linux CI `load-gate` job** on `main`, run by a
  maintainer before a release: `gh workflow run ci.yml --ref main -f load_gate=true`
  ([Performance](docs/DESIGN.md#performance)).

## What a good pull request looks like

- **One topic.** Small diffs review faster; split unrelated fixes.
- **Evidence from real runs.** Command output, diffs and screenshots in docs and PR text
  must come from an actual run, not be written by hand or by a model. Say which commands
  you ran and the test count.
- **Nothing private.** No absolute paths from your machine (user or home folders), personal
  emails, internal hostnames, registry URLs, tokens, or boards with real project data. Use
  `boards/sandbox/...` and repo-relative paths in examples.
- **Docs move with behavior.** If a command, tool or default changes, update the
  [README](README.md), [user guide](docs/user-guide.md), [reference](docs/reference.md) and
  the [agent skill](.github/skills/xcld-collab/SKILL.md) in the same PR.
- **Upstreams stay upstream.** Change Excalidraw, mermaid-to-excalidraw or excalidraw-mcp
  behavior with a versioned patch under `patches/<component>/` that applies at build time,
  and send generally useful fixes to the upstream project too.

## Design and boards

Read [docs/DESIGN.md](docs/DESIGN.md) before larger changes; it records the architecture,
the data boundary and the decisions behind them. The design-rules format (`design-rules.csv`,
match vocabulary, briefing, checks) is specified in the
[reference](docs/reference.md#design-rules) and
[DESIGN.md](docs/DESIGN.md#annotation-convention--free-form-by-default-local-design-rules).

Only `boards/examples/` is tracked. Work on copies under `boards/sandbox/`; everything else
in `boards/` is gitignored.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
The image bundles Excalidraw, mermaid-to-excalidraw and excalidraw-mcp, each under its own
license; see [NOTICE](NOTICE). Keep NOTICE current when you add a bundled component.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
