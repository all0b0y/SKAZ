"""``/kb/search``: fragments and wiki blocks (FTS5), page titles/aliases, material titles and counts."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from ..index.search import SnippetPart
from ..service import KnowledgeService
from ..sources.material_search import counts, search_materials
from .deps import KbDep, kb_call
from .schemas import (
    KbBlockHit,
    KbFragmentHit,
    KbMaterialHit,
    KbPageHit,
    KbSearchCounts,
    KbSearchResults,
    KbSnippetPart,
)

router = APIRouter(prefix="/kb/search", tags=["kb"])


def _snippet(parts: tuple[SnippetPart, ...]) -> list[KbSnippetPart]:
    return [KbSnippetPart(text=part.text, match=part.match) for part in parts]


def run_search(kb: KnowledgeService, q: str, limit: int) -> KbSearchResults:
    results = kb.search(q, limit=limit)
    materials, titled = search_materials(kb.db, q, limit=limit)
    totals = counts(kb.db, q, material_titles=titled)
    return KbSearchResults.model_validate({
        "query": results.query,
        "fragments": [
            KbFragmentHit.model_validate({
                "material_id": hit.material_id, "material_title": hit.material_title,
                "material_kind": hit.material_kind, "seg": hit.seg, "start_ms": hit.start_ms,
                "page": hit.page,
                "snippet": _snippet(hit.snippet),
            })
            for hit in results.fragments
        ],
        "blocks": [
            KbBlockHit.model_validate({
                "page_id": hit.page_id, "page_title": hit.page_title, "page_kind": hit.page_kind,
                "block_id": hit.block_id, "kind": hit.kind, "owner": hit.owner,
                "snippet": _snippet(hit.snippet),
            })
            for hit in results.blocks
        ],
        "pages": [
            KbPageHit.model_validate({"id": hit.id, "title": hit.title, "kind": hit.kind,
                                      "matched_alias": hit.matched_alias})
            for hit in results.pages
        ],
        "materials": [
            KbMaterialHit.model_validate({
                "id": hit.id, "title": hit.title, "kind": hit.kind, "folder_id": hit.folder_id,
                "folder_name": hit.folder_name, "created_at": hit.created_at,
                "snippet": _snippet(hit.snippet),
            })
            for hit in materials
        ],
        "counts": KbSearchCounts(wiki=totals.wiki, materials=totals.materials, chats=totals.chats),
    })


@router.get("")
async def search(kb: KbDep, q: Annotated[str, Query(max_length=500)],
                 limit: Annotated[int, Query(ge=1, le=100)] = 20) -> KbSearchResults:
    return await kb_call(run_search, kb, q, limit)
