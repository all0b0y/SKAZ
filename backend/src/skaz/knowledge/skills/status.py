"""Per agent, whether its turns carry SKAZ's skills now (Settings → Skills → Applies to)."""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from ..agents.engine import EngineId
from ..agents.registry import ENGINE_NAMES, AgentView

SkillState = Literal["loaded", "not_loaded", "off"]


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
        # Also a launcher SKAZ can't trust or start: the agent's own reason says which.
        return EngineSkillStatus(view.engine, "not_loaded",
                                 view.status.reason or f"This {name} version isn't supported. Update it.")
    if view.state == "preparing":
        return EngineSkillStatus(view.engine, "not_loaded", f"{name} is being checked.")
    if view.action == "first_check":
        return EngineSkillStatus(view.engine, "not_loaded", f"{name} needs its one-time check first.")
    return EngineSkillStatus(view.engine, "not_loaded", f"SKAZ couldn't check {name}.")


def engine_statuses(enabled: bool, views: Sequence[AgentView]) -> list[EngineSkillStatus]:
    return [engine_status(enabled, view) for view in views]
