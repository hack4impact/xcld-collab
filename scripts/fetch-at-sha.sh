#!/bin/sh
# Usage: fetch-at-sha <repo-url> <full-sha> <dest-dir>
# Fetches exactly one commit and fails if HEAD does not match the requested SHA.
set -eu
repo="$1"; sha="$2"; dest="$3"
case "$sha" in
  *[!0-9a-f]*|'') bad=1 ;;
  *) bad=0 ;;
esac
if [ "$bad" -ne 0 ] || [ "${#sha}" -ne 40 ]; then
  echo "fetch-at-sha: '$sha' is not a full 40-char commit SHA (use build.ps1/build.sh)" >&2
  exit 1
fi
git init -q "$dest"
git -C "$dest" remote add origin "$repo"
git -C "$dest" fetch -q --depth 1 origin "$sha"
git -C "$dest" checkout -q FETCH_HEAD
actual="$(git -C "$dest" rev-parse HEAD)"
if [ "$actual" != "$sha" ]; then
  echo "fetch-at-sha: expected $sha, got $actual" >&2
  exit 1
fi
echo "fetched $repo @ $sha"
