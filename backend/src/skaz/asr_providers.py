"""Transcription providers behind the native live stream and media import.

One small interface, three implementations, and never a silent fallback:

* ``soniox`` — cloud real-time WebSocket and async file API; full diarization,
  any-to-any translation and language identification.
* ``local-whisper`` — faster-whisper on this computer; works with the network off.
  Near-streaming (provisional then confirmed text), approximate speaker separation
  with a local voice model, translation into English only.
* ``openai`` — the OpenAI transcription endpoint; final text per utterance.

Every live session speaks :class:`~.gateways.soniox.SonioxEvent`, so storage,
speaker numbering, recovery and session files do not know which one ran.
"""

from __future__ import annotations

import contextlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from .catalog import OPENAI_TRANSCRIPTION_MODELS
from .file_asr import FileTranscript, transcribe_pcm_file
from .gateways import LiveAsrError, ProviderNotConfigured
from .gateways.asr import (
    LocalAsrDependencyMissing,
    LocalWhisperTranscriber,
    _to_thread_until_finished,
    load_speaker_embedder,
    local_asr_available,
)
from .gateways.live_session import LiveAsrSession, LiveSessionOpener
from .gateways.soniox import DEFAULT_MODEL, SonioxConfig, SonioxGateway
from .gateways.soniox_async import ASYNC_MODEL
from .gateways.whisper_stream import (
    EnergyVoiceActivity,
    SpeakerTracker,
    StreamSettings,
    VoiceActivity,
    WhisperStreamSession,
)
from .live_store import LiveConnection
from .local_models import (
    LOCAL_WHISPER_REPOSITORIES,
    SPEAKER_MODEL_ID,
    SPEAKER_PROVIDER,
    local_model_cache_present,
    local_model_size,
    speaker_runtime_available,
)
from .schemas import (
    TranscriptionCapabilities,
    TranscriptionModel,
    TranscriptionProvider,
    TranscriptionProviderInfo,
)
from .settings_store import StoredSettings

if TYPE_CHECKING:  # pragma: no cover
    from .runtime import Runtime

TRANSCRIPTION_PROVIDERS: tuple[TranscriptionProvider, ...] = ("soniox", "local-whisper", "openai")
LABELS: dict[str, str] = {"soniox": "Soniox", "local-whisper": "Local Whisper", "openai": "OpenAI"}
#: Loading a checkpoint from disk takes a while; a socket connect does not. Audio
#: captured meanwhile waits in the 30-second replay buffer.
LOCAL_OPEN_TIMEOUT_S = 25.0
CLOUD_OPEN_TIMEOUT_S = 10.0
RECOMMENDED_LOCAL_MODEL = "small"

CAPABILITIES: dict[str, TranscriptionCapabilities] = {
    "soniox": TranscriptionCapabilities(
        live="streaming", provisional_text=True, file_transcription=True, speakers="full",
        translation="any", language_detection="full", word_timestamps="exact", offline=False,
        requires_cloud_consent=True, api_key_provider="soniox",
    ),
    "local-whisper": TranscriptionCapabilities(
        live="near_streaming", provisional_text=True, file_transcription=True, speakers="approximate",
        translation="english_only", language_detection="selected_languages", word_timestamps="exact",
        offline=True, requires_cloud_consent=False,
    ),
    "openai": TranscriptionCapabilities(
        live="utterance", provisional_text=False, file_transcription=True, speakers="approximate",
        translation="none", language_detection="full", word_timestamps="approximate", offline=False,
        requires_cloud_consent=True, api_key_provider="openai",
    ),
}

LIMITATIONS: dict[str, list[str]] = {
    "soniox": [],
    "local-whisper": [
        "Near-streaming: provisional text is refined every second or so, then confirmed.",
        "Speakers are separated approximately by a local voice model (download it below); "
        "without it every word belongs to one speaker.",
        "Translation is available into English only, and not with large-v3-turbo or distil models.",
        "Language identification picks among your spoken languages and can be unreliable on short phrases.",
        "Speed depends on this computer: a larger model is more accurate but can fall behind live speech.",
    ],
    "openai": [
        "No provisional text: each phrase appears after a pause.",
        "Speakers are separated approximately by the local voice model, if downloaded; "
        "otherwise every word belongs to one speaker.",
        "No live translation.",
        "Only whisper-1 returns word timings; for other models they are spread evenly over each phrase.",
    ],
}


def whisper_model_note(model: str) -> str | None:
    notes = {
        "tiny": "Fastest, least accurate. For testing or very slow computers.",
        "base": "Fast; noticeably less accurate than small.",
        "small": "Recommended for live use on Apple silicon: a good speed/accuracy balance.",
        "medium": "More accurate; may fall behind live speech on base M-series chips.",
        "large-v3": "Most accurate; usually too slow for live use on CPU — better for media import.",
        "large-v2": "Accurate; usually too slow for live use on CPU — better for media import.",
        "large-v3-turbo": "Accurate multilingual transcription, faster than large-v3. Cannot translate.",
        "distil-large-v3": "English only. Cannot translate.",
        "distil-small.en": "English only. Cannot translate.",
    }
    return notes.get(model)


