"""Smoke-test fixture: replace the Soniox WebSocket connector in the backend.

Loaded only when a smoke spec puts this directory on PYTHONPATH AND sets
SKAZ_SMOKE_FAKE_SONIOX. It exists so desktop smokes can run with a stored
Soniox key and cloud consent (which the recorder requires) without any network
call or paid request.

This is NOT a check of real speech recognition. ``words`` answers every audio
frame with the fixed word "fixture", timed to the audio it received; nothing is
ever listened to. It only lets the recording lifecycle (live text, quit,
restart, continue, retry) run end to end on the real backend.

Modes (value of SKAZ_SMOKE_FAKE_SONIOX):
  accept  — the connection opens, audio is swallowed, the end-of-stream marker
            is answered with an empty ``finished`` response.
  words   — like ``accept``, and each binary audio frame is answered with one
            final token "fixture" covering exactly that frame's samples; an
            all-zero (silent) frame is answered with no token, so a pause ends a
            monologue the way it does in speech.
  refuse  — every connection attempt fails, as an unreachable provider would.
  control — read one of the modes above from the file named by
            SKAZ_SMOKE_FAKE_SONIOX_CONTROL at every connection attempt, so a
            spec can make the provider fail and then recover mid-run.
"""

import asyncio
import json
import os
from pathlib import Path

_MODE = os.environ.get("SKAZ_SMOKE_FAKE_SONIOX", "").strip().lower()
_CONTROL = os.environ.get("SKAZ_SMOKE_FAKE_SONIOX_CONTROL", "")
_WORD = " fixture"


class _AcceptingTransport:
    def __init__(self, *, words: bool) -> None:
        self._replies: asyncio.Queue[str] = asyncio.Queue()
        self._closed = asyncio.Event()
        self._words = words
        self._sample_rate = 16000
        self._samples = 0

    def _ms(self) -> int:
        return self._samples * 1000 // self._sample_rate

    async def send(self, message: str | bytes) -> None:
        if self._closed.is_set():
            raise ConnectionError("fixture socket closed")
        if isinstance(message, bytes):
            start = self._ms()
            self._samples += len(message) // 2
            end = self._ms()
            if self._words and end > start:
                # A silent frame (all-zero PCM) gets no word, so pauses end monologues as in speech.
                voiced = any(message)
                self._replies.put_nowait(json.dumps({
                    "tokens": [{"text": _WORD, "start_ms": start, "end_ms": end, "confidence": 0.99,
                                "is_final": True, "language": "en"}] if voiced else [],
                    "final_audio_proc_ms": end, "total_audio_proc_ms": end,
                }))
            return
        if message == "":
            done = self._ms()
            self._replies.put_nowait(json.dumps({
                "tokens": [], "final_audio_proc_ms": done, "total_audio_proc_ms": done, "finished": True,
            }))
            return
        # The session configuration: only its sample rate matters to the fixture.
        try:
            rate = json.loads(message).get("sample_rate")
        except (ValueError, AttributeError):
            rate = None
        if isinstance(rate, int) and rate > 0:
            self._sample_rate = rate

    async def recv(self) -> str | bytes:
        reply = asyncio.ensure_future(self._replies.get())
        closed = asyncio.ensure_future(self._closed.wait())
        done, pending = await asyncio.wait({reply, closed}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        if reply in done:
            return reply.result()
        raise ConnectionError("fixture socket closed")

    async def close(self) -> None:
        self._closed.set()


def _current_mode() -> str:
    if _MODE != "control":
        return _MODE
    try:
        return Path(_CONTROL).read_text(encoding="utf-8").strip().lower()
    except OSError:
        return "refuse"


async def _connector(url: str) -> _AcceptingTransport:
    mode = _current_mode()
    if mode == "accept":
        return _AcceptingTransport(words=False)
    if mode == "words":
        return _AcceptingTransport(words=True)
    raise ConnectionError("fixture: Soniox unreachable")


if _MODE in {"accept", "words", "refuse", "control"}:
    from skaz.gateways import soniox as _soniox

    _defaults = dict(_soniox.SonioxGateway.__init__.__kwdefaults__ or {})
    _defaults["connector"] = _connector
    _soniox.SonioxGateway.__init__.__kwdefaults__ = _defaults
