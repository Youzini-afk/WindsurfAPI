#!/usr/bin/env bash
# update.sh — one-click update: pull latest + update LS binary + restart PM2
set -e

cd "$(dirname "$0")"

PORT="${PORT:-3003}"
NAME="${PM2_NAME:-windsurf-api}"

echo "=== [1/5] Pull latest ==="
git fetch --quiet origin
BEFORE=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)

if ! git pull --ff-only --quiet 2>/dev/null; then
  echo "    ! remote history rewritten — hard-resetting to origin/master"
  git reset --hard "$REMOTE"
fi

AFTER=$(git rev-parse HEAD)
if [ "$BEFORE" = "$AFTER" ]; then
  echo "    已是最新 / Already up to date"
else
  echo "    $BEFORE → $AFTER"
  git log --oneline "$BEFORE..$AFTER" 2>/dev/null | head -10 || true
fi

echo ""
echo "=== [2/5] Update LS binary ==="
LS_PATH="${LS_BINARY_PATH:-/opt/windsurf/language_server_linux_x64}"
if [ -f .env ]; then
  _lp="$(grep -oP '(?<=LS_BINARY_PATH=).+' .env 2>/dev/null | head -1)"
  [ -n "$_lp" ] && LS_PATH="$_lp"
fi
RELEASE_URL="https://github.com/dwgx/WindsurfAPI/releases/latest/download/language_server_linux_x64"
if [ -f "$LS_PATH" ]; then
  LOCAL_SIZE=$(stat --format=%s "$LS_PATH" 2>/dev/null || stat -f%z "$LS_PATH" 2>/dev/null || echo 0)
  REMOTE_SIZE=$(curl -sI -L "$RELEASE_URL" 2>/dev/null | grep -i content-length | tail -1 | tr -dc '0-9')
  if [ -n "$REMOTE_SIZE" ] && [ "$REMOTE_SIZE" -gt 0 ] && [ "$LOCAL_SIZE" != "$REMOTE_SIZE" ]; then
    echo "    LS binary size changed ($LOCAL_SIZE → $REMOTE_SIZE), downloading..."
    curl -fL --progress-bar -o "$LS_PATH.tmp" "$RELEASE_URL" && mv -f "$LS_PATH.tmp" "$LS_PATH" && chmod +x "$LS_PATH"
    echo "    LS binary updated"
  else
    echo "    LS binary up to date (${LOCAL_SIZE} bytes)"
  fi
else
  echo "    LS binary not found, downloading..."
  mkdir -p "$(dirname "$LS_PATH")"
  curl -fL --progress-bar -o "$LS_PATH" "$RELEASE_URL" && chmod +x "$LS_PATH"
  echo "    LS binary installed"
fi

echo ""
echo "=== [3/5] Stop service ==="
pm2 stop "$NAME" >/dev/null 2>&1 || true
pm2 delete "$NAME" >/dev/null 2>&1 || true
fuser -k "$PORT"/tcp >/dev/null 2>&1 || true
pkill -f "node.*WindsurfAPI/src/index.js" >/dev/null 2>&1 || true

for i in $(seq 1 30); do
  if ! ss -ltn 2>/dev/null | grep -q ":$PORT "; then break; fi
  sleep 1
done

echo ""
echo "=== [4/5] Start service ==="
pm2 start src/index.js --name "$NAME" --cwd "$(pwd)"
pm2 save >/dev/null 2>&1 || true

echo ""
echo "=== [5/5] Health check ==="
sleep 3
if curl -sf "http://localhost:$PORT/health" | head -200; then
  echo ""
  echo ""
  echo "✓ Update complete. Dashboard: http://\$YOUR_IP:$PORT/dashboard"
else
  echo ""
  echo "✗ Health check failed. Check 'pm2 logs $NAME' for details."
  exit 1
fi
