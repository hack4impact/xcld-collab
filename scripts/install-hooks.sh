#!/usr/bin/env bash
# Install an optional git pre-commit hook that scans staged changes with gitleaks,
# using the repo's .gitleaks.toml (the same rules CI runs on main). It also rejects a staged
# app/package-lock.json whose resolved URLs aren't public npm (gitleaks' defaults skip lockfiles).
#
#   scripts/install-hooks.sh            # install (refuses to replace a foreign hook)
#   scripts/install-hooks.sh --force    # replace an existing pre-commit hook
#   scripts/install-hooks.sh --remove   # uninstall
#
# Needs gitleaks 8.19+ on PATH (CI pins 8.30.1). Without it the hook warns and lets
# the commit through. Skip it for one commit with `git commit --no-verify`.
# Windows: scripts\install-hooks.ps1 installs the same hook.
set -euo pipefail

marker="# xcld-collab gitleaks pre-commit hook"
mode=install
case "${1:-}" in
  "") ;;
  --force) mode=force ;;
  --remove) mode=remove ;;
  *) echo "usage: $0 [--force|--remove]" >&2; exit 2 ;;
esac

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
hooks="$(git -C "$root" config --get core.hooksPath || git -C "$root" rev-parse --git-path hooks)"
case "$hooks" in /*|[A-Za-z]:*) ;; *) hooks="$root/$hooks" ;; esac
hook="$hooks/pre-commit"

if [ -f "$hook" ] && ! grep -qF "$marker" "$hook"; then
  if [ "$mode" != force ]; then
    echo "$hook exists and was not installed by this script; rerun with --force to replace it." >&2
    exit 1
  fi
fi

if [ "$mode" = remove ]; then
  if [ -f "$hook" ]; then rm -f "$hook"; echo "removed $hook"; else echo "no hook at $hook"; fi
  exit 0
fi

mkdir -p "$hooks"
cat >"$hook" <<EOF
#!/bin/sh
$marker (installed by scripts/install-hooks)
root="\$(git rev-parse --show-toplevel)" || exit 1
# The app lockfile must only name public npm (or vendor tarballs); check the staged copy.
if git diff --cached --name-only --diff-filter=ACMR | grep -qx 'app/package-lock.json'; then
  if command -v node >/dev/null 2>&1; then
    tmp="\$(mktemp)" || exit 1
    git show :app/package-lock.json >"\$tmp" || { rm -f "\$tmp"; exit 1; }
    node "\$root/app/scripts/public-lockfile.mjs" --check "\$tmp"; status=\$?
    rm -f "\$tmp"
    if [ "\$status" -ne 0 ]; then
      echo "pre-commit: run 'npm run lockfile:public' in app/, then stage app/package-lock.json again." >&2
      exit 1
    fi
  else
    echo "pre-commit: node not found on PATH; lockfile registry check skipped." >&2
  fi
fi
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "pre-commit: gitleaks not found on PATH; secret scan skipped." >&2
  exit 0
fi
exec gitleaks git --staged --config "\$root/.gitleaks.toml" --redact --no-banner --verbose "\$root"
EOF
chmod +x "$hook"
echo "installed $hook"
