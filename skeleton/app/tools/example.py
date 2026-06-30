"""Example tool domain.

Each tool domain is a `FastMCP` router mounted into the root server in
app/main.py. Copy this file (e.g. to weather.py), rename the router, write
`@<name>_router.tool` async functions, and `mcp.mount(<name>_router)` in main.

Conventions:
  - tools are `async def` and return plain dicts (JSON-serialisable)
  - catch exceptions and return `{"error": str(e)}` rather than raising, so a
    single failing tool call doesn't kill the session
  - docstrings are the tool's description shown to the model — make them useful
"""

import logging

from fastmcp import FastMCP

logger = logging.getLogger(__name__)

example_router = FastMCP(name="Example Tools")


@example_router.tool
async def ping() -> dict:
    """Connectivity / health check. Returns ok plus the server name."""
    try:
        return {"ok": True, "server": "__MCP_SLUG__"}
    except Exception as e:  # pragma: no cover - illustrative pattern
        logger.exception("ping failed: %s", e)
        return {"error": str(e)}
