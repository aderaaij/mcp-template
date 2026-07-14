#!/usr/bin/env bash
# Apply local patches to the shared supergateway install.
#
# supergateway 3.4.3 (latest as of 2026-07-14, published 2025-10) leaks one child
# process per MCP session, which walks each unit into its 512M MemoryMax and gets
# it OOM-killed mid-handshake. See patches/stdioToStatefulStreamableHttp.js for
# the two root causes. No upstream fix exists, so we patch.
#
# Pinned to the exact version the patch was written against: if the pin moves,
# this refuses to run rather than clobber a newer upstream file. Re-check the
# patch against the new source, then bump PATCHED_VERSION.
set -euo pipefail

PATCHED_VERSION="3.4.3"
DEST="${1:-$HOME/.local/share/mcp-common}"
SRC="$(cd "$(dirname "$0")" && pwd)"

TARGET_DIR="$DEST/node_modules/supergateway/dist/gateways"
INSTALLED="$(node -p "require('$DEST/node_modules/supergateway/package.json').version" 2>/dev/null || echo "unknown")"

if [ "$INSTALLED" != "$PATCHED_VERSION" ]; then
  echo "REFUSING TO PATCH: supergateway is $INSTALLED, patch was written for $PATCHED_VERSION." >&2
  echo "Review patches/stdioToStatefulStreamableHttp.js against the new upstream source," >&2
  echo "then update PATCHED_VERSION in $SRC/apply.sh." >&2
  exit 1
fi

cp "$SRC/stdioToStatefulStreamableHttp.js" "$TARGET_DIR/stdioToStatefulStreamableHttp.js"
echo "Patched: $TARGET_DIR/stdioToStatefulStreamableHttp.js (supergateway $INSTALLED)"
echo "  - reaps sessions idle past SUPERGATEWAY_SESSION_IDLE_MS (default 30m)"
echo "  - kills the child's whole process group, not just the sh wrapper"
echo "  - returns 404 (not 400) for an expired session so clients re-initialize"
