"""``/kb/materials/{text,file,link}``, ``/kb/links/classify`` and exclusions (area S1)."""

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, HTTPException, Request

from ..errors import KnowledgeError
from ..sources.links import LinkInfo
from ..sources.service import GuardReport, IntakeResult, SourceService, location_label
from .deps import kb_call
from .materials import summary_view
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


def get_sources(request: Request) -> SourceService:
    return cast(SourceService, request.app.state.runtime.kb_sources)


async def _added(sources: SourceService, result: IntakeResult) -> KbMaterialAdded:
    record = await kb_call(sources.kb.material_repo.get, result.material_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Material not found.")
    summary: KbMaterialSummary = summary_view(record)
    return KbMaterialAdded(
        material=summary,
        excluded_count=result.excluded_count,
        hidden_count=result.hidden_count,
        failure_reason=result.failure,
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
    return KbLinkInfo(
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


@router.post("/kb/materials/link", status_code=201)
async def add_link(payload: KbAddLink, request: Request) -> KbMaterialAdded:
    """Articles, PDFs and text by URL. A video link answers 422: the speech import adds videos."""
    sources = get_sources(request)
    try:
        result = await sources.add_link(payload.url, payload.folder_id, payload.title)
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error
    except OSError as error:
        raise HTTPException(
            status_code=503,
            detail=f"SKAZ couldn't use the library folder: {error.strerror or error}.",
        ) from error
    return await _added(sources, result)


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
