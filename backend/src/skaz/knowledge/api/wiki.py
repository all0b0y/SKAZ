"""``/kb/wiki``: pages with their blocks, editing, recheck, "Find connections"; ``/kb/graph``; rescan."""

from __future__ import annotations

from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Request

from ..corrections.settings import RecognitionSettings
from ..errors import KnowledgeError
from ..markdown.page import PageKind
from ..store.records import PageRecord
from ..wiki.links import LinkView
from ..wiki.page_ops import PageDeletePlan
from ..wiki.service import PageDetail, WikiService
from .deps import KbDep, kb_call
from .ingest import job_view
from .schemas import KbBlock, KbBlockLink, KbCitation, KbPage, KbPageRef, KbPageSummary
from .schemas_ingest import KbJob
from .schemas_wiki2 import (
    KbBlockCreate,
    KbBlockUpdate,
    KbEdgeKind,
    KbGraph,
    KbGraphEdge,
    KbGraphNode,
    KbNodeKind,
    KbPageDeletePreview,
    KbPageFile,
    KbPageLinking,
    KbPageRename,
    KbRecognitionSettings,
    KbRecognitionSettingsUpdate,
    KbRescanResult,
    KbSourceKept,
    KbWikiFile,
)

router = APIRouter(prefix="/kb/wiki", tags=["kb"])
#: ``/kb/graph`` and ``/kb/library/rescan`` (W2) live outside the ``/kb/wiki`` prefix.
graph_router = APIRouter(tags=["kb"])


def get_wiki(request: Request) -> WikiService:
    return cast(WikiService, request.app.state.runtime.kb_wiki)


WikiDep = Annotated[WikiService, Depends(get_wiki)]


def summary_view(record: PageRecord) -> KbPageSummary:
    return KbPageSummary.model_validate(
        {
            "id": record.id,
            "kind": record.kind,
            "title": record.title,
            "original": record.original,
            "aliases": list(record.aliases),
            "folders": list(record.folders),
            "sources": list(record.sources),
            "language": record.language,
        }
    )


def _link_view(link: LinkView) -> KbBlockLink:
    return KbBlockLink(
        target=link.target,
        page=KbPageRef(id=link.page_id, kind=cast(PageKind, link.page_kind), title=link.page_title or "")
        if link.page_id else None,
        material_id=link.material_id,
    )


def page_view(detail: PageDetail) -> KbPage:
    view = detail.view
    return KbPage.model_validate(
        {
            "id": view.id,
            "kind": view.kind,
            "title": view.title,
            "original": view.original,
            "aliases": list(view.aliases),
            "folders": list(view.folders),
            "sources": list(view.sources),
            "language": view.language,
            "blocks": [
                KbBlock.model_validate(
                    {
                        "id": entry.id,
                        "kind": entry.kind,
                        "owner": entry.owner,
                        "marked": entry.marked,
                        "section": entry.section,
                        "text": entry.text,
                        "hash": entry.hash,
                        "citations": [
                            KbCitation(
                                material_id=c.material_id,
                                seg=c.seg,
                                available=c.available,
                                material_title=c.material_title,
                                start_ms=c.start_ms,
                                end_ms=c.end_ms,
                                page=c.page,
                                quote=c.quote,
                                index=c.index,
                            )
                            for c in entry.citations
                        ],
                        "links": [_link_view(link) for link in detail.links.get(entry.id, [])],
                    }
                )
                for entry in view.entries
            ],
            "related": [KbPageRef.model_validate(ref.__dict__) for ref in detail.related],
            "mentioned_in": [KbPageRef.model_validate(ref.__dict__) for ref in detail.mentioned_in],
            "folder_names": detail.folder_names,
            "updated_at": detail.updated_at,
            "is_analysis_source_forbidden": view.kind == "analysis",
        }
    )


@router.get("/pages")
async def list_pages(
    kb: KbDep, kind: PageKind | None = None, folder_id: str | None = None
) -> list[KbPageSummary]:
    return [summary_view(record) for record in await kb_call(kb.pages, kind=kind, folder_id=folder_id)]


@router.get("/pages/{page_id}")
async def read_page(page_id: str, wiki: WikiDep) -> KbPage:
    """Re-reads the page file first: an external edit is detected when the page is opened."""
    return page_view(await kb_call(wiki.page, page_id))


@router.get("/files/{name}")
async def read_wiki_file(name: Literal["index", "log"], wiki: WikiDep) -> KbWikiFile:
    """``Wiki/index.md`` or ``Wiki/log.md``, read-only, with its links resolved (B20)."""
    text, links = await kb_call(wiki.wiki_file, name)
    return KbWikiFile(name=name, text=text, links=[_link_view(link) for link in links])


@router.get("/pages/{page_id}/file")
async def page_file(page_id: str, wiki: WikiDep) -> KbPageFile:
    """The page's file on disk, for the main process only (Show in Finder, Open in Obsidian, B20).

    The renderer never calls it (the IPC policy refuses it): main checks the path lies inside the
    library root before it hands it to Finder or Obsidian.
    """
    return KbPageFile(path=await kb_call(wiki.page_file, page_id))


