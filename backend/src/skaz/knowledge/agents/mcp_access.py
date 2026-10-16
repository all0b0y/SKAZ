"""How an engine reaches the SKAZ MCP server for one run (seam with area A1).

The SKAZ MCP server (``knowledge/mcp/``, area A1) serves read-only library
tools at ``http://127.0.0.1:<port>/kb/mcp`` behind a bearer token issued per
run. Engines only need the URL and the token; until A1 lands, adapters take any
``McpAccessProvider`` and refuse tool runs when none is wired.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from .engine import ToolSpec

#: Server name the agents see; tools become ``mcp__skaz__<tool>`` in Claude Code and Hermes.
MCP_SERVER_NAME = "skaz"
MCP_TOOL_PREFIX = f"mcp__{MCP_SERVER_NAME}__"
NO_TOOL_ACCESS = "SKAZ tools are not available right now. Try again after restarting SKAZ."


@dataclass(frozen=True)
class McpAccess:
    url: str
    #: Bearer token valid for this run only; never logged, never put on a command line.
    token: str = field(repr=False)


class McpAccessProvider(Protocol):
    def grant(self, run_id: str, tools: tuple[ToolSpec, ...]) -> McpAccess:
        """Issue access limited to ``tools`` for ``run_id``."""
        ...

    def revoke(self, run_id: str) -> None:
        """End the access issued for ``run_id`` (idempotent)."""
        ...


def tool_name(qualified: str) -> str:
    """``mcp__skaz__search`` -> ``search``; other names are returned unchanged."""
    return qualified[len(MCP_TOOL_PREFIX):] if qualified.startswith(MCP_TOOL_PREFIX) else qualified
