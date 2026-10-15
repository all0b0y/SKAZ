"""Recording and speech settings over the legacy settings document and the local model manager.

The provider, languages and translation default are the legacy
``StoredSettings`` fields (written through the legacy settings update, so the
same validation and stream shutdown apply). The local Whisper state is read
cheaply — whether its files are cached and whether a download runs — without
loading the model.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from ... import asr_providers
from ...gateways.asr import LOCAL_ASR_DEPENDENCY_DETAIL
from ...local_models import local_model_size

if TYPE_CHECKING:  # pragma: no cover
    from ...gateways.asr import LocalModelPreparations
    from ...runtime import Runtime
    from ...settings_store import StoredSettings

SpeechProvider = Literal["soniox", "local_whisper", "openai"]
LocalState = Literal["missing", "downloading", "ready", "failed"]
_FAILED_STATES = ("error", "dependency_missing", "unsupported")
_WORKING_STATES = ("installing", "verifying", "loading")


@dataclass(frozen=True)
class LocalModel:
    model: str
    state: LocalState
    progress: float | None
    reason: str | None
    #: Approximate size of the model's files (its download size); ``None`` when unknown.
    size_bytes: int | None = None


@dataclass(frozen=True)
class LocalModelDeleted:
    #: Whether any files of the model were there to remove.
    deleted: bool
    deleted_bytes: int


@dataclass(frozen=True)
class SpeechSettings:
    provider: SpeechProvider
    languages: tuple[str, ...]
    translate_by_default: bool
    translation_language: str
    local_model: LocalModel
    #: Consent to send audio to a cloud speech service (the existing ``cloud_consent``).
    cloud_consent: bool


def to_new(provider: str) -> SpeechProvider:
    return "local_whisper" if provider == "local-whisper" else "openai" if provider == "openai" else "soniox"


def to_legacy(provider: str) -> str:
    return "local-whisper" if provider == "local_whisper" else provider


def local_model(runtime: Runtime, model: str) -> LocalModel:
    """Missing / downloading (with progress) / ready / failed (with the reason), never loading the model."""
    found = _local_model(runtime, model)
    return LocalModel(found.model, found.state, found.progress, found.reason,
                      local_model_size("local-whisper", model))


def _local_model(runtime: Runtime, model: str) -> LocalModel:
    preparations: LocalModelPreparations = runtime.local_models
    # The manager's last report for this checkpoint (it has no public reader; read-only peek).
    reports: dict[str, Any] = getattr(preparations, "_reports", {})
    known = reports.get(f"local-whisper:{model}")
    progress = preparations.progress("local-whisper", model)
    if (known is not None and known[0] in _WORKING_STATES) or progress is not None:
        fraction = None
        if progress is not None and progress.total_bytes:
            fraction = max(0.0, min(1.0, progress.downloaded_bytes / progress.total_bytes))
        return LocalModel(model, "downloading", fraction, None)
    if known is not None and known[0] in _FAILED_STATES:
        return LocalModel(model, "failed", None, str(known[1] or "The model couldn't be prepared."))
    # The record button's own check (installed engine, cached files) — one source of truth.
    settings = runtime.settings_store.load().model_copy(update={"local_whisper_model": model})
    ready, detail = asr_providers.readiness(runtime, settings, "local-whisper")
    if ready:
        return LocalModel(model, "ready", None, None)
    if detail and "not downloaded" in detail:
        return LocalModel(model, "missing", None, None)
    return LocalModel(model, "failed", None, detail or LOCAL_ASR_DEPENDENCY_DETAIL)


def speech_settings(runtime: Runtime, stored: StoredSettings | None = None) -> SpeechSettings:
    settings = stored or runtime.settings_store.load()
    return SpeechSettings(
        provider=to_new(settings.transcription_provider),
        languages=tuple(settings.used_languages or ()),
        translate_by_default=settings.native_recording_mode == "translation",
        translation_language=settings.translation_target_language,
        local_model=local_model(runtime, settings.local_whisper_model),
        cloud_consent=settings.cloud_consent,
    )


async def delete_local_model(runtime: Runtime) -> LocalModelDeleted:
    """Remove the downloaded files of the chosen Whisper model (only that model's cache folder).

    The model manager refuses while the model is downloading, being checked or used by a
    recording (``LocalModelBusy``), and refuses a cache folder that is not safe to remove
    (``CacheSafetyError``). Recording with Soniox is not affected.
    """
    model = runtime.settings_store.load().local_whisper_model
    preparations: LocalModelPreparations = runtime.local_models
    result = await preparations.delete("local-whisper", model)
    return LocalModelDeleted(deleted=result.deleted, deleted_bytes=result.deleted_bytes)
