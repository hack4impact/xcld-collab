#!/usr/bin/env bash
# Build the xcld-collab image with a tag derived from the exact source commits.
# Mirrors build.ps1; see it for full documentation. Requires: docker, git, jq.
#
#   ./build.sh                          # pinned (default): SHAs from pins.json
#   ./build.sh --latest --update-pins   # resolve branch HEADs, rewrite pins.json
#   ./build.sh --target vendor          # export upstream tarballs to app/vendor
#   ./build.sh --no-lockfile            # ignore app/package-lock.json; tag gets -nolock
#   ./build.sh --dry-run
#
# npm registry, first match wins: --registry, $XCLD_NPM_REGISTRY, `npm config get
# registry` (if not the public default), otherwise public npm.
# --no-lockfile (or XCLD_NO_LOCKFILE=1) installs the app with npm install
# --no-package-lock (package.json ranges) for private-registry environments.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pins_path="$root/pins.json"
mode=pinned target=runtime image=xcld-collab registry="" npmrc="" update_pins=0 dry_run=0
no_lock=0; [ "${XCLD_NO_LOCKFILE:-}" = 1 ] && no_lock=1

while [ $# -gt 0 ]; do
  case "$1" in
    --latest) mode=latest ;;
    --pinned) mode=pinned ;;
    --registry) registry="$2"; shift ;;
    --npmrc) npmrc="$2"; shift ;;
    --update-pins) update_pins=1 ;;
    --no-lockfile) no_lock=1 ;;
    --target) target="$2"; shift ;;
    --image) image="$2"; shift ;;
    --dry-run) dry_run=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$target" in runtime|vendor) ;; *) echo "--target must be runtime or vendor" >&2; exit 2 ;; esac
command -v jq >/dev/null || { echo "jq is required (brew install jq / apt install jq)" >&2; exit 1; }

short() { printf '%s' "${1:0:7}"; }

# --- our commit -------------------------------------------------------------
dirty="-dirty"
if command -v git >/dev/null && ours="$(git -C "$root" rev-parse --verify -q HEAD 2>/dev/null)"; then
  # boards/ never goes into the image (.dockerignore), so board edits don't make the tag -dirty.
  [ -n "$(git -C "$root" status --porcelain -- . ':(exclude)boards' 2>/dev/null)" ] || dirty=""
else
  # No git, a ZIP download, or no commits yet: build anyway, marked unreproducible.
  echo "WARNING: no commit found for this repo; our slot is 0000000 and the tag is marked -dirty." >&2
  ours=0000000000000000000000000000000000000000
fi

# --- upstream SHAs: fixed slots <ours>-<exc>-<m2e>-<mcp>; disabled = 0000000 --
build_args=()
tag="$(short "$ours")"
resolved=""   # newline-separated name=sha (bash 3.2 compatible; macOS default)
for entry in excalidraw:EXCALIDRAW mermaid-to-excalidraw:M2E excalidraw-mcp:MCP; do
  name="${entry%%:*}" arg="${entry##*:}"
  if [ "$(jq -r --arg n "$name" '.components[$n].enabled' "$pins_path")" != "true" ]; then
    tag="$tag-0000000"
    continue
  fi
  repo="$(jq -r --arg n "$name" '.components[$n].repo' "$pins_path")"
  ref="$(jq -r --arg n "$name" '.components[$n].ref' "$pins_path")"
  pinned="$(jq -r --arg n "$name" '.components[$n].sha' "$pins_path")"
  if [ "$mode" = latest ]; then
    sha="$(git ls-remote "$repo" "refs/heads/$ref" | awk 'NR==1{print $1}')"
    [ "$sha" != "$pinned" ] && printf '%-22s %s -> %s (pinned -> latest)\n' "$name" "$(short "$pinned")" "$(short "$sha")"
  else
    sha="$pinned"
  fi
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid SHA for $name: '$sha'" >&2; exit 1; }
  resolved="$resolved$name=$sha
"
  tag="$tag-$(short "$sha")"
  build_args+=(--build-arg "${arg}_REPO=$repo" --build-arg "${arg}_SHA=$sha")
done
nolock=""; [ "$no_lock" -eq 1 ] && nolock="-nolock"
tag="$tag$nolock$dirty"

