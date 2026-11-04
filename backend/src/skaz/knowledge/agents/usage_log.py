"""The ``agent_usage`` log: one row of counters per agent run outside the wiki pipeline.

Never text — the question, answer, prompt and tool output stay in their own tables (or nowhere).
A row is written once the run has ended; a failed or stopped run has unknown tokens (``NULL``).
Internal accounting only: SKAZ shows no token or money numbers in the UI.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from ..store.database import KnowledgeDatabase
from .engine import EngineId, Usage


@dataclass(frozen=True)
class RunUsage:
    kind: str
    engine: EngineId
    model: str | None
    effort: str | None
    #: The message state the run ended in (``done``, ``failed``, ``cancelled``, ``interrupted``).
    outcome: str
    usage: Usage | None
    tool_calls: int
    prompt_characters: int
    duration_ms: int
    chat_id: str | None = None
    message_id: str | None = None


class UsageLog:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self._db = db

    def record(self, run: RunUsage) -> None:
        usage = run.usage or Usage()
        with self._db.write() as connection:
            connection.execute(
                "INSERT INTO agent_usage (kind, chat_id, message_id, engine, model, effort, outcome, "
                "input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, reasoning_tokens, "
                "tool_calls, prompt_characters, duration_ms, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (run.kind, run.chat_id, run.message_id, run.engine, run.model, run.effort, run.outcome,
                 usage.input_tokens, usage.cached_input_tokens, usage.cache_write_tokens,
                 usage.output_tokens, usage.reasoning_tokens, run.tool_calls, run.prompt_characters,
                 run.duration_ms, datetime.now(UTC).isoformat(timespec="seconds")),
            )
