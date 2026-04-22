FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3003 \
    DATA_DIR=/data \
    APP_DATA_DIR=/data \
    WINDSURF_HOME=/opt/windsurf \
    WINDSURF_DATA_DIR=/opt/windsurf/data \
    WORKSPACE_DIR=/tmp/windsurf-workspace \
    LS_BINARY_PATH=/opt/windsurf/language_server_linux_x64 \
    LS_INSTALL_PATH=/opt/windsurf/language_server_linux_x64 \
    CLASH_BINARY_PATH=/opt/windsurf/mihomo \
    CLASH_INSTALL_PATH=/opt/windsurf/mihomo \
    HOME=/home/node \
    LS_PORT=42100

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG LS_INSTALL_URL=
ARG MIHOMO_INSTALL_URL=
COPY package.json ./
COPY src ./src
COPY install-ls.sh install-mihomo.sh setup.sh .env.example ./

RUN sed -i 's/\r$//' install-ls.sh install-mihomo.sh setup.sh \
    && chmod +x install-ls.sh install-mihomo.sh setup.sh \
    && if [ -n "$LS_INSTALL_URL" ]; then bash install-ls.sh --url "$LS_INSTALL_URL"; else bash install-ls.sh; fi \
    && if [ -n "$MIHOMO_INSTALL_URL" ]; then bash install-mihomo.sh --url "$MIHOMO_INSTALL_URL"; else bash install-mihomo.sh; fi \
    && mkdir -p /data /opt/windsurf/data/db /tmp/windsurf-workspace /home/node \
    && chown -R node:node /app /data /opt/windsurf /tmp/windsurf-workspace /home/node

EXPOSE 3003

VOLUME ["/data", "/opt/windsurf", "/tmp/windsurf-workspace"]

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3003) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
