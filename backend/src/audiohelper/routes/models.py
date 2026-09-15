"""Model discovery.

Entries carry the provider's declared modalities and an honest ``verified`` flag:
true only when this installation already completed a successful call with that
provider, model and task.

For ``task=asr`` every entry also carries ``asr_contract``: ``dedicated`` for a
real speech-to-text endpoint, ``legacy`` for an audio-input chat model that is
merely a candidate. A picker should offer the dedicated group by default; the
legacy group is an explicit advanced choice and can never become ASR-verified.

``/models/local/prepare`` and ``/models/local/status`` cover the separate question
of whether a local checkpoint is present on this machine. Preparing is the only
download path in the app; the contract is written down in
``.runtime/asr-local-contract.md``.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..catalog import RECOMMENDED_OPENROUTER_ASR, CatalogEntry, CatalogUnavailable
from ..gateways.asr import LocalModelBusy
from ..local_models import GIGACHAT_PROVIDER, CacheSafetyError, local_model_spec
from ..schemas import (
    AsrContract,
    CatalogModel,
    CatalogPricing,
    DeleteLocalModelRequest,
    DeleteLocalModelResponse,
    LocalModelHardware,
    LocalModelProgress,
    LocalModelState,
    LocalModelStatus,
    LocalProvider,
    ModelsResponse,
    PrepareLocalModelRequest,
    PricingUnit,
    Provider,
    Task,
)
from ..verifications import notes_for_task
from .deps import RuntimeDep

router = APIRouter()

KNOWN_PRICING_UNITS: tuple[PricingUnit, ...] = ("second", "minute", "request", "token")

UNVERIFIED_DEDICATED_NOTE = (
    "Dedicated speech-to-text endpoint; no successful transcription recorded here yet."
)
UNVERIFIED_LEGACY_NOTE = (
    "Advanced/legacy option: an audio input chat model, not a dedicated speech-to-text contract. "
    "Its transcription quality is unverified and it is never marked ASR-verified — "
    "a model can answer with text and still not transcribe."
)
UNVERIFIED_CHAT_NOTE = "No successful request recorded in this installation yet."
GIGACHAT_LOCAL_NOTE = (
    "Local audio-language model, not dedicated ASR: output is unverified and uses chunk timing only. "
    "It provides no word timestamps; contextual finality requires local-whisper."
)
SHARED_CACHE_WARNING = (
    "This is the shared Hugging Face cache. Deleting this model may affect other applications "
    "that use the same cached repository."
)


@router.get("/models")
async def list_models(
    runtime: RuntimeDep,
    provider: Provider = Query(),
    task: Task = Query(),
) -> ModelsResponse:
    try:
        entries = await runtime.catalogs.entries(provider, task)
    except CatalogUnavailable as error:
        return ModelsResponse(models=[], error=str(error))
    verified = notes_for_task(runtime.db, provider, task)
    return ModelsResponse(
        models=[_model(entry, task, verified, provider) for entry in entries if _fits(entry, task)]
    )


@router.post("/models/local/prepare")
async def prepare_local_model(payload: PrepareLocalModelRequest, runtime: RuntimeDep) -> LocalModelStatus:
    """Start fetching one known local checkpoint. The only download path in the app."""
    provider, model = _known_local_model(payload.provider, payload.model)
    try:
        state, error = await runtime.local_models.start(model, provider)
    except LocalModelBusy as busy:
        raise HTTPException(
            status_code=409,
            detail=f"'{busy.active}' is being prepared right now; wait for it to finish.",
        ) from busy
    return _local_status(runtime, provider, model, state, error)


@router.get("/models/local/status")
async def local_model_status(
    runtime: RuntimeDep,
    model: str = Query(),
    provider: LocalProvider = Query(default="local-whisper"),
) -> LocalModelStatus:
    """Poll a preparation. The first call for a model verifies its local files."""
    known_provider, known_model = _known_local_model(provider, model)
    try:
        state, error = await runtime.local_models.report(known_model, known_provider)
    except LocalModelBusy as busy:
        raise HTTPException(
            status_code=409,
            detail="The local model is being deleted or used; its status check is deferred.",
        ) from busy
    return _local_status(runtime, known_provider, known_model, state, error)


@router.delete("/models/local")
async def delete_local_model(
    payload: DeleteLocalModelRequest, runtime: RuntimeDep
) -> DeleteLocalModelResponse:
    provider, model = _known_local_model(payload.provider, payload.model)
    if payload.confirmation_model != model:
        raise HTTPException(status_code=400, detail="Local model deletion confirmation did not match.")
    try:
        result = await runtime.local_models.delete(provider, model)
    except LocalModelBusy as busy:
        raise HTTPException(
            status_code=409,
            detail="The local model is being installed, verified, or used; wait before deleting it.",
        ) from busy
    except CacheSafetyError as cache_error:
        raise HTTPException(
            status_code=409,
            detail="The model cache failed its path-isolation check and was not deleted.",
        ) from cache_error
    except OSError as cache_error:
        raise HTTPException(
            status_code=409,
            detail="The model cache could not be deleted. Check its permissions and try again.",
        ) from cache_error
    state, status_error = await runtime.local_models.report(model, provider)
    status = _local_status(runtime, provider, model, state, status_error)
    return DeleteLocalModelResponse(
        **status.model_dump(),
        deleted=result.deleted,
        deleted_bytes=result.deleted_bytes,
        deleted_files=result.deleted_files,
    )


def _known_local_model(provider: LocalProvider, model: str) -> tuple[LocalProvider, str]:
    """Only catalog checkpoint names pass; an arbitrary id or path never reaches a loader.

    The rejected value is deliberately not echoed back into the error message.
    """
    if local_model_spec(provider, model) is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Unknown local model identity. Choose an exact provider/model pair from the local catalog."
            ),
        )
    return provider, model


def _local_status(
    runtime: RuntimeDep,
    provider: LocalProvider,
    model: str,
    state: LocalModelState,
    error: str | None,
) -> LocalModelStatus:
    progress = runtime.local_models.progress(provider, model)
    progress_view = None
    if state in ("installing", "verifying"):
        progress_view = LocalModelProgress(
            stage="verifying" if state == "verifying" else "downloading",
            downloaded_bytes=progress.downloaded_bytes if progress else 0,
            completed_files=progress.completed_files if progress else 0,
            total_bytes=progress.total_bytes if progress else None,
            total_files=progress.total_files if progress else None,
        )
    hardware = runtime.local_models.hardware(provider)
    return LocalModelStatus(
        provider=provider,
        model=model,
        state=state,
        error=error,
        progress=progress_view,
        hardware=(
            LocalModelHardware(
                physical_memory_bytes=hardware.physical_memory_bytes,
                required_memory_bytes=hardware.required_memory_bytes,
            )
            if hardware is not None
            else None
        ),
        cached=runtime.local_models.cached(provider, model),
        shared_cache=runtime.local_models.shared_cache,
        warning=SHARED_CACHE_WARNING if runtime.local_models.shared_cache else None,
    )


def _model(
    entry: CatalogEntry, task: Task, verified: dict[str, str], provider: Provider
) -> CatalogModel:
    contract: AsrContract | None = None
    if task == "asr":
        contract = "dedicated" if entry.emits_transcription else "legacy"
    return CatalogModel(
        id=entry.id,
        name=entry.name,
        input_modalities=list(entry.input_modalities),
        output_modalities=list(entry.output_modalities),
        max_output_tokens=entry.max_output_tokens,
        pricing=_pricing(entry),
        asr_contract=contract,
        # Only a dedicated transcription contract may be recommended.
        recommended=contract == "dedicated" and entry.id == RECOMMENDED_OPENROUTER_ASR,
        # A legacy audio-chat model is never verified, so its own note always wins.
        verified=contract != "legacy" and entry.id in verified,
        note=_note(entry, task, contract, verified, provider),
    )


def _note(
    entry: CatalogEntry,
    task: Task,
    contract: AsrContract | None,
    verified: dict[str, str],
    provider: Provider,
) -> str:
    if provider == GIGACHAT_PROVIDER:
        return GIGACHAT_LOCAL_NOTE
    if contract == "legacy":
        return UNVERIFIED_LEGACY_NOTE
    recorded = verified.get(entry.id)
    if recorded:
        return recorded
    if task != "asr" and not entry.output_declared:
        return (
            "The provider did not declare output modalities; compatibility is unknown. "
            + UNVERIFIED_CHAT_NOTE
        )
    return UNVERIFIED_DEDICATED_NOTE if task == "asr" else UNVERIFIED_CHAT_NOTE


def _pricing(entry: CatalogEntry) -> CatalogPricing | None:
    """Pricing is exposed only when the billing unit is explicitly known for that model."""
    if entry.pricing_amount_usd is None:
        return None
    for unit in KNOWN_PRICING_UNITS:
        if entry.pricing_unit == unit:
            return CatalogPricing(amount_usd=entry.pricing_amount_usd, unit=unit)
    return None


def _fits(entry: CatalogEntry, task: Task) -> bool:
    if task == "asr":
        return entry.accepts_audio
    return not entry.excludes_text_output
