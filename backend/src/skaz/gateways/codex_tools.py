"""Explicit, turn-bound SKAZ dynamic tools; no discovery or built-in actions.

Handlers must validate their own argument schema, source scope and write
permissions. A matching tool name is not authorization to read arbitrary data.
"""
from __future__ import annotations

import asyncio
import math
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

ToolHandler = Callable[[dict[str, Any]], Awaitable[str]]


def tool_failure() -> dict[str, Any]:
    return {
        "success": False,
        "contentItems": [{"type": "inputText", "text": "Tool unavailable or request refused"}],
    }


class CodexTools:
    """A single turn's allowlist; revoke instead of reusing across turns/chats."""

    def __init__(
        self, thread_id: str, turn_id: str, handlers: Mapping[str, ToolHandler], *,
        timeout: float = 15, max_calls: int = 128, max_output_bytes: int = 65536,
        tool_timeouts: Mapping[str, float] | None = None,
    ) -> None:
        if (
            not thread_id or not turn_id or not math.isfinite(timeout) or timeout <= 0
            or max_calls < 1 or max_output_bytes < 1
            or any(not name.startswith("skaz_") for name in handlers)
        ):
            raise ValueError("Invalid Codex tool scope")
        self._thread_id = thread_id
        self._turn_id = turn_id
        self._handlers = dict(handlers)
        self._timeout = timeout
        self._tool_timeouts = dict(tool_timeouts or {})
        if any(n not in handlers or not math.isfinite(t) or t <= 0
               for n, t in self._tool_timeouts.items()):
            raise ValueError("Invalid tool timeout")
        self._max_calls = max_calls
        self._max_output_bytes = max_output_bytes
        self._seen: set[str] = set()
        self._revoked = False

    def revoke(self) -> None:
        self._revoked = True

    def end_turn(self, thread_id: object, turn_id: object) -> bool:
        if thread_id == self._thread_id and turn_id == self._turn_id:
            self.revoke()
            return True
        return False

    async def invoke(self, params: dict[str, Any]) -> dict[str, Any]:
        name, arguments, identity = params.get("tool"), params.get("arguments"), params.get("callId")
        if (
            self._revoked or params.get("threadId") != self._thread_id
            or params.get("turnId") != self._turn_id or params.get("namespace") is not None
            or not isinstance(name, str) or name not in self._handlers
            or not isinstance(arguments, dict) or not isinstance(identity, str) or not identity
            or identity in self._seen or len(self._seen) >= self._max_calls
        ):
            return tool_failure()
        # Consume before awaiting: failures and cancellation must not replay writes.
        self._seen.add(identity)
        try:
            async with asyncio.timeout(self._tool_timeouts.get(name, self._timeout)):
                text = await self._handlers[name](arguments)
            if self._revoked or not isinstance(text, str) or len(text.encode()) > self._max_output_bytes:
                return tool_failure()
            return {"success": True, "contentItems": [{"type": "inputText", "text": text}]}
        except asyncio.CancelledError:
            raise
        except Exception:
            return tool_failure()
