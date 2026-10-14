"""``/kb/wiki``: wiki pages split into blocks with their citations."""
from __future__ import annotations

from fastapi import APIRouter

from ..markdown.page import PageKind
from ..service import PageView
from ..store.records import PageRecord
from .deps import KbDep, kb_call
from .schemas import KbBlock, KbCitation, KbPage, KbPageSummary

router = APIRouter(prefix="/kb/wiki", tags=["kb"])


def summary_view(record: PageRecord) -> KbPageSummary:
    return KbPageSummary.model_validate({
        "id": record.id, "kind": record.kind, "title": record.title, "original": record.original,
        "aliases": list(record.aliases), "folders": list(record.folders), "sources": list(record.sources),
        "language": record.language,
    })


def page_view(view: PageView) -> KbPage:
    return KbPage.model_validate({
        "id": view.id, "kind": view.kind, "title": view.title, "original": view.original,
        "aliases": list(view.aliases), "folders": list(view.folders), "sources": list(view.sources),
        "language": view.language,
        "blocks": [
            KbBlock.model_validate({
                "id": entry.id, "kind": entry.kind, "owner": entry.owner, "marked": entry.marked,
                "section": entry.section, "text": entry.text, "hash": entry.hash,
                "citations": [
                    KbCitation(material_id=c.material_id, seg=c.seg, available=c.available,
                               material_title=c.material_title, start_ms=c.start_ms, end_ms=c.end_ms,
                               page=c.page)
                    for c in entry.citations
                ],
            })
            for entry in view.entries
        ],
    })


@router.get("/pages")
async def list_pages(kb: KbDep, kind: PageKind | None = None,
                     folder_id: str | None = None) -> list[KbPageSummary]:
    return [summary_view(record) for record in await kb_call(kb.pages, kind=kind, folder_id=folder_id)]


@router.get("/pages/{page_id}")
async def read_page(page_id: str, kb: KbDep) -> KbPage:
    """Re-reads the page file first: an external edit is detected when the page is opened."""
    return page_view(await kb_call(kb.page, page_id))
