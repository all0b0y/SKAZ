"""``/kb/export``: the wiki as plain Markdown plus the materials' .md into a chosen folder (B20);
``/kb/export/items``: only the chosen chats, pages and materials (0.3.1 F5)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from ..errors import KnowledgeError
from ..wiki.export import ChatFile, export_items
from .chats import ChatsDep
from .deps import kb_call
from .ingest import job_view
from .schemas_ingest import KbJob
from .schemas_wiki2 import (
    KbExportItemsRequest,
    KbExportItemsResult,
    KbExportRequest,
    KbExportSkipped,
    KbExportTarget,
    KbExportWritten,
)
from .wiki import WikiDep

router = APIRouter(prefix="/kb/export", tags=["kb"])


@router.get("/target")
async def export_target(
    wiki: WikiDep, path: Annotated[str, Query(min_length=1, max_length=4096)]
) -> KbExportTarget:
    """Whether the folder (picked in the native chooser) may receive the export; changes nothing."""
    target = await kb_call(wiki.export_target, path)
    return KbExportTarget(
        path=target.path, reason=target.reason, non_empty=target.non_empty, entries=target.entries
    )


@router.post("", status_code=202)
async def start_export(body: KbExportRequest, wiki: WikiDep) -> KbJob:
    """An ``export`` job; 409 for a folder inside the library or a non-empty one without ``overwrite``."""
    try:
        return job_view(await wiki.export(body.path, overwrite=body.overwrite))
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error


@router.post("/items")
async def export_chosen(body: KbExportItemsRequest, wiki: WikiDep, chats: ChatsDep) -> KbExportItemsResult:
    """The chosen items as ``.md`` (pages and materials laid out as in the full export, chats in
    ``Chats/``); 409 with the same folder rules as ``POST /kb/export``; unknown items are skipped."""
    rendered: dict[str, ChatFile | str] = {}
    for item in body.items:
        if item.type != "chat" or item.id in rendered:
            continue
        try:
            exported = await chats.export(item.id)
        except KnowledgeError as error:
            rendered[item.id] = error.message
        else:
            rendered[item.id] = ChatFile(exported.file_name, exported.markdown)
    result = await kb_call(
        export_items, wiki.kb, body.path, [(item.type, item.id) for item in body.items],
        overwrite=body.overwrite, chats=rendered,
    )
    return KbExportItemsResult(
        written=[KbExportWritten(type=kind, id=item_id, file=file)
                 for kind, item_id, file in result.written],
        skipped=[KbExportSkipped(type=kind, id=item_id, reason=reason)
                 for kind, item_id, reason in result.skipped],
    )
