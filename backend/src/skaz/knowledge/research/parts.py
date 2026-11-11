"""The ``type: "research"`` chat part: a card while it waits, then the compact pointer to its task.

Blocking (``disk_call``). The task's title and state are read now, so a pointer shows the task as it is.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any, cast

from ..api.schemas_explore_common import KbExploreJob
from ..api.schemas_research import KbResearchCreate, KbResearchPermission
from .store import PermissionRow, ResearchStore, TaskRow

JobLookup = Callable[[str], KbExploreJob | None]


def permission_view(
    row: PermissionRow, task: TaskRow | None, job: KbExploreJob | None
) -> KbResearchPermission:
    return KbResearchPermission(
        type="research",
        id=row.id,
        engine=cast(Any, row.engine),
        chat_id=row.chat_id,
        arguments=KbResearchCreate.model_validate(dict(row.arguments)),
        topics=list(row.topics),
        status=row.status,
        auto=row.auto,
        reason=row.reason,
        task_id=task.id if task is not None else None,
        task_title=task.title if task is not None else None,
        task_state=job.state if job is not None else None,
        created_at=datetime.fromisoformat(row.created_at.replace("Z", "+00:00")),
    )


def research_part(store: ResearchStore, jobs: JobLookup, permission_id: str) -> KbResearchPermission | None:
    """The part as shown now; ``None`` once the card is gone (its chat was deleted)."""
    row = store.permission(permission_id)
    if row is None:
        return None
    task = store.task(row.task_id) if row.task_id is not None else None
    job = jobs(task.job_id) if task is not None else None
    return permission_view(row, task, job)
