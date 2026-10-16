"""``/kb/recordings`` and ``/kb/imports``: speech that becomes a library material.

Audio still streams over the existing WebSocket ``/sessions/{session_id}/live/stream``
(the recorder ends it with its own Stop/Pause message); these routes create and
settle the *material* fed by that session. Imports run side by side and beside
a recording — nothing is queued.
"""
from __future__ import annotations

from collections.abc import Awaitable
from typing import Annotated, TypeVar, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ...native_io import disk_call
from ..errors import KnowledgeError
from ..speech.service import ImportInput, SpeechService, SpeechView
from ..store.database import MAX_DB_INT
from .schemas import KbFragment
from .schemas_speech import (
    KbImportCreate,
    KbLiveMonologue,
    KbLivePartial,
    KbRecordingCreate,
    KbRecordingLive,
    KbSpeechDefaults,
    KbSpeechMaterial,
)

T = TypeVar("T")

router = APIRouter(tags=["kb"])


def get_speech(request: Request) -> SpeechService:
    return cast(SpeechService, request.app.state.runtime.kb_speech)


SpeechDep = Annotated[SpeechService, Depends(get_speech)]


async def speech_call(work: Awaitable[T]) -> T:
    try:
        return await work
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error
    except OSError as error:
        raise HTTPException(
            status_code=503, detail=f"SKAZ couldn't use the library folder: {error.strerror or error}.",
        ) from error


def material_view(view: SpeechView) -> KbSpeechMaterial:
    return KbSpeechMaterial.model_validate(view, from_attributes=True)


@router.get("/kb/recordings/defaults")
async def recording_defaults(speech: SpeechDep) -> KbSpeechDefaults:
    return KbSpeechDefaults(folder_id=await disk_call(speech.default_folder))


@router.post("/kb/recordings", status_code=201)
async def start_recording(body: KbRecordingCreate, speech: SpeechDep) -> KbSpeechMaterial:
    """A new recording material; then stream audio to ``/sessions/{session_id}/live/stream``."""
    return material_view(await speech_call(speech.start_recording(body.folder_id, body.title)))


@router.get("/kb/recordings/{material_id}")
async def read_recording(material_id: str, speech: SpeechDep) -> KbSpeechMaterial:
    return material_view(await speech_call(speech.view(material_id)))


@router.get("/kb/recordings/{material_id}/live")
async def read_recording_live(
    material_id: str, speech: SpeechDep,
    since_seg: Annotated[int | None, Query(ge=0, le=MAX_DB_INT)] = None,
) -> KbRecordingLive:
    """The live panel's text after the material's fragments: the open monologue's final words
    and the words still being recognised, plus the recorder's stream state, and with ``since_seg``
    the fragments added after it. Poll it (one request at a time)."""
    tail, stream = await speech_call(speech.live(material_id, since_seg))
    partial = tail.partial
    return KbRecordingLive(
        material_id=material_id, after_seg=tail.after_seg, stream=stream,
        monologues=[KbLiveMonologue(speaker=item.speaker, start_ms=item.start_ms, end_ms=item.end_ms,
                                    text=item.text) for item in tail.monologues],
        partial=KbLivePartial(speaker=partial.speaker, text=partial.text, translation=partial.translation)
        if partial else None,
        fragments=[KbFragment(id=f.id, seg=f.seg, text=f.text, start_ms=f.start_ms, end_ms=f.end_ms,
                              speaker=f.speaker, page=f.page, index=f.index, role=f.role, level=f.level,
                              original_text=None, corrections=[])
                   for f in tail.fragments],
    )


@router.post("/kb/recordings/{material_id}/stop")
async def stop_recording(material_id: str, speech: SpeechDep) -> KbSpeechMaterial:
    """Finish the material after the recorder stopped streaming (409 while it still streams)."""
    return material_view(await speech_call(speech.end_recording(material_id, "stop")))


@router.post("/kb/recordings/{material_id}/pause")
async def pause_recording(material_id: str, speech: SpeechDep) -> KbSpeechMaterial:
    """Settle the material as paused after the recorder paused (409 while it still streams)."""
    return material_view(await speech_call(speech.end_recording(material_id, "pause")))


@router.post("/kb/recordings/{material_id}/resume")
async def resume_recording(material_id: str, speech: SpeechDep) -> KbSpeechMaterial:
    """Check that recording may continue into the same material; then reopen its stream."""
    return material_view(await speech_call(speech.resume_recording(material_id)))


@router.post("/kb/imports", status_code=201)
async def start_import(body: KbImportCreate, speech: SpeechDep) -> KbSpeechMaterial:
    view = await speech_call(speech.start_import(ImportInput(
        path=body.path, url=body.url, folder_id=body.folder_id, title=body.title, translate=body.translate,
        language=body.language, allow_duplicate=body.allow_duplicate, to_wiki=body.to_wiki,
    )))
    return material_view(view)


@router.get("/kb/imports/active")
async def list_active_imports(speech: SpeechDep) -> list[KbSpeechMaterial]:
    return [material_view(view) for view in await speech_call(speech.active_imports())]


@router.get("/kb/imports/{material_id}")
async def read_import(material_id: str, speech: SpeechDep) -> KbSpeechMaterial:
    return material_view(await speech_call(speech.view(material_id)))


@router.post("/kb/imports/{material_id}/cancel")
async def cancel_import(material_id: str, speech: SpeechDep) -> KbSpeechMaterial:
    return material_view(await speech_call(speech.cancel_import(material_id)))


@router.post("/kb/imports/{material_id}/retry")
async def retry_import(material_id: str, speech: SpeechDep) -> KbSpeechMaterial:
    return material_view(await speech_call(speech.retry_import(material_id)))
