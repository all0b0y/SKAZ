"""Model discovery.

Entries carry the provider's declared modalities and an honest ``verified`` flag:
true only when this installation already completed a successful call with that
provider, model and task.

For ``task=asr`` every entry also carries ``asr_contract``: ``dedicated`` for a
real speech-to-text endpoint, ``legacy`` for an audio-input chat model that is
merely a candidate. A picker should offer the dedicated group by default; the
legacy group is an explicit advanced choice and can never become ASR-verified.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from ..catalog import RECOMMENDED_OPENROUTER_ASR, CatalogEntry, CatalogUnavailable
from ..schemas import (
    AsrContract,
    CatalogModel,
    CatalogPricing,
    ModelsResponse,
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
    return ModelsResponse(models=[_model(entry, task, verified) for entry in entries if _fits(entry, task)])


def _model(entry: CatalogEntry, task: Task, verified: dict[str, str]) -> CatalogModel:
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
        note=_note(entry, task, contract, verified),
    )


def _note(entry: CatalogEntry, task: Task, contract: AsrContract | None, verified: dict[str, str]) -> str:
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
