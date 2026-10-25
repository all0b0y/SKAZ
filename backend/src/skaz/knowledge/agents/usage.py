"""Each agent protocol's token report → one ``Usage`` (counters only; ``None`` = not reported).

One meaning for every engine (it is what the ingest accounting and the chat log store):

* ``input_tokens`` — every input token of the run, cached ones included;
* ``cached_input_tokens`` / ``cache_write_tokens`` — the part of ``input_tokens`` read from /
  written to the provider's prompt cache;
* ``output_tokens`` — every output token, reasoning included;
* ``reasoning_tokens`` — the reasoning part of ``output_tokens``.

The protocols count differently, checked on the installed builds (2026-10-24):

* Codex 0.160 ``thread/tokenUsage/updated`` ``total`` (``codex app-server generate-ts``:
  ``TokenUsageBreakdown``) — OpenAI counting, already in this meaning.
* Claude Code ``result.usage`` — Anthropic counting: ``input_tokens`` leaves out the cache reads
  and writes, so they are added back.
* Hermes 0.22 ACP ``PromptResponse.usage`` — ``inputTokens`` is ``prompt_tokens`` =
  input + cache read + cache write (``agent/usage_pricing.py`` ``CanonicalUsage``), already total.
* OpenCode 1.17 ACP ``usage`` — ``inputTokens`` is the uncached input and ``outputTokens``
  leaves out reasoning (``totalTokens`` = input + output + reasoning + cache read + cache write);
  a zero cache/reasoning count is left out of the reply, so a missing one is 0.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .engine import Usage


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _plus(*values: int | None) -> int | None:
    return None if any(value is None for value in values) else sum(v for v in values if v is not None)


def codex_usage(total: Mapping[str, Any]) -> Usage:
    return Usage(_int(total.get("inputTokens")), _int(total.get("outputTokens")),
                 cached_input_tokens=_int(total.get("cachedInputTokens")),
                 cache_write_tokens=_int(total.get("cacheWriteInputTokens")),
                 reasoning_tokens=_int(total.get("reasoningOutputTokens")))


def claude_usage(usage: Mapping[str, Any]) -> Usage:
    uncached = _int(usage.get("input_tokens"))
    read = _int(usage.get("cache_read_input_tokens"))
    written = _int(usage.get("cache_creation_input_tokens"))
    # Without the cache counts the total is unknown; the uncached part alone would under-report it.
    known_cache = "cache_read_input_tokens" in usage or "cache_creation_input_tokens" in usage
    total = _plus(uncached, read or 0, written or 0) if known_cache else uncached
    return Usage(total, _int(usage.get("output_tokens")), cached_input_tokens=read,
                 cache_write_tokens=written)


def hermes_usage(usage: Mapping[str, Any]) -> Usage:
    return Usage(_int(usage.get("inputTokens")), _int(usage.get("outputTokens")),
                 cached_input_tokens=_int(usage.get("cachedReadTokens")),
                 cache_write_tokens=_int(usage.get("cachedWriteTokens")),
                 reasoning_tokens=_int(usage.get("thoughtTokens")))


def opencode_usage(usage: Mapping[str, Any]) -> Usage:
    if not usage:
        return Usage()
    read = _int(usage.get("cachedReadTokens", 0))
    written = _int(usage.get("cachedWriteTokens", 0))
    thought = _int(usage.get("thoughtTokens", 0))
    return Usage(_plus(_int(usage.get("inputTokens")), read, written),
                 _plus(_int(usage.get("outputTokens")), thought),
                 cached_input_tokens=read, cache_write_tokens=written, reasoning_tokens=thought)
