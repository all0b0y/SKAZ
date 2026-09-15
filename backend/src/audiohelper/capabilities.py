"""Profile validation and honest capability reporting.

Two separate questions are kept apart:

* **Compatible** — may this provider+model be configured for this task at all?
  A text-only model for ASR, or a Whisper checkpoint for chat, is rejected here.
* **Verified** — has this installation actually completed a successful call with
  this provider+model for this task? Declared audio input in a catalog is not
  enough (an audio-input model in the catalog returned HTTP 400 on a real call),
  so ``verified`` flips to true only from a recorded successful run.
"""

from __future__ import annotations

from .catalog import OPENAI_TRANSCRIPTION_MODELS, CatalogUnavailable, ProviderCatalogs
from .local_models import GIGACHAT_MODEL_ID, GIGACHAT_PROVIDER
from .schemas import Profile, Task
from .settings_store import StoredProfile

CHAT_PROVIDERS = ("openai", "openrouter", "anthropic", "openai-compatible")


class IncompatibleProfile(ValueError):
    """The requested provider+model cannot serve the requested task."""


async def validate_profile(task: Task, profile: StoredProfile, catalogs: ProviderCatalogs) -> None:
    """Raise :class:`IncompatibleProfile` when the profile cannot serve ``task``."""
    if not profile.model:
        return  # unconfigured profile; nothing to check yet
    if task == "asr":
        await _validate_asr(profile, catalogs)
        return
    await _validate_chat(task, profile, catalogs)


async def _validate_asr(profile: StoredProfile, catalogs: ProviderCatalogs) -> None:
    provider = profile.provider
    if provider == "anthropic":
        raise IncompatibleProfile("Anthropic exposes no speech-to-text endpoint; pick another ASR provider.")
    if provider == "local-whisper":
        known = await catalogs.entries("local-whisper")
        if profile.model not in {entry.id for entry in known}:
            raise IncompatibleProfile(
                f"'{profile.model}' is not a faster-whisper checkpoint. "
                f"Known: {', '.join(entry.id for entry in known)}."
            )
        return
    if provider == GIGACHAT_PROVIDER:
        if profile.model != GIGACHAT_MODEL_ID:
            raise IncompatibleProfile(
                f"'{profile.model}' is not the pinned GigaChat Audio MLX artifact. "
                f"Known: {GIGACHAT_MODEL_ID}."
            )
        return
    if provider == "openai":
        if profile.model not in OPENAI_TRANSCRIPTION_MODELS:
            raise IncompatibleProfile(
                f"'{profile.model}' is not served by OpenAI /v1/audio/transcriptions. "
                f"Supported: {', '.join(OPENAI_TRANSCRIPTION_MODELS)}."
            )
        return
    if provider == "openai-compatible":
        if not profile.base_url:
            raise IncompatibleProfile(
                "openai-compatible ASR requires base_url of the transcriptions endpoint."
            )
        return
    try:
        await catalogs.openrouter_asr_kind(profile.model)
    except CatalogUnavailable as error:
        if "catalog" in str(error).lower() and "unavailable" in str(error).lower():
            return
        raise IncompatibleProfile(str(error)) from error


async def _validate_chat(task: Task, profile: StoredProfile, catalogs: ProviderCatalogs) -> None:
    if profile.provider in ("local-whisper", GIGACHAT_PROVIDER):
        raise IncompatibleProfile(
            f"{profile.provider} is a local audio model and cannot answer text-only questions."
        )
    if profile.provider == "openai" and profile.model in OPENAI_TRANSCRIPTION_MODELS:
        raise IncompatibleProfile(
            f"'{profile.model}' uses the transcription endpoint and cannot be used for {task}."
        )
    if profile.provider == "openai-compatible" and not profile.base_url:
        raise IncompatibleProfile("openai-compatible profiles require base_url.")
    if profile.provider != "openrouter":
        return
    try:
        entry = await catalogs.find("openrouter", profile.model)
    except CatalogUnavailable:
        return
    if entry is None:
        # Private/new IDs can be absent from discovery; absence is not evidence
        # of a non-text output contract. A real request must still verify this ID.
        return
    if entry.excludes_text_output:
        declared = ", ".join(entry.output_modalities)
        raise IncompatibleProfile(
            f"'{profile.model}' declares output [{declared}], not text, and cannot be used for {task}."
        )


def describe(
    task: Task,
    profile: StoredProfile,
    *,
    has_api_key: bool,
    verification: str | None,
    asr_kind: str | None = None,
) -> Profile:
    """Build the sanitised API view of a stored profile."""
    return Profile(
        provider=profile.provider,
        model=profile.model,
        base_url=profile.base_url,
        has_api_key=(
            has_api_key if profile.provider not in ("local-whisper", GIGACHAT_PROVIDER) else False
        ),
        verified=verification is not None,
        verification_note=(
            verification if verification is not None else _pending_note(task, profile, asr_kind)
        ),
    )


def _pending_note(task: Task, profile: StoredProfile, asr_kind: str | None) -> str:
    if not profile.model:
        return "Model is not configured."
    if profile.provider == "local-whisper":
        return (
            "faster-whisper checkpoint; weights download only after explicit model preparation. "
            "No successful local transcription recorded yet."
        )
    if profile.provider == GIGACHAT_PROVIDER:
        return (
            "Pinned local GigaChat audio-language model; chunk timing only, no word timestamps or "
            "contextual finality. No successful local transcription is claimed."
        )
    if task == "asr" and profile.provider == "openrouter":
        if asr_kind == "legacy":
            return (
                "Manually selected audio input chat model (legacy adapter). It is not a dedicated "
                "speech-to-text contract, its transcription quality is unverified, and it is never "
                "marked ASR-verified."
            )
        return "Dedicated OpenRouter speech-to-text endpoint. No successful transcription recorded yet."
    if task == "asr" and profile.provider == "openai":
        return "OpenAI /v1/audio/transcriptions model. No successful transcription recorded yet."
    if task == "asr":
        return "Custom transcription endpoint. No successful transcription recorded yet."
    return "No successful request recorded yet."
