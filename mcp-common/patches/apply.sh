#!/usr/bin/env bash
# Apply local patches to the shared supergateway install.
#
# supergateway 3.4.3 (latest; published 2025-10) leaks one child process per MCP
# session, which walks each unit into its MemoryMax and gets it OOM-killed --
# often mid-handshake, which clients report as "could not attach to MCP server X"
# while the server itself is perfectly healthy. Two upstream bugs:
#
#   1. --sessionTimeout cannot bound sessions. SessionAccessCounter arms its
#      cleanup timer only when the access count hits exactly 0, and any new access
#      clears it. A client holding an SSE stream reconnects every ~2 min, so the
#      timer is armed and disarmed forever. No timeout value fixes this.
#   2. child.kill() signals only the `/bin/sh -c` wrapper, orphaning the real
#      server for any command sh can't exec away (npx foo -> npm exec -> node).
#
# The files under dist/ here are BUILD OUTPUT from our fork -- do not hand-edit:
#
#     ~/src/supergateway   branch: fix/stateful-session-child-leak
#
# To change behaviour: edit the fork's TypeScript, `npm test && npm run build`,
# then copy dist/index.js and dist/gateways/stdioToStatefulStreamableHttp.js back
# over the ones here. Keeping the fork as the single source means the deployed
# patch is always something we have actually built and tested, and an upstream PR
# stays one `git push` away.
#
# Pinned to the exact upstream version the fork is based on: if the pin moves, this
# refuses to run rather than clobber newer upstream files. Rebase the fork, re-run
# its tests, then bump PATCHED_VERSION.
set -euo pipefail

PATCHED_VERSION="3.4.3"
DEST="${1:-$HOME/.local/share/mcp-common}"
SRC="$(cd "$(dirname "$0")" && pwd)"

SG="$DEST/node_modules/supergateway"
INSTALLED="$(node -p "require('$SG/package.json').version" 2>/dev/null || echo "unknown")"

if [ "$INSTALLED" != "$PATCHED_VERSION" ]; then
  echo "REFUSING TO PATCH: supergateway is $INSTALLED, the fork is based on $PATCHED_VERSION." >&2
  echo "Rebase ~/src/supergateway (branch fix/stateful-session-child-leak) onto the new" >&2
  echo "release, re-run its tests, rebuild, refresh patches/dist/, then bump" >&2
  echo "PATCHED_VERSION in $SRC/apply.sh." >&2
  exit 1
fi

cp "$SRC/dist/index.js" "$SG/dist/index.js"
cp "$SRC/dist/gateways/stdioToStatefulStreamableHttp.js" \
   "$SG/dist/gateways/stdioToStatefulStreamableHttp.js"

echo "Patched supergateway $INSTALLED at $SG"
echo "  - reaps sessions idle past --sessionIdleMs (default 30m); SSE reconnects do NOT count as activity"
echo "  - backstops: --sessionMaxAgeMs (12h), --maxSessions (64), --sweepIntervalMs (1m)"
echo "  - kills the child's whole process group, not just the sh wrapper"
echo "  - returns 404 (not 400) for an expired session so clients re-initialize"
