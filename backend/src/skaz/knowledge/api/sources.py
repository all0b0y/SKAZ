"""``/kb/materials/{text,file,link}``, ``/kb/links/classify`` and exclusions (area S1)."""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse

from ..errors import KnowledgeError
from ..library.library import INBOX_ID
from ..sources.intake import SourceRejected
from ..sources.links import LinkInfo, classify_offline
from ..sources.native_intake041 import MAX_IMAGE_BYTES
from ..sources.service import GuardReport, IntakeResult, SourceService, location_label
from ..sources.web_page import WebPageUnavailable
from ..speech.service import SpeechInvalid, SpeechService, SpeechView
from ..wiki.service import WikiService
from .deps import kb_call
from .materials import material_summaries, material_view
from .schemas import KbMaterial, KbMaterialSummary
from .schemas_sources import (
    KbAddFile,
    KbAddLink,
    KbAddText,
    KbAddWebPage,
    KbClassifyLink,
    KbExcludedFragment,
    KbFragmentLocation,
    KbHiddenFinding,
    KbImagePreviewRequest,
    KbLinkInfo,
    KbMaterialAdded,
    KbMaterialGuard,
    KbRestoredFragment,
    KbWebPageUnavailable,
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
        saved_pdf_page_count=result.saved_pdf_page_count,
        video=None,
        video_failure_reason=None,
        already_in_library=result.existing,
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
    result = await kb_call(sources.add_text, payload.text, payload.folder_id, payload.title,
                           to_wiki=payload.to_wiki)
    return await _added(sources, result)


@router.post("/kb/materials/file", status_code=201)
async def add_file(payload: KbAddFile, request: Request, response: Response) -> KbMaterialAdded:
    """201 = a new material; 200 = the same file is already in the library (N2, ``already_in_library``)."""
    sources = get_sources(request)
    result = await kb_call(
        sources.add_file,
        payload.path,
        payload.folder_id,
        payload.title,
        to_wiki=payload.to_wiki,
        selection_source=payload.selection_source or "picker",
        expected_size=payload.expected_size,
        expected_sha256=payload.expected_sha256,
    )
    if result.existing:
        response.status_code = 200
    return await _added(sources, result)


async def _read_bounded_image_body(request: Request) -> bytes:
    limit_mb = MAX_IMAGE_BYTES // (1024 * 1024)
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > MAX_IMAGE_BYTES:
        raise SourceRejected(f"This image is larger than {limit_mb} MB.")
    parts: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_IMAGE_BYTES:
            raise SourceRejected(f"This image is larger than {limit_mb} MB.")
        parts.append(chunk)
    return b"".join(parts)


@router.post("/kb/materials/clipboard-image", status_code=201)
async def add_clipboard_image(
    request: Request,
    response: Response,
    folder_id: Annotated[str, Query(min_length=1, max_length=64)] = INBOX_ID,
    file_name: Annotated[str, Query(min_length=1, max_length=255)] = "Screenshot",
    title: Annotated[str | None, Query(max_length=255)] = None,
) -> KbMaterialAdded:
    """Import bounded clipboard image bytes sent by Electron main (no OCR or auto-wiki ingest)."""
    sources = get_sources(request)
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    try:
        data = await _read_bounded_image_body(request)
    except SourceRejected as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error
    result = await kb_call(
        sources.add_clipboard_image,
        data,
        folder_id,
        mime_type=content_type,
        file_name=file_name,
        title=title,
    )
    if result.existing:
        response.status_code = 200
    return await _added(sources, result)


@router.post("/kb/materials/image-preview", response_class=Response)
async def image_preview(payload: KbImagePreviewRequest, request: Request) -> Response:
    """Decode an authorized disk or material image (including HEIC) into bounded PNG bytes."""
    sources = get_sources(request)
    if payload.path is not None:
        png = await kb_call(
            sources.preview_trusted_image,
            payload.path,
            expected_size=payload.expected_size,
            expected_sha256=payload.expected_sha256,
        )
    else:
        assert payload.material_id is not None
        png = await kb_call(sources.preview_material_image, payload.material_id)
    return Response(content=png, media_type="image/png")


def _http(error: KnowledgeError) -> HTTPException:
    # A video link that can't be added is a problem with the link (like S1's refusals): 422.
    status = 422 if isinstance(error, SpeechInvalid) else error.status_code
    return HTTPException(status_code=status, detail=error.message)


async def _video(speech: SpeechService, payload: KbAddLink, url: str, *,
                 title: str | None, avoid_title: str | None = None) -> SpeechView:
    # Decision 15: the "to wiki" choice travels with the import and is kept before it can finish.
    return await speech.add_video_link(url, payload.folder_id, title, language=payload.language,
                                       translate=payload.translate, avoid_title=avoid_title,
                                       to_wiki=payload.to_wiki)


@router.post("/kb/materials/link", status_code=201)
async def add_link(payload: KbAddLink, request: Request, response: Response) -> KbMaterialAdded:
    """Articles, PDFs, text — and videos (YouTube, VK Video, RuTube, Vimeo), which go to the speech
    import and come back ``processing``. A page with an embedded video: ``mode`` text / video / both.
    The same address, DOI or content already in the library: 200 with ``already_in_library`` (N2)."""
    sources = get_sources(request)
    speech = get_speech(request)
    try:
        offline = classify_offline(payload.url)
        if offline is not None and offline.kind == "video":
            view = await _video(speech, payload, offline.url, title=payload.title)
            return await _video_added(sources, view, response)
        embedded: LinkInfo | None = None
        if payload.mode != "text":
            info = await sources.classify(payload.url, probe=False)
            embedded = info.embedded_video
            if embedded is None:
                raise SpeechInvalid(NO_EMBEDDED_VIDEO)
        if payload.mode == "video":
            assert embedded is not None
            view = await _video(speech, payload, embedded.url, title=payload.title)
            return await _video_added(sources, view, response)
        result = await sources.add_link(payload.url, payload.folder_id, payload.title,
                                        to_wiki=payload.to_wiki)
    except KnowledgeError as error:
        raise _http(error) from error
    except OSError as error:
        raise HTTPException(
            status_code=503,
            detail=f"SKAZ couldn't use the library folder: {error.strerror or error}.",
        ) from error
    added = await _added(sources, result)
    if result.existing:
        response.status_code = 200
    if embedded is None:
        return added
    # Mode "both": the article is added; the video follows, and its own refusal doesn't undo the article.
    try:
        view = await _video(speech, payload, embedded.url, title=None, avoid_title=result.title)
    except KnowledgeError as error:
        return added.model_copy(update={"video_failure_reason": error.message})
    return added.model_copy(update={"video": await _summary(sources, view.material_id),
                                    "video_already_in_library": view.already_in_library})


async def _video_added(sources: SourceService, view: SpeechView, response: Response) -> KbMaterialAdded:
    # N2: the same video already in the library answers 200 with that material; nothing is imported.
    if view.already_in_library:
        response.status_code = 200
    return KbMaterialAdded(material=await _summary(sources, view.material_id), excluded_count=0,
                           hidden_count=0, failure_reason=None, video=None, video_failure_reason=None,
                           already_in_library=view.already_in_library)


@router.post(
    "/kb/materials/web",
    status_code=201,
    response_model=KbMaterial,
    responses={422: {"model": KbWebPageUnavailable}},
)
async def add_web_page(
    payload: KbAddWebPage, request: Request, response: Response
) -> KbMaterial | JSONResponse:
    """W-3 "Add to wiki": SKAZ itself fetches only this URL, saves the whole page as text with the link
    and the date, and the normal ingest follows. 201 = new material; 200 = the same page was already in
    the folder (no request made; ingest is asked for again if it isn't in the wiki). A page SKAZ can't
    save (sign-in, paywall, JavaScript-only, not HTML, too large, too slow, an error answer, a blocked
    address): 422 ``{detail, error_code: "web_page_unavailable"}``."""
    sources = get_sources(request)
    try:
        folder_id = payload.folder_id or INBOX_ID
        saved = await sources.add_web_page(payload.url, folder_id, to_wiki=payload.to_wiki)
    except WebPageUnavailable as error:
        body = KbWebPageUnavailable(detail=error.message, error_code="web_page_unavailable")
        return JSONResponse(status_code=error.status_code, content=body.model_dump())
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error
    except OSError as error:
        raise HTTPException(
            status_code=503, detail=f"SKAZ couldn't use the library folder: {error.strerror or error}."
        ) from error
    if saved.existing:
        response.status_code = 200
    wiki = cast(WikiService, request.app.state.runtime.kb_wiki)
    return await kb_call(material_view, sources.kb, saved.material_id, wiki)


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
