"""Bounded, read-only contextual ASR preview over stored source chunks."""

from __future__ import annotations

import asyncio
import hashlib
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from . import repository as repo
from .audio import InvalidAudio, WavAudio, parse_wav
from .gateways import ProviderError, ProviderNotConfigured
from .gateways.asr import (
    WHISPER_SAMPLE_RATE,
    LocalWhisperTranscriber,
    TranscriptPiece,
    TranscriptWord,
    build_transcriber,
)
from .schemas import AsrPreviewResponse, AsrPreviewSource, AsrPreviewWindow

if TYPE_CHECKING:  # pragma: no cover
    from .runtime import Runtime


class PreviewSourceMissing(Exception):
    """A requested endpoint chunk or its durable source file is absent."""


class PreviewSourceConflict(Exception):
    """Stored metadata and source bytes cannot form one trustworthy timeline."""


class PreviewTooLarge(Exception):
    """The selected window exceeds a configured resource bound."""


class PreviewBusy(Exception):
    """The process-wide contextual decoder slot is occupied."""


class PreviewStale(Exception):
    """The source session disappeared while inference was running."""


class PreviewDecodeFailed(Exception):
    """Local inference failed; the original exception is intentionally not exposed."""


@dataclass(frozen=True)
class _PreparedWindow:
    audio: WavAudio
    sources: tuple[AsrPreviewSource, ...]
    records: tuple[repo.ChunkRecord, ...]


@dataclass(frozen=True)
class PreparedPreview(_PreparedWindow):
    session_id: str
    model: str
    requested_language: str
    speech_gate_enabled: bool
    config_revision: int


@dataclass(frozen=True)
class TimedPreview:
    response: AsrPreviewResponse
    words: tuple[TranscriptWord, ...] | None
    provenance: Literal["live", "source_ended_final_pass"] = "live"


def _read_bounded(path: Path, maximum: int) -> bytes:
    try:
        with path.open("rb") as handle:
            data = handle.read(maximum + 1)
    except FileNotFoundError as error:
        raise PreviewSourceMissing("A selected source audio file is missing.") from error
    except OSError as error:
        raise PreviewSourceConflict("A selected source audio file cannot be read.") from error
    if len(data) > maximum:
        raise PreviewTooLarge("Selected source audio exceeds the combined byte limit.")
    return data


