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
    declared = request.headers.get("content-length")
    too_large = declared is not None and declared.isdigit() and int(declared) > MAX_BODY_BYTES
    body = b"" if too_large else await request.body()
    reply = await server.handle(headers=request.headers, body=body, too_large=too_large)
    if reply.body is None:
        return Response(status_code=reply.status, headers=reply.headers)
    return JSONResponse(reply.body, status_code=reply.status, headers=reply.headers)


@router.get("")
@router.delete("")
async def mcp_other() -> Response:
    # No standalone SSE stream and no sessions to end (Streamable HTTP allows 405 for both).
    return Response(status_code=405, headers={"Allow": "POST"})
