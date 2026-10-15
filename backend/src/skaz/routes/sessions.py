"""What the Knowledge Wiki recorder still reads from a recording's technical session.

A recording runs in a legacy session (``knowledge/speech/legacy.py``): the new interface reads
its live transcript (``/live``, ``/live/events``) and, when a pause never acquired a transport,
settles its status (``PATCH``). Deletion is called by the speech area, never by the renderer.
Audio is never archived.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, HTTPException, Query

from .. import repository as repo
from ..asr_providers import provider_of_model
from ..live_store import LiveConflict
from ..native_event_pages import EventCursorConflict, EventPageTooLarge, read_event_page
from ..native_io import disk_call, drain_on_cancel
from ..native_page_projection import read_projected_page
from ..schemas import PatchSessionRequest, Session
from ..session_files import FileDeletionBlocked
from .deps import RuntimeDep

if TYPE_CHECKING:
    from ..runtime import Runtime

router = APIRouter(prefix="/sessions")


@router.get("/{session_id}/live/events")
async def read_native_events(
    session_id: str, runtime: RuntimeDep,
    connection_id: str | None = Query(default=None, min_length=1, max_length=128),
    after: int | None = Query(default=None, ge=-1),
    before: int | None = Query(default=None, ge=0),
    limit: int = Query(default=64, ge=1, le=128),
    project: bool = False,
    segment_id: str | None = Query(default=None, min_length=1, max_length=128),
) -> dict[str, Any]:
    if after is not None and before is not None:
        raise HTTPException(status_code=422, detail="Use either after or before, not both.")
    if connection_id is None and (after is not None or before is not None):
        raise HTTPException(status_code=422, detail="A cursor requires its connection_id epoch.")
    if segment_id is not None and (
        not project or connection_id is not None or after is not None or before is not None
    ):
        raise HTTPException(status_code=422, detail="A source locator requires project=true and no cursor.")
    try:
        if project:
            page = await disk_call(
                read_projected_page,
                runtime.db,
                session_id,
                connection_id=connection_id,
                after=after,
                before=before,
                limit=limit,
                **({"segment_id": segment_id} if segment_id else {}),
            )
        else:
            page = await disk_call(
                read_event_page,
                runtime.db,
                session_id,
                connection_id=connection_id,
                after=after,
                before=before,
                limit=limit,
            )
        stream = runtime.native_streams.get(session_id)
        page["transcription"] = stream.state if stream is not None else "inactive"
        return page
    except LiveConflict as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except EventCursorConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except EventPageTooLarge as error:
        raise HTTPException(status_code=413, detail=str(error)) from error


@router.get("/{session_id}/live")
async def read_native_live(session_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    await disk_call(_require_session, runtime, session_id)
    try:
        snapshot = await disk_call(runtime.live_store.snapshot, session_id)
        stream = runtime.native_streams.get(session_id)
        snapshot["transcription"] = stream.state if stream is not None else "inactive"
        snapshot["processing"] = bool(stream and stream.processing)
        _describe_provider(snapshot, stream)
        return _live_view(snapshot)
    except LiveConflict as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


# Derived views the live client never reads. They are recomputed on every poll
# and dominated the response: at minute 60 of a real recording
# `final_stream_tokens` alone was 10.5 MiB of a 34.5 MiB payload, and the whole
# translation half is dead weight in a transcription recording
# (docs/BASELINE-PROFILE.md). The durable tables and LiveStore.snapshot() keep
# producing them for diagnostics and replay checks; only this per-second
# response drops them.
_LIVE_INTERNAL_FIELDS = (
    "final_stream_tokens", "final_translation_projection", "partial_stream_tokens",
)
_LIVE_TRANSLATION_FIELDS = (
    "live_translation_projection", "final_translation_tokens", "partial_translation_tokens",
)


def _describe_provider(snapshot: dict[str, Any], stream: Any) -> None:
    """Which provider transcribes (or last transcribed) this recording, and why it cannot."""
    connections = snapshot.get("connections") or []
    last_model = connections[-1].get("model") if connections else None
    provider = (stream.provider if stream is not None else None) or provider_of_model(last_model)
    snapshot["transcription_provider"] = provider
    if stream is not None and stream.state == "unavailable" and stream.failure_reason:
        snapshot["transcription_detail"] = stream.failure_reason


def _live_view(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Trim the live response to what a client actually renders."""
    view = {key: value for key, value in snapshot.items() if key not in _LIVE_INTERNAL_FIELDS}
    if view.get("recording_mode") == "translation":
        # Translation UI reads the projection; the flat original list is the
        # same tokens a second time.
        view.pop("final_tokens", None)
    else:
        for field in _LIVE_TRANSLATION_FIELDS:
            view.pop(field, None)
    return view


def _require_session(runtime: RuntimeDep, session_id: str) -> Session:
    session = repo.get_session(runtime.db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' does not exist.")
    return session



@router.patch("/{session_id}")
async def patch_session(session_id: str, payload: PatchSessionRequest, runtime: RuntimeDep) -> Session:
    """Title and pause/stop status. Native recordings settle their transcript themselves, so
    ``flush_transcription`` is accepted for compatibility and has nothing left to flush."""
    _require_session(runtime, session_id)
    updated = repo.update_session(runtime.db, session_id, status=payload.status, title=payload.title)
    if updated is None:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' does not exist.")
    if payload.status in ("stopped", "paused"):
        await disk_call(runtime.session_files.project, session_id)
    return updated


async def delete_session(session_id: str, runtime: Runtime) -> None:
    """Stop capture/imports of one session and remove its files and rows (speech area only)."""
    async def remove() -> None:
        await runtime.imports.prepare_delete(session_id)
        await runtime.stop_native(session_id)
        try:
            await disk_call(_require_session, runtime, session_id)
            try:
                if runtime.storage.enabled():
                    await disk_call(runtime.storage.delete, session_id)
                else:
                    await disk_call(runtime.session_files.delete_session, session_id)
            except FileDeletionBlocked as error:
                raise HTTPException(status_code=409, detail=(
                    "Session was not deleted: Markdown files need attention. "
                    "Preserve external/conflict/recovery files outside the session folder "
                    "and retry. If the files root changed, restore the previous root first."
                )) from error

        finally:
            runtime.native_closing.discard(session_id)

    # Concurrent callers join the same deletion.
    # A later, separate request still gets the usual missing-session response.
    pending = runtime.session_deletions.get(session_id)
    if pending is None:
        pending = asyncio.create_task(remove())
        runtime.session_deletions[session_id] = pending
        pending.add_done_callback(lambda _task: runtime.session_deletions.pop(session_id, None))

    async def join() -> None:
        await asyncio.shield(pending)

    await drain_on_cancel(join())
