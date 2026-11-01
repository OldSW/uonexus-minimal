# UO Nexus (minimal) - https://github.com/jenschude/uonexus-minimal (branch mac-fixes)
#
# Everything is built from one checkout of the fork (UONEXUS_REPO @ UONEXUS_REF), no release
# zip involved. Targets:
#   client - the client bundle only (copied into a shared volume on start)
#   proxy  - Node WebSocket relay (UO protocol <-> browser)
#   nginx  - plain nginx with upstream's config; serves the bundle from a mounted volume
#
# The client is compiled here (.NET 10 + wasm-tools, C# -> WASM, AOT). That takes ~10+ minutes
# and a few GB of RAM on a cold build; BuildKit caches it until UONEXUS_REF's commit changes.
# Pin UONEXUS_REF to a commit SHA (or tag) for reproducible builds; a branch name is only
# re-fetched when the cache is busted (--no-cache, or change UONEXUS_REV).

ARG UONEXUS_REPO=https://github.com/OldSW/uonexus-minimal.git
ARG UONEXUS_REF=mac-fixes
ARG UONEXUS_REV=1

# --- source (server code + nginx config + client source) --------------------
FROM alpine/git AS source
ARG UONEXUS_REPO
ARG UONEXUS_REF
ARG UONEXUS_REV
RUN git clone --depth 1 --branch "$UONEXUS_REF" "$UONEXUS_REPO" /src \
    && echo "uonexus rev $UONEXUS_REV: $(git -C /src rev-parse HEAD)"

# --- compile the client bundle ---------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS client-build
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
# python3: emscripten; libatomic1: emscripten's bundled node; node 22: the build-web scripts
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 libatomic1 rsync git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
RUN dotnet workload install wasm-tools
WORKDIR /repo
COPY --from=source /src/ ./
# build.sh derives WebClientVersion from `git describe`; there is no .git here
ARG UONEXUS_REF
ENV WEBCLIENT_VERSION=${UONEXUS_REF}
RUN CLIENT_NAME=cuo bash ./server/scripts/build.sh prod \
    && node server/scripts/build-minimal-bundle.mjs cuo \
    && test -d client/minimal/_framework

# --- client image: just the bundle -----------------------------------------------
FROM busybox:stable AS client
COPY --from=client-build /repo/client/minimal /client
CMD ["sh", "-c", "cp -a /client/. /out/"]

# --- proxy -------------------------------------------------------------------
FROM node:22-alpine AS proxy
ARG APP_UID=1000
ARG APP_GID=1000
WORKDIR /app

COPY --from=source /src/server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=source /src/server/tsconfig.json ./
COPY --from=source /src/server/src/ ./src/
COPY --from=source /src/server/scripts/check-build-tag.mjs /src/server/scripts/check-src-syntax.mjs \
     /src/server/scripts/minimal-asset-worker.mjs /src/server/scripts/bake-worldmap.mjs /src/server/scripts/_hashFile.mjs ./scripts/
RUN node scripts/check-build-tag.mjs src/shared/UOProxy.ts \
    && node scripts/check-src-syntax.mjs

RUN deluser node 2>/dev/null || true \
    && delgroup node 2>/dev/null || true \
    && if ! getent group ${APP_GID} >/dev/null 2>&1; then addgroup -g ${APP_GID} nodegrp; fi \
    && _grp=$(getent group ${APP_GID} | cut -d: -f1) \
    && adduser -D -u ${APP_UID} -G "${_grp}" -s /bin/sh node \
    && mkdir -p /app/data /home/node/.npm \
    && chown -R ${APP_UID}:${APP_GID} /app /home/node \
    && chmod -R u=rwX,go=rX /app /home/node
USER node
ENV DOCKER=1 NODE_ENV=production HOME=/home/node \
    NPM_CONFIG_CACHE=/tmp/.npm NPM_CONFIG_LOGS_DIR=/tmp/.npm/_logs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider --tries=1 http://127.0.0.1:3000/api/config || exit 1
CMD ["npm", "run", "start:minimal"]

# --- nginx -------------------------------------------------------------------
FROM alpine:3.20 AS nginx
RUN apk add --no-cache nginx nginx-mod-http-brotli \
    && mkdir -p /var/log/nginx /var/cache/nginx /var/run /var/lib/nginx/logs /var/lib/nginx/tmp \
    && chown -R nginx:nginx /var/log/nginx /var/cache/nginx /var/lib/nginx \
    && chmod -R a+rX /var/lib/nginx /var/cache/nginx /var/log/nginx
COPY --from=source /src/server/deploy/nginx.main.conf /etc/nginx/nginx.conf
COPY --from=source /src/server/deploy/nginx.minimal.conf /etc/nginx/conf.d/default.conf
RUN chmod 644 /etc/nginx/nginx.conf
EXPOSE 80
STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
