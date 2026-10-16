"""Request plumbing shared by the ``/kb`` routers."""
from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, ParamSpec, TypeVar, cast

from fastapi import Depends, HTTPException, Request

from ...native_io import disk_call
from ..errors import KnowledgeError
from ..library.fsio import os_error_reason
from ..service import KnowledgeService

P = ParamSpec("P")
T = TypeVar("T")


def get_kb(request: Request) -> KnowledgeService:
    return cast(KnowledgeService, request.app.state.runtime.kb)


KbDep = Annotated[KnowledgeService, Depends(get_kb)]


async def kb_call(function: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    """Run library work off the event loop; domain errors become plain-English HTTP errors."""
    try:
        return await disk_call(function, *args, **kwargs)
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error
    except OSError as error:
        raise HTTPException(status_code=503, detail=os_error_reason(error)) from error
