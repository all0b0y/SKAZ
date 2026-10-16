"""``/kb/export``: the wiki as plain Markdown plus the materials' .md into a chosen folder (B20)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from ..errors import KnowledgeError
from .deps import kb_call
from .ingest import job_view
from .schemas_ingest import KbJob
from .schemas_wiki2 import KbExportRequest, KbExportTarget
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
