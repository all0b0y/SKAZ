"""``POST /kb/dictation``: WAV from the composer's microphone button → text. Nothing is stored.

The body is the raw WAV (``Content-Type: audio/wav``), PCM16 mono, at most
120 s and 8 MB; the Electron bridge (``dictate``) sends it with the app token.
"""
from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, HTTPException, Query, Request

from ..errors import KnowledgeError
from ..speech.dictation import MAX_BYTES, Dictation, DictationTooLarge
from .schemas_speech import KbDictation

router = APIRouter(tags=["kb"])
WAV_TYPES = frozenset({"audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"})
_BODY = {"requestBody": {"required": True, "content": {
    "audio/wav": {"schema": {"type": "string", "format": "binary"}}}}}


def get_dictation(request: Request) -> Dictation:
    return cast(Dictation, request.app.state.runtime.kb_dictation)


async def _body(request: Request) -> bytes:
    """The request body, refused as soon as it grows past the limit (never buffered beyond it)."""
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > MAX_BYTES:
        raise DictationTooLarge("The dictation is larger than 8 MB.")
    parts: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BYTES:
            raise DictationTooLarge("The dictation is larger than 8 MB.")
        parts.append(chunk)
    return b"".join(parts)


@router.post("/kb/dictation", openapi_extra=_BODY)
async def dictate(request: Request,
                  language: Annotated[str | None, Query(max_length=16)] = None) -> KbDictation:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in WAV_TYPES:
        raise HTTPException(status_code=415, detail="Send the dictation as audio/wav.")
    try:
        data = await _body(request)
        result = await get_dictation(request).transcribe(data, language or None)
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error
    return KbDictation(text=result.text, language=result.language, provider=result.provider)
