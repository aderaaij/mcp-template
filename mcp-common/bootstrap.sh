#!/usr/bin/env bash
# Recreate the shared supergateway install that all new MCP systemd units point
# at (~/.local/share/mcp-common). Reproducible from the committed lockfile.
#
# Usage: ./bootstrap.sh [DEST]   (DEST default: ~/.local/share/mcp-common)
set -euo pipefail

DEST="${1:-$HOME/.local/share/mcp-common}"
SRC="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DEST"
cp "$SRC/package.json" "$SRC/package-lock.json" "$DEST/"
cd "$DEST"
npm ci

echo "Shared supergateway installed at: $DEST"
"$DEST/node_modules/.bin/supergateway" --version || true
