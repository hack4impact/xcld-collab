# syntax=docker/dockerfile:1.7
#
# xcld-collab — phase B image: local Excalidraw canvas + board API + CLI tools.
#
# Build with build.ps1 / build.sh. They resolve the upstream SHAs (pins.json or
# latest), compute the tag <ours7>-<exc7>-<m2e7>-<mcp7>, and pass everything below as
# build args. A plain `docker build .` fails fast because the SHAs are required.
#
# Registry: public npm by default. Pass --build-arg NPM_CONFIG_REGISTRY=<url> to
# use a proxy (only builder stages see it; it never reaches the runtime image).
# Credentials, if ever needed: --secret id=npmrc,src=<path-to-.npmrc>.

ARG BASE_IMAGE=node:22-bookworm-slim

# ----------------------------------------------------------------------------
# builder-base: git + yarn 1.22, shared by all builder stages
# ----------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS builder-base
ARG NPM_CONFIG_REGISTRY=""
ENV CI=true \
    HUSKY=0 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 scripts/fetch-at-sha.sh /usr/local/bin/fetch-at-sha
COPY --chmod=0755 scripts/with-registry.sh /usr/local/bin/with-registry
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    with-registry npm install -g yarn@1.22.22 --force --no-audit --no-fund \
 && yarn --version

# ----------------------------------------------------------------------------
# excalidraw: build the editor packages from source at the pinned SHA
# ----------------------------------------------------------------------------
FROM builder-base AS excalidraw
ARG EXCALIDRAW_REPO=https://github.com/excalidraw/excalidraw.git
ARG EXCALIDRAW_SHA
ARG NPM_CONFIG_REGISTRY=""
RUN fetch-at-sha "$EXCALIDRAW_REPO" "$EXCALIDRAW_SHA" /src/excalidraw
WORKDIR /src/excalidraw
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=cache,id=xcld-excalidraw-yarn,target=/usr/local/share/.cache/yarn,sharing=locked \
    with-registry --rewrite yarn.lock -- yarn install --frozen-lockfile --network-timeout 600000
RUN yarn build:packages
# Pack each published package to a stable file name: /out/<package>.tgz
RUN mkdir -p /out \
 && for p in common math fractional-indexing laser-pointer element excalidraw; do \
      f="$(cd "packages/$p" && npm pack --ignore-scripts --pack-destination /out | tail -n 1)"; \
      mv "/out/$f" "/out/$p.tgz"; \
    done \
 && ls -l /out

# ----------------------------------------------------------------------------
# rules-vocab: the design-rules linter vocabulary (element types, stroke/fill
# styles, arrowheads, roundness, stroke widths, palette), generated from this
# exact Excalidraw checkout. Fails the build if the types or constants can't be
# read. The image ships this file, so a pin bump updates the vocabulary; the
# checked-in copy (tools/rules-vocab.generated.mjs) is for host dev and tests.
# ----------------------------------------------------------------------------
FROM excalidraw AS rules-vocab
ARG EXCALIDRAW_SHA
COPY scripts/gen-rules-vocab.mjs /gen/scripts/gen-rules-vocab.mjs
COPY tools/rules-vocab.generated.mjs /gen/checked-in.mjs
RUN mkdir -p /out \
 && node /gen/scripts/gen-rules-vocab.mjs --source /src/excalidraw --sha "$EXCALIDRAW_SHA" --out /out/rules-vocab.generated.mjs \
 && if ! cmp -s /gen/checked-in.mjs /out/rules-vocab.generated.mjs; then \
      echo "NOTE: tools/rules-vocab.generated.mjs differs from this Excalidraw build; the image uses the generated one. Run node scripts/gen-rules-vocab.mjs on the host after updating pins."; \
      diff /gen/checked-in.mjs /out/rules-vocab.generated.mjs || true; \
    fi

