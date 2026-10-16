"""``POST /kb/mcp``: the MCP endpoint. Mounted WITHOUT the app token; it checks its own per-run bearer.

Not part of the renderer API: hidden from OpenAPI, so ``types.gen.ts`` and
the Electron route policy never see it. Loopback Host/Origin are enforced by
the app-wide ``local_only`` middleware like every other route.
"""
from __future__ import annotations

from typing import cast

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from .server import MAX_BODY_BYTES, McpServer

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
        reply = await server.handle(headers=request.headers, body=body,
                                    too_large=too_large or len(body) > MAX_BODY_BYTES)
    if reply.body is None:
        return Response(status_code=reply.status, headers=reply.headers)
    return JSONResponse(reply.body, status_code=reply.status, headers=reply.headers)


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
