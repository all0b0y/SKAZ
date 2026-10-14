"""``/kb/decisions``: the decision provider (off / OpenRouter · Jev / this Mac), its state and «Check»."""
from __future__ import annotations

from typing import cast

from fastapi import APIRouter, HTTPException, Request

from ..decisions.local import LocalUnavailable
from ..decisions.service import DecisionService, DecisionSettingsConflict, DecisionsView, TestResult
from .deps import kb_call
from .schemas_decisions import (
    KbDecisionProviderUpdate,
    KbDecisions,
    KbDecisionStats,
    KbDecisionTest,
    KbLocalDecisions,
)

router = APIRouter(prefix="/kb/decisions", tags=["kb"])


def get_decisions(request: Request) -> DecisionService:
    return cast(DecisionService, request.app.state.runtime.kb_decisions)


def view_model(view: DecisionsView) -> KbDecisions:
    local = view.local
    return KbDecisions(
        provider=view.provider, cloud_consent=view.cloud_consent, openrouter_key=view.openrouter_key,
        cloud_model=view.cloud_model,
        local=KbLocalDecisions(
            state=local.state, progress=local.progress, downloaded_bytes=local.downloaded_bytes,
            total_bytes=local.total_bytes, reason=local.reason, message=local.message,
            required_bytes=local.required_bytes, model_id=view.local_model.id,
            model_title=view.local_model.title, model_license=view.local_model.license,
            model_url=view.local_model.homepage, server_build=view.local_server.build,
            server_license=view.local_server.license,
        ),
        stats=KbDecisionStats(decided=view.stats.decided, undecided=view.stats.undecided),
    )


def result_model(result: TestResult) -> KbDecisionTest:
    return KbDecisionTest(provider=result.provider, decided=result.decided, answer=result.answer,
                          probability=result.probability, reason=result.reason, elapsed_ms=result.elapsed_ms)


@router.get("")
async def read_decisions(request: Request) -> KbDecisions:
    return view_model(await get_decisions(request).view())


@router.put("/provider")
async def set_provider(update: KbDecisionProviderUpdate, request: Request) -> KbDecisions:
    service = get_decisions(request)
    await kb_call(service.configure, update.provider, update.cloud_consent)
    return view_model(await service.view())


@router.post("/local/download", status_code=202)
async def download_local(request: Request) -> KbDecisions:
    service = get_decisions(request)
    try:
        service.manager.download()
    except LocalUnavailable as error:
        raise HTTPException(status_code=503, detail=error.message) from error
    return view_model(await service.view())


@router.post("/local/cancel")
async def cancel_local(request: Request) -> KbDecisions:
    service = get_decisions(request)
    await service.manager.cancel()
    return view_model(await service.view())


@router.delete("/local")
async def delete_local(request: Request) -> KbDecisions:
    service = get_decisions(request)
    await service.manager.delete()
    return view_model(await service.view())


@router.post("/test")
async def check_decisions(request: Request) -> KbDecisionTest:
    try:
        return result_model(await get_decisions(request).test())
    except DecisionSettingsConflict as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error
