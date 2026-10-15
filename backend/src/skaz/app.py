"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .activity import current_activity
from .config import AppConfig
from .knowledge.api import ROUTERS as KB_ROUTERS
from .knowledge.mcp.router import router as kb_mcp_router
from .managed_storage import StorageConflict
from .native_io import disk_call
from .routes import health, live, logs, sessions, settings
from .runtime import Runtime
from .schemas import Provider  # noqa: F401  (kept for OpenAPI clarity)
from .secrets import SecretStore
from .security import local_access_error, require_token

logger = logging.getLogger(__name__)


def _recover_storage(runtime: Runtime) -> None:
    """Finish a managed-storage operation a crash interrupted (the old interface had a button).

    While one is pending every new recording session is refused, so the app tries once at
    start; an operation that still cannot finish is logged and keeps blocking, as before.
    """
    if runtime.storage.pending() is None:
        return
    try:
        runtime.storage.recover()
    except (StorageConflict, OSError) as error:
        logger.warning("Interrupted storage operation could not be finished: %s", type(error).__name__)


def create_app(
    config: AppConfig,
    *,
    secret_store: SecretStore | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> FastAPI:
    runtime = Runtime(config, secret_store=secret_store, http_client=http_client)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            await disk_call(_recover_storage, runtime)
            await disk_call(runtime.session_files.reconcile)
            # Reopen and rescan the connected knowledge library; never creates one.
            await disk_call(runtime.kb.start)
            runtime.kb_auto_ingest.bind_loop(asyncio.get_running_loop())
            # Outside edits of Wiki/ (every 2 s) and background connections when the user allowed them.
            await runtime.kb_wiki.start()
            # Imports outlive the process that started them: a paid job keeps
            # running at the provider, so re-attach instead of abandoning it.
            runtime.imports.resume()
            # Speech materials interrupted by the last shutdown settle in the background.
            await runtime.kb_speech.start()
            yield
        finally:
            await runtime.kb_wiki.close()
            await runtime.kb_chats.close()
            await runtime.kb_ingest.close()
            await runtime.kb_codex.close()
            await runtime.kb_decisions.aclose()
            await runtime.kb_agents.aclose()
            await runtime.codex_connection.close()
            await runtime.imports.close()
            await runtime.stop_native()
            await runtime.kb_speech.close()
            await runtime.http.aclose()
            runtime.close()

    app = FastAPI(title="SKAZ backend", version="0.1.0", lifespan=lifespan)
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
    # Legacy routes the Knowledge Wiki still calls: recording options (/settings), the live
    # transcript of a recording and its status fallback (/sessions/{id}/live…, PATCH).
    app.include_router(settings.router, dependencies=protected)
    app.include_router(sessions.router, dependencies=protected)
    app.include_router(logs.router, dependencies=protected)
    for kb_router in KB_ROUTERS:
        app.include_router(kb_router, dependencies=protected)
    # MCP for agent runs: its own per-run bearer token, never the app token (Host/Origin checked above).
    app.include_router(kb_mcp_router)
    return app


def _describe_validation(error: RequestValidationError) -> str:
    parts = []
    for item in error.errors():
        location = ".".join(str(piece) for piece in item.get("loc", ()) if piece != "body")
        parts.append(f"{location or 'body'}: {item.get('msg', 'invalid value')}")
    return "; ".join(parts) or "Invalid request."
