"""Provider model catalogs.

Catalogs are fetched live and cached on disk so a profile can still be validated
without network. A catalog entry describes declared modalities only — it is not
evidence that a model implements a usable speech-to-text contract.

"Declared" is literal: a modality tuple is filled in only from metadata the
provider actually published. Absent, empty or malformed metadata leaves the
tuple empty, which means *unknown* — never "text". Unknown capability is not a
reason to invent a text contract, and not a reason to claim incompatibility.
"""

from __future__ import annotations

import contextlib
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from .local_models import (
    GIGACHAT_MODEL_ID,
    GIGACHAT_PROVIDER,
    LOCAL_WHISPER_REPOSITORIES,
)
from .secrets import SecretStore

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models"
ANTHROPIC_VERSION = "2023-06-01"
OPENROUTER_ASR_MODELS_URL = f"{OPENROUTER_MODELS_URL}?output_modalities=transcription"
RECOMMENDED_OPENROUTER_ASR = "qwen/qwen3-asr-1.7b"

#: faster-whisper checkpoint names; weights are downloaded only on explicit user action.
LOCAL_WHISPER_MODELS: tuple[str, ...] = tuple(LOCAL_WHISPER_REPOSITORIES)

#: OpenAI models served by the dedicated /v1/audio/transcriptions endpoint.
#: This is the documented endpoint contract, the one exception to "declared metadata only";
#: OpenAI's /v1/models response itself carries no modality fields.
OPENAI_TRANSCRIPTION_MODELS: tuple[str, ...] = ("whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe")

#: Disk cache layout. Bumped when the meaning of stored fields changes: caches written
#: before this version recorded a defaulted "text" modality for models whose provider
#: declared nothing, and replaying them would keep that fabrication alive.
CACHE_SCHEMA_VERSION = 2


class CatalogUnavailable(RuntimeError):
    """Raised when a catalog could not be fetched and no cached copy exists."""


@dataclass(frozen=True)
class CatalogEntry:
    """One catalog row. Empty modality tuples mean the provider declared nothing."""

    id: str
    name: str
    input_modalities: tuple[str, ...]
    output_modalities: tuple[str, ...]
    max_output_tokens: int | None = None
    pricing_amount_usd: float | None = None
    pricing_unit: str | None = None

    @property
    def accepts_audio(self) -> bool:
        return "audio" in self.input_modalities

    @property
    def emits_text(self) -> bool:
        """True only when text output is actually declared."""
        return "text" in self.output_modalities

    @property
    def emits_transcription(self) -> bool:
        return "transcription" in self.output_modalities

    @property
    def output_declared(self) -> bool:
        return bool(self.output_modalities)

    @property
    def excludes_text_output(self) -> bool:
        """True only for a declared output set that contains no text — a known incompatibility.

        An image-, audio-, video- or transcription-only model answers False to
        :attr:`emits_text` for the same reason an undeclared model does, so text tasks must
        ask this question instead: only a declared non-text output rules a model out.
        """
        return self.output_declared and not self.emits_text


