"""``/kb/materials/{id}/ingest``, ``/kb/jobs``, ``/kb/settings/wiki`` (area W1)."""
from __future__ import annotations

from dataclasses import asdict
from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Request

from ..errors import KnowledgeError
from ..ingest.jobs import JobRecord
from ..ingest.service import IngestService
from ..ingest.settings import WikiSettings
from .deps import kb_call
from .schemas_ingest import KbJob, KbJobLogEntry, KbJobProgress, KbWikiSettings, KbWikiSettingsUpdate

router = APIRouter(tags=["kb"])


def get_ingest(request: Request) -> IngestService:
    return cast(IngestService, request.app.state.runtime.kb_ingest)


IngestDep = Annotated[IngestService, Depends(get_ingest)]


def job_view(record: JobRecord) -> KbJob:
    counters = record.counters
    return KbJob.model_validate({
        "id": record.id, "kind": record.kind, "material_id": record.material_id, "state": record.state,
        "step": record.step, "label": record.label, "error": record.error,
        "error_code": record.error_code, "can_retry": record.can_retry,
        "execution": asdict(record.execution) if record.execution is not None else None,
        "progress": KbJobProgress(**{name: counters.get(name, 0) for name in KbJobProgress.model_fields}),
        "journal": [KbJobLogEntry(at=entry.at, message=entry.message) for entry in record.journal],
        "created_at": record.created_at, "updated_at": record.updated_at,
        "step_started_at": record.step_started_at,
    })


def settings_view(settings: WikiSettings) -> KbWikiSettings:
    return KbWikiSettings.model_validate({
        "wiki_language": settings.language, "wiki_language_chosen": settings.language_chosen,
        "wiki_engine": settings.engine, "wiki_model": settings.model, "wiki_effort": settings.effort,
        "wiki_remembered": {engine: {"model": model, "effort": effort}
                            for engine, (model, effort) in settings.remembered.items()},
        "auto_add_files_links": settings.auto_add_files_links,
        "auto_add_text": settings.auto_add_text, "background_connections": settings.background_connections,
        "auto_corrections": settings.auto_corrections,
        "wiki_budget_characters": settings.budget,
    })


@router.post("/kb/materials/{material_id}/ingest", status_code=202)
async def request_ingest(material_id: str, ingest: IngestDep) -> KbJob:
    """Queue the material for the wiki (or retry). 409 while a job for it is queued or running.

    C1-d Continue: a material paused at its wiki budget continues from its checkpoint; when only
    its follow-up work (overview, connections) paused, just that work runs again.
    """
    try:
        return job_view(await ingest.request_from_user(material_id))
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error


@router.post("/kb/jobs/retry-failed")
async def retry_failed(ingest: IngestDep) -> list[KbJob]:
    """Queue again every material whose latest wiki job failed or was interrupted."""
    return [job_view(record) for record in await ingest.retry_failed()]


@router.get("/kb/jobs")
async def list_jobs(ingest: IngestDep, material_id: str | None = None) -> list[KbJob]:
    return [job_view(record) for record in await kb_call(ingest.list_jobs, material_id=material_id)]


@router.get("/kb/jobs/{job_id}")
async def read_job(job_id: str, ingest: IngestDep) -> KbJob:
    return job_view(await kb_call(ingest.job, job_id))


@router.post("/kb/jobs/{job_id}/cancel")
async def cancel_job(job_id: str, ingest: IngestDep) -> KbJob:
    try:
        return job_view(await ingest.cancel(job_id))
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error


@router.get("/kb/settings/wiki")
async def read_wiki_settings(ingest: IngestDep) -> KbWikiSettings:
    return settings_view(await kb_call(ingest.settings))


@router.put("/kb/settings/wiki")
async def update_wiki_settings(body: KbWikiSettingsUpdate, ingest: IngestDep) -> KbWikiSettings:
    fields = body.model_fields_set
    settings = await kb_call(
        ingest.update_settings, language=body.wiki_language, engine=body.wiki_engine,
        clear_engine="wiki_engine" in fields and body.wiki_engine is None,
        model=body.wiki_model, effort=body.wiki_effort,
        clear_model="wiki_model" in fields and body.wiki_model is None,
        clear_effort="wiki_effort" in fields and body.wiki_effort is None,
        auto_add_files_links=body.auto_add_files_links, auto_add_text=body.auto_add_text,
        background_connections=body.background_connections, auto_corrections=body.auto_corrections,
        budget=body.wiki_budget_characters,
    )
    return settings_view(settings)