def validate_selection(settings: StoredSettings) -> None:
    """Reject unknown model identities before they are stored."""
    if settings.local_whisper_model not in LOCAL_WHISPER_REPOSITORIES:
        raise ProviderNotConfigured("Unknown Local Whisper model. Choose one from the list.")
    if settings.openai_transcription_model not in OPENAI_TRANSCRIPTION_MODELS:
        raise ProviderNotConfigured("Unknown OpenAI transcription model. Choose one from the list.")


def provider_model(settings: StoredSettings, provider: str | None = None) -> str:
    provider = provider or settings.transcription_provider
    if provider == "local-whisper":
        return settings.local_whisper_model
    if provider == "openai":
        return settings.openai_transcription_model
    return DEFAULT_MODEL


def connection_model(settings: StoredSettings) -> str:
    """The model identity stored on each ASR connection (provenance only)."""
    provider = settings.transcription_provider
    if provider == "soniox":
        return DEFAULT_MODEL
    return f"{provider}/{provider_model(settings)}"


def provider_of_model(model: str | None) -> str:
    """The provider behind a stored connection or import model identity."""
    provider, separator, _name = (model or "").partition("/")
    return provider if separator and provider in ("local-whisper", "openai") else "soniox"


def readiness(runtime: Runtime, settings: StoredSettings, provider: str) -> tuple[bool, str | None]:
    """Cheap, synchronous check used by settings and the record button.

    Loading a local model is not attempted here: a cached-but-broken model is
    reported when a recording starts, with its own clear reason.
    """
    capabilities = CAPABILITIES[provider]
    if capabilities.requires_cloud_consent and not settings.cloud_consent:
        return False, "Cloud processing is off. Turn it on under API keys, or choose Local Whisper."
    if capabilities.api_key_provider and not runtime.api_key(capabilities.api_key_provider):
        return False, f"No {LABELS[capabilities.api_key_provider]} API key is stored. Add it under API keys."
    if provider == "local-whisper":
        if not local_asr_available():
            return False, ("faster-whisper is not installed in this backend. Install the 'local-asr' extra.")
        model = settings.local_whisper_model
        try:
            present = local_model_cache_present(
                "local-whisper", model, cache_dir=runtime.config.local_model_cache_dir)
        except ValueError:
            present = False
        if not present:
            return False, f"The Local Whisper model '{model}' is not downloaded yet. Download it below."
    return True, None


def speaker_model_present(runtime: Runtime) -> bool:
    try:
        return speaker_runtime_available() and local_model_cache_present(
            SPEAKER_PROVIDER, SPEAKER_MODEL_ID, cache_dir=runtime.config.local_model_cache_dir)
    except ValueError:
        return False


def describe_providers(runtime: Runtime, settings: StoredSettings) -> list[TranscriptionProviderInfo]:
    infos = []
    for provider in TRANSCRIPTION_PROVIDERS:
        ready, detail = readiness(runtime, settings, provider)
        models: list[TranscriptionModel] = []
        selected: str | None = None
        if provider == "local-whisper":
            selected = settings.local_whisper_model
            models = [
                TranscriptionModel(
                    id=name, name=f"Whisper {name}", size_bytes=local_model_size(provider, name),
                    note=whisper_model_note(name), recommended=name == RECOMMENDED_LOCAL_MODEL,
                )
                for name in LOCAL_WHISPER_REPOSITORIES
            ]
        elif provider == "openai":
            selected = settings.openai_transcription_model
            models = [
                TranscriptionModel(id=name, name=name, recommended=name == "whisper-1",
                                   note=("Word timestamps." if name == "whisper-1"
                                         else "Text only; word timing is approximate."))
                for name in OPENAI_TRANSCRIPTION_MODELS
            ]
        infos.append(TranscriptionProviderInfo(
            id=provider, label=LABELS[provider], capabilities=CAPABILITIES[provider], models=models,
            model=selected, ready=ready, detail=detail, limitations=LIMITATIONS[provider],
        ))
    return infos


# ── Live sessions ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class LivePlan:
    """What a recording will use, decided once when its stream opens."""

    provider: str
    model: str
    opener: LiveSessionOpener | None
    #: Why transcription cannot run (``opener`` is None).
    unavailable: str | None = None
    #: Whether revoking cloud consent or a key must stop this stream.
    cloud: bool = False
    api_key_provider: str | None = None


def _translation_target(connection: LiveConnection) -> str | None:
    return connection.translation_target_language if connection.recording_mode == "translation" else None


