"""``/kb/materials/{text,file,link}``, ``/kb/links/classify`` and exclusions (area S1)."""

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, HTTPException, Request

from ..errors import KnowledgeError
from ..sources.links import LinkInfo, classify_offline
from ..sources.service import GuardReport, IntakeResult, SourceService, location_label
from ..speech.service import SpeechInvalid, SpeechService, SpeechView
from .deps import kb_call
from .materials import material_summaries
from .schemas import KbMaterialSummary
from .schemas_sources import (
    KbAddFile,
    KbAddLink,
    KbAddText,
    KbClassifyLink,
    KbExcludedFragment,
    KbFragmentLocation,
    KbHiddenFinding,
    KbLinkInfo,
    KbMaterialAdded,
    KbMaterialGuard,
    KbRestoredFragment,
)

router = APIRouter(tags=["kb"])
NO_EMBEDDED_VIDEO = "This page has no video SKAZ can add (YouTube, VK Video, RuTube or Vimeo)."


def get_sources(request: Request) -> SourceService:
    return cast(SourceService, request.app.state.runtime.kb_sources)


def get_speech(request: Request) -> SpeechService:
    return cast(SpeechService, request.app.state.runtime.kb_speech)


async def _summary(sources: SourceService, material_id: str) -> KbMaterialSummary:
    record = await kb_call(sources.kb.material_repo.get, material_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Material not found.")
    return (await kb_call(material_summaries, sources.kb, [record]))[0]


async def _added(sources: SourceService, result: IntakeResult) -> KbMaterialAdded:
    return KbMaterialAdded(
        material=await _summary(sources, result.material_id),
        excluded_count=result.excluded_count,
        hidden_count=result.hidden_count,
        failure_reason=result.failure,
        video=None,
        video_failure_reason=None,
    )


def guard_view(report: GuardReport) -> KbMaterialGuard:
    return KbMaterialGuard(
        material_id=report.material_id,
        excluded=[
            KbExcludedFragment(
                seg=item.seg,
                id=f"seg-{item.seg}",
                reason=item.reason,
                rules=item.rules,
                score=item.score,
                found=item.found,
                text_hash=item.text_hash,
                detected_at=item.detected_at,
                location=KbFragmentLocation(
                    index=item.location.index,
                    page=item.location.page,
                    start_ms=item.location.start_ms,
                    label=location_label(item.location),
                ),
            )
            for item in report.excluded
        ],
        restored=[
            KbRestoredFragment(seg=item.seg, text_hash=item.text_hash, restored_at=item.restored_at)
            for item in report.restored
        ],
        hidden=[
            KbHiddenFinding(
                kind=item.kind,
                detail=item.detail,
                original=item.original,
                index=item.index,
                page=item.page,
                element=item.element,
                instruction=item.instruction,
            )
            for item in report.hidden
        ],
        failure_reason=report.failure,
    )


def link_view(info: LinkInfo) -> KbLinkInfo:
    embedded = link_view(info.embedded_video) if info.embedded_video is not None else None
    return KbLinkInfo(
        embedded_video=embedded,
        kind=info.kind,
        url=info.url,
        domain=info.domain,
        label=info.label,
        platform=info.platform,
        video_id=info.video_id,
        title=info.title,
        duration_ms=info.duration_ms,
        supported=info.supported,
        note=info.note,
    )


@router.post("/kb/materials/text", status_code=201)
async def add_text(payload: KbAddText, request: Request) -> KbMaterialAdded:
    sources = get_sources(request)
    result = await kb_call(sources.add_text, payload.text, payload.folder_id, payload.title)
    return await _added(sources, result)


@router.post("/kb/materials/file", status_code=201)
async def add_file(payload: KbAddFile, request: Request) -> KbMaterialAdded:
    sources = get_sources(request)
    result = await kb_call(sources.add_file, payload.path, payload.folder_id, payload.title)
    return await _added(sources, result)


def _http(error: KnowledgeError) -> HTTPException:
    # A video link that can't be added is a problem with the link (like S1's refusals): 422.
    status = 422 if isinstance(error, SpeechInvalid) else error.status_code
    return HTTPException(status_code=status, detail=error.message)


async def _video(speech: SpeechService, payload: KbAddLink, url: str, *,
                 title: str | None, avoid_title: str | None = None) -> SpeechView:
    return await speech.add_video_link(url, payload.folder_id, title, language=payload.language,
                                       translate=payload.translate, avoid_title=avoid_title)


@router.post("/kb/materials/link", status_code=201)
async def add_link(payload: KbAddLink, request: Request) -> KbMaterialAdded:
    """Articles, PDFs, text — and videos (YouTube, VK Video, RuTube, Vimeo), which go to the speech
    import and come back ``processing``. A page with an embedded video: ``mode`` text / video / both."""
    sources = get_sources(request)
    speech = get_speech(request)
    try:
        offline = classify_offline(payload.url)
        if offline is not None and offline.kind == "video":
            view = await _video(speech, payload, offline.url, title=payload.title)
            return KbMaterialAdded(material=await _summary(sources, view.material_id), excluded_count=0,
                                   hidden_count=0, failure_reason=None, video=None, video_failure_reason=None)
        embedded: LinkInfo | None = None
        if payload.mode != "text":
            info = await sources.classify(payload.url, probe=False)
            embedded = info.embedded_video
            if embedded is None:
                raise SpeechInvalid(NO_EMBEDDED_VIDEO)
        if payload.mode == "video":
            assert embedded is not None
            view = await _video(speech, payload, embedded.url, title=payload.title)
            return KbMaterialAdded(material=await _summary(sources, view.material_id), excluded_count=0,
                                   hidden_count=0, failure_reason=None, video=None, video_failure_reason=None)
        result = await sources.add_link(payload.url, payload.folder_id, payload.title)
    except KnowledgeError as error:
        raise _http(error) from error
    except OSError as error:
        raise HTTPException(
            status_code=503,
            detail=f"SKAZ couldn't use the library folder: {error.strerror or error}.",
        ) from error
    added = await _added(sources, result)
    if embedded is None:
        return added
    # Mode "both": the article is added; the video follows, and its own refusal doesn't undo the article.
    try:
        view = await _video(speech, payload, embedded.url, title=None, avoid_title=result.title)
    except KnowledgeError as error:
        return added.model_copy(update={"video_failure_reason": error.message})
    return added.model_copy(update={"video": await _summary(sources, view.material_id)})


@router.post("/kb/links/classify")
async def classify(payload: KbClassifyLink, request: Request) -> KbLinkInfo:
    """Preview of a pasted link: kind and label for the UI, before anything is added."""
    try:
        info = await get_sources(request).classify(payload.url, probe=payload.probe)
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error
    return link_view(info)


@router.get("/kb/materials/{material_id}/excluded")
async def read_excluded(material_id: str, request: Request) -> KbMaterialGuard:
    return guard_view(await kb_call(get_sources(request).guard_report, material_id))


@router.post("/kb/materials/{material_id}/excluded/{seg}/restore")
async def restore_fragment(material_id: str, seg: int, request: Request) -> KbMaterialGuard:
    """ "This isn't an instruction — restore": the fragment is processed again from now on."""
    return guard_view(await kb_call(get_sources(request).restore, material_id, seg))