class WindowAsrPreview:
    """One explicit contextual decode at a time; never writes transcript state."""

    def __init__(self, runtime: Runtime) -> None:
        self._runtime = runtime
        self._slot = asyncio.Lock()

    async def preview(
        self, session_id: str, first_sequence: int, last_sequence: int
    ) -> AsrPreviewResponse:
        if self._slot.locked():
            raise PreviewBusy("Another contextual ASR preview is already running.")
        return await self.decode(self.inspect(session_id, first_sequence, last_sequence))

    def inspect(
        self, session_id: str, first_sequence: int, last_sequence: int
    ) -> PreparedPreview:
        """Validate and assemble a bounded source window without constructing a decoder."""
        settings, config_revision = self._runtime.settings_store.load_asr_snapshot()
        profile = settings.profile("asr")
        speech_gate_enabled = self._runtime.local_speech_gate
        if profile.provider != "local-whisper":
            raise ProviderNotConfigured(
                "Context preview supports only the selected local-whisper ASR provider."
            )
        prepared = self._prepare(session_id, first_sequence, last_sequence)
        return PreparedPreview(
            session_id=session_id,
            audio=prepared.audio,
            sources=tuple(prepared.sources),
            records=prepared.records,
            model=profile.model,
            requested_language=settings.transcript_language,
            speech_gate_enabled=speech_gate_enabled,
            config_revision=config_revision,
        )

    def inspect_source(
        self, session_id: str, first_sequence: int, last_sequence: int
    ) -> tuple[AsrPreviewSource, ...]:
        """Validate persisted bytes independently of the currently selected ASR config."""
        return self._prepare(session_id, first_sequence, last_sequence).sources

    async def decode(self, prepared: PreparedPreview) -> AsrPreviewResponse:
        """Decode one already-validated window through the shared bounded slot."""
        if self._slot.locked():
            raise PreviewBusy("Another contextual ASR preview is already running.")
        async with self._slot:
            transcriber = build_transcriber(
                http=self._runtime.http,
                provider="local-whisper",
                model=prepared.model,
                api_key=None,
                base_url=None,
                timeout=self._runtime.config.asr_timeout_s,
                allow_download=False,
                speech_gate_enabled=prepared.speech_gate_enabled,
                local_model_cache_dir=self._runtime.config.local_model_cache_dir,
            )
            async def run() -> list[TranscriptPiece]:
                async with self._runtime.local_models.use("local-whisper", prepared.model):
                    return await transcriber.transcribe(
                        prepared.audio, language=prepared.requested_language
                    )

            inference = asyncio.create_task(run())
            try:
                pieces = await asyncio.shield(inference)
            except asyncio.CancelledError:
                # A worker thread cannot be force-cancelled. Keep the slot until it exits.
                with suppress(Exception, asyncio.CancelledError):
                    await inference
                raise
            except ProviderNotConfigured as error:
                raise ProviderNotConfigured(
                    "The selected local Whisper model is unavailable without downloading weights."
                ) from error
            except ProviderError:
                raise
            except Exception as error:
                raise PreviewDecodeFailed("Local ASR preview failed.") from error

            self.ensure_live(prepared)
            return self._response(prepared, pieces)

    async def decode_with_word_evidence(self, prepared: PreparedPreview) -> TimedPreview:
        """Local-only live decode that asks the installed adapter for timed words."""
        return await self._decode_timed(prepared, provenance="live")

    async def decode_source_ended_final_pass(self, prepared: PreparedPreview) -> TimedPreview:
        """One bounded EOF decode, distinguished from repeated live agreement."""
        return await self._decode_timed(prepared, provenance="source_ended_final_pass")

    async def _decode_timed(
        self,
        prepared: PreparedPreview,
        *,
        provenance: Literal["live", "source_ended_final_pass"],
    ) -> TimedPreview:
        if self._slot.locked():
            raise PreviewBusy("Another contextual ASR preview is already running.")
        async with self._slot:
            transcriber = build_transcriber(
                http=self._runtime.http,
                provider="local-whisper",
                model=prepared.model,
                api_key=None,
                base_url=None,
                timeout=self._runtime.config.asr_timeout_s,
                allow_download=False,
                speech_gate_enabled=prepared.speech_gate_enabled,
                local_model_cache_dir=self._runtime.config.local_model_cache_dir,
            )
            if not isinstance(transcriber, LocalWhisperTranscriber):
                raise PreviewDecodeFailed("Local ASR word timestamps are unavailable.")
            async def run() -> tuple[list[TranscriptPiece], tuple[TranscriptWord, ...] | None]:
                async with self._runtime.local_models.use("local-whisper", prepared.model):
                    return await transcriber.transcribe_with_word_timestamps(
                        prepared.audio, language=prepared.requested_language
                    )

            inference = asyncio.create_task(run())
            try:
                pieces, words = await asyncio.shield(inference)
            except asyncio.CancelledError:
                with suppress(Exception, asyncio.CancelledError):
                    await inference
                raise
            except ProviderNotConfigured as error:
                raise ProviderNotConfigured(
                    "The selected local Whisper model is unavailable without downloading weights."
                ) from error
            except ProviderError:
                raise
            except Exception as error:
                raise PreviewDecodeFailed("Local ASR preview failed.") from error
            self.ensure_live(prepared)
            return TimedPreview(
                response=self._response(prepared, pieces),
                words=words,
                provenance=provenance,
            )

    @staticmethod
    def _response(prepared: PreparedPreview, pieces: list[TranscriptPiece]) -> AsrPreviewResponse:
        text = " ".join(piece.text.strip() for piece in pieces if piece.text.strip())
        detected = next((piece.language for piece in pieces if piece.language), None)
        model_sample_count = max(
            1,
            round(
                prepared.audio.frame_count * WHISPER_SAMPLE_RATE / prepared.audio.sample_rate
            ),
        )
        return AsrPreviewResponse(
            text=text,
            language=detected,
            model=prepared.model,
            requested_language=prepared.requested_language,
            speech_gate_enabled=prepared.speech_gate_enabled,
            window=AsrPreviewWindow(
                start_ms=prepared.records[0].start_ms,
                end_ms=prepared.records[-1].end_ms,
                sample_rate=prepared.audio.sample_rate,
                sample_count=prepared.audio.frame_count,
                model_input_sample_rate=WHISPER_SAMPLE_RATE,
                model_input_sample_count=model_sample_count,
            ),
            sources=list(prepared.sources),
        )

    def _prepare(
        self, session_id: str, first_sequence: int, last_sequence: int
    ) -> _PreparedWindow:
        if repo.get_session(self._runtime.db, session_id) is None:
            raise PreviewSourceMissing("Session does not exist.")
        maximum_chunks = self._runtime.config.max_preview_chunks
        records = repo.chunks_in_sequence_range(
            self._runtime.db,
            session_id,
            first_sequence,
            last_sequence,
            limit=maximum_chunks + 1,
        )
        if len(records) > maximum_chunks:
            raise PreviewTooLarge("Selected window contains too many source chunks.")
        if (
            not records
            or records[0].sequence != first_sequence
            or records[-1].sequence != last_sequence
        ):
            raise PreviewSourceMissing("Both endpoint source chunks must exist in this session.")

        byte_limit = self._runtime.config.max_chunk_bytes
        total_bytes = 0
        paths: list[Path] = []
        for record in records:
            path = Path(record.path)
            try:
                size = path.stat().st_size
            except FileNotFoundError as error:
                raise PreviewSourceMissing("A selected source audio file is missing.") from error
            except OSError as error:
                raise PreviewSourceConflict("A selected source audio file cannot be read.") from error
            total_bytes += size
            if total_bytes > byte_limit:
                raise PreviewTooLarge("Selected source audio exceeds the combined byte limit.")
            paths.append(path)

        frames = bytearray()
        sources: list[AsrPreviewSource] = []
        sample_rate: int | None = None
        previous_end: int | None = None
        bytes_read = 0
        for record, path in zip(records, paths, strict=True):
            data = _read_bounded(path, byte_limit - bytes_read)
            bytes_read += len(data)
            if hashlib.sha256(data).hexdigest() != record.sha256:
                raise PreviewSourceConflict("A selected source audio digest does not match metadata.")
            try:
                audio = parse_wav(data, max_seconds=self._runtime.config.max_chunk_seconds)
            except InvalidAudio as error:
                raise PreviewSourceConflict("A selected source is not valid mono PCM16 WAV.") from error
            if sample_rate is None:
                sample_rate = audio.sample_rate
            elif audio.sample_rate != sample_rate:
                raise PreviewSourceConflict("Selected source chunks use different sample rates.")
            if record.end_ms - record.start_ms != audio.duration_ms:
                raise PreviewSourceConflict(
                    "A selected source duration is inconsistent with its PCM sample count."
                )
            if previous_end is not None and record.start_ms != previous_end:
                raise PreviewSourceConflict("Selected source chunks have a timeline gap or overlap.")
            sample_start = len(frames) // 2
            frames.extend(audio.frames)
            sample_end = len(frames) // 2
            sources.append(
                AsrPreviewSource(
                    sequence=record.sequence,
                    start_ms=record.start_ms,
                    end_ms=record.end_ms,
                    sample_rate=audio.sample_rate,
                    sample_count=audio.frame_count,
                    window_sample_start=sample_start,
                    window_sample_end=sample_end,
                    sha256=record.sha256,
                )
            )
            previous_end = record.end_ms

        assert sample_rate is not None
        if len(frames) // 2 > self._runtime.config.max_chunk_seconds * sample_rate:
            raise PreviewTooLarge("Selected source audio exceeds the combined duration limit.")
        return _PreparedWindow(
            audio=WavAudio(sample_rate=sample_rate, frames=bytes(frames)),
            sources=tuple(sources),
            records=tuple(records),
        )

    def ensure_live(self, prepared: PreparedPreview) -> None:
        """Reject source or ASR-setting changes after a prepared snapshot was taken."""
        self._ensure_snapshot_is_live(prepared.session_id, prepared.records)
        settings, revision = self._runtime.settings_store.load_asr_snapshot()
        profile = settings.profile("asr")
        if (
            revision != prepared.config_revision
            or profile.provider != "local-whisper"
            or profile.model != prepared.model
            or settings.transcript_language != prepared.requested_language
            or self._runtime.local_speech_gate != prepared.speech_gate_enabled
        ):
            raise PreviewStale("ASR profile or language changed while contextual ASR was running.")

    def _ensure_snapshot_is_live(
        self, session_id: str, expected: tuple[repo.ChunkRecord, ...]
    ) -> None:
        if repo.get_session(self._runtime.db, session_id) is None:
            raise PreviewStale("Session was deleted while contextual ASR was running.")
        current = repo.chunks_in_sequence_range(
            self._runtime.db,
            session_id,
            expected[0].sequence,
            expected[-1].sequence,
            limit=len(expected) + 1,
        )
        if tuple(current) != expected:
            raise PreviewStale("Selected sources changed while contextual ASR was running.")

    def close(self) -> None:
        """Reserved for symmetry with other process-wide services."""
