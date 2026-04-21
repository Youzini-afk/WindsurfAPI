FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app

ARG LS_INSTALL_URL=
ARG MIHOMO_INSTALL_URL=
ENV NODE_ENV=production
ENV APP_DATA_DIR=/data/app
ENV WINDSURF_HOME=/data/windsurf
ENV WINDSURF_DATA_DIR=/data/windsurf/data
ENV WORKSPACE_DIR=/tmp/windsurf-workspace
ENV LS_BINARY_PATH=/data/windsurf/language_server_linux_x64
ENV LS_INSTALL_PATH=/data/windsurf/language_server_linux_x64
ENV CLASH_BINARY_PATH=/data/windsurf/mihomo
ENV CLASH_INSTALL_PATH=/data/windsurf/mihomo
ENV HOME=/home/node
ENV PORT=3003

RUN if [ -n "$LS_INSTALL_URL" ]; then bash install-ls.sh --url "$LS_INSTALL_URL"; else bash install-ls.sh; fi \
    && if [ -n "$MIHOMO_INSTALL_URL" ]; then bash install-mihomo.sh --url "$MIHOMO_INSTALL_URL"; else bash install-mihomo.sh; fi \
    && mkdir -p /data/app /data/windsurf/data/db /tmp/windsurf-workspace /home/node \
    && chown -R node:node /app /data /tmp/windsurf-workspace /home/node

USER node
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD sh -c 'curl -fsS "http://127.0.0.1:${PORT:-3003}/ready" > /dev/null || exit 1'
CMD ["node", "src/index.js"]