def live_plan(runtime: Runtime, settings: StoredSettings, connection: LiveConnection) -> LivePlan:
    provider = settings.transcription_provider
    model = provider_model(settings)
    capabilities = CAPABILITIES[provider]
    cloud = not capabilities.offline
    if capabilities.requires_cloud_consent and not settings.cloud_consent:
        return LivePlan(provider, model, None, "Cloud processing is off.", cloud,
                        capabilities.api_key_provider)
    key = runtime.api_key(capabilities.api_key_provider) if capabilities.api_key_provider else None
    if capabilities.api_key_provider and not key:
        return LivePlan(provider, model, None, f"No {LABELS[provider]} API key is stored.", cloud,
                        capabilities.api_key_provider)
    target = _translation_target(connection)
    if target is not None and capabilities.translation == "none":
        return LivePlan(provider, model, None,
                        f"{LABELS[provider]} cannot translate live. Choose Transcription mode or Soniox.",
                        cloud, capabilities.api_key_provider)
    if target is not None and capabilities.translation == "english_only" and target != "en":
        return LivePlan(provider, model, None,
                        f"{LABELS[provider]} can translate into English only. Choose English as the "
                        "translation language, Transcription mode, or Soniox.",
                        cloud, capabilities.api_key_provider)
    if provider == "soniox":
        assert key is not None
        config = SonioxConfig(
            sample_rate=connection.sample_rate, event_queue_size=8,
            used_languages=connection.used_languages, translation_target_language=target,
        )
        api_key = key

        async def open_soniox() -> LiveAsrSession:
            return await SonioxGateway(api_key=api_key, config=config).open()

        opener = LiveSessionOpener(provider, LABELS[provider], model, open_soniox)
    elif provider == "local-whisper":
        opener = LiveSessionOpener(
            provider, LABELS[provider], model,
            _local_opener(runtime, settings, connection, target), LOCAL_OPEN_TIMEOUT_S,
        )
    else:
        assert key is not None
        opener = LiveSessionOpener(
            provider, LABELS[provider], model,
            _openai_opener(runtime, settings, connection, key), CLOUD_OPEN_TIMEOUT_S,
        )
    return LivePlan(provider, model, opener, None, cloud, capabilities.api_key_provider)


def _stream_settings(connection: LiveConnection, label: str, target: str | None, *,
                     utterance: bool = False) -> StreamSettings:
    if utterance:
        return StreamSettings(
            sample_rate=connection.sample_rate, label=label, used_languages=connection.used_languages,
            translation_target_language=target, min_step_s=0.5, trim_after_s=10.0, max_window_s=15.0,
        )
    return StreamSettings(
        sample_rate=connection.sample_rate, label=label, used_languages=connection.used_languages,
        translation_target_language=target,
    )


async def _speaker_tracker(runtime: Runtime, settings: StoredSettings) -> SpeakerTracker:
    """The local voice model when the user keeps separation on and it is downloaded."""
    if not settings.speaker_separation or not speaker_model_present(runtime):
        return SpeakerTracker(None)
    try:
        embedder = await _to_thread_until_finished(
            load_speaker_embedder, cache_dir=runtime.config.local_model_cache_dir)
    except Exception as error:
        raise LiveAsrError(
            "The speaker model could not be loaded. Download it again, or turn speaker separation off.",
            retryable=False,
        ) from error
    return SpeakerTracker(embedder)


def _voice_activity() -> VoiceActivity:
    if local_asr_available():
        from .gateways.whisper_local import SileroVoiceActivity

        return SileroVoiceActivity()
    return EnergyVoiceActivity()


class _GuardedSession(WhisperStreamSession):
    """Releases the local-model use guard when the session closes."""

    _release: Callable[[], Awaitable[None]] | None = None

    async def aclose(self) -> None:
        try:
            await super().aclose()
        finally:
            release, self._release = self._release, None
            if release is not None:
                await release()


def _local_opener(
    runtime: Runtime, settings: StoredSettings, connection: LiveConnection, target: str | None,
) -> Callable[[], Awaitable[LiveAsrSession]]:
    model = settings.local_whisper_model
    cache_dir: Path | None = runtime.config.local_model_cache_dir

    async def open_local() -> LiveAsrSession:
        from .gateways.whisper_local import LocalWhisperDecoder

        stack = contextlib.AsyncExitStack()
        try:
            try:
                await stack.enter_async_context(runtime.local_models.use("local-whisper", model))
                transcriber = LocalWhisperTranscriber(model=model, allow_download=False, cache_dir=cache_dir)
                engine = await _to_thread_until_finished(transcriber._engine)
            except LocalAsrDependencyMissing as error:
                raise LiveAsrError(str(error), retryable=False) from error
            except ProviderNotConfigured as error:
                raise LiveAsrError(
                    f"The Local Whisper model '{model}' is not ready: "
                    "download it in Settings → Transcription.",
                    retryable=False,
                ) from error
            speakers = await _speaker_tracker(runtime, settings)
            session = _GuardedSession(
                _stream_settings(connection, LABELS["local-whisper"], target),
                decoder=LocalWhisperDecoder(engine, model=model), vad=_voice_activity(), speakers=speakers,
            )
        except BaseException:
            await stack.aclose()
            raise
        session._release = stack.aclose
        return session

    return open_local


