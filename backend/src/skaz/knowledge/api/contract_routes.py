"""Fail-closed wiring for independently implemented 0.4.0 services.

Owners override get_service or provide runtime.kb_<area>; no service is constructed here.
Validation responses intentionally omit submitted data, including secret inputs.
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from ..errors import KnowledgeError
from .schemas_explore_common import KbContractError

#: A domain error's status → the wire: the code only, because its message may carry a title.
_DOMAIN_ERRORS = {404: "not_found", 409: "conflict", 422: "invalid_request", 503: "library_unavailable"}


class ContractFailure(Exception):
    def __init__(self, status: int, code: str) -> None:
        self.status = status
        self.code = KbContractError(code=code).code  # type: ignore[arg-type]
        super().__init__(self.code)


class ContractRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()

        async def handle(request: Request) -> Response:
            try:
                return await original(request)
            except ContractFailure as exc:
                return JSONResponse(status_code=exc.status, content={"code": exc.code})
            except KnowledgeError as exc:
                code = _DOMAIN_ERRORS.get(exc.status_code, "invalid_request")
                status = exc.status_code if exc.status_code in _DOMAIN_ERRORS else 422
                return JSONResponse(status_code=status, content={"code": code})
            except RequestValidationError:
                return JSONResponse(status_code=422, content={"code": "invalid_request"})

        return handle


ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    status: {"model": KbContractError} for status in (403, 404, 409, 422, 429, 502, 503)
}


def service_for(request: Request, area: str) -> object:
    runtime = getattr(request.app.state, "runtime", request.app.state)
    service = getattr(runtime, "kb_" + area, None)
    if service is None:
        raise ContractFailure(503, "not_ready")
    return service
