"""Deciding corrections: revert / accept / keep / reapply, and the material view with corrections.

A change that alters the text the wiki was built from (``applied`` in or out)
is followed at once by ``on_text_changed``: the wiki takes down statements
whose quote is no longer verbatim and starts a ``refresh`` of the material.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from ...native_io import disk_call
from ..errors import KnowledgeError, NotFound
from ..ids import utc_now
from ..notifications.actions import ActionSpec
from ..notifications.feed import OPEN_MATERIAL
from ..store.records import FragmentRecord, NotificationRecord
from .model import CorrectionEntry, CorrectionState, apply_to_text
from .store import CorrectionStore, CorrectionsUnreadable

if TYPE_CHECKING:
    from ..ingest.jobs import JobRecord
    from ..service import KnowledgeService

ACCEPT_ALL = ActionSpec("accept_all", "Accept all", primary=True)
#: action → (state it must be in, state it moves to)
TRANSITIONS: dict[str, tuple[CorrectionState, CorrectionState]] = {
    "revert": ("applied", "reverted"),
    "accept": ("doubtful", "applied"),
    "keep": ("doubtful", "kept"),
    "reapply": ("reverted", "applied"),
}
STATE_WORDS = {
    "applied": "applied",
    "doubtful": "waiting for your decision",
    "reverted": "reverted",
    "kept": "kept as recognised",
}

#: ``(material_id, changed segs) -> (statements taken down, refresh job or None)``
TextChanged = Callable[[str, set[int]], Awaitable[tuple[int, "JobRecord | None"]]]


class CorrectionConflict(KnowledgeError):
    status_code = 409


@dataclass(frozen=True)
class CorrectionChange:
    correction: CorrectionEntry
    material_id: str
    affected_blocks: int
    job: JobRecord | None


@dataclass(frozen=True)
class FragmentView:
    fragment: FragmentRecord
    text: str
    original_text: str | None
    corrections: tuple[str, ...]


class CorrectionService:
    def __init__(self, kb: KnowledgeService, store: CorrectionStore) -> None:
        self.kb = kb
        self.store = store
        self.on_text_changed: TextChanged | None = None

    # -- reading ------------------------------------------------------------

    def corrections(self, material_id: str) -> tuple[str, list[CorrectionEntry]]:
        if self.kb.material_repo.get(material_id) is None:
            raise NotFound("Material not found.")
        try:
            data = self.store.read(material_id)
        except CorrectionsUnreadable as error:
            raise CorrectionConflict("The corrections of this material can't be read.") from error
        entries = sorted(data.corrections if data else [], key=lambda entry: (entry.seg, entry.start))
        return material_id, entries

    def fragment_views(self, material_id: str, fragments: Sequence[FragmentRecord]) -> list[FragmentView]:
        data = self.store.read_or_empty(material_id)
        views = []
        for fragment in fragments:
            entries = data.for_seg(fragment.seg)
            text = apply_to_text(fragment.text, entries) if entries else fragment.text
            views.append(
                FragmentView(
                    fragment,
                    text,
                    fragment.text if text != fragment.text else None,
                    tuple(entry.id for entry in sorted(entries, key=lambda e: e.start)),
                )
            )
        return views

    def counts(self, material_id: str) -> tuple[int, int]:
        counts = self.store.counts(material_id)
        return counts.get("applied", 0), counts.get("doubtful", 0)

    # -- deciding -----------------------------------------------------------

    def _transition(self, correction_id: str, action: str) -> tuple[CorrectionEntry, CorrectionEntry, str]:
        required, target = TRANSITIONS[action]
        material_id = self.store.material_of(correction_id)
        if material_id is None:
            raise NotFound("Correction not found.")
        with self.store.lock:
            try:
                data = self.store.read(material_id)
            except CorrectionsUnreadable as error:
                raise CorrectionConflict("The corrections of this material can't be read.") from error
            entry = data.by_id(correction_id) if data else None
            if data is None or entry is None:
                raise NotFound("Correction not found.")
            if entry.state != required:
                raise CorrectionConflict(
                    f"This correction is {STATE_WORDS[entry.state]}; it can't be changed this way."
                )
            updated = entry.model_copy(update={"state": target, "decided_at": utc_now(), "auto": False})
            corrections = [updated if item.id == correction_id else item for item in data.corrections]
            self.store.write(material_id, data.model_copy(update={"corrections": corrections}))
        return entry, updated, material_id

    async def change(self, correction_id: str, action: str) -> CorrectionChange:
        before, after, material_id = await disk_call(self._transition, correction_id, action)
        affected, job = 0, None
        if (before.state == "applied") != (after.state == "applied") and self.on_text_changed is not None:
            affected, job = await self.on_text_changed(material_id, {after.seg})
        return CorrectionChange(after, material_id, affected, job)

    # -- the doubtful_corrections notification --------------------------------

    @staticmethod
    def notification_actions(_record: NotificationRecord) -> Sequence[ActionSpec]:
        return (ACCEPT_ALL, OPEN_MATERIAL)

    async def resolve_notification(
        self, _kb: KnowledgeService, record: NotificationRecord, action: str, _text: str | None
    ) -> None:
        if action != ACCEPT_ALL.id:
            return
        material_id = str(record.payload.get("material_id", ""))
        ids = [str(item) for item in record.payload.get("correction_ids", [])]
        _material, entries = await disk_call(self.corrections, material_id)
        doubtful = {entry.id for entry in entries if entry.state == "doubtful"}
        segs: set[int] = set()
        for correction_id in ids:
            if correction_id in doubtful:
                _before, after, _material = await disk_call(self._transition, correction_id, "accept")
                segs.add(after.seg)
        if segs and self.on_text_changed is not None:
            await self.on_text_changed(material_id, segs)
