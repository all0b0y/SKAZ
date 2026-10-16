"""Which SKAZ skills are on (0.3.1 H3), kept in the ``settings`` table of ``knowledge.sqlite3``.

One flat key per skill (``humanizer_enabled``), on by default, next to the wiki
settings. Every prompt reads it when its turn is built, so a change applies from
the next answer and never touches an answer that is already running.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from ..agents.engine import EngineId
from ..agents.registry import ENGINE_NAMES, AgentView
from . import SkazSkill, catalog, skill

SkillState = Literal["loaded", "not_loaded", "off"]


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


@dataclass(frozen=True)
class EngineSkillStatus:
    engine: EngineId
    state: SkillState
    #: Plain words when ``not_loaded``; ``None`` otherwise.
    reason: str | None


def engine_status(enabled: bool, view: AgentView) -> EngineSkillStatus:
    """``loaded``: the agent can run, and every SKAZ turn it runs carries the skill (see ``prompting``).

    Signed out still counts as loaded — the skill rides on SKAZ's instructions, not on the account;
    Accounts & keys shows the sign-in state.
    """
    if not enabled:
        return EngineSkillStatus(view.engine, "off", None)
    name = ENGINE_NAMES[view.engine]
    if view.state in ("ready", "signed_out"):
        return EngineSkillStatus(view.engine, "loaded", None)
    if view.state == "not_installed":
        return EngineSkillStatus(view.engine, "not_loaded", f"{name} is not installed.")
    if view.state == "outdated":
        return EngineSkillStatus(view.engine, "not_loaded",
                                 f"This {name} version isn't supported. Update it.")
    if view.state == "preparing":
        return EngineSkillStatus(view.engine, "not_loaded", f"{name} is being checked.")
    if view.action == "first_check":
        return EngineSkillStatus(view.engine, "not_loaded", f"{name} needs its one-time check first.")
    return EngineSkillStatus(view.engine, "not_loaded", f"SKAZ couldn't check {name}.")


def engine_statuses(enabled: bool, views: Sequence[AgentView]) -> list[EngineSkillStatus]:
    return [engine_status(enabled, view) for view in views]
