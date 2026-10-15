"""``/kb/materials``: sources with their fragments; rename/move, delete with preview, corrections (W2)."""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Request

from ..corrections.model import CorrectionEntry
from ..errors import KnowledgeError
from ..markdown.source import MaterialKind
from ..service import MaterialDetail
from ..store.records import MaterialRecord
from ..wiki.delete import DeletePlan, PageRefView
from ..wiki.service import WikiService
from .deps import KbDep, kb_call
from .ingest import job_view
from .schemas import KbCorrectionCounts, KbFragment, KbMaterial, KbMaterialSummary, KbOrigin, KbPageRef
from .schemas_wiki2 import KbCorrection, KbCorrectionChange, KbDeletePreview, KbMaterialUpdate

router = APIRouter(prefix="/kb/materials", tags=["kb"])
#: ``/kb/corrections/{id}/…`` (decisions on one recognition correction).
corrections_router = APIRouter(prefix="/kb/corrections", tags=["kb"])


def get_wiki(request: Request) -> WikiService:
    return cast(WikiService, request.app.state.runtime.kb_wiki)


WikiDep = Annotated[WikiService, Depends(get_wiki)]


def summary_view(record: MaterialRecord) -> KbMaterialSummary:
    return KbMaterialSummary.model_validate(
        {
            "id": record.id,
            "title": record.title,
            "kind": record.kind,
            "status": record.status,
            "folder_id": record.folder_id,
            "languages": list(record.languages),
            "created_at": record.created_at,
            "fragment_count": record.fragment_count,
        }
    )


def detail_view(detail: MaterialDetail, wiki: WikiService) -> KbMaterial:
    origin = None
    if detail.origin is not None:
        origin = KbOrigin(
            type=detail.origin["type"], url=detail.origin.get("url"), file_name=detail.origin.get("file_name")
        )
    views = wiki.corrections.fragment_views(detail.id, detail.fragments)
    applied, doubtful = wiki.corrections.counts(detail.id)
    return KbMaterial.model_validate(
        {
            "id": detail.id,
            "title": detail.title,
            "kind": detail.kind,
            "status": detail.status,
            "folder_id": detail.folder_id,
            "languages": list(detail.languages),
            "created_at": detail.created_at,
            "fragment_count": len(detail.fragments),
            "origin": origin,
            "fragments": [
                KbFragment(
                    id=v.fragment.id,
                    seg=v.fragment.seg,
                    text=v.text,
                    start_ms=v.fragment.start_ms,
                    end_ms=v.fragment.end_ms,
                    speaker=v.fragment.speaker,
                    page=v.fragment.page,
                    index=v.fragment.index,
                    original_text=v.original_text,
                    corrections=list(v.corrections),
                )
                for v in views
            ],
            "correction_counts": KbCorrectionCounts(applied=applied, doubtful=doubtful),
        }
    )


def _material(kb: KbDep, wiki: WikiService, material_id: str) -> KbMaterial:
    return detail_view(kb.material(material_id), wiki)


def correction_view(material_id: str, entry: CorrectionEntry) -> KbCorrection:
    return KbCorrection(
        id=entry.id,
        material_id=material_id,
        seg=entry.seg,
        before=entry.before,
        after=entry.after,
        reason=entry.reason,
        confidence=entry.confidence,
        state=entry.state,
        auto=entry.auto,
        created_at=entry.created_at,
        decided_at=entry.decided_at,
    )


def preview_view(plan: DeletePlan) -> KbDeletePreview:
    def refs(items: list[PageRefView]) -> list[KbPageRef]:
        return [
            KbPageRef.model_validate({"id": item.id, "kind": item.kind, "title": item.title})
            for item in items
        ]

    return KbDeletePreview(
        material_id=plan.material_id,
        title=plan.title,
        claims_removed=plan.claims_removed,
        claims_kept=plan.claims_kept,
        pages_changed=refs(plan.pages_changed),
        pages_removed=refs(plan.pages_removed),
        connections_removed=plan.connections_removed,
        user_notes_kept=plan.user_notes_kept,
    )


@router.get("")
async def list_materials(
    kb: KbDep, folder_id: str | None = None, kind: MaterialKind | None = None
) -> list[KbMaterialSummary]:
    records = await kb_call(kb.materials, folder_id=folder_id, kind=kind)
    return [summary_view(record) for record in records]


@router.get("/{material_id}")
async def read_material(material_id: str, kb: KbDep, wiki: WikiDep) -> KbMaterial:
    """Fragment text with the applied recognition corrections; ``original_text`` when they changed it."""
    return await kb_call(_material, kb, wiki, material_id)


@router.patch("/{material_id}")
async def update_material(material_id: str, body: KbMaterialUpdate, kb: KbDep, wiki: WikiDep) -> KbMaterial:
    """Rename and/or move; a taken name is 409 and nothing changes. Wiki links follow by id."""
    await kb_call(wiki.move_material, material_id, title=body.title, folder_id=body.folder_id)
    return await kb_call(_material, kb, wiki, material_id)


@router.get("/{material_id}/delete-preview")
async def delete_preview(material_id: str, wiki: WikiDep) -> KbDeletePreview:
    return preview_view(await kb_call(wiki.delete_preview, material_id))


@router.delete("/{material_id}")
async def delete_material(material_id: str, wiki: WikiDep) -> KbDeletePreview:
    """What actually happened. 409 while the material is recorded or being added to the wiki."""
    return preview_view(await kb_call(wiki.delete_material, material_id))


@router.get("/{material_id}/corrections")
async def list_corrections(material_id: str, wiki: WikiDep) -> list[KbCorrection]:
    material, entries = await kb_call(wiki.corrections.corrections, material_id)
    return [correction_view(material, entry) for entry in entries]


async def _change(wiki: WikiService, correction_id: str, action: str) -> KbCorrectionChange:
    try:
        change = await wiki.change_correction(correction_id, action)
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error
    return KbCorrectionChange(
        correction=correction_view(change.material_id, change.correction),
        affected_blocks=change.affected_blocks,
        job=job_view(change.job) if change.job is not None else None,
    )


@corrections_router.post("/{correction_id}/revert")
async def revert_correction(correction_id: str, wiki: WikiDep) -> KbCorrectionChange:
    """applied → reverted: the recognised text again; the wiki follows at once."""
    return await _change(wiki, correction_id, "revert")


@corrections_router.post("/{correction_id}/accept")
async def accept_correction(correction_id: str, wiki: WikiDep) -> KbCorrectionChange:
    """doubtful → applied."""
    return await _change(wiki, correction_id, "accept")


@corrections_router.post("/{correction_id}/keep")
async def keep_correction(correction_id: str, wiki: WikiDep) -> KbCorrectionChange:
    """doubtful → kept: the recognised text stays."""
    return await _change(wiki, correction_id, "keep")


@corrections_router.post("/{correction_id}/reapply")
async def reapply_correction(correction_id: str, wiki: WikiDep) -> KbCorrectionChange:
    """reverted → applied."""
    return await _change(wiki, correction_id, "reapply")
