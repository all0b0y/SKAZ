"""Smoke-test fixture: replace the Soniox WebSocket connector in the backend.

Loaded only when a smoke spec puts this directory on PYTHONPATH AND sets
SKAZ_SMOKE_FAKE_SONIOX. It exists so UI smokes can run with a stored
Soniox key and cloud consent (which the recorder now requires) without any
network call or paid request.

This is NOT a check of real speech recognition. It never produces a single
token: it only answers the stream protocol so the recording lifecycle can run.

Modes (value of SKAZ_SMOKE_FAKE_SONIOX):
  accept — the connection opens, audio is swallowed, the end-of-stream marker
           is answered with an empty ``finished`` response.
  refuse — every connection attempt fails, as an unreachable provider would.
"""

import asyncio
import json
import os

_MODE = os.environ.get("SKAZ_SMOKE_FAKE_SONIOX", "").strip().lower()


class _AcceptingTransport:
    def __init__(self) -> None:
        self._replies: asyncio.Queue[str] = asyncio.Queue()
        self._closed = asyncio.Event()

    async def send(self, message: str | bytes) -> None:
        if self._closed.is_set():
            raise ConnectionError("fixture socket closed")
        if message == b"":
            self._replies.put_nowait(json.dumps({
                "tokens": [], "final_audio_proc_ms": 0, "total_audio_proc_ms": 0, "finished": True,
            }))

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


async def _accepting_connector(url: str) -> _AcceptingTransport:
    return _AcceptingTransport()


async def _refusing_connector(url: str) -> _AcceptingTransport:
    raise ConnectionError("fixture: Soniox unreachable")


if _MODE in {"accept", "refuse"}:
    from skaz.gateways import soniox as _soniox

    _defaults = dict(_soniox.SonioxGateway.__init__.__kwdefaults__ or {})
    _defaults["connector"] = _accepting_connector if _MODE == "accept" else _refusing_connector
    _soniox.SonioxGateway.__init__.__kwdefaults__ = _defaults
