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
from .knowledge.logsafe import error_note
from .knowledge.mcp.router import router as kb_mcp_router
from .knowledge.shutdown import close_knowledge
from .native_io import disk_call
from .routes import health, live, logs, sessions, settings
from .runtime import Runtime
from .schemas import Provider  # noqa: F401  (kept for OpenAPI clarity)
from .secrets import SecretStore
from .security import local_access_error, require_token

logger = logging.getLogger(__name__)

#: The startup library scan runs in the background; the app waits this long for a small library
#: before it starts answering (``/health``), never for the whole scan of a large one.
STARTUP_SCAN_WAIT_S = 1.0


def _log_scan_failure(task: asyncio.Task[None]) -> None:
    error = None if task.cancelled() else task.exception()
    if error is not None:
        logger.error("startup library scan failed: %s", error_note(error))


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
            # Reopen the connected knowledge library (never creates one) and rescan it in the
            # background: the app answers meanwhile and the library says "indexing" (Electron
            # gives the backend 30 s to answer /health; a large library takes longer to scan).
            if await disk_call(runtime.kb.open_connected):
                scan = asyncio.create_task(disk_call(runtime.kb.rescan), name="kb-startup-scan")
                scan.add_done_callback(_log_scan_failure)
                app.state.kb_startup_scan = scan
                await asyncio.wait({scan}, timeout=STARTUP_SCAN_WAIT_S)
            runtime.kb_auto_ingest.bind_loop(asyncio.get_running_loop())
            # Outside edits of Wiki/ (every 2 s) and background connections when the user allowed them.
            await runtime.kb_wiki.start()
            # Imports outlive the process that started them: a paid job keeps
            # running at the provider, so re-attach instead of abandoning it.
            runtime.imports.resume()
            # Speech materials interrupted by the last shutdown settle in the background.
            await runtime.kb_speech.start()
            # Agents' housekeeping in the background (Hermes' leftover sessions, once prepared).
            runtime.kb_agents.start()
            yield
        finally:
            # Agents and llama-server first, then the wiki services, within Electron's grace.
            await close_knowledge(runtime)
            await runtime.codex_connection.close()
            await runtime.imports.close()
            await runtime.stop_native()
            await runtime.kb_speech.close()
            await runtime.http.aclose()
            runtime.close()

    app = FastAPI(title="SKAZ backend", version="0.1.0", lifespan=lifespan)
    app.state.runtime = runtime

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
