# syntax=docker/dockerfile:1.7
#
# xcld-collab — phase B image: local Excalidraw canvas + board API + CLI tools.
#
# Build with build.ps1 / build.sh. They resolve the upstream SHAs (pins.json or
# latest), compute the tag <ours7>-<exc7>-<m2e7>-0000000 (the MCP slot is
# zero-filled until phase A), and pass everything below as
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
# resolves to the source build.
# ----------------------------------------------------------------------------
FROM builder-base AS app
ARG NPM_CONFIG_REGISTRY=""
WORKDIR /src/xcld-collab
COPY --from=vendor / ./app/vendor/
COPY app/package.json app/.npmrc ./app/
WORKDIR /src/xcld-collab/app
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=cache,target=/root/.npm \
    with-registry npm install --no-audit --no-fund
WORKDIR /src/xcld-collab
COPY app/ ./app/
COPY tools/ ./tools/
WORKDIR /src/xcld-collab/app
RUN npm run build
# Record the tree that was bundled into dist/ (runtime deps only); npm ls exits
# non-zero on extraneous/peer warnings, so check the file instead of the exit code.
RUN npm ls --all --omit=dev --json > /src/xcld-collab/resolved-deps.json; \
    test -s /src/xcld-collab/resolved-deps.json

# ----------------------------------------------------------------------------
# runtime: built artifacts only, non-root, no git, no registry config
# ----------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS runtime
ARG OURS_SHA
ARG EXCALIDRAW_SHA
ARG M2E_SHA
ARG BUILD_TAG
LABEL org.opencontainers.image.title="xcld-collab" \
      org.opencontainers.image.description="Shared Excalidraw workspace for humans and agents (Mermaid round trip, semantic diffs)" \
      org.opencontainers.image.source="https://github.com/Hack4Impact/xcld-collab" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${OURS_SHA}" \
      org.opencontainers.image.version="${BUILD_TAG}" \
      io.xcld-collab.excalidraw.sha="${EXCALIDRAW_SHA}" \
      io.xcld-collab.mermaid-to-excalidraw.sha="${M2E_SHA}"
ENV NODE_ENV=production \
    XCLD_HOST=0.0.0.0 \
    XCLD_PORT=3100 \
    XCLD_BOARDS_DIR=/boards
WORKDIR /opt/xcld-collab
# The canvas is a pre-bundled SPA and the server/tools use only Node built-ins,
# so no node_modules ship in the runtime image.
COPY --from=app --chown=node:node /src/xcld-collab/app/dist ./app/dist
COPY --from=app --chown=node:node /src/xcld-collab/app/server ./app/server
COPY --from=app --chown=node:node /src/xcld-collab/app/package.json ./app/package.json
COPY --from=app --chown=node:node /src/xcld-collab/tools ./tools
COPY --from=app --chown=node:node /src/xcld-collab/resolved-deps.json ./resolved-deps.json
COPY --chown=node:node LICENSE NOTICE ./
RUN printf '{\n  "tag": "%s",\n  "xcld-collab": "%s",\n  "excalidraw": "%s",\n  "mermaid-to-excalidraw": "%s"\n}\n' \
      "$BUILD_TAG" "$OURS_SHA" "$EXCALIDRAW_SHA" "$M2E_SHA" > manifest.json \
 && printf '#!/bin/sh\nexec node /opt/xcld-collab/tools/cli.mjs "$@"\n' > /usr/local/bin/xcld \
 && chmod 0755 /usr/local/bin/xcld \
 && mkdir -p /boards \
 && chown node:node /boards
USER node
VOLUME ["/boards"]
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.XCLD_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/xcld-collab/app/server/index.mjs"]
