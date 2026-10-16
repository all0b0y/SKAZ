"""Per-run MCP bearer tokens: one token per agent run, revoked when the run ends.

The SKAZ app token never reaches an agent. A run gets its own random token
bound to the exact SKAZ tool names it may call; ingest runs (no tools) get no
token at all. Only a SHA-256 of each token is kept, compared in constant time.
"""
from __future__ import annotations

import hashlib
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

#: A token outlives no run; this cap only bounds a run whose owner forgot to revoke.
DEFAULT_TOKEN_TTL_S = 6 * 60 * 60
#: Upper bound of tool calls per run over MCP (rate limit, MCP tools spec "Security Considerations").
DEFAULT_MAX_CALLS = 400


@dataclass(frozen=True)
class McpRunScope:
    run_id: str
    #: Exactly the SKAZ tools this run may list and call (never empty: ingest gets no token).
    tools: frozenset[str]


@dataclass
class _Grant:
    scope: McpRunScope
    expires_at: float
    calls: int = 0


class McpTokens:
    def __init__(self, *, ttl_s: float = DEFAULT_TOKEN_TTL_S, max_calls: int = DEFAULT_MAX_CALLS,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl_s = ttl_s
        self._max_calls = max_calls
        self._clock = clock
        self._grants: dict[str, _Grant] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def issue(self, scope: McpRunScope) -> str:
        if not scope.run_id or not scope.tools:
            raise ValueError("An MCP token needs a run id and at least one tool; ingest runs get none.")
        token = "skaz-mcp-" + secrets.token_urlsafe(32)
        with self._lock:
            self._sweep()
            self._grants[self._digest(token)] = _Grant(scope, self._clock() + self._ttl_s)
        return token

    def revoke_run(self, run_id: str) -> None:
        with self._lock:
            for key in [key for key, grant in self._grants.items() if grant.scope.run_id == run_id]:
                del self._grants[key]

    def resolve(self, token: str) -> McpRunScope | None:
        """The scope of a live token, or None (unknown, revoked or expired)."""
        if not token:
            return None
        # Keys are digests of 256-bit random tokens, so a dict lookup leaks nothing useful.
        with self._lock:
            self._sweep()
            grant = self._grants.get(self._digest(token))
            return grant.scope if grant is not None else None

    def count_call(self, token: str) -> bool:
        """Record one tool call; False once the run's call budget is spent."""
        with self._lock:
            grant = self._grants.get(self._digest(token))
            if grant is None:
                return False
            grant.calls += 1
            return grant.calls <= self._max_calls

    def _sweep(self) -> None:
        now = self._clock()
        for key in [key for key, grant in self._grants.items() if grant.expires_at <= now]:
            del self._grants[key]

