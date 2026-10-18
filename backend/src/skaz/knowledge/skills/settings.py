"""Which SKAZ skills are on (0.3.1 H3), kept in the ``settings`` table of ``knowledge.sqlite3``.

One flat key per skill (``humanizer_enabled``), on by default, next to the wiki
settings. Every prompt reads it when its turn is built, so a change applies from
the next answer and never touches an answer that is already running.
"""
from __future__ import annotations

from typing import Any, Protocol

from . import SkazSkill, catalog, skill


class SettingsStore(Protocol):
    def get(self, key: str, default: Any = None) -> Any: ...

    def set(self, key: str, value: Any) -> None: ...


def enabled_key(skill_id: str) -> str:
    return f"{skill_id}_enabled"


def is_enabled(settings: SettingsStore, skill_id: str) -> bool:
    return settings.get(enabled_key(skill(skill_id).id), True) is not False


def set_enabled(settings: SettingsStore, skill_id: str, enabled: bool) -> SkazSkill:
    item = skill(skill_id)  # unknown ids are refused before anything is written
    settings.set(enabled_key(item.id), bool(enabled))
    return item


def enabled_skills(settings: SettingsStore) -> tuple[SkazSkill, ...]:
    """The skills to put into a turn's instructions now (read at the moment the turn is built)."""
    return tuple(item for item in catalog() if is_enabled(settings, item.id))
