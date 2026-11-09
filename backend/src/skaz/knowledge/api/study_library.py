"""``/kb/study-library``: saved decks and tests, when they were opened, their archive (N4-7, N4-8)."""

from __future__ import annotations

from fastapi import APIRouter

from ..study.shelf import ShelfEntry
from .deps import kb_call
from .schemas_study_library import KbStudyDeleteWarning, KbStudyLibrary, KbStudyShelfEntry
from .study import StudyDep

router = APIRouter(prefix="/kb/study-library", tags=["kb"])


def _entry(entry: ShelfEntry) -> KbStudyShelfEntry:
    return KbStudyShelfEntry.model_validate({
        "page_id": entry.page_id, "kind": entry.kind, "title": entry.title, "folders": list(entry.folders),
        "opened_at": entry.opened_at, "archived_at": entry.archived_at, "archived_by": entry.archived_by,
        "suggest_archive": entry.suggest_archive,
    })


@router.get("")
async def read_study_library(study: StudyDep) -> KbStudyLibrary:
    entries = await kb_call(study.shelf.listing)
    shown = [entry for entry in entries if entry.archived_at is None]
    return KbStudyLibrary(
        decks=[_entry(entry) for entry in shown if entry.kind == "deck"],
        tests=[_entry(entry) for entry in shown if entry.kind == "test"],
        archived=[_entry(entry) for entry in entries if entry.archived_at is not None],
    )


@router.post("/{page_id}/opened")
async def note_opened(page_id: str, study: StudyDep) -> KbStudyShelfEntry:
    """The user opened the page: its days start again, and an archived one is back in the lists."""
    return _entry(await kb_call(study.shelf.opened, page_id))


@router.post("/{page_id}/archive")
async def archive_page(page_id: str, study: StudyDep) -> KbStudyShelfEntry:
    return _entry(await kb_call(study.shelf.archive, page_id))


@router.post("/{page_id}/unarchive")
async def unarchive_page(page_id: str, study: StudyDep) -> KbStudyShelfEntry:
    return _entry(await kb_call(study.shelf.unarchive, page_id))


@router.post("/{page_id}/keep")
async def keep_page(page_id: str, study: StudyDep) -> KbStudyShelfEntry:
    """"Not now" to the suggestion to archive a learned deck."""
    return _entry(await kb_call(study.shelf.keep, page_id))


@router.get("/{page_id}/delete-warning")
async def read_delete_warning(page_id: str, study: StudyDep) -> KbStudyDeleteWarning:
    warning = await kb_call(study.shelf.delete_warning_of, page_id)
    return KbStudyDeleteWarning.model_validate(warning.__dict__)
