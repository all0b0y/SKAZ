"""Audio chunk intake: durable storage, ordered transcription, idempotent sequences.

Ordering and back-pressure are per session: one chunk is transcribed at a time so
segments land in timeline order, while question answering and note generation run
on their own tasks and are never blocked by the ASR queue.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from . import repository as repo
from .audio import WavAudio, parse_wav
from .audio_storage import write_audio_file
from .gateways import ProviderError, ProviderNotConfigured, require_cloud_consent
from .gateways.asr import Transcriber, build_transcriber
from .schemas import AudioResponse, Segment, StoredAudioResponse
from .settings_store import StoredSettings

if TYPE_CHECKING:  # pragma: no cover
    from .runtime import Runtime

logger = logging.getLogger(__name__)


class ChunkConflict(Exception):
    """The sequence number was reused with different audio."""


class QueueFull(Exception):
    """Too many chunks are already waiting for transcription in this session."""


@dataclass(frozen=True)
class PersistedAudio:
    audio: WavAudio
    record: repo.ChunkRecord
    duplicate: bool


def _piece_end(chunk_start_ms: int, chunk_end_ms: int, offset_ms: int, duration_ms: int) -> int:
    """Clamp a transcript piece to the chunk window declared by the recorder."""
    if duration_ms <= 0:
        return chunk_end_ms
    return min(chunk_end_ms, chunk_start_ms + offset_ms + duration_ms)


class IngestionService:
    def __init__(self, runtime: Runtime) -> None:
        self._runtime = runtime
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._storage_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._pending: dict[str, int] = defaultdict(int)

    def pending(self, session_id: str) -> int:
        return self._pending[session_id]

    async def store(
        self, session_id: str, sequence: int, start_ms: int, end_ms: int, body: bytes
    ) -> StoredAudioResponse:
        """Persist captured WAV bytes without constructing or waiting for ASR."""
        stored = await self._persist(session_id, sequence, start_ms, end_ms, body)
        return StoredAudioResponse(
            sequence=stored.record.sequence,
            start_ms=stored.record.start_ms,
            end_ms=stored.record.end_ms,
            status=stored.record.status,
            available=True,
            duplicate=stored.duplicate,
        )

    async def ingest(
        self, session_id: str, sequence: int, start_ms: int, end_ms: int, body: bytes
    ) -> AudioResponse:
        config = self._runtime.config
        repo.assert_final_writer_available(self._runtime.db, session_id, "legacy")
        stored_audio = await self._persist(session_id, sequence, start_ms, end_ms, body)
        if stored_audio.duplicate and stored_audio.record.status == repo.CHUNK_DONE:
            stored = repo.segments_for_chunk(self._runtime.db, session_id, sequence)
            return AudioResponse(segments=stored, duplicate=True, pending=self.pending(session_id))

        if self._pending[session_id] >= config.max_pending_chunks:
            raise QueueFull(
                f"{self._pending[session_id]} chunks are pending transcription "
                f"(limit {config.max_pending_chunks}); retry this chunk shortly."
            )

        # Repeat after persistence so an ownership commit that raced source storage
        # still prevents avoidable decoding. The final transaction is authoritative.
        repo.assert_final_writer_available(self._runtime.db, session_id, "legacy")
        transcriber = await self._transcriber()
        self._pending[session_id] += 1
        try:
            async with self._locks[session_id]:
                if stored_audio.duplicate:
                    refreshed = repo.get_chunk(self._runtime.db, session_id, sequence)
                    if refreshed is not None and refreshed.status == repo.CHUNK_DONE:
                        return AudioResponse(
                            segments=repo.segments_for_chunk(self._runtime.db, session_id, sequence),
                            duplicate=True,
                            pending=max(0, self.pending(session_id) - 1),
                        )
                segments = await self._transcribe_chunk(
                    transcriber, session_id, sequence, start_ms, end_ms, stored_audio.audio
                )
        finally:
            self._pending[session_id] -= 1
        return AudioResponse(
            segments=segments,
            duplicate=stored_audio.duplicate,
            pending=self.pending(session_id),
        )

    async def flush(self, session_id: str) -> list[str]:
        """Finish the tail: wait for in-flight work, then retry chunks that never transcribed."""
        errors: list[str] = []
        repo.assert_final_writer_available(self._runtime.db, session_id, "legacy")
        async with self._locks[session_id]:
            pending_chunks = repo.unfinished_chunks(self._runtime.db, session_id)
            if not pending_chunks:
                return errors
            repo.assert_final_writer_available(self._runtime.db, session_id, "legacy")
            try:
                transcriber = await self._transcriber()
            except ProviderNotConfigured as error:
                return [str(error)]
            for chunk in pending_chunks:
                try:
                    audio = parse_wav(
                        Path(chunk.path).read_bytes(), max_seconds=self._runtime.config.max_chunk_seconds
                    )
                    await self._transcribe_chunk(
                        transcriber, session_id, chunk.sequence, chunk.start_ms, chunk.end_ms, audio
                    )
                except (ProviderError, ProviderNotConfigured, OSError, ValueError) as error:
                    errors.append(f"chunk {chunk.sequence}: {error}")
        return errors

    async def _transcribe_chunk(
        self,
        transcriber: Transcriber,
        session_id: str,
        sequence: int,
        start_ms: int,
        end_ms: int,
        audio: WavAudio,
    ) -> list[Segment]:
        settings = self._runtime.settings_store.load()
        try:
            if transcriber.provider in ("local-whisper", "local-gigachat-mlx"):
                async with self._runtime.local_models.use(transcriber.provider, transcriber.model):
                    pieces = await transcriber.transcribe(
                        audio, language=settings.transcript_language
                    )
            else:
                pieces = await transcriber.transcribe(audio, language=settings.transcript_language)
        except (ProviderError, ProviderNotConfigured) as error:
            # The audio stays on disk with a failed marker so a later flush can retry it.
            repo.set_chunk_status(self._runtime.db, session_id, sequence, repo.CHUNK_FAILED, str(error))
            logger.warning("Transcription failed for %s/%s: %s", session_id, sequence, error)
            raise
        segments = [
            repo.new_segment(
                start_ms=min(start_ms + piece.offset_ms, end_ms),
                end_ms=_piece_end(start_ms, end_ms, piece.offset_ms, piece.duration_ms),
                text=piece.text,
                language=piece.language,
            )
            for piece in pieces
        ]
        repo.replace_chunk_segments(self._runtime.db, session_id, sequence, segments)
        repo.set_chunk_status(self._runtime.db, session_id, sequence, repo.CHUNK_DONE, None)
        if segments and transcriber.can_verify_asr:
            self._runtime.mark_verified(
                "asr",
                transcriber.provider,
                transcriber.model,
                "Transcribed a real audio chunk through this installation",
            )
        return segments

    async def _transcriber(self) -> Transcriber:
        settings: StoredSettings = self._runtime.settings_store.load()
        profile = settings.profile("asr")
        # One gate for every outbound transfer of user material: audio here, text in the agent.
        require_cloud_consent(profile.provider, settings.cloud_consent, "audio")
        openrouter_kind = None
        if profile.provider == "openrouter":
            try:
                openrouter_kind = await self._runtime.catalogs.openrouter_asr_kind(profile.model)
            except Exception as error:
                raise ProviderNotConfigured(str(error)) from error
        return build_transcriber(
            http=self._runtime.http,
            provider=profile.provider,
            model=profile.model,
            api_key=self._runtime.api_key(profile.provider),
            base_url=profile.base_url,
            timeout=self._runtime.config.asr_timeout_s,
            allow_download=self._runtime.allow_model_download,
            # Legacy per-chunk path: the process-level flag only. The contextual
            # local opt-in must never change legacy or cloud gate semantics.
            speech_gate_enabled=self._runtime.config.local_speech_gate,
            openrouter_kind=openrouter_kind,
            local_model_cache_dir=self._runtime.config.local_model_cache_dir,
        )

    def _check_existing(
        self, session_id: str, sequence: int, digest: str, start_ms: int, end_ms: int
    ) -> repo.ChunkRecord | None:
        """The stored chunk for this sequence, or None. Raises when it is a different chunk."""
        existing = repo.get_chunk(self._runtime.db, session_id, sequence)
        if existing is None:
            return None
        if existing.sha256 != digest:
            raise ChunkConflict(
                f"Sequence {sequence} was already stored with different audio; use a new sequence number."
            )
        if existing.start_ms != start_ms or existing.end_ms != end_ms:
            raise ChunkConflict(
                f"Sequence {sequence} was already stored with different timeline metadata; "
                "use a new sequence number."
            )
        return existing

    async def _persist(
        self, session_id: str, sequence: int, start_ms: int, end_ms: int, body: bytes
    ) -> PersistedAudio:
        audio = parse_wav(body, max_seconds=self._runtime.config.max_chunk_seconds)
        digest = hashlib.sha256(body).hexdigest()
        async with self._storage_locks[session_id]:
            with self._runtime.db.read() as connection:
                if connection.execute(
                    "SELECT 1 FROM native_recordings WHERE session_id=?", (session_id,)
                ).fetchone():
                    raise ChunkConflict("Native recordings only accept their ordered PCM stream.")
            existing = self._check_existing(session_id, sequence, digest, start_ms, end_ms)
            duplicate = existing is not None
            if existing is not None:
                path = Path(existing.path)
                if not path.is_file():
                    self._store_audio(path, body)
                record = existing
            else:
                winner = self._claim(session_id, sequence, start_ms, end_ms, digest, body)
                duplicate = winner is not None
                claimed = winner or repo.get_chunk(self._runtime.db, session_id, sequence)
                if claimed is None:  # defensive: the successful claim must be readable immediately
                    raise OSError("Stored audio metadata could not be read back.")
                record = claimed
            repo.extend_duration(self._runtime.db, session_id, end_ms)
        return PersistedAudio(audio=audio, record=record, duplicate=duplicate)

    def _claim(
        self, session_id: str, sequence: int, start_ms: int, end_ms: int, digest: str, body: bytes
    ) -> repo.ChunkRecord | None:
        """Take ownership of the sequence and persist its audio, or return the winner's record.

        The row is claimed atomically first, so two concurrent uploads of the same
        sequence can never both write to the same file: the loser never touches disk
        and is validated against the winner's stored digest and timeline metadata.
        """
        path = self._runtime.config.audio_dir / session_id / f"{sequence:06d}.wav"
        record = repo.ChunkRecord(
            session_id=session_id,
            sequence=sequence,
            start_ms=start_ms,
            end_ms=end_ms,
            sha256=digest,
            path=str(path),
            status=repo.CHUNK_PENDING,
            error=None,
        )
        if repo.insert_chunk(self._runtime.db, record):
            try:
                self._store_audio(path, body)
            except OSError:
                repo.delete_pending_chunk_claim(self._runtime.db, session_id, sequence, digest)
                raise
            return None
        existing = self._check_existing(session_id, sequence, digest, start_ms, end_ms)
        if existing is None:  # deleted between the failed insert and the re-read
            raise ChunkConflict(f"Sequence {sequence} could not be stored; retry with a new sequence number.")
        return existing

    @staticmethod
    def _store_audio(path: Path, body: bytes) -> None:
        write_audio_file(path, body)

    def close(self) -> None:
        self._locks.clear()
        self._storage_locks.clear()
        self._pending.clear()
