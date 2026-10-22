"""``POST /kb/mcp``: the MCP endpoint. Mounted WITHOUT the app token; it checks its own per-run bearer.

Not part of the renderer API: hidden from OpenAPI, so ``types.gen.ts`` and
the Electron route policy never see it. Loopback Host/Origin are enforced by
the app-wide ``local_only`` middleware like every other route.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Coroutine
from typing import Any, cast

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from .server import MAX_BODY_BYTES, McpReply, McpServer

#: Seconds between keep-alive comments on a call that waits for the user.
KEEPALIVE_S = 20.0

router = APIRouter(prefix="/kb/mcp", include_in_schema=False)


@router.post("")
async def mcp_post(request: Request) -> Response:
    server = cast(McpServer, request.app.state.runtime.kb_mcp)
    if not server.authorized(request.headers):
        # Before reading a byte of the body: an unauthenticated sender can't make SKAZ buffer it.
        reply = await server.handle(headers=request.headers, body=b"")
    else:
        declared = request.headers.get("content-length")
        too_large = declared is not None and declared.isdigit() and int(declared) > MAX_BODY_BYTES
        body = b"" if too_large else await _bounded_body(request)
        too_large = too_large or len(body) > MAX_BODY_BYTES
        if not too_large and server.waits_for_user(request.headers, body):
            return StreamingResponse(_waiting(server.handle(headers=request.headers, body=body)),
                                     media_type="text/event-stream",
                                     headers={"Cache-Control": "no-store"})
        reply = await server.handle(headers=request.headers, body=body, too_large=too_large)
    if reply.body is None:
        return Response(status_code=reply.status, headers=reply.headers)
    return JSONResponse(reply.body, status_code=reply.status, headers=reply.headers)


async def _waiting(reply: Coroutine[Any, Any, McpReply]) -> AsyncIterator[bytes]:
    """The reply of a call that waits for the user, as one SSE message after keep-alive comments.

    Hermes 0.22.1 reads its MCP HTTP stream with ``read=300.0`` s (``tools/mcp_tool_transport.py:571``):
    a byte every :data:`KEEPALIVE_S` keeps a wait for Allow / Deny open. If the client goes away the
    call is cancelled — the broker then records the request as cancelled.
    """
    task = asyncio.ensure_future(reply)
    try:
        while not task.done():
            done, _pending = await asyncio.wait({task}, timeout=KEEPALIVE_S)
            if not done:
                yield b": waiting for the user\n\n"
        body = task.result().body or {}
        yield b"event: message\ndata: " + json.dumps(body, ensure_ascii=False).encode() + b"\n\n"
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


async def _bounded_body(request: Request) -> bytes:
    """The body, read until one byte past the limit at most (a chunked body has no declared length)."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        chunks.append(chunk)
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            break
    return b"".join(chunks)


@router.get("")
@router.delete("")
async def mcp_other() -> Response:
    # No standalone SSE stream and no sessions to end (Streamable HTTP allows 405 for both).
    return Response(status_code=405, headers={"Allow": "POST"})
