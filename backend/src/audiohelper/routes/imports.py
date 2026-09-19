"""Importing an existing audio file as a session.

The audio goes to the provider; the file itself stays where the user keeps it.
Every route here refuses to spend money implicitly: creating an import is the
only charged action, and it requires an explicit request with a title the user
has seen.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException

from .. import repository as repo
from ..gateways import ProviderNotConfigured
from ..gateways.soniox_async import SUPPORTED_EXTENSIONS
from ..import_service import MAX_CONCURRENT_IMPORTS, ImportRejected, ImportRequest
from ..import_store import ImportConflict, ImportRecord
from ..native_io import disk_call
from ..schemas import (
    MAX_IMPORT_DURATION_MS,
    CreateImportRequest,
    DeleteResponse,
    ImportCapabilities,
    ImportCreatedResponse,
    ImportSourceView,
    ImportsResponse,
    ImportView,
)
from .deps import RuntimeDep

router = APIRouter(prefix="/imports")

#: Advertised provider rates in US dollars per hour of audio (async file input).
#: Transcription is input audio plus one text stream; translation adds a second.
RATE_PER_HOUR_USD = 0.10
TRANSLATION_RATE_PER_HOUR_USD = 0.15


@router.get("")
async def read_capabilities(runtime: RuntimeDep) -> ImportCapabilities:
    settings = await disk_call(runtime.settings_store.load)
    root = runtime.session_files.root
    return ImportCapabilities(
        supported_extensions=list(SUPPORTED_EXTENSIONS),
        max_duration_ms=MAX_IMPORT_DURATION_MS,
        rate_per_hour_usd=RATE_PER_HOUR_USD,
        translation_rate_per_hour_usd=TRANSLATION_RATE_PER_HOUR_USD,
        warn_above_usd=settings.import_cost_warning_usd,
        cloud_consent=settings.cloud_consent,
        has_api_key=bool(await disk_call(runtime.api_key, "soniox")),
        active_imports=runtime.imports.active,
        max_concurrent_imports=MAX_CONCURRENT_IMPORTS,
        # Honest about where the result lands: the database always, a folder only
        # when the user turned the Markdown projection on.
        destination=(str(root) if root is not None
                     else "Внутреннее хранилище приложения (экспорт в папку не включён)"),
        markdown_enabled=root is not None,
    )


@router.get("/active")
async def list_active(runtime: RuntimeDep) -> ImportsResponse:
    records = await disk_call(runtime.imports.store.unsettled)
    return ImportsResponse(imports=[_view(record) for record in records])


@router.post("", status_code=201)
async def create_import(payload: CreateImportRequest, runtime: RuntimeDep) -> ImportCreatedResponse:
    path = Path(payload.path)
    _validate_candidate(path)
    session = await disk_call(repo.create_session, runtime.db, payload.title.strip())
    # The session exists only to hold the import; a rejected import takes it away
    # again rather than leaving an empty shell in the navigator.
    try:
        record = await runtime.imports.start(ImportRequest(
            session_id=session.id, path=path, translate=payload.translate,
            declared_duration_ms=payload.declared_duration_ms,
        ))
    except (ImportRejected, ImportConflict) as error:
        await disk_call(repo.delete_session, runtime.db, session.id)
        raise HTTPException(status_code=400, detail=str(error)) from error
    except ProviderNotConfigured as error:
        await disk_call(repo.delete_session, runtime.db, session.id)
        raise HTTPException(status_code=409, detail=str(error)) from error
    refreshed = await disk_call(repo.get_session, runtime.db, session.id)
    return ImportCreatedResponse(session=refreshed or session, import_state=_view(record))


@router.get("/{session_id}")
async def read_import(session_id: str, runtime: RuntimeDep) -> ImportView:
    record = await disk_call(runtime.imports.store.get, session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="This session is not an import.")
    return _view(record)


@router.post("/{session_id}/cancel")
async def cancel_import(session_id: str, runtime: RuntimeDep) -> ImportView:
    try:
        record = await runtime.imports.cancel(session_id)
    except ImportConflict as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return _view(record)


@router.post("/{session_id}/retry", status_code=201)
async def retry_import(session_id: str, runtime: RuntimeDep) -> ImportCreatedResponse:
    """Start a new paid job for a failed import, in a new session.

    The failed session is kept: it carries the provider's reason, and deleting it
    silently would hide what went wrong. Retrying is a fresh charge, which is why
    it is a separate explicit request rather than an automatic recovery.
    """
    record = await disk_call(runtime.imports.store.get, session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="This session is not an import.")
    if record.status not in ("failed", "cancelled"):
        raise HTTPException(
            status_code=409, detail="Only a failed or cancelled import can be retried."
        )
    path = Path(record.source.path)
    _validate_candidate(path)
    original = await disk_call(repo.get_session, runtime.db, session_id)
    session = await disk_call(
        repo.create_session, runtime.db, (original.title if original else record.source.name),
    )
    try:
        retried = await runtime.imports.start(ImportRequest(
            session_id=session.id, path=path, translate=record.translate,
            declared_duration_ms=record.declared_duration_ms,
        ))
    except (ImportRejected, ImportConflict) as error:
        await disk_call(repo.delete_session, runtime.db, session.id)
        raise HTTPException(status_code=400, detail=str(error)) from error
    except ProviderNotConfigured as error:
        await disk_call(repo.delete_session, runtime.db, session.id)
        raise HTTPException(status_code=409, detail=str(error)) from error
    refreshed = await disk_call(repo.get_session, runtime.db, session.id)
    return ImportCreatedResponse(session=refreshed or session, import_state=_view(retried))


@router.delete("/{session_id}")
async def delete_import(session_id: str, runtime: RuntimeDep) -> DeleteResponse:
    """Cancel if still running, then delete the session and its transcript."""
    record = await disk_call(runtime.imports.store.get, session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="This session is not an import.")
    if record.status in ("queued", "uploading", "processing"):
        await runtime.imports.cancel(session_id)
    deleted = await disk_call(repo.delete_session, runtime.db, session_id)
    return DeleteResponse(deleted=deleted)


def _validate_candidate(path: Path) -> None:
    """Cheap local checks before anything is uploaded or charged."""
    if not path.is_absolute():
        raise HTTPException(status_code=400, detail="The file path must be absolute.")
    suffix = path.suffix.lower().lstrip(".")
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Soniox does not accept .{suffix} files. "
                   f"Supported: {', '.join(SUPPORTED_EXTENSIONS)}.",
        )


def _view(record: ImportRecord) -> ImportView:
    return ImportView(
        session_id=record.session_id,
        status=record.status,
        source=ImportSourceView(
            name=record.source.name,
            path=record.source.path,
            size_bytes=record.source.size_bytes,
            available=_source_available(record),
        ),
        translate=record.translate,
        model=record.model,
        declared_duration_ms=record.declared_duration_ms,
        audio_duration_ms=record.audio_duration_ms,
        error=record.error,
        created_at=record.created_at,
        settled_at=record.settled_at,
    )


def _source_available(record: ImportRecord) -> bool:
    """Cheap identity check: existence, size and mtime. Never a full re-hash.

    Re-reading a two-hour file on every listing would be absurd, so this answers
    "plausibly the same file" and nothing stronger. A user who needs certainty
    can ask for a verification, which is a separate, explicit action.
    """
    path = Path(record.source.path)
    try:
        stat = path.stat()
    except OSError:
        return False
    return (
        path.is_file()
        and stat.st_size == record.source.size_bytes
        and stat.st_mtime_ns == record.source.mtime_ns
    )