def _openai_opener(
    runtime: Runtime, settings: StoredSettings, connection: LiveConnection, key: str,
) -> Callable[[], Awaitable[LiveAsrSession]]:
    model = settings.openai_transcription_model

    async def open_openai() -> LiveAsrSession:
        from .gateways.openai_stream import OpenAIWindowDecoder

        speakers = await _speaker_tracker(runtime, settings)
        decoder = OpenAIWindowDecoder(runtime.http, api_key=key, model=model,
                                      timeout=runtime.config.request_timeout_s)
        return WhisperStreamSession(
            _stream_settings(connection, LABELS["openai"], None, utterance=True),
            decoder=decoder, vad=_voice_activity(), speakers=speakers,
        )

    return open_openai


# ── Media import ─────────────────────────────────────────────────────────────

#: Advertised OpenAI transcription rates, US dollars per hour of audio.
OPENAI_RATE_PER_HOUR_USD: dict[str, float] = {
    "whisper-1": 0.36, "gpt-4o-transcribe": 0.36, "gpt-4o-mini-transcribe": 0.18,
}


def import_model(settings: StoredSettings) -> str:
    """The model identity an import records; its prefix names the provider."""
    if settings.transcription_provider == "soniox":
        return ASYNC_MODEL
    return connection_model(settings)


def import_provider(model: str) -> str:
    return provider_of_model(model)


def check_import(runtime: Runtime, settings: StoredSettings, *, translate: bool) -> None:
    """Refuse before anything starts: consent, key, local model and translation support."""
    provider = settings.transcription_provider
    ready, detail = readiness(runtime, settings, provider)
    if not ready:
        raise ProviderNotConfigured(f"{LABELS[provider]}: {detail}")
    capabilities = CAPABILITIES[provider]
    if translate and capabilities.translation == "none":
        raise ProviderNotConfigured(f"{LABELS[provider]} cannot translate imported media. "
                                    "Import without translation, or choose Soniox.")
    if translate and capabilities.translation == "english_only":
        from .gateways.whisper_local import can_translate_to_english

        if (settings.translation_target_language != "en"
                or not can_translate_to_english(settings.local_whisper_model)):
            raise ProviderNotConfigured(
                "Local Whisper translates into English only, and not with large-v3-turbo or distil "
                "models. Choose English as the translation language, another model, or Soniox.")


async def transcribe_import(
    runtime: Runtime, model: str, pcm: Path, *, languages: tuple[str, ...] | None,
    translation_target: str | None,
) -> FileTranscript:
    """Transcribe decoded 16 kHz PCM with the provider recorded on the import."""
    provider = import_provider(model)
    name = model.partition("/")[2]
    settings = runtime.settings_store.load()
    speakers = await _speaker_tracker(runtime, settings)
    if provider == "local-whisper":
        from .gateways.whisper_local import LocalWhisperDecoder

        async with runtime.local_models.use("local-whisper", name):
            transcriber = LocalWhisperTranscriber(
                model=name, allow_download=False, cache_dir=runtime.config.local_model_cache_dir)
            try:
                engine = await _to_thread_until_finished(transcriber._engine)
            except ProviderNotConfigured as error:
                raise ProviderNotConfigured(
                    f"The Local Whisper model '{name}' is not ready: download it in Settings → Transcription."
                ) from error
            return await transcribe_pcm_file(
                pcm, decoder=LocalWhisperDecoder(engine, model=name), vad=_voice_activity(),
                speakers=speakers, languages=languages, translation_target=translation_target,
            )
    if provider == "openai":
        from .gateways.openai_stream import OpenAIWindowDecoder

        if not settings.cloud_consent:
            raise ProviderNotConfigured("Importing with OpenAI sends audio to OpenAI; enable cloud consent.")
        key = runtime.api_key("openai")
        if not key:
            raise ProviderNotConfigured("OpenAI has no API key stored; add one in settings.")
        decoder = OpenAIWindowDecoder(runtime.http, api_key=key, model=name,
                                      timeout=max(runtime.config.request_timeout_s, 600.0))
        return await transcribe_pcm_file(
            pcm, decoder=decoder, vad=_voice_activity(), speakers=speakers, languages=languages,
            translation_target=None,
        )
    raise ProviderNotConfigured("This import's transcription provider is unknown.")
