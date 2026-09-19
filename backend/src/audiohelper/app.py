"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .activity import current_activity
from .config import AppConfig
from .managed_storage import StorageConflict
from .native_io import disk_call
from .note_store import prune_history
from .routes import agent, asr, health, imports, live, logs, models, sessions, settings, storage
from .runtime import Runtime
from .schemas import Provider  # noqa: F401  (kept for OpenAPI clarity)
from .secrets import SecretStore
from .security import local_access_error, require_token


def create_app(
    config: AppConfig,
    *,
    secret_store: SecretStore | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> FastAPI:
    runtime = Runtime(config, secret_store=secret_store, http_client=http_client)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async def clean_note_history() -> None:
            while True:
                try:
                    await disk_call(prune_history, runtime.db)
                except Exception:
                    logging.getLogger(__name__).warning("Note history cleanup failed; retrying later.")
                await asyncio.sleep(3600)

        cleanup = asyncio.create_task(clean_note_history())
        try:
            await disk_call(runtime.session_files.reconcile)
            # Imports outlive the process that started them: a paid job keeps
            # running at the provider, so re-attach instead of abandoning it.
            runtime.imports.resume()
            yield
        finally:
            cleanup.cancel()
            with suppress(asyncio.CancelledError):
                await cleanup
            await runtime.imports.close()
            await runtime.stop_native()
            await runtime.http.aclose()
            runtime.close()

    app = FastAPI(title="AudioHelper backend", version="0.1.0", lifespan=lifespan)
    app.state.runtime = runtime

    @app.exception_handler(StorageConflict)
    async def storage_conflict(_request: Request, _error: StorageConflict) -> JSONResponse:
        return JSONResponse(status_code=409, content={
            "detail": "Storage needs attention. Pause recording and check storage recovery.",
        })

    @app.middleware("http")
    async def local_only(
        request: Request, call_next: Callable[[Request], Awaitable[JSONResponse]]
    ) -> JSONResponse:
        reason = local_access_error(request, config)
        if reason is not None:
            return JSONResponse(status_code=403, content={"detail": reason})
        token = current_activity.set(runtime.activity_log)
        try:
            return await call_next(request)
        finally:
            current_activity.reset(token)

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_request: Request, error: RequestValidationError) -> JSONResponse:
        # docs/API.md requires a string detail on every error response.
        return JSONResponse(status_code=422, content={"detail": _describe_validation(error)})

    app.include_router(health.router)
    # WebSocket authentication is explicit in the route, not the HTTP dependency.
    app.include_router(live.router)
    protected = [Depends(require_token)]
    app.include_router(settings.router, dependencies=protected)
    app.include_router(storage.router, dependencies=protected)
    app.include_router(asr.router, dependencies=protected)
    app.include_router(sessions.router, dependencies=protected)
    app.include_router(imports.router, dependencies=protected)
    app.include_router(agent.router, dependencies=protected)
    app.include_router(models.router, dependencies=protected)
    app.include_router(logs.router, dependencies=protected)
    return app


def _describe_validation(error: RequestValidationError) -> str:
    parts = []
    for item in error.errors():
        location = ".".join(str(piece) for piece in item.get("loc", ()) if piece != "body")
        parts.append(f"{location or 'body'}: {item.get('msg', 'invalid value')}")
    return "; ".join(parts) or "Invalid request."