@router.patch("/pages/{page_id}")
async def rename_page(page_id: str, body: KbPageRename, wiki: WikiDep) -> KbPage:
    """Rename a page; every [[link]] to it is rewritten (B20). 409 for a taken name."""
    return page_view(await kb_call(wiki.rename_page, page_id, body.title))


def _delete_view(plan: PageDeletePlan) -> KbPageDeletePreview:
    return KbPageDeletePreview(
        page=KbPageRef(id=plan.page.id, kind=cast(PageKind, plan.page.kind), title=plan.page.title),
        linking_pages=[
            KbPageLinking(
                page=KbPageRef(id=item.ref.id, kind=cast(PageKind, item.ref.kind), title=item.ref.title),
                links=item.links,
                in_your_notes=item.in_user_text,
            )
            for item in plan.linking
        ],
        links_unlinked=plan.links_unlinked,
        user_notes=plan.user_notes,
        sources=[KbSourceKept(id=material_id, title=title) for material_id, title in plan.sources],
    )


@router.get("/pages/{page_id}/delete-preview")
async def page_delete_preview(page_id: str, wiki: WikiDep) -> KbPageDeletePreview:
    """What deleting the page would do; changes nothing."""
    return _delete_view(await kb_call(wiki.page_delete_preview, page_id))


@router.delete("/pages/{page_id}")
async def delete_page(page_id: str, wiki: WikiDep) -> KbPageDeletePreview:
    """Delete the page: links to it are unlinked, its sources stay."""
    return _delete_view(await kb_call(wiki.delete_page, page_id))


@router.put("/pages/{page_id}/blocks/{block_id}")
async def update_block(page_id: str, block_id: str, body: KbBlockUpdate, wiki: WikiDep) -> KbPage:
    """An agent block becomes ``user_edited`` (ingest never rewrites it); a note stays the user's."""
    return page_view(await kb_call(wiki.update_block, page_id, block_id, body.text))


@router.post("/pages/{page_id}/blocks", status_code=201)
async def add_block(page_id: str, body: KbBlockCreate, wiki: WikiDep) -> KbPage:
    """A new ``user_note`` (after a block, at the end of a section, or under "My notes")."""
    return page_view(
        await kb_call(
            wiki.add_note, page_id, body.text, after_block_id=body.after_block_id, section=body.section
        )
    )


@router.delete("/pages/{page_id}/blocks/{block_id}")
async def delete_block(page_id: str, block_id: str, wiki: WikiDep) -> KbPage:
    """Only the user's own notes; 409 for agent statements."""
    return page_view(await kb_call(wiki.delete_note, page_id, block_id))


@router.post("/pages/{page_id}/blocks/{block_id}/recheck", status_code=202)
async def recheck_block(page_id: str, block_id: str, wiki: WikiDep) -> KbJob:
    """The agent rewrites the block from its sources; it stays (or becomes again) the agent's."""
    try:
        return job_view(await wiki.recheck(page_id, block_id))
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error


@router.post("/connections/find", status_code=202)
async def find_connections(wiki: WikiDep) -> KbJob:
    """ "Find connections" across the whole wiki (and disagreements between sources). 409 while one runs."""
    try:
        return job_view(await wiki.find_connections_now())
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error


def recognition_view(settings: RecognitionSettings) -> KbRecognitionSettings:
    return KbRecognitionSettings(engine=settings.engine, model=settings.model, effort=settings.effort)


@graph_router.get("/kb/settings/recognition")
async def read_recognition_settings(wiki: WikiDep) -> KbRecognitionSettings:
    return recognition_view(await kb_call(wiki.recognition_settings))


@graph_router.put("/kb/settings/recognition")
async def update_recognition_settings(
    body: KbRecognitionSettingsUpdate, wiki: WikiDep
) -> KbRecognitionSettings:
    return recognition_view(
        await kb_call(wiki.update_recognition, engine=body.engine, model=body.model, effort=body.effort)
    )


@graph_router.post("/kb/materials/{material_id}/recognition-check", status_code=202)
async def check_recognition_again(material_id: str, wiki: WikiDep) -> KbJob:
    """"Check recognition again" of a recording: a ``corrections`` job; 409 when it can't run now."""
    try:
        return job_view(await wiki.check_recognition_again(material_id))
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error


@graph_router.get("/kb/graph")
async def read_graph(wiki: WikiDep, folder_id: str | None = None) -> KbGraph:
    graph = await kb_call(wiki.graph_view, folder_id)
    return KbGraph(
        nodes=[
            KbGraphNode(
                id=node.id,
                kind=cast(KbNodeKind, node.kind),
                title=node.title,
                folder_ids=list(node.folder_ids),
                degree=node.degree,
                hub=node.hub,
            )
            for node in graph.nodes
        ],
        edges=[
            KbGraphEdge(
                source=edge.source,
                target=edge.target,
                kind=cast(KbEdgeKind, edge.kind),
                cross_folder=cross,
                page_id=edge.page_id,
                block_id=edge.block_id,
            )
            for edge, cross in graph.edges
        ],
    )


@graph_router.post("/kb/library/rescan")
async def rescan_library(wiki: WikiDep) -> KbRescanResult:
    """Read the whole library again now (outside edits); how many pages changed."""
    return KbRescanResult(pages_changed=await kb_call(wiki.rescan))
