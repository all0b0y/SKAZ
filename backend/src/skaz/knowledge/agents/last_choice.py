"""The last model and reasoning chosen for each agent in the message field (models screen v2).

Kept in SKAZ's settings of this profile (key ``models.last_chat``), so it survives a restart. A new
chat and a switch to another agent in the message field start from it; a chat that exists keeps
its own model. ``model=None`` is a choice too: "as set in the agent".
"""
from __future__ import annotations

from typing import Any, Protocol

from .engine import EngineId

LAST_CHAT_KEY = "models.last_chat"
_ENGINES: tuple[EngineId, ...] = ("codex", "claude_code", "hermes", "opencode")


class _Settings(Protocol):
    def get(self, key: str, default: Any = None) -> Any: ...

    def set(self, key: str, value: Any) -> None: ...


class LastChoice:
    def __init__(self, settings: _Settings) -> None:
        self.settings = settings

    def all(self) -> dict[EngineId, tuple[str | None, str | None]]:
        raw = self.settings.get(LAST_CHAT_KEY) or {}
        out: dict[EngineId, tuple[str | None, str | None]] = {}
        if not isinstance(raw, dict):
            return out
        for engine in _ENGINES:
            entry = raw.get(engine)
            if not isinstance(entry, dict):
                continue
            model, effort = entry.get("model"), entry.get("effort")
            out[engine] = (model if isinstance(model, str) and model else None,
                           effort if isinstance(effort, str) and effort else None)
        return out

    def get(self, engine: EngineId) -> tuple[str | None, str | None] | None:
        return self.all().get(engine)

    def remember(self, engine: EngineId, model: str | None, effort: str | None) -> None:
        data = {name: {"model": m, "effort": e} for name, (m, e) in self.all().items()}
        data[engine] = {"model": model, "effort": effort}
        self.settings.set(LAST_CHAT_KEY, data)
