#!/usr/bin/env bash
set -euo pipefail

TARGET="${CLASH_INSTALL_PATH:-/opt/windsurf/mihomo}"
VERSION_URL='https://github.com/MetaCubeX/mihomo/releases/latest/download/version.txt'
BASE_URL='https://github.com/MetaCubeX/mihomo/releases/download'

log() { echo -e "\033[1;34m==>\033[0m $*"; }
err() { echo -e "\033[1;31m!!\033[0m  $*" >&2; }

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64)  ASSET='mihomo-linux-amd64-v2' ;;
  aarch64|arm64) ASSET='mihomo-linux-arm64' ;;
  *) err "Unsupported arch: $arch"; exit 1 ;;
esac

mkdir -p "$(dirname "$TARGET")"
tmp="$(mktemp)"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

install_from_gzip() {
  local src="$1"
  gzip -dc "$src" > "$TARGET"
}

get_latest_version() {
  local version
  version="$(curl -fsSL "$VERSION_URL" | tr -d '\r\n')"
  if [[ -z "$version" ]]; then
    err "Could not resolve latest Mihomo version from $VERSION_URL"
    exit 1
  fi
  printf '%s' "$version"
}

if [[ $# -gt 0 && "$1" != "--url" && -f "$1" ]]; then
  log "Installing Mihomo from local file: $1"
  if [[ "$1" == *.gz ]]; then
    install_from_gzip "$1"
  else
    cp -f "$1" "$TARGET"
  fi
elif [[ $# -ge 2 && "$1" == "--url" ]]; then
  url="$2"
  log "Downloading Mihomo from: $url"
  curl -fL --progress-bar -o "$tmp" "$url"
  if [[ "$url" == *.gz ]]; then
    install_from_gzip "$tmp"
  else
    cp -f "$tmp" "$TARGET"
  fi
else
  version="$(get_latest_version)"
  url="$BASE_URL/$version/$ASSET-$version.gz"
  log "Downloading Mihomo asset: $url"
  curl -fL --progress-bar -o "$tmp" "$url"
  install_from_gzip "$tmp"
fi

chmod +x "$TARGET"
size="$(du -h "$TARGET" | cut -f1)"
sha="$(sha256sum "$TARGET" | cut -c1-16)"
log "Installed: $TARGET ($size, sha256:$sha...)"
