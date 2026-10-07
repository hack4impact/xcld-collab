<#
.SYNOPSIS
  Build the xcld-collab image with a tag derived from the exact source commits.

.DESCRIPTION
  Tag: <ours7>-<excalidraw7>-<mermaid-to-excalidraw7>-<excalidraw-mcp7>, plus "-nolock" for
  -NoLockfile builds and "-dirty" when this repo has uncommitted changes. Components disabled
  in pins.json are not built and keep their slot as 0000000 (phase B: <ours7>-<exc7>-<m2e7>-0000000).

  -Mode pinned (default): use the SHAs in pins.json (team/class use, reproducible).
  -Mode latest: resolve each component's branch HEAD with git ls-remote (development).

  npm registry, first match wins: -Registry, $env:XCLD_NPM_REGISTRY, your global
  `npm config get registry` (if not the public default), otherwise public npm.
  The URL is passed to builder stages only and never committed or baked into the image.

  -NoLockfile (or $env:XCLD_NO_LOCKFILE=1): ignore app/package-lock.json and install the app
  with `npm install --no-package-lock` (package.json ranges, through the registry). For
  private-registry environments; not reproducible, so the tag gets "-nolock".

.EXAMPLE
  .\build.ps1
.EXAMPLE
  .\build.ps1 -NoLockfile
.EXAMPLE
  .\build.ps1 -Mode latest -UpdatePins
.EXAMPLE
  .\build.ps1 -Target vendor      # export built upstream tarballs to app\vendor
