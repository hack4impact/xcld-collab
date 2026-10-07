<#
.SYNOPSIS
  Install an optional git pre-commit hook that scans staged changes with gitleaks.

.DESCRIPTION
  Windows counterpart of scripts/install-hooks.sh; both write the same hook. The hook
  runs `gitleaks git --staged` with the repo's .gitleaks.toml (the rules CI runs on
  main). It also rejects a staged app/package-lock.json whose resolved URLs aren't public npm
  (gitleaks' default config skips lockfiles). Needs gitleaks 8.19+ on PATH (CI pins 8.30.1; `winget install gitleaks`).
  Without it the hook warns and lets the commit through. Skip it for one commit with
  `git commit --no-verify`.

.EXAMPLE
  .\scripts\install-hooks.ps1           # install (refuses to replace a foreign hook)
  .\scripts\install-hooks.ps1 -Force    # replace an existing pre-commit hook
  .\scripts\install-hooks.ps1 -Remove   # uninstall
#>
[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'

$marker = '# xcld-collab gitleaks pre-commit hook'
$root = (git -C $PSScriptRoot rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) { throw 'not inside a git repository' }
$hooks = git -C $root config --get core.hooksPath
if (-not $hooks) { $hooks = git -C $root rev-parse --git-path hooks }
$hooks = $hooks.Trim()
if (-not [System.IO.Path]::IsPathRooted($hooks)) { $hooks = Join-Path $root $hooks }
$hook = Join-Path $hooks 'pre-commit'

if ((Test-Path $hook) -and -not (Select-String -Path $hook -SimpleMatch $marker -Quiet) -and -not $Force) {
  throw "$hook exists and was not installed by this script; rerun with -Force to replace it."
}

if ($Remove) {
  if (Test-Path $hook) { Remove-Item $hook; "removed $hook" } else { "no hook at $hook" }
  return
}

$body = @"
#!/bin/sh
$marker (installed by scripts/install-hooks)
root="`$(git rev-parse --show-toplevel)" || exit 1
# The app lockfile must only name public npm (or vendor tarballs); check the staged copy.
if git diff --cached --name-only --diff-filter=ACMR | grep -qx 'app/package-lock.json'; then
  if command -v node >/dev/null 2>&1; then
    tmp="`$(mktemp)" || exit 1
    git show :app/package-lock.json >"`$tmp" || { rm -f "`$tmp"; exit 1; }
    node "`$root/app/scripts/public-lockfile.mjs" --check "`$tmp"; status=`$?
    rm -f "`$tmp"
    if [ "`$status" -ne 0 ]; then
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
exec gitleaks git --staged --config "`$root/.gitleaks.toml" --redact --no-banner --verbose "`$root"

"@
New-Item -ItemType Directory -Force $hooks | Out-Null
# Git for Windows runs hooks with its own sh; write LF line endings and no BOM.
[System.IO.File]::WriteAllText($hook, ($body -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
"installed $hook"
