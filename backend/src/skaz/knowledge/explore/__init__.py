"""0.4.0 B2: the funnel, novelty, findings and the shared ``JobStore`` (``runtime.kb_jobs``).

Importing this package loads nothing; ``build_explore`` is imported by ``runtime.py`` only.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .jobs import SqliteJobStore
    from .service import DecisionChoice, ExploreFunnel

EXPLORE_FINISHED = "explore_finished"


class DecisionChoices:
    """``Deciders`` over ``DecisionService``: the answer to ``decision_model_required`` is the user's own
    explicit choice on the card — "OpenRouter Jev (paid)" includes the cloud consent the Settings switch
    asks for; "Download local model" starts the same download as Settings → Decisions and waits for it."""

    def __init__(self, decisions: Any) -> None:
        self._decisions = decisions

    def layer(self) -> Any:
        return self._decisions.layer()

    def ready(self) -> bool:
        return bool(self._decisions.ready())

    async def choose(self, choice: DecisionChoice) -> bool:
        from ...native_io import disk_call

        if choice == "openrouter_jev":
            await disk_call(self._decisions.configure, "openrouter_jev", True)
            return self.ready()
        await disk_call(self._decisions.configure, "local", None)
        manager = self._decisions.manager
        if not manager.installed():
            try:
                manager.download()
            except Exception:
                return False
            await manager.wait_download()
        return self.ready()


def register_notifications(kb: Any) -> None:
    """``explore_finished``: one navigation button; resolving it changes nothing."""
    from ..notifications.actions import ActionSpec

    if EXPLORE_FINISHED in kb.notification_actions.kinds:
        return

    async def handle(_kb: Any, _notification: Any, _action: str, _text: str | None) -> None:
        return None

    kb.notification_actions.register(
        EXPLORE_FINISHED,
        lambda _record: (ActionSpec("open_explore", "Open in Explore", primary=True),),
        handle,
    )


def build_explore(runtime: Any) -> tuple[SqliteJobStore, ExploreFunnel]:
    """The job store and the funnel, wired to the runtime's own services (explicitly, by attribute)."""
    from ..permissions.search_rules import active_rules
    from .jobs import SqliteJobStore
    from .novelty import AgentNoveltyChecker, WikiClaims
    from .reading import ReadingDesk
    from .service import ExploreFunnel

    kb = runtime.kb
    jobs = SqliteJobStore(kb.db)
    claims = WikiClaims(kb.db)
    rules_store = runtime.kb_search_rules
    areas = runtime.kb_areas
    register_notifications(kb)
    funnel = ExploreFunnel(
        kb,
        jobs,
        directory=areas.directory,
        recorder=areas.recorder,
        finding_mark=areas.store.get_finding_read_mark,
        publication_dates=runtime.kb_freshness,
        deciders=DecisionChoices(runtime.kb_decisions),
        novelty=AgentNoveltyChecker(claims, lambda: runtime.kb_agents.registry),
        claims=claims,
        search_rules=lambda: active_rules(rules_store.global_rules(), None, beta=rules_store.beta()),
        reading=ReadingDesk(
            kb,
            chats=runtime.kb_chats,
            sources=runtime.kb_sources,
            move_mark=areas.move_finding_mark_to_material,
        ),
    )
    return jobs, funnel
