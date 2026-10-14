"""``/kb/materials``: sources with their fragments (read-only here; adding is done by the source areas)."""
from __future__ import annotations

from fastapi import APIRouter

from ..markdown.source import MaterialKind
from ..service import MaterialDetail
from ..store.records import MaterialRecord
from .deps import KbDep, kb_call
from .schemas import KbFragment, KbMaterial, KbMaterialSummary, KbOrigin

router = APIRouter(prefix="/kb/materials", tags=["kb"])


def summary_view(record: MaterialRecord) -> KbMaterialSummary:
    return KbMaterialSummary.model_validate({
        "id": record.id, "title": record.title, "kind": record.kind, "status": record.status,
        "folder_id": record.folder_id, "languages": list(record.languages), "created_at": record.created_at,
        "fragment_count": record.fragment_count,
    })


def detail_view(detail: MaterialDetail) -> KbMaterial:
    origin = None
    if detail.origin is not None:
        origin = KbOrigin(type=detail.origin["type"], url=detail.origin.get("url"),
                          file_name=detail.origin.get("file_name"))
    return KbMaterial.model_validate({
        "id": detail.id, "title": detail.title, "kind": detail.kind, "status": detail.status,
        "folder_id": detail.folder_id, "languages": list(detail.languages), "created_at": detail.created_at,
        "fragment_count": len(detail.fragments), "origin": origin,
        "fragments": [
            KbFragment(id=f.id, seg=f.seg, text=f.text, start_ms=f.start_ms, end_ms=f.end_ms,
                       speaker=f.speaker, page=f.page, index=f.index)
            for f in detail.fragments
        ],
    })


@router.get("")
async def list_materials(kb: KbDep, folder_id: str | None = None,
                         kind: MaterialKind | None = None) -> list[KbMaterialSummary]:
    records = await kb_call(kb.materials, folder_id=folder_id, kind=kind)
    return [summary_view(record) for record in records]


@router.get("/{material_id}")
async def read_material(material_id: str, kb: KbDep) -> KbMaterial:
    return detail_view(await kb_call(kb.material, material_id))
