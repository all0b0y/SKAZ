"""Silent refusal of agents' own permission requests (decision A-1) and the agents' tool limits.

Agents change the wiki only through SKAZ's tools; any native request for permission
(Hermes ``session/request_permission`` other than SKAZ's own model switch, a Codex approval,
should one arrive despite ``approvalPolicy: never``) is refused without a UI card. The agent
gets the reason "outside the SKAZ library" so it doesn't try again; the technical log gets
one line without content: engine, kind of action, time (the log record's own).
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)

#: What the agent is told (A-1).
OUTSIDE = "Refused: outside the SKAZ library. Change the wiki only with the SKAZ wiki tools."

#: How long a SKAZ MCP tool call may wait, as the agents' own MCP clients allow it (0.3.1 P).
#:
#: * Claude Code 2.1.281 (``dr``/``$s`` in the installed binary): the hard per-call limit is the
#:   server's ``timeout`` (ms, >= 1000) ?? ``MCP_TOOL_TIMEOUT`` ?? default, clamped to
#:   2147483647 ms; an HTTP server's idle limit is ``CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`` ?? 300000 ms,
#:   raised to the server's ``timeout``. SKAZ writes ``timeout`` = the clamp into its run's
#:   ``mcp.json`` (only SKAZ's server), so neither limit ends a wait for the user.
CLAUDE_MCP_TIMEOUT_MS = 2_147_483_647
#: * Hermes 0.22.1: the per-call deadline is ``timeouts.mcp.tool_call`` (``tools/mcp_tool_common.py``
#:   ``_resolve_tool_timeout``; ACP-given servers carry no ``timeout`` of their own,
#:   ``gateway/session_local_mcp.py:128-142``), clamped to ``MAX_SAFE_TIMEOUT_S`` = 365 days
#:   (``agent/deadline.py:57``); SKAZ sets it in its managed policy. Its HTTP client reads with
#:   ``httpx.Timeout(…, read=300.0)`` (``tools/mcp_tool_transport.py:571``), so SKAZ's server sends
#:   a keep-alive on the event stream of a waiting call (``mcp/server.py``).
HERMES_MCP_TOOL_CALL_S = 31_536_000
#: ``agent.clarify_timeout`` ``<= 0`` = no limit (``tools/clarify_gateway.py:273-283``).
HERMES_CLARIFY_TIMEOUT_S = 0


def refused(engine: str, action: str) -> None:
    """The log line of a refusal: engine and kind of action only — never paths, commands or text."""
    log.info("Refused %s request of %s: outside the SKAZ library", action[:80], engine)
