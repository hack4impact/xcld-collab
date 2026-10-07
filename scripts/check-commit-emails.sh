#!/usr/bin/env bash
# Fail if any commit's author or committer email is not a GitHub noreply address.
#
#   scripts/check-commit-emails.sh            # every commit reachable from HEAD
#   scripts/check-commit-emails.sh main~5..   # any `git rev-list` arguments
#
# Allowed: <id>+<login>@users.noreply.github.com, <login>@users.noreply.github.com,
# and noreply@github.com (the committer of commits made in the GitHub web UI).
# Offending addresses are not printed, so the CI log never repeats them; run
#   git log --format='%h %ae %ce' <sha> -1
# locally to see them. Set your address with
#   git config user.email "<id>+<login>@users.noreply.github.com"
set -euo pipefail

[ $# -gt 0 ] || set -- HEAD
allowed='^([A-Za-z0-9._%+-]+@users\.noreply\.github\.com|noreply@github\.com)$'

log="$(git log --format='%H%x09%ae%x09%ce' "$@")"
total=0 bad=0
while IFS=$'\t' read -r sha author committer; do
  [ -n "$sha" ] || continue
  total=$((total + 1))
  fields=""
  [[ "$author" =~ $allowed ]] || fields="author"
  [[ "$committer" =~ $allowed ]] || fields="${fields:+$fields, }committer"
  if [ -n "$fields" ]; then
    bad=$((bad + 1))
    echo "::error::commit ${sha:0:12}: $fields email is not a GitHub noreply address"
  fi
done <<<"$log"

if [ "$bad" -gt 0 ]; then
  echo "$bad of $total commit(s) use a non-noreply author/committer email." >&2
  exit 1
fi
echo "OK: all $total commit(s) use GitHub noreply author and committer emails."
