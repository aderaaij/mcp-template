"""__MCP_NAME__ MCP Server — main entry point.

Served natively over streamable HTTP in production (MCP_TRANSPORT=http in the
systemd user unit `__MCP_SLUG__.service`; endpoint /mcp). Run it directly for
local dev over stdio:
    uv run start
"""

import logging
import os
from datetime import date

from fastmcp import FastMCP

from app.config import settings

# One import per tool domain. Each module exposes a `<domain>_router` FastMCP
# instance; mount them below. Copy app/tools/example.py to add a new domain.
from app.tools.example import example_router

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

mcp = FastMCP(
    "__MCP_SLUG__",
    instructions=f"""
    Today's date is {date.today().isoformat()}.

    __MCP_DESCRIPTION__
    Single-user system — no user-discovery step is needed.

    Available tools:
    - ping: connectivity / health check (replace with your real tools).
    """,
)

# Mount one router per tool domain. Add more with `mcp.mount(<domain>_router)`.
mcp.mount(example_router)

logger.info("__MCP_SLUG__ initialized. Configured: %s", settings.is_configured())


def main() -> None:
    """Entry point for the MCP server.

    Default transport is stdio (direct clients, local dev). Set
    MCP_TRANSPORT=http (with MCP_HOST / MCP_PORT) to serve streamable HTTP
    natively — no gateway needed; point clients at http://<host>:<port>/mcp
    """
    transport = os.environ.get("MCP_TRANSPORT", "stdio").lower()
    if transport in ("http", "streamable-http"):
        mcp.run(
            transport="http",
            host=os.environ.get("MCP_HOST", "0.0.0.0"),
            port=int(os.environ.get("MCP_PORT", "__MCP_PORT__")),
        )
    else:
        mcp.run()


if __name__ == "__main__":
    main()