# --- registry ---------------------------------------------------------------
registry_source=parameter
if [ -z "$registry" ]; then registry="${XCLD_NPM_REGISTRY:-}"; registry_source=XCLD_NPM_REGISTRY; fi
if [ -z "$registry" ] && command -v npm >/dev/null; then
  npm_reg="$(npm config get registry 2>/dev/null || true)"
  if [ -n "$npm_reg" ] && ! [[ "$npm_reg" =~ ^https://registry\.(npmjs\.org|yarnpkg\.com)/?$ ]]; then
    registry="$npm_reg"; registry_source="npm config"
  fi
fi
[ -n "$registry" ] || registry_source="public npm"

base_image="$(jq -r '.baseImage' "$pins_path")"
cmd=(docker build --target "$target"
  --build-arg "BASE_IMAGE=$base_image"
  --build-arg "OURS_SHA=$ours"
  --build-arg "BUILD_TAG=$tag"
  ${build_args[@]+"${build_args[@]}"})
[ -n "$registry" ] && cmd+=(--build-arg "NPM_CONFIG_REGISTRY=$registry")
[ "$no_lock" -eq 1 ] && cmd+=(--build-arg "XCLD_NO_LOCKFILE=1")
if [ -n "$npmrc" ]; then
  [ -f "$npmrc" ] || { echo "--npmrc not found: $npmrc" >&2; exit 1; }
  cmd+=(--secret "id=npmrc,src=$(cd "$(dirname "$npmrc")" && pwd)/$(basename "$npmrc")")
fi
if [ "$target" = vendor ]; then
  cmd+=(--output "type=local,dest=$root/app/vendor")
else
  cmd+=(--tag "$image:$tag")
fi
cmd+=("$root")

echo "mode      : $mode"
echo "registry  : $registry_source"
if [ "$no_lock" -eq 1 ]; then echo "lockfile  : ignored (npm install --no-package-lock)"; else echo "lockfile  : app/package-lock.json (npm ci)"; fi
echo "target    : $target"
echo "tag       : $image:$tag"
[ -n "$dirty" ] && echo "WARNING: working tree is dirty; tag carries -dirty and is not reproducible." >&2

if [ "$dry_run" -eq 1 ]; then
  echo; printf '%q ' "${cmd[@]}"; echo
else
  "${cmd[@]}"
fi

# --- pins update ------------------------------------------------------------
if [ "$update_pins" -eq 1 ]; then
  [ "$mode" = latest ] || { echo "--update-pins requires --latest" >&2; exit 1; }
  updated="$(cat "$pins_path")"
  while IFS='=' read -r name sha; do
    [ -n "$name" ] || continue
    updated="$(jq --arg n "$name" --arg s "$sha" '.components[$n].sha = $s' <<<"$updated")"
  done <<<"$resolved"
  base_ref="${base_image%%@*}"
  if digest="$(docker buildx imagetools inspect "$base_ref" --format '{{json .Manifest.Digest}}' 2>/dev/null)"; then
    updated="$(jq --arg b "$base_ref@$(jq -r . <<<"$digest")" '.baseImage = $b' <<<"$updated")"
  fi
  if [ "$dry_run" -eq 1 ]; then
    printf '\n(dry run) pins.json would become:\n%s\n' "$updated"
  else
    printf '%s\n' "$updated" > "$pins_path"; echo "pins.json updated."
  fi
fi

if [ "$dry_run" -eq 0 ] && [ "$target" = runtime ]; then
  # Hand the tag (and, on Linux, your uid/gid for bind-mount writes) to compose.yaml
  # via .env, keeping any other user settings in it. The experimental chat widget is
  # opt-in (COMPOSE_PROFILES=widget). The build never writes or removes COMPOSE_PROFILES;
  # earlier builds seeded it, so a kept line only gets a notice.
  env_path="$root/.env"
  keep=""
  [ -f "$env_path" ] && keep="$(grep -Ev '^[[:space:]]*(XCLD_IMAGE|XCLD_TAG|XCLD_UID|XCLD_GID)[[:space:]]*=' "$env_path" || true)"
  {
    [ -n "$keep" ] && printf '%s\n' "$keep"
    printf 'XCLD_IMAGE=%s\nXCLD_TAG=%s\n' "$image" "$tag"
    if [ "$(uname -s)" = Linux ]; then printf 'XCLD_UID=%s\nXCLD_GID=%s\n' "$(id -u)" "$(id -g)"; fi
  } > "$env_path.tmp" && mv "$env_path.tmp" "$env_path"
  printf '\n.env updated (XCLD_TAG=%s). Start or restart the workspace:\n  docker compose up -d --wait\n' "$tag"
  if printf '%s\n' "$keep" | grep -Eq '^[[:space:]]*COMPOSE_PROFILES[[:space:]]*=.*widget'; then
    echo 'Note: COMPOSE_PROFILES in .env enables the experimental chat widget (loads JS from esm.sh). Builds no longer set it and the default is canvas only; remove "widget" from that line to opt out.'
  else
    echo 'Chat widget (experimental, loads JS from esm.sh): off. To opt in, add COMPOSE_PROFILES=widget to .env.'
  fi
fi
