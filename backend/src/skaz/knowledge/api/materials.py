"""``/kb/materials``: sources with their fragments (read-only here; adding is done by the source areas)."""
from __future__ import annotations

from collections.abc import Sequence

from fastapi import APIRouter

from ..errors import LibraryUnavailable
from ..markdown.source import MaterialKind
from ..service import KnowledgeService, MaterialDetail
from ..sources.material_info import (
    NOT_IN_WIKI,
    MaterialWiki,
    Translation,
    excluded_count,
    read_translation,
    wiki_states,
)
from ..store.records import MaterialRecord
from .deps import KbDep, kb_call
from .schemas import (
    KbFragment,
    KbMaterial,
    KbMaterialSummary,
    KbMaterialWiki,
    KbOrigin,
    KbTranslation,
    KbTranslationFragment,
)

router = APIRouter(prefix="/kb/materials", tags=["kb"])


def summary_view(record: MaterialRecord, *, folder_name: str, wiki: MaterialWiki) -> KbMaterialSummary:
    return KbMaterialSummary.model_validate({
        "id": record.id, "title": record.title, "kind": record.kind, "status": record.status,
        "folder_id": record.folder_id, "languages": list(record.languages), "created_at": record.created_at,
        "fragment_count": record.fragment_count, "wiki_state": wiki.state, "folder_name": folder_name,
    })


def material_summaries(kb: KnowledgeService, records: Sequence[MaterialRecord]) -> list[KbMaterialSummary]:
    """Summaries with folder names and wiki states, read once for the whole list."""
    folders = {folder.id: folder.name for folder in kb.folders()}
    states = wiki_states(kb.db, [record.id for record in records])
    return [summary_view(record, folder_name=folders.get(record.folder_id, ""),
                         wiki=states.get(record.id, NOT_IN_WIKI)) for record in records]


def _wiki_view(wiki: MaterialWiki) -> KbMaterialWiki:
    return KbMaterialWiki(state=wiki.state, note_page_id=wiki.note_page_id, concept_count=wiki.concept_count,
                          job_id=wiki.job_id, error=wiki.error)


def _translation_view(translation: Translation | None) -> KbTranslation | None:
    if translation is None:
        return None
    return KbTranslation(language=translation.language, fragments=[
        KbTranslationFragment(seg=item.seg, speaker=item.speaker, text=item.text)
        for item in translation.fragments
    ])


def detail_view(detail: MaterialDetail, *, folder_name: str, wiki: MaterialWiki,
                translation: Translation | None, excluded: int) -> KbMaterial:
    origin = None
    if detail.origin is not None:
        origin = KbOrigin(type=detail.origin["type"], url=detail.origin.get("url"),
                          file_name=detail.origin.get("file_name"))
    return KbMaterial.model_validate({
        "id": detail.id, "title": detail.title, "kind": detail.kind, "status": detail.status,
        "folder_id": detail.folder_id, "languages": list(detail.languages), "created_at": detail.created_at,
        "fragment_count": len(detail.fragments), "origin": origin, "wiki_state": wiki.state,
        "folder_name": folder_name,
        "fragments": [
            KbFragment(id=f.id, seg=f.seg, text=f.text, start_ms=f.start_ms, end_ms=f.end_ms,
                       speaker=f.speaker, page=f.page, index=f.index)
            for f in detail.fragments
        ],
        "translation": _translation_view(translation), "wiki": _wiki_view(wiki), "excluded_count": excluded,
    })


def material_view(kb: KnowledgeService, material_id: str) -> KbMaterial:
    detail = kb.material(material_id)
    record = kb.material_repo.get(material_id)
    folder = kb.folder_repo.get(detail.folder_id)
    wiki = wiki_states(kb.db, [material_id]).get(material_id, NOT_IN_WIKI)
    translation, excluded = None, 0
    try:
        library = kb.require()
    except LibraryUnavailable:
        library = None  # the index still shows the text; the service files can't be read now
    if library is not None and record is not None:
        directory = library.root / record.rel_dir
        translation = read_translation(directory)
        excluded = excluded_count(directory)
    return detail_view(detail, folder_name=folder.name if folder else "", wiki=wiki,
                       translation=translation, excluded=excluded)


@router.get("")
async def list_materials(kb: KbDep, folder_id: str | None = None,
                         kind: MaterialKind | None = None) -> list[KbMaterialSummary]:
    records = await kb_call(kb.materials, folder_id=folder_id, kind=kind)
    return await kb_call(material_summaries, kb, records)


@router.get("/{material_id}")
async def read_material(material_id: str, kb: KbDep) -> KbMaterial:
    return await kb_call(material_view, kb, material_id)
