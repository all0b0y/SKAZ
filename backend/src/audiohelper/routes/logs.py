"""Read-only technical activity for this backend installation."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from .deps import RuntimeDep

router = APIRouter(tags=["logs"])


@router.get("/logs")
def read_logs(runtime: RuntimeDep, limit: int = Query(default=100, ge=1)) -> dict[str, Any]:
    return runtime.activity_log.snapshot(limit)