class ProviderCatalogs:
    """Fetches and caches per-provider model lists."""

    def __init__(
        self,
        http: httpx.AsyncClient,
        secrets: SecretStore,
        cache_dir: Path,
        ttl_seconds: float = 600.0,
    ) -> None:
        self._http = http
        self._secrets = secrets
        self._cache_dir = cache_dir
        self._ttl = ttl_seconds
        self._memory: dict[str, tuple[float, list[CatalogEntry]]] = {}

    async def entries(self, provider: str, task: str | None = None) -> list[CatalogEntry]:
        if provider == "local-whisper":
            return [
                CatalogEntry(
                    id=name,
                    name=f"faster-whisper {name}",
                    input_modalities=("audio",),
                    output_modalities=("transcription",),
                )
                for name in LOCAL_WHISPER_MODELS
            ]
        if provider == GIGACHAT_PROVIDER:
            if task not in (None, "asr"):
                return []
            return [
                CatalogEntry(
                    id=GIGACHAT_MODEL_ID,
                    name="GigaChat Audio MLX (BF16)",
                    input_modalities=("audio",),
                    output_modalities=("text",),
                    max_output_tokens=512,
                )
            ]
        if provider == "openai-compatible":
            raise CatalogUnavailable(
                "openai-compatible endpoints have no discovery contract; enter the model id manually."
            )
        if provider == "openrouter" and task == "asr":
            return await self._openrouter_asr_entries()
        # Only OpenRouter has a task-specific discovery URL; other catalogs are one list.
        return await self._cached(provider, None)

    async def _openrouter_asr_entries(self) -> list[CatalogEntry]:
        """Dedicated speech-to-text models first, then legacy audio-input candidates.

        The two groups are different contracts and stay distinguishable by
        ``emits_transcription``: only the dedicated group is a real ASR endpoint.
        Both are returned so a user who deliberately wants the legacy audio-chat
        adapter can still find the model, but nothing is silently mixed together.
        A declared audio input with an undeclared output stays in the legacy group:
        unknown output is not evidence against the model, and the group is marked
        unverified anyway.
        """
        dedicated: list[CatalogEntry] = []
        legacy: list[CatalogEntry] = []
        failures: list[str] = []
        try:
            dedicated = await self._cached("openrouter", "asr")
        except CatalogUnavailable as error:
            failures.append(str(error))
        try:
            known = {entry.id for entry in dedicated}
            legacy = [
                entry
                for entry in await self._cached("openrouter", None)
                if entry.accepts_audio and not entry.excludes_text_output and entry.id not in known
            ]
        except CatalogUnavailable as error:
            failures.append(str(error))
        if not dedicated and not legacy and failures:
            raise CatalogUnavailable(failures[0])
        return dedicated + legacy

    async def _cached(self, provider: str, task: str | None) -> list[CatalogEntry]:
        cache_key = self._cache_key(provider, task)
        cached = self._memory.get(cache_key)
        if cached and time.monotonic() - cached[0] < self._ttl:
            return cached[1]
        try:
            fetched = await self._fetch(provider, task)
        except (httpx.HTTPError, ValueError, KeyError) as error:
            disk = self._read_disk_cache(provider, task)
            if disk is None:
                raise CatalogUnavailable(
                    f"{provider} catalog unavailable; check connectivity and provider settings."
                ) from error
            self._memory[cache_key] = (time.monotonic(), disk)
            return disk
        self._memory[cache_key] = (time.monotonic(), fetched)
        self._write_disk_cache(provider, task, fetched)
        return fetched

    async def find(self, provider: str, model_id: str, task: str | None = None) -> CatalogEntry | None:
        """Entry for ``model_id`` or None when the catalog is reachable but lacks it."""
        for entry in await self.entries(provider, task):
            if entry.id == model_id:
                return entry
        return None

    async def openrouter_asr_kind(self, model_id: str) -> str:
        """Return the explicit OpenRouter adapter contract for a configured model.

        Classification always follows the declared output modality, never the model
        name, and the unfiltered catalog is consulted as well so a transient failure
        of the transcription-filtered listing cannot demote a real STT model.
        """
        for task in ("asr", None):
            entry = await self.find("openrouter", model_id, task)
            if entry is None or not entry.accepts_audio:
                continue
            if entry.emits_transcription:
                return "dedicated"
            if not entry.excludes_text_output:
                return "legacy"
        raise CatalogUnavailable(
            f"OpenRouter model '{model_id}' has no dedicated transcription or legacy audio-chat contract."
        )

    def cached_openrouter_asr_kind(self, model_id: str) -> str | None:
        for entry in self._memory.get(self._cache_key("openrouter", "asr"), (0, []))[1]:
            if entry.id == model_id and entry.emits_transcription:
                return "dedicated"
        for entry in self._memory.get(self._cache_key("openrouter", None), (0, []))[1]:
            if entry.id == model_id and entry.accepts_audio and not entry.excludes_text_output:
                return "legacy"
        return None

    async def _fetch(self, provider: str, task: str | None) -> list[CatalogEntry]:
        key = self._secrets.get(provider)
        if provider == "openrouter":
            headers = {"Authorization": f"Bearer {key}"} if key else {}
            url = OPENROUTER_ASR_MODELS_URL if task == "asr" else OPENROUTER_MODELS_URL
            payload = await self._get_json(url, headers)
            entries = [
                entry
                for entry in (_openrouter_entry(item) for item in _rows(payload))
                if entry is not None
            ]
            if task == "asr":
                entries = [entry for entry in entries if entry.accepts_audio and entry.emits_transcription]
                entries.sort(key=lambda entry: entry.id != RECOMMENDED_OPENROUTER_ASR)
            return entries
        if provider == "openai":
            if not key:
                raise CatalogUnavailable("OpenAI API key is not configured.")
            payload = await self._get_json(OPENAI_MODELS_URL, {"Authorization": f"Bearer {key}"})
            # /v1/models lists text, image, audio and embedding models side by side and
            # declares no modalities. Only the documented transcriptions allowlist is known;
            # the rest stay unknown, because the alternative is guessing from the name.
            return [
                CatalogEntry(
                    id=model_id,
                    name=model_id,
                    input_modalities=("audio",) if model_id in OPENAI_TRANSCRIPTION_MODELS else (),
                    output_modalities=("transcription",)
                    if model_id in OPENAI_TRANSCRIPTION_MODELS
                    else (),
                )
                for model_id in _model_ids(payload)
            ]
        if provider == "anthropic":
            if not key:
                raise CatalogUnavailable("Anthropic API key is not configured.")
            payload = await self._get_json(
                ANTHROPIC_MODELS_URL, {"x-api-key": key, "anthropic-version": ANTHROPIC_VERSION}
            )
            # /v1/models carries no modality metadata either; nothing is declared here.
            return [
                CatalogEntry(
                    id=model_id,
                    name=str(item.get("display_name") or model_id),
                    input_modalities=(),
                    output_modalities=(),
                )
                for item in _rows(payload)
                if (model_id := _model_id(item)) is not None
            ]
        raise CatalogUnavailable(f"unknown provider {provider}")

    async def _get_json(self, url: str, headers: dict[str, str]) -> dict[str, Any]:
        response = await self._http.get(url, headers=headers)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("catalog response is not a JSON object")
        return payload

    @staticmethod
    def _cache_key(provider: str, task: str | None) -> str:
        return f"{provider}:{task or 'all'}"

    def _cache_path(self, provider: str, task: str | None) -> Path:
        suffix = f"-{task}" if task else ""
        return self._cache_dir / f"catalog-{provider}{suffix}.json"

    def _read_disk_cache(self, provider: str, task: str | None) -> list[CatalogEntry] | None:
        """Cached entries, or None when the file is missing, unreadable or from an older schema."""
        path = self._cache_path(provider, task)
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(raw, dict) or raw.get("version") != CACHE_SCHEMA_VERSION:
            return None
        try:
            return [
                CatalogEntry(
                    id=item["id"],
                    name=item["name"],
                    input_modalities=_modalities(item.get("input_modalities")),
                    output_modalities=_modalities(item.get("output_modalities")),
                    max_output_tokens=item.get("max_output_tokens"),
                    pricing_amount_usd=item.get("pricing_amount_usd"),
                    pricing_unit=item.get("pricing_unit"),
                )
                for item in raw.get("models", [])
            ]
        except (AttributeError, KeyError, TypeError):
            return None

    def _write_disk_cache(self, provider: str, task: str | None, entries: list[CatalogEntry]) -> None:
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": CACHE_SCHEMA_VERSION,
            "models": [
                {
                    "id": entry.id,
                    "name": entry.name,
                    "input_modalities": list(entry.input_modalities),
                    "output_modalities": list(entry.output_modalities),
                    "max_output_tokens": entry.max_output_tokens,
                    "pricing_amount_usd": entry.pricing_amount_usd,
                    "pricing_unit": entry.pricing_unit,
                }
                for entry in entries
            ],
        }
        with contextlib.suppress(OSError):
            self._cache_path(provider, task).write_text(json.dumps(payload, ensure_ascii=False), "utf-8")


