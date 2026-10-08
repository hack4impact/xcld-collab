# Starts the real-check stack (scripts/real-check/README.md): a separate Compose project on its own
# ports, boards and history, with the demo board laid out and pinned as "kickoff".
#   .\scripts\real-check\start.ps1            # start (or keep) the stack, seed the board if missing
#   .\scripts\real-check\start.ps1 -Reset     # remove the stack, its history volume and boards first
# Needs the image: run .\build.ps1 once (it writes XCLD_TAG to .env).
param(
  [int]$Port = 3241,
  [int]$McpPort = 3242,
  [string]$Project = 'xcld-w2r',
  [string]$Container = 'xcld-w2r',
  [string]$McpContainer = 'xcld-w2r-mcp',
  [string]$Board = 'realcheck/demo',
  [string]$StateRoot = '',
  [switch]$Reset
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $StateRoot) { $StateRoot = Join-Path $repoRoot '.scratch\real-check' }
$boards = Join-Path $StateRoot 'boards'
$cache = Join-Path $StateRoot 'cache'

# Everything below is scoped to this project: its own ports, containers, boards folder, cache
# folder and history volume (<project>_xcld-state). The default stack (3100) is never touched.
$env:XCLD_PORT = "$Port"
$env:XCLD_MCP_PORT = "$McpPort"
$env:XCLD_CONTAINER = $Container
$env:XCLD_MCP_CONTAINER = $McpContainer
$env:XCLD_BOARDS = $boards
$env:XCLD_CACHE_DIR = $cache

Push-Location $repoRoot
try {
  if ($Reset) {
    docker compose -p $Project down -v
    if (Test-Path $StateRoot) { Remove-Item -Recurse -Force $StateRoot }
  }
  New-Item -ItemType Directory -Force $boards, (Join-Path $cache 'exports'), (Join-Path $cache 'history') | Out-Null
  docker compose -p $Project up -d --wait
  if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

  $leaf = Join-Path $boards (($Board -split '/') -join '\')
  if (-not (Test-Path "$leaf.excalidraw")) {
    Write-Host "Seeding $Board from scripts/real-check/demo.mmd ..."
    $answer = Get-Content -Raw (Join-Path $PSScriptRoot 'demo.mmd') | docker exec -i -e XCLD_AUTHOR=seed $Container xcld write-mermaid $Board - --json | ConvertFrom-Json
    if ($answer.status -eq 'needs-tab') {
      Write-Host "A new diagram needs a layout once: open http://127.0.0.1:$Port/?board=$Board now to lay it out at once; otherwise the server lays it out in a grid in about 2 minutes. Waiting ..."
      docker exec $Container xcld mermaid-status $Board $answer.pendingId --wait
    } elseif ($answer.status -ne 'merged') {
      throw "seeding failed: $($answer | ConvertTo-Json -Compress)"
    }
    docker exec $Container xcld snapshot $Board --name kickoff
  } else {
    Write-Host "$Board exists; left as it is (use -Reset for a fresh one)."
  }

  Write-Host ""
  Write-Host "Canvas:   http://127.0.0.1:$Port/?board=$Board"
  Write-Host "Watch:    docker exec -it $Container xcld watch $Board"
  Write-Host "Diff:     docker exec $Container xcld diff $Board --since kickoff"
  Write-Host "Agents:   copilot --additional-mcp-config `"@$(Join-Path $PSScriptRoot 'mcp-config.json')`"  (see README.md)"
  Write-Host "Stop:     docker compose -p $Project down      (add -v to delete this stack's history)"
} finally {
  Pop-Location
}
