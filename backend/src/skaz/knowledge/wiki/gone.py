"""A material folder removed outside SKAZ (Finder, Obsidian) — QA C21.

The full scan no longer finds the folder (``KnowledgeService.vanished``); the material
leaves the lists, but its wiki statements would keep footnotes to a source that is gone.
SKAZ says so in the feed and offers the same cleanup as "Delete" (one plan,
``delete.plan_cleanup``): statements resting only on it go, statements other sources
confirm lose its citation, pages left without a source go, the user's notes stay.
"Keep as is" leaves the pages alone (their footnotes read "no longer available").
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence

from ...native_io import disk_call
from ..errors import NotFound
from ..notifications.actions import ActionSpec
from ..service import KnowledgeService
from ..store.records import MaterialRecord, NotificationRecord
from .delete import append_log, execute_delete, plan_cleanup
from .graph import GraphIndex

logger = logging.getLogger(__name__)
KIND = "material_gone"
CLEAN_UP = ActionSpec("clean_up", "Clean up the wiki", primary=True)
KEEP = ActionSpec("keep", "Keep the pages as they are")


def _cited_pages(kb: KnowledgeService, material_id: str) -> list[str]:
    with kb.db.read() as connection:
        rows = connection.execute(
            "SELECT page_id FROM page_sources WHERE material_id = ? UNION "
            "SELECT DISTINCT page_id FROM citations WHERE material_id = ?",
            (material_id, material_id),
        ).fetchall()
    return sorted({row[0] for row in rows})


class GoneMaterials:
    def __init__(self, kb: KnowledgeService, graph: GraphIndex, *, language: Callable[[], str],
                 after_cleanup: Callable[[], None]) -> None:
        self.kb = kb
        self.graph = graph
        self.language = language
        self.after_cleanup = after_cleanup

    @staticmethod
    def actions(record: NotificationRecord) -> Sequence[ActionSpec]:
        return (CLEAN_UP, KEEP) if record.requires_action else ()

    def notify(self, materials: Sequence[MaterialRecord]) -> int:
        """One notice per material that disappeared (never twice for one still open)."""
        open_ids = {
            item.payload.get("gone_material_id")
            for item in self.kb.notifications()
            if item.kind == KIND and not item.resolved_at
        }
        raised = 0
        for record in materials:
            if record.id in open_ids:
                continue
            pages = _cited_pages(self.kb, record.id)
            if pages:
                body = (
                    f"Its folder is no longer in the library. {len(pages)} wiki "
                    f"{'page cites' if len(pages) == 1 else 'pages cite'} it. Clean up removes what "
                    "only this material said, as Delete does; your notes stay."
                )
            else:
                body = "Its folder is no longer in the library. Nothing in the wiki cited it."
            self.kb.notify(
                KIND,
                f"“{record.title}” was removed outside SKAZ",
                body=body,
                payload={"gone_material_id": record.id, "material_title": record.title,
                         "rel_dir": record.rel_dir, "pages": len(pages)},
                requires_action=bool(pages),
                subject={"type": "page", "id": pages[0], "block_id": None, "seg": None} if pages else None,
            )
            raised += 1
        return raised

    async def resolve(self, kb: KnowledgeService, record: NotificationRecord, action: str,
                      _text: str | None) -> None:
        if action != CLEAN_UP.id:
            return
        material_id = str(record.payload.get("gone_material_id") or "")
        title = str(record.payload.get("material_title") or "")
        rel_dir = str(record.payload.get("rel_dir") or "")
        if not material_id or not rel_dir:
            raise NotFound("This notice no longer says which material it was.")
        await disk_call(self._clean, material_id, title, rel_dir)

    def _clean(self, material_id: str, title: str, rel_dir: str) -> None:
        if self.kb.material_repo.get(material_id) is not None:
            raise NotFound("The material is back in the library; nothing to clean up.")
        with self.kb.writing():
            plan = plan_cleanup(self.kb, self.graph, material_id, title, rel_dir, folder_gone=True)
            execute_delete(self.kb, plan)
            append_log(self.kb.require(), self.language(), title, outside=True)
        logger.info("cleaned up the wiki after material %s left the library: %d page(s)",
                    material_id, len(plan.pages))
        self.after_cleanup()
