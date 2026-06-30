"""__MCP_NAME__ MCP Server — main entry point.

Wrapped by supergateway in production (stdio -> streamableHTTP) via the
systemd user unit `__MCP_SLUG__.service`. Run it directly for local dev:
    uv run start
"""

import logging
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
    """Entry point for the MCP server (stdio transport)."""
    mcp.run()


if __name__ == "__main__":
    main()