def _modalities(values: Any) -> tuple[str, ...]:
    """Declared modality names, lowercased and de-duplicated.

    Anything that is not a list of non-empty strings — absent, null, a bare string,
    numbers — yields an empty tuple, i.e. "the provider declared nothing".
    """
    if not isinstance(values, (list, tuple)):
        return ()
    named = [value.strip().lower() for value in values if isinstance(value, str) and value.strip()]
    return tuple(dict.fromkeys(named))


def _rows(payload: Any) -> list[Any]:
    data = payload.get("data") if isinstance(payload, dict) else None
    return list(data) if isinstance(data, list) else []


def _model_id(item: Any) -> str | None:
    """The model id, or None when the row carries no usable one."""
    if not isinstance(item, dict):
        return None
    raw = item.get("id")
    return raw if isinstance(raw, str) and raw.strip() else None


def _model_ids(payload: Any) -> list[str]:
    return [model_id for item in _rows(payload) if (model_id := _model_id(item)) is not None]


def _openrouter_entry(item: Any) -> CatalogEntry | None:
    """Map one OpenRouter row, or None when it has no usable model id.

    Modalities come from ``architecture`` only when that block is a real object with
    real modality lists; otherwise they stay unknown instead of defaulting to text.
    """
    model_id = _model_id(item)
    if model_id is None:
        return None
    assert isinstance(item, dict)
    architecture = item.get("architecture")
    architecture = architecture if isinstance(architecture, dict) else {}
    inputs = architecture.get("input_modalities")
    outputs = architecture.get("output_modalities")
    top_provider = item.get("top_provider") or {}
    max_output = top_provider.get("max_completion_tokens") if isinstance(top_provider, dict) else None
    max_output = int(max_output) if isinstance(max_output, (int, float)) and max_output > 0 else None
    pricing_amount: float | None = None
    pricing_unit: str | None = None
    # OpenRouter's Qwen model page explicitly defines this registry value as USD/second.
    # Other catalog prompt prices are not exposed because their units are vendor-dependent.
    if str(item.get("id")) == RECOMMENDED_OPENROUTER_ASR:
        pricing = item.get("pricing") or {}
        try:
            pricing_amount = float(pricing["prompt"])
            pricing_unit = "second"
        except (KeyError, TypeError, ValueError):
            pricing_amount = None
            pricing_unit = None
    return CatalogEntry(
        id=str(item["id"]),
        name=str(item.get("name") or item["id"]),
        input_modalities=_modalities(inputs),
        output_modalities=_modalities(outputs),
        max_output_tokens=max_output,
        pricing_amount_usd=pricing_amount,
        pricing_unit=pricing_unit,
    )
