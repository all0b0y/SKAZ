"""Questions about the recording and session notes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import note_store
from .. import repository as repo
from ..agent import ask as ask_service
from ..agent import note_rewrite
from ..agent import notes as notes_service
from ..gateways import ProviderError, ProviderNotConfigured
from ..gateways.chat import ProviderTimeout
from ..native_io import disk_call
from ..schemas import (
    ApplyRewriteRequest,
    AskRequest,
    AskResponse,
    DeleteResponse,
    EditNoteRequest,
    Note,
    NoteRevisionRequest,
    NotesRequest,
    NoteVersion,
    RewritePassageRequest,
    RewritePreview,
)
from .deps import RuntimeDep

router = APIRouter(prefix="/sessions")


def _require_session(runtime: RuntimeDep, session_id: str) -> None:
    if repo.get_session(runtime.db, session_id) is None:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' does not exist.")


def _provider_failure(error: Exception) -> HTTPException:
    if isinstance(error, ProviderTimeout):
        return HTTPException(status_code=504, detail=str(error))
    if isinstance(error, ProviderNotConfigured):
        return HTTPException(status_code=400, detail=str(error))
    return HTTPException(status_code=502, detail=str(error))


@router.post("/{session_id}/ask")
async def ask(session_id: str, payload: AskRequest, runtime: RuntimeDep) -> AskResponse:
    _require_session(runtime, session_id)
    if not payload.question.strip():
        raise HTTPException(status_code=422, detail="question must not be empty.")
    try:
        return await ask_service.answer(runtime, session_id, payload)
    except (ProviderNotConfigured, ProviderError) as error:
        raise _provider_failure(error) from error


@router.post("/{session_id}/notes")
async def write_notes(session_id: str, payload: NotesRequest, runtime: RuntimeDep) -> Note:
    _require_session(runtime, session_id)
    try:
        note = await notes_service.write(
            runtime, session_id, payload.language, payload.replace_note_id,
            payload.expected_revision, payload.detail,
        )
        await disk_call(runtime.session_files.project, session_id)
        return note
    except note_store.NoteMissing as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except note_store.NoteConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except notes_service.NothingToSummarise as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (ProviderNotConfigured, ProviderError) as error:
        raise _provider_failure(error) from error


@router.post("/{session_id}/notes/empty")
def create_empty_note(session_id: str, runtime: RuntimeDep) -> Note:
    """Start a blank document the user writes themselves.

    It is stored immediately rather than kept as an unsaved draft in the window:
    with note versions gone, an in-memory-only document is one crash away from
    being lost, and the editor's autosave has nothing to save into until the note
    exists. It carries no citations because nothing in it came from the recording.
    """
    _require_session(runtime, session_id)
    note = repo.add_note(runtime.db, session_id, "", "", [], None)
    runtime.session_files.project(session_id)
    return note


@router.get("/{session_id}/notes")
def list_notes(session_id: str, runtime: RuntimeDep) -> dict[str, list[Note]]:
    _require_session(runtime, session_id)
    return {"notes": note_store.list_notes(runtime.db, session_id)}


@router.patch("/{session_id}/notes/{note_id}")
def edit_note(session_id: str, note_id: str, payload: EditNoteRequest, runtime: RuntimeDep) -> Note:
    """Edit the document, rename it, or both.

    A name that sanitises to nothing is refused rather than stored, so clearing the
    field leaves the previous name in place instead of producing an unnamed note.
    """
    if payload.content is None and payload.title is None:
        raise HTTPException(status_code=400, detail="Nothing to change.")
    try:
        title = None if payload.title is None else note_store.sanitise_title(payload.title)
    except note_store.BlankTitle as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    try:
        note = note_store.replace(
            runtime.db, session_id, note_id, payload.expected_revision,
            content=payload.content, title=title,
        )
        runtime.session_files.project(session_id)
        return note
    except note_store.NoteMissing as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except note_store.NoteConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.delete("/{session_id}/notes/{note_id}")
def delete_note(session_id: str, note_id: str, runtime: RuntimeDep) -> DeleteResponse:
    """Hide a note: the row waits for the trash instead of being destroyed.

    The projection runs afterwards so the note's Markdown leaves the session folder
    with it; the primary record stays recoverable in the database.
    """
    _require_session(runtime, session_id)
    try:
        note_store.soft_delete(runtime.db, session_id, note_id)
    except note_store.NoteMissing as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    # A preview of a deleted note can never be applied; holding it would only keep
    # generated text in memory for a document that is gone.
    runtime.note_rewrites.drop_note(note_id)
    runtime.session_files.project(session_id)
    return DeleteResponse()


@router.post("/{session_id}/notes/{note_id}/rewrite")
async def rewrite_passage(
    session_id: str, note_id: str, payload: RewritePassageRequest, runtime: RuntimeDep,
) -> RewritePreview:
    """Write a replacement for one selected passage. Nothing is stored yet.

    The answer is a comparison, not a new note: the user sees the old passage beside
    the written one and decides. Applying is a separate call precisely so a rewrite
    can be refused after reading it.
    """
    _require_session(runtime, session_id)
    try:
        pending = await note_rewrite.preview(
            runtime, session_id, note_id,
            expected_revision=payload.expected_revision,
            start=payload.start, end=payload.end,
            language=payload.language, detail=payload.detail,
        )
    except note_store.NoteMissing as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except note_store.NoteConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (note_rewrite.InvalidSpan, note_rewrite.NoSource) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (ProviderNotConfigured, ProviderError) as error:
        raise _provider_failure(error) from error
    return RewritePreview(
        id=pending.id, note_id=pending.note_id, revision=pending.revision,
        start=pending.start, end=pending.end,
        original=pending.original, replacement=pending.replacement,
        citations=list(pending.citations),
    )


@router.post("/{session_id}/notes/{note_id}/rewrite/apply")
async def apply_rewrite(
    session_id: str, note_id: str, payload: ApplyRewriteRequest, runtime: RuntimeDep,
) -> Note:
    """Put an accepted replacement into the note as one whole new revision."""
    _require_session(runtime, session_id)
    try:
        note = note_rewrite.apply(runtime, session_id, note_id, payload.preview_id)
    except note_rewrite.PreviewMissing as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except note_store.NoteMissing as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except note_store.NoteConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await disk_call(runtime.session_files.project, session_id)
    return note


@router.get("/{session_id}/notes/{note_id}/history")
def note_history(session_id: str, note_id: str, runtime: RuntimeDep) -> dict[str, list[NoteVersion]]:
    try:
        return {"versions": note_store.history(runtime.db, session_id, note_id)}
    except note_store.NoteMissing as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.post("/{session_id}/notes/{note_id}/history/{version_id}/restore")
def restore_note(
    session_id: str, note_id: str, version_id: str, payload: NoteRevisionRequest, runtime: RuntimeDep,
) -> Note:
    try:
        note = note_store.restore(runtime.db, session_id, note_id, version_id, payload.expected_revision)
        runtime.session_files.project(session_id)
        return note
    except note_store.NoteMissing as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except note_store.NoteConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