# ----------------------------------------------------------------------------
# mermaid-to-excalidraw: build the converter from source at the pinned SHA
# ----------------------------------------------------------------------------
FROM builder-base AS mermaid-to-excalidraw
ARG M2E_REPO=https://github.com/excalidraw/mermaid-to-excalidraw.git
ARG M2E_SHA
ARG NPM_CONFIG_REGISTRY=""
RUN fetch-at-sha "$M2E_REPO" "$M2E_SHA" /src/mermaid-to-excalidraw
WORKDIR /src/mermaid-to-excalidraw
COPY patches/mermaid-to-excalidraw/ /tmp/mermaid-to-excalidraw-patches/
RUN for patch in /tmp/mermaid-to-excalidraw-patches/*.patch; do \
      [ -e "$patch" ] || continue; \
      git apply --check "$patch"; \
      git apply "$patch"; \
    done
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=cache,id=xcld-m2e-yarn,target=/usr/local/share/.cache/yarn,sharing=locked \
    with-registry --rewrite yarn.lock -- yarn install --frozen-lockfile --network-timeout 600000
RUN yarn build \
 && mkdir -p /out \
 && f="$(npm pack --ignore-scripts --pack-destination /out | tail -n 1)" \
 && mv "/out/$f" /out/mermaid-to-excalidraw.tgz \
 && ls -l /out

# ----------------------------------------------------------------------------
# excalidraw-mcp: MCP Apps UI server at the pinned SHA, patched to remove export
# to excalidraw.com. It keeps the upstream esm.sh widget loading for now; the 3c
# network spike decides whether to serve those dependencies locally or inline.
# ----------------------------------------------------------------------------
FROM builder-base AS excalidraw-mcp
ARG MCP_REPO=https://github.com/excalidraw/excalidraw-mcp.git
ARG MCP_SHA
ARG NPM_CONFIG_REGISTRY=""
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    with-registry npm install -g pnpm@10.11.0 --force --no-audit --no-fund \
 && pnpm --version
RUN fetch-at-sha "$MCP_REPO" "$MCP_SHA" /src/excalidraw-mcp
WORKDIR /src/excalidraw-mcp
COPY patches/excalidraw-mcp/ /patches/excalidraw-mcp/
RUN for p in /patches/excalidraw-mcp/*.patch; do \
      git apply --check "$p"; \
      git apply "$p"; \
    done
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    with-registry pnpm install --frozen-lockfile
RUN pnpm run build

# ----------------------------------------------------------------------------
# vendor: just the tarballs. Export locally for app development with
#   build.ps1 -Target vendor   (writes app/vendor/*.tgz)
# ----------------------------------------------------------------------------
FROM scratch AS vendor
COPY --from=excalidraw /out/ /
COPY --from=mermaid-to-excalidraw /out/ /

# ----------------------------------------------------------------------------
# app: our canvas (Vite) + board server + tools, built against vendor tarballs
# app/package.json references them as file:vendor/<name>.tgz and uses npm
# "overrides" so Excalidraw's own mermaid-to-excalidraw dependency also
# resolves to the source build. app/package-lock.json pins the full tree with
# public npm URLs; with a registry set, with-registry rewrites them in this stage
# only, and `npm ci` fails if the lockfile and package.json disagree.
# XCLD_NO_LOCKFILE=1 (build -NoLockfile / --no-lockfile; tag suffix -nolock) is the
# opt-out for private-registry environments: the lockfile is ignored and
# `npm install --no-package-lock` resolves package.json ranges instead.
# ----------------------------------------------------------------------------
FROM builder-base AS app
ARG NPM_CONFIG_REGISTRY=""
ARG XCLD_NO_LOCKFILE=""
WORKDIR /src/xcld-collab
COPY --from=vendor / ./app/vendor/
COPY app/package.json app/package-lock.json ./app/
WORKDIR /src/xcld-collab/app
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=cache,target=/root/.npm \
    if [ "$XCLD_NO_LOCKFILE" = 1 ]; then \
      rm -f package-lock.json \
   && with-registry npm install --no-package-lock --no-audit --no-fund; \
    else \
      with-registry --rewrite package-lock.json -- npm ci --no-audit --no-fund; \
    fi
WORKDIR /src/xcld-collab
COPY app/ ./app/
COPY tools/ ./tools/
COPY --from=rules-vocab /out/rules-vocab.generated.mjs ./tools/rules-vocab.generated.mjs
WORKDIR /src/xcld-collab/app
RUN npm run build
# Record the tree that was bundled into dist/ (runtime deps only); npm ls exits
# non-zero on extraneous/peer warnings, so check the file instead of the exit code.
# Map registry tarball URLs (a configured registry, or the host it redirects to
# in -nolock builds) to their public npm equivalent, and fail if any other host
# remains: the registry must not reach the runtime image.
RUN npm ls --all --omit=dev --json > /src/xcld-collab/resolved-deps.json; \
    test -s /src/xcld-collab/resolved-deps.json \
 && sed -E -i 's#"resolved": "https?://[^"@]*/((@[^/"]+/)?[^/"@]+/-/[^/"]+\.tgz)"#"resolved": "https://registry.npmjs.org/\1"#g' \
      /src/xcld-collab/resolved-deps.json \
 && ! grep -Eo '"resolved": "[^"]*' /src/xcld-collab/resolved-deps.json \
      | grep -Ev '"resolved": "(https://registry\.npmjs\.org/|file:)'

# ----------------------------------------------------------------------------
# runtime: built artifacts only, non-root, no git, no registry config
# ----------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS runtime
ARG OURS_SHA
ARG EXCALIDRAW_SHA
ARG M2E_SHA
ARG MCP_SHA
ARG BUILD_TAG
LABEL org.opencontainers.image.title="xcld-collab" \
      org.opencontainers.image.description="Shared Excalidraw workspace for humans and agents (Mermaid round trip, semantic diffs)" \
      org.opencontainers.image.source="https://github.com/Hack4Impact/xcld-collab" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${OURS_SHA}" \
      org.opencontainers.image.version="${BUILD_TAG}" \
      io.xcld-collab.excalidraw.sha="${EXCALIDRAW_SHA}" \
      io.xcld-collab.mermaid-to-excalidraw.sha="${M2E_SHA}" \
      io.xcld-collab.excalidraw-mcp.sha="${MCP_SHA}"
ENV NODE_ENV=production \
    XCLD_HOST=0.0.0.0 \
    XCLD_PORT=3100 \
    XCLD_BOARDS_DIR=/boards \
    XCLD_CACHE_DIR=/xcld-cache
WORKDIR /opt/xcld-collab
# The canvas is a pre-bundled SPA and the server/tools use only Node built-ins plus
# esbuild bundles built in the app stage (tools/mcp.bundle.mjs, and
# tools/mermaid-parse.bundle.mjs with jsdom + Mermaid for server-side parsing), so no
# node_modules ship in the runtime image.
COPY --from=app --chown=node:node /src/xcld-collab/app/dist ./app/dist
COPY --from=app --chown=node:node /src/xcld-collab/app/server ./app/server
COPY --from=app --chown=node:node /src/xcld-collab/app/package.json ./app/package.json
COPY --from=app --chown=node:node /src/xcld-collab/tools ./tools
COPY --from=app --chown=node:node /src/xcld-collab/resolved-deps.json ./resolved-deps.json
COPY --from=excalidraw-mcp --chown=node:node /src/excalidraw-mcp/dist ./excalidraw-mcp/dist
COPY --chown=node:node LICENSE NOTICE ./
RUN printf '{\n  "tag": "%s",\n  "xcld-collab": "%s",\n  "excalidraw": "%s",\n  "mermaid-to-excalidraw": "%s",\n  "excalidraw-mcp": "%s"\n}\n' \
      "$BUILD_TAG" "$OURS_SHA" "$EXCALIDRAW_SHA" "$M2E_SHA" "$MCP_SHA" > manifest.json \
 && printf '#!/bin/sh\nexec node /opt/xcld-collab/tools/cli.mjs "$@"\n' > /usr/local/bin/xcld \
 && chmod 0755 /usr/local/bin/xcld \
 && mkdir -p /boards /xcld-state /xcld-cache \
 && chown node:node /boards /xcld-state /xcld-cache \
 && chmod 1777 /xcld-state /xcld-cache
# /xcld-state is where compose mounts the xcld-state volume (version history with
# XCLD_HISTORY=volume); 1777 so a new volume is writable whatever XCLD_UID is. /xcld-cache is
# where compose mounts the host's cache folder (XCLD_CACHE_DIR, default ~/.excalidraw):
# `xcld history export` writes exports/ there, and XCLD_HISTORY=cache keeps history/ there.
USER node
VOLUME ["/boards"]
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.XCLD_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/xcld-collab/app/server/index.mjs"]
