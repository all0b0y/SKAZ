"""Shared helpers for the speech area: the legacy recorder/importer driven through public seams.

Providers are scripted fakes at the external socket/HTTP edge; they prove the
plumbing, never recognition quality.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx

from skaz.db import Database
from skaz.gateways.soniox import SonioxEvent, SonioxToken, SonioxTokenRef, SonioxTranslationToken
from skaz.gateways.soniox_async import ASYNC_MODEL
from skaz.live_store import LiveConnection, LiveStore
from tests.conftest import FakeHttp

RATE = 16_000
BLOCK = RATE // 2  # the store accepts at most 500 ms per audio block

#: (text, start_ms, end_ms, speaker) relative to the connection start.
Word = tuple[str, int, int, str | None]


@dataclass
class Recorder:
    """Feeds a legacy native recording the way ``NativeStream`` does: audio clock first, then events."""

    store: LiveStore
    connection: LiveConnection
    saved_samples: int
    next_sequence: int
    ordinal: int = 0
    final_ms: int = 0

    @classmethod
    def open(cls, db: Database, session_id: str, *, mode: str = "transcription",
             target: str = "en") -> Recorder:
        store = LiveStore(db)
        connection = store.open(session_id, sample_rate=RATE, model="stt-rt-v5",
                                recording_mode=mode,  # type: ignore[arg-type]
                                translation_target_language=target)
        return cls(store, connection, connection.start_sample, connection.next_sequence)

    def _audio_until(self, relative_ms: int) -> None:
        target = self.connection.start_sample + relative_ms * RATE // 1000
        while self.saved_samples < target:
            self.store.append_audio(self.connection.id, sequence=self.next_sequence,
                                    start_sample=self.saved_samples, pcm=b"\x01\x00" * BLOCK)
            self.saved_samples += BLOCK
            self.next_sequence += 1

    def say(self, words: Sequence[Word], *, translation: Sequence[tuple[str, str | None]] = (),
            partial: Sequence[Word] = (), partial_translation: Sequence[tuple[str, str | None]] = ()) -> None:
        """One provider event with these final words (and optional final translation), and the
        replaceable non-final tail that follows them (``partial``)."""
        end = max(word[2] for word in (*words, *partial))
        self._audio_until(end)
        originals = tuple(SonioxToken(text, start, stop, 0.9, True, "en", speaker)
                          for text, start, stop, speaker in words)
        drafts = tuple(SonioxToken(text, start, stop, 0.5, False, "en", speaker)
                       for text, start, stop, speaker in partial)
        translated = tuple(SonioxTranslationToken(text, 0.9, True, "ru", "en", speaker)
                           for text, speaker in translation)
        draft_translation = tuple(SonioxTranslationToken(text, 0.5, False, "ru", "en", speaker)
                                  for text, speaker in partial_translation)
        order = None
        if translated:
            order = tuple(
                [SonioxTokenRef("original", True, index) for index in range(len(originals))]
                + [SonioxTokenRef("translation", True, index) for index in range(len(translated))]
            )
        # The provider's final clock never goes back, also for an event that only revises the tail.
        self.final_ms = max([self.final_ms, *(word[2] for word in words)])
        event = SonioxEvent(originals, drafts, (), self.final_ms, end, False,
                            final_translation_tokens=translated,
                            partial_translation_tokens=draft_translation, token_order=order)
        self.store.save_event(self.connection.id, ordinal=self.ordinal, event=event)
        self.ordinal += 1

    def close(self) -> None:
        self.store.close(self.connection.id, finished=True)

    def resume(self, db: Database, session_id: str) -> Recorder:
        """A new connection on the same recording (Pause → Continue)."""
        self.close()
        return Recorder.open(db, session_id)


def sentence(text: str, start_ms: int, speaker: str | None, *, word_ms: int = 300) -> list[Word]:
    """Words of ``text`` one after another, ``word_ms`` each."""
    words = text.split()
    return [(" " + word, start_ms + index * word_ms, start_ms + (index + 1) * word_ms, speaker)
            for index, word in enumerate(words)]


#: One step of a live script: words answered for one audio frame, or ``"fail"`` (HTTP 401, not retried).
Step = list[Word] | str


class ScriptedSoniox:
    """A Soniox realtime socket: answers each audio frame with the next scripted final words."""

    def __init__(self, script: Sequence[Step]) -> None:
        self.script = list(script)
        self.responses: asyncio.Queue[str] = asyncio.Queue()
        self.received_ms = 0
        self.answered_ms = 0
        self.closed = False

    async def send(self, message: str | bytes) -> None:
        if isinstance(message, str) and message:
            return  # the configuration message
        if message:
            # The gateway may cut audio into smaller frames: answer per 500 ms of audio.
            self.received_ms += len(message) // 32  # PCM16 mono 16 kHz
            while self.received_ms - self.answered_ms >= 500:
                self.answered_ms += 500
                await self._answer(self.script.pop(0) if self.script else [])
        else:
            await self.responses.put(json.dumps({
                "tokens": [], "final_audio_proc_ms": self.received_ms,
                "total_audio_proc_ms": self.received_ms, "finished": True,
            }))

    async def _answer(self, step: Step) -> None:
        if isinstance(step, str):  # "fail"
            await self.responses.put(json.dumps({"error_code": 401, "error_message": "denied"}))
            return
        tokens = [{"text": text, "start_ms": start, "end_ms": end, "confidence": 0.9, "is_final": True,
                   "language": "en", **({"speaker": speaker} if speaker else {})}
                  for text, start, end, speaker in step]
        await self.responses.put(json.dumps({
            "tokens": tokens, "final_audio_proc_ms": self.answered_ms,
            "total_audio_proc_ms": self.answered_ms,
        }))

    async def recv(self) -> str:
        return await self.responses.get()

    async def close(self) -> None:
        self.closed = True


@dataclass
class AsyncSoniox:
    """The Soniox file API with independent jobs; a job in ``hold`` keeps processing until released."""

    outbound: FakeHttp
    tokens: list[dict[str, Any]] = field(default_factory=lambda: [
        {"text": "Hello", "start_ms": 0, "end_ms": 400, "confidence": 0.9, "speaker": "1", "language": "en"},
        {"text": " there", "start_ms": 400, "end_ms": 900, "confidence": 0.9, "speaker": "1",
         "language": "en"},
        {"text": "Hi", "start_ms": 1_400, "end_ms": 2_000, "confidence": 0.9, "speaker": "2",
         "language": "en"},
    ])
    hold: set[str] = field(default_factory=set)
    hold_all: bool = False
    #: Every job reports a provider error (``audio_decode_failed``).
    failing: bool = False
    jobs: list[str] = field(default_factory=list)
    deleted_jobs: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        route = self.outbound.route
        route("POST", "/v1/files")(self._upload)
        route("POST", "/v1/transcriptions")(self._create)
        route("GET", "/v1/transcriptions/")(self._get)
        route("DELETE", "/v1/files/")(lambda _request: httpx.Response(204))
        route("DELETE", "/v1/transcriptions/")(self._delete_job)

    def _job(self, job_id: str, status: str) -> dict[str, Any]:
        return {"id": job_id, "status": status, "audio_duration_ms": 2_500 if status == "completed" else None,
                "error_type": None, "error_message": None, "model": ASYNC_MODEL,
                "created_at": "2026-01-01T00:00:00Z", "filename": "lecture.m4a",
                "enable_speaker_diarization": True, "enable_language_identification": True}

    def _upload(self, _request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"id": str(uuid.uuid4()), "filename": "lecture.m4a", "size": 4096,
                                         "created_at": "2026-01-01T00:00:00Z"})

    def _create(self, _request: httpx.Request) -> httpx.Response:
        job_id = str(uuid.uuid4())
        self.jobs.append(job_id)
        if self.hold_all:
            self.hold.add(job_id)
        return httpx.Response(201, json=self._job(job_id, "queued"))

    def _get(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/transcript"):
            return self._transcript(request)
        return self._status(request)

    def _status(self, request: httpx.Request) -> httpx.Response:
        job_id = str(request.url).rstrip("/").rsplit("/", 1)[-1]
        if self.failing:
            failed = {**self._job(job_id, "error"), "error_type": "audio_decode_failed",
                      "error_message": "fixture error"}
            return httpx.Response(200, json=failed)
        status = "processing" if job_id in self.hold else "completed"
        return httpx.Response(200, json=self._job(job_id, status))

    def _transcript(self, request: httpx.Request) -> httpx.Response:
        job_id = str(request.url).rsplit("/", 2)[-2]
        return httpx.Response(200, json={"id": job_id, "text": "x", "tokens": self.tokens})

    def _delete_job(self, request: httpx.Request) -> httpx.Response:
        self.deleted_jobs.append(str(request.url).rsplit("/", 1)[-1])
        return httpx.Response(204)
