"""0.4.0 B3: research tasks — their chats, the permission card, the research agent and the agent tools.

Importing this package loads nothing; ``build_research`` is imported by ``runtime.py`` only.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .service import ResearchTasks

RESEARCH_FINISHED = "research_finished"
OPEN_TASK = "open_research_task"


def register_notifications(kb: Any) -> None:
    """``research_finished``: one navigation button ("Open task"); resolving it changes nothing."""
    from ..notifications.actions import ActionSpec

    if RESEARCH_FINISHED in kb.notification_actions.kinds:
        return

    async def handle(_kb: Any, _notification: Any, _action: str, _text: str | None) -> None:
        return None

    kb.notification_actions.register(
        RESEARCH_FINISHED,
        lambda _record: (ActionSpec(OPEN_TASK, "Open task", primary=True),),
        handle,
    )


def build_research(runtime: Any) -> ResearchTasks:
    """The research service over B2's funnel (``kb_explore`` is both ``FunnelRunner`` and
    ``ExploreService``), B4's areas, the chats and the user's own chat agent — wired explicitly."""
    from .agent import ResearchAgent
    from .service import ResearchTasks
    from .store import ResearchStore
    from .tools import research_tools

    kb = runtime.kb
    store = ResearchStore(kb.db)
    store.ensure_columns()
    register_notifications(kb)
    research = ResearchTasks(
        kb,
        store,
        funnel=runtime.kb_explore,
        explore=runtime.kb_explore,
        areas=runtime.kb_areas,
        chats=runtime.kb_chats,
        agent=ResearchAgent(lambda: runtime.kb_agents.registry),
        waits=runtime.kb_waits,
        runs=runtime.kb_chats.run_ref,
    )
    runtime.kb_chats.attach_research(research)
    runtime.kb_tools.add(research_tools(research, runtime.kb_chats.run_ref))
    return research
