"""Maintenance contracts for SKAZ 0.4.0 and B6's weekly check (``runtime.kb_maintenance``).

Importing this package loads nothing else: ``api/maintenance.py`` imports ``maintenance.protocols``, and
the service imports the API schemas, so ``build_maintenance`` is imported lazily by ``runtime.py`` only.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..areas.protocols import AreaDirectory
    from ..freshness.protocols import PublicationDates
    from .deps import IngestStarter, LinkIntake, LinkObservations, WeeklyFunnel, WeeklyJobs, WeeklyScience
    from .service import Maintenance

VIEW_CHECK = "view_check"
CHECK_NOVELTY = "check_novelty"
REVIEW_UPDATES = "review_updates"


def register_notifications(kb: Any) -> None:
    """``weekly_check_started`` (View check) and ``weekly_check_finished`` (Check novelty when candidates
    wait; Review source updates when sources changed). All navigate; resolving one changes nothing."""
    from ..notifications.actions import ActionSpec
    from .service import FINISHED, STARTED

    async def navigate(_kb: Any, _notification: Any, _action: str, _text: str | None) -> None:
        return None

    def finished(record: Any) -> tuple[ActionSpec, ...]:
        payload = record.payload or {}
        buttons: list[ActionSpec] = []
        if payload.get("candidates_waiting"):
            buttons.append(ActionSpec(CHECK_NOVELTY, "Check novelty", primary=True))
        if payload.get("new_versions") or payload.get("retractions") or payload.get("newer_contradictions"):
            buttons.append(ActionSpec(REVIEW_UPDATES, "Review source updates", primary=not buttons))
        return tuple(buttons)

    actions = kb.notification_actions
    if STARTED not in actions.kinds:
        actions.register(
            STARTED, lambda _record: (ActionSpec(VIEW_CHECK, "View check", primary=True),), navigate
        )
    if FINISHED not in actions.kinds:
        actions.register(FINISHED, finished, navigate)


def build_maintenance(
    kb: Any,
    *,
    jobs: WeeklyJobs,
    science: WeeklyScience,
    funnel: WeeklyFunnel,
    areas: AreaDirectory,
    dates: PublicationDates,
    links: LinkObservations,
    sources: LinkIntake,
    ingest: IngestStarter,
) -> Maintenance:
    """The weekly check and the N1 marks, on the runtime's own services (passed explicitly)."""
    from .service import Maintenance

    register_notifications(kb)
    return Maintenance(
        kb,
        jobs=jobs,
        science=science,
        funnel=funnel,
        areas=areas,
        dates=dates,
        links=links,
        sources=sources,
        ingest=ingest,
    )