#>
[CmdletBinding()]
param(
  [ValidateSet('pinned', 'latest')]
  [string]$Mode = 'pinned',
  [string]$Registry,
  [string]$NpmrcPath,
  [switch]$UpdatePins,
  [switch]$NoLockfile,
  [ValidateSet('runtime', 'vendor')]
  [string]$Target = 'runtime',
  [string]$Image = 'xcld-collab',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $PSScriptRoot
$pinsPath = Join-Path $root 'pins.json'
$pins = Get-Content $pinsPath -Raw | ConvertFrom-Json

function Get-Short([string]$sha) { $sha.Substring(0, 7) }

function Resolve-Head([string]$repo, [string]$ref) {
  $line = git ls-remote $repo "refs/heads/$ref" | Select-Object -First 1
  if ($LASTEXITCODE -ne 0 -or -not $line) { throw "git ls-remote failed for $repo ($ref)" }
  ($line -split '\s+')[0]
}

# --- our commit -------------------------------------------------------------
$ours = $null
if (Get-Command git -ErrorAction SilentlyContinue) { $ours = git -C $root rev-parse --verify -q HEAD 2>$null }
$dirty = $true
if ($ours) {
  # boards/ never goes into the image (.dockerignore), so board edits don't make the tag -dirty.
  $dirty = [bool](git -C $root status --porcelain -- . ':(exclude)boards' 2>$null)
} else {
  # No git, a ZIP download, or no commits yet: build anyway, marked unreproducible.
  Write-Warning 'No commit found for this repo; our slot is 0000000 and the tag is marked -dirty.'
  $ours = '0000000000000000000000000000000000000000'
}

# --- upstream SHAs ----------------------------------------------------------
# Tag slots are fixed: <ours>-<excalidraw>-<mermaid-to-excalidraw>-<excalidraw-mcp>.
# A disabled component keeps its slot as 0000000 so every tag has the same shape.
$order = @(
  @{ Name = 'excalidraw';            Arg = 'EXCALIDRAW' },
  @{ Name = 'mermaid-to-excalidraw'; Arg = 'M2E' },
  @{ Name = 'excalidraw-mcp';        Arg = 'MCP' }
)
$disabledSlot = '0000000'
$resolved = [ordered]@{}
$tagParts = @(Get-Short $ours)
foreach ($c in $order) {
  $pin = $pins.components.($c.Name)
  if (-not $pin.enabled) { $tagParts += $disabledSlot; continue }
  $sha = if ($Mode -eq 'latest') { Resolve-Head $pin.repo $pin.ref } else { $pin.sha }
  if ($sha -notmatch '^[0-9a-f]{40}$') { throw "Invalid SHA for $($c.Name): '$sha'" }
  $resolved[$c.Name] = @{ Sha = $sha; Repo = $pin.repo; Arg = $c.Arg }
  $tagParts += Get-Short $sha
  if ($Mode -eq 'latest' -and $sha -ne $pin.sha) {
    Write-Host ("{0,-22} {1} -> {2} (pinned -> latest)" -f $c.Name, (Get-Short $pin.sha), (Get-Short $sha))
  }
}

$noLock = $NoLockfile -or $env:XCLD_NO_LOCKFILE -eq '1'
$tag = ($tagParts -join '-') + $(if ($noLock) { '-nolock' } else { '' }) + $(if ($dirty) { '-dirty' } else { '' })

# --- registry ---------------------------------------------------------------
$registrySource = 'parameter'
if (-not $Registry) { $Registry = $env:XCLD_NPM_REGISTRY; $registrySource = 'XCLD_NPM_REGISTRY' }
if (-not $Registry -and (Get-Command npm -ErrorAction SilentlyContinue)) {
  $npmReg = (npm config get registry 2>$null | Select-Object -First 1)
  if ($npmReg -and $npmReg -notmatch '^https://registry\.(npmjs\.org|yarnpkg\.com)/?$') {
    $Registry = $npmReg.Trim(); $registrySource = 'npm config'
  }
}
if (-not $Registry) { $registrySource = 'public npm' }

# --- docker build -----------------------------------------------------------
$buildArgs = @(
  'build', '--target', $Target,
  '--build-arg', "BASE_IMAGE=$($pins.baseImage)",
  '--build-arg', "OURS_SHA=$ours",
  '--build-arg', "BUILD_TAG=$tag"
)
foreach ($r in $resolved.Values) {
  $buildArgs += @('--build-arg', "$($r.Arg)_REPO=$($r.Repo)", '--build-arg', "$($r.Arg)_SHA=$($r.Sha)")
}
if ($Registry) { $buildArgs += @('--build-arg', "NPM_CONFIG_REGISTRY=$Registry") }
if ($noLock) { $buildArgs += @('--build-arg', 'XCLD_NO_LOCKFILE=1') }
if ($NpmrcPath) {
  if (-not (Test-Path $NpmrcPath)) { throw "NpmrcPath not found: $NpmrcPath" }
  $buildArgs += @('--secret', "id=npmrc,src=$((Resolve-Path $NpmrcPath).Path)")
}
if ($Target -eq 'vendor') {
  $buildArgs += @('--output', "type=local,dest=$(Join-Path $root 'app\vendor')")
} else {
  $buildArgs += @('--tag', "${Image}:$tag")
}
$buildArgs += $root

Write-Host "mode      : $Mode"
Write-Host "registry  : $registrySource"
Write-Host "lockfile  : $(if ($noLock) { 'ignored (npm install --no-package-lock)' } else { 'app/package-lock.json (npm ci)' })"
Write-Host "target    : $Target"
Write-Host "tag       : ${Image}:$tag"
if ($dirty) { Write-Warning 'Working tree is dirty; tag carries -dirty and is not reproducible.' }

if ($DryRun) {
  Write-Host "`ndocker $($buildArgs -join ' ')"
} else {
  & docker @buildArgs
  if ($LASTEXITCODE -ne 0) { throw "docker build failed ($LASTEXITCODE)" }
}

# --- pins update ------------------------------------------------------------
if ($UpdatePins) {
  if ($Mode -ne 'latest') { throw '-UpdatePins requires -Mode latest.' }
  foreach ($name in $resolved.Keys) { $pins.components.$name.sha = $resolved[$name].Sha }
  $digest = docker buildx imagetools inspect ($pins.baseImage -replace '@sha256:.*$', '') --format '{{json .Manifest.Digest}}'
  if ($LASTEXITCODE -eq 0 -and $digest) {
    $pins.baseImage = ($pins.baseImage -replace '@sha256:.*$', '') + '@' + ($digest | ConvertFrom-Json)
  }
  if ($DryRun) { Write-Host "`n(dry run) pins.json would become:"; $pins | ConvertTo-Json -Depth 5 }
  else {
    $json = $pins | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($pinsPath, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
    Write-Host 'pins.json updated.'
  }
}

if (-not $DryRun -and $Target -eq 'runtime') {
  # Hand the tag to compose.yaml via .env, keeping any other user settings in it.
  # The experimental chat widget is opt-in (COMPOSE_PROFILES=widget). The build never writes
  # or removes COMPOSE_PROFILES; earlier builds seeded it, so a kept line only gets a notice.
  $envPath = Join-Path $root '.env'
  $settings = [ordered]@{ XCLD_IMAGE = $Image; XCLD_TAG = $tag }
  $lines = @()
  if (Test-Path $envPath) {
    $lines = @(Get-Content $envPath | Where-Object { $_ -notmatch '^\s*(XCLD_IMAGE|XCLD_TAG)\s*=' })
  }
  # The canvas's default author name (the server can't see the host user). Seeded once from
  # git config user.name, else the OS user; edit it in .env, the build never overwrites it.
  if (-not ($lines | Where-Object { $_ -match '^\s*XCLD_AUTHOR_NAME\s*=' })) {
    $authorName = ''
    try { $authorName = [string](& git -C $root config user.name 2>$null) } catch {}
    if (-not $authorName.Trim()) { $authorName = [Environment]::UserName }
    $authorName = ($authorName -replace '[\r\n#=]', ' ').Trim()
    if ($authorName) { $settings['XCLD_AUTHOR_NAME'] = $authorName }
  }
  # Storage (README, "Where history lives"). XCLD_CACHE_DIR is a host folder (default
  # ~/.excalidraw) for exports and, with XCLD_HISTORY=cache, history. XCLD_HISTORY (advanced) is
  # written once and never overwritten: Linux `cache` (bind mounts are native there),
  # Windows/macOS `volume`, the Docker volume xcld-state (Docker Desktop bind mounts fail the
  # write-latency gate).
  $onLinux = [bool](Get-Variable -Name IsLinux -ValueOnly -ErrorAction SilentlyContinue)
  $hasLine = { param($name) [bool]($lines | Where-Object { $_ -match "^\s*$name\s*=" }) }
  $envValue = {
    param($name)
    $line = $lines | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -Last 1
    if ($line) { ($line -replace "^\s*$name\s*=\s*", '').Trim().Trim('"', "'") }
  }
  $isFolder = { param($value) [bool]($value -and $value -match '[\\/]|^~') }
  # Earlier builds wrote XCLD_STATE_DIR (a volume name or a folder) and read XCLD_EXPORT_DIR (a
  # folder). Compose no longer reads them: map them to the new settings; their lines stay.
  $oldNames = @('XCLD_STATE_DIR', 'XCLD_EXPORT_DIR' | Where-Object { & $hasLine $_ })
  $oldState = & $envValue 'XCLD_STATE_DIR'
  $oldExport = & $envValue 'XCLD_EXPORT_DIR'
  $mapped = @()
  if (-not (& $hasLine 'XCLD_HISTORY')) {
    if ($oldState) {
      $settings['XCLD_HISTORY'] = if (& $isFolder $oldState) { 'cache' } else { 'volume' }
      $mapped += "XCLD_HISTORY=$($settings['XCLD_HISTORY'])"
    } else {
      $settings['XCLD_HISTORY'] = if ($onLinux) { 'cache' } else { 'volume' }
    }
  }
  if (-not (& $hasLine 'XCLD_CACHE_DIR')) {
    $oldCache = if (& $isFolder $oldExport) { $oldExport } elseif (& $isFolder $oldState) { $oldState }
    if ($oldCache) {
      $settings['XCLD_CACHE_DIR'] = $oldCache
      $mapped += "XCLD_CACHE_DIR=$oldCache"
    }
  }
  if ($onLinux) {
    # Bind-mounted folders must be writable by the container user: your uid/gid (as build.sh).
    $lines = @($lines | Where-Object { $_ -notmatch '^\s*(XCLD_UID|XCLD_GID)\s*=' })
    $settings['XCLD_UID'] = (& id -u).Trim()
    $settings['XCLD_GID'] = (& id -g).Trim()
  }
  $lines += $settings.Keys | ForEach-Object { "$_=$($settings[$_])" }
  [System.IO.File]::WriteAllText($envPath, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
  # Create the cache folder and the subfolders the container writes now, as you: Docker would
  # create a missing one owned by root on Linux.
  $history = & $envValue 'XCLD_HISTORY'
  $cache = & $envValue 'XCLD_CACHE_DIR'
  if (-not $cache) { $cache = '~/.excalidraw' }
  $separator = if ($cache -match '\\' -and $cache -notmatch '/') { '\' } else { '/' }
  $cacheSub = { param($name) $cache.TrimEnd('\', '/') + $separator + $name }
  if (-not (& $isFolder $cache)) {
    Write-Warning "XCLD_CACHE_DIR=$cache in .env is not a folder path, so Compose would take it as a volume name. Use a path such as ~/.excalidraw."
  } else {
    $cacheFolder = if ($cache -match '^~(?=$|[\\/])') { Join-Path $HOME $cache.Substring(1).TrimStart('\', '/') } elseif ([System.IO.Path]::IsPathRooted($cache)) { $cache } else { Join-Path $root $cache }
    $folders = @($cacheFolder, (Join-Path $cacheFolder 'exports'))
    if ($history -eq 'cache') { $folders += Join-Path $cacheFolder 'history' }
    foreach ($folder in $folders) {
      $writable = $true
      try { New-Item -ItemType Directory -Force -Path $folder -ErrorAction Stop | Out-Null } catch { $writable = $false }
      if ($writable -and $onLinux) { & test -w $folder; $writable = $LASTEXITCODE -eq 0 }
      if (-not $writable) {
        $fix = if ($onLinux) { " (uid $($settings['XCLD_UID'])), so the container can't write it either. Fix: sudo chown -R $($settings['XCLD_UID']):$($settings['XCLD_GID']) $cacheFolder" } else { '' }
        Write-Warning "$folder is not writable by you$fix"
        break
      }
    }
  }
  Write-Host "`n.env updated (XCLD_TAG=$tag). Start or restart the workspace:"
  Write-Host '  docker compose up -d --wait'
  if ($oldNames) {
    $old = $oldNames -join ' and '
    if ($mapped) {
      Write-Host "Note: .env has $old, which Compose no longer reads; mapped to $($mapped -join ', ') (added to .env). The old lines stay; delete them when you like."
    } else {
      Write-Host "Note: .env has $old, which Compose no longer reads (XCLD_HISTORY and XCLD_CACHE_DIR replace them); delete the old lines when you like."
    }
  }
  switch ($history) {
    'cache' {
      Write-Host "Version history (XCLD_HISTORY=cache): $(& $cacheSub 'history'). Exports: $(& $cacheSub 'exports')."
      if (-not $onLinux) { Write-Warning 'XCLD_HISTORY=cache on Docker Desktop is slow: history in a host folder fails the write-latency gate. The default here is XCLD_HISTORY=volume.' }
    }
    'volume' {
      Write-Host "Version history (XCLD_HISTORY=volume): Docker volume xcld-state; 'docker compose down -v' deletes it. 'docker exec xcld-collab xcld history export <board>' copies a board's history to $(& $cacheSub 'exports')."
    }
    default { Write-Warning "XCLD_HISTORY=$history in .env must be volume or cache; the canvas won't start until it is." }
  }
  if ($lines | Where-Object { $_ -match '^\s*COMPOSE_PROFILES\s*=.*\bwidget\b' }) {
    Write-Host 'Note: COMPOSE_PROFILES in .env enables the experimental chat widget (loads JS from esm.sh). Builds no longer set it and the default is canvas only; remove "widget" from that line to opt out.'
  } else {
    Write-Host 'Chat widget (experimental, loads JS from esm.sh): off. To opt in, add COMPOSE_PROFILES=widget to .env.'
  }
}
