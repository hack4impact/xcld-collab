#!/bin/sh
# Usage: with-registry [--rewrite <lockfile>]... [--] <command> [args...]
#
# When NPM_CONFIG_REGISTRY is set (e.g. an internal proxy), routes npm, yarn,
# pnpm and corepack through it, then execs the command. Yarn v1 lockfiles pin
# tarball URLs to the public registry, so --rewrite rewrites those in place.
# With no registry set, the command runs unchanged against public npm.
set -eu
locks=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rewrite) locks="$locks $2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
if [ -n "${NPM_CONFIG_REGISTRY:-}" ]; then
  reg="${NPM_CONFIG_REGISTRY%/}/"
  export NPM_CONFIG_REGISTRY="$reg"
  export YARN_REGISTRY="$reg"
  export COREPACK_NPM_REGISTRY="${reg%/}"
  for lock in $locks; do
    sed -i \
      -e "s#https://registry.yarnpkg.com/#${reg}#g" \
      -e "s#https://registry.npmjs.org/#${reg}#g" \
      "$lock"
  done
fi
exec "$@"
