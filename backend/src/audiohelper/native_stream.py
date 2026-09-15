"""Storage-first native live stream; network tasks never gate audio persistence."""
from __future__ import annotations

import asyncio
from contextlib import suppress

from .gateways.soniox import SonioxConfig, SonioxGateway, SonioxGatewayError, SonioxSession
from .live_store import LiveConflict, LiveConnection, LiveStore
from .native_io import disk_call, drain_on_cancel

RECONNECT_DELAY_S = 1.0
FINISH_TIMEOUT_S = 10.0
SEND_TIMEOUT_S = 2.0


class NativeStream:
    def __init__(self, store: LiveStore, connection: LiveConnection, api_key: str | None) -> None:
        self.store = store
        self.connection = connection
        if connection.recording_mode == "audio_only":
            api_key = None
        self.state = "connecting" if api_key else "unavailable"
        if connection.recording_mode == "audio_only":
            self.state = "disabled"
        self.complete = False
        self._storage_lock = asyncio.Lock()
        self._key = api_key
        self._provider_disabled = False
        # Both packet count and bytes are bounded (at most two seconds of PCM).
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=64)
        self._queued_bytes = 0
        self._stopping = asyncio.Event()
        self._submitted_samples = 0
        self._opened_provider = False
        self._session: SonioxSession | None = None
        self._worker = asyncio.create_task(self._run()) if api_key else None

    def check(self) -> None:
        if self._worker is not None and self._worker.done():
            if self._worker.cancelled() and self._provider_disabled:
                return
            self._worker.result()  # Storage errors must stop capture, not become ASR errors.

    async def wait_failure(self) -> None:
        if self._worker is not None:
            try:
                await asyncio.shield(self._worker)
            except asyncio.CancelledError:
                waiter = asyncio.current_task()
                if not self._provider_disabled or (waiter is not None and waiter.cancelling()):
                    raise
                # Revocation ends cloud work, not the local PCM transport.
                await asyncio.Event().wait()
        else:
            await asyncio.Event().wait()

    def offer(self, pcm: bytes) -> None:
        self.check()
        if self._provider_disabled or self.state != "streaming" or self._stopping.is_set():
            return
        if self._queue.full() or self._queued_bytes + len(pcm) > self.connection.sample_rate * 4:
            # Do not skip a packet within a provider clock. End this connection;
            # the next connection anchors at the then-current saved sample.
            self.state = "unavailable"
            if self._session is not None:
                self._overflow.set()
            return
        self._queue.put_nowait(pcm)
        self._queued_bytes += len(pcm)

    async def append_audio(
        self, *, sequence: int, start_sample: int, pcm: bytes, replay_start_sample: int,
    ) -> bool:
        # Provider rotation cannot sample the clock between this commit and offer.
        async with self._storage_lock:
            self.check()
            added = await disk_call(
                self.store.append_audio, self.connection.id, sequence=sequence,
                start_sample=start_sample, pcm=pcm, replay_start_sample=replay_start_sample,
            )
            if added:
                self.offer(pcm)
            return added

    async def _activate(self, config: SonioxConfig) -> None:
        async with self._storage_lock:
            saved = (await disk_call(self.store.snapshot, self.connection.session_id))["saved_samples"]
            if self._opened_provider or saved != self.connection.start_sample:
                await disk_call(self.store.close, self.connection.id, finished=False)
                self.connection = await disk_call(
                    self.store.open, self.connection.session_id,
                    sample_rate=config.sample_rate, model=config.model,
                )
            self._opened_provider = True
            self._submitted_samples = 0
            self._overflow = asyncio.Event()
            self.state = "streaming"

    async def _receive(self, session: SonioxSession) -> None:
        ordinal = 0
        async for event in session.events():
            if event.total_audio_proc_ms * self.connection.sample_rate > self._submitted_samples * 1000:
                raise LiveConflict("Provider progress exceeds submitted audio.")
            await disk_call(self.store.save_event, self.connection.id, ordinal=ordinal, event=event)
            ordinal += 1
            if event.finished:
                self.complete = True

    async def _send(self, session: SonioxSession) -> None:
        while True:
            pcm = await self._queue.get()
            if pcm is None:
                await session.finish()
                return
            self._queued_bytes -= len(pcm)
            self._submitted_samples += len(pcm) // 2
            async with asyncio.timeout(SEND_TIMEOUT_S):
                await session.send_audio(pcm)

    async def _connected(self, session: SonioxSession) -> None:
        receiver = asyncio.create_task(self._receive(session))
        sender = asyncio.create_task(self._send(session))
        overflow = asyncio.create_task(self._overflow.wait())
        try:
            done, _ = await asyncio.wait((receiver, sender, overflow), return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            if sender in done and self._stopping.is_set():
                await receiver
        finally:
            for task in (sender, receiver, overflow):
                task.cancel()
            await asyncio.gather(sender, receiver, overflow, return_exceptions=True)
            await session.aclose()
            self._session = None

    async def _run(self) -> None:
        assert self._key is not None
        config = SonioxConfig(
            sample_rate=self.connection.sample_rate, event_queue_size=8,
            used_languages=self.connection.used_languages,
            translation_target_language=(self.connection.translation_target_language
                                         if self.connection.recording_mode == "translation" else None),
        )
        while not self._stopping.is_set():
            self.complete = False
            try:
                self.state = "connecting"
                async with asyncio.timeout(10):
                    session = await SonioxGateway(api_key=self._key, config=config).open()
                self._session = session
                await drain_on_cancel(self._activate(config))
                await self._connected(session)
            except (SonioxGatewayError, TimeoutError, LiveConflict):
                self.complete = False
            finally:
                self.state = "unavailable"
                if self._session is not None:
                    await self._session.aclose()
                    self._session = None
                while not self._queue.empty():
                    self._queue.get_nowait()
                self._queued_bytes = 0
            if not self._stopping.is_set():
                # Even a remote finished:true is not the end of local capture.
                self.complete = False
                with suppress(TimeoutError):
                    async with asyncio.timeout(RECONNECT_DELAY_S):
                        await self._stopping.wait()

    async def disable_provider(self) -> None:
        """Revoke cloud access without closing local storage or replaying audio."""
        if self.connection.recording_mode == "audio_only":
            return
        self._provider_disabled = True
        self._key = None
        self.state = "unavailable"
        self.complete = False
        if self._worker is not None:
            self._worker.cancel()
            with suppress(asyncio.CancelledError):
                await self._worker
        self.state = "unavailable"
        self.complete = False

    async def finish(self) -> bool:
        self._stopping.set()
        if self._worker is not None:
            try:
                async with asyncio.timeout(FINISH_TIMEOUT_S):
                    if self.state == "streaming":
                        await self._queue.put(None)
                    else:
                        self._worker.cancel()
                    with suppress(asyncio.CancelledError):
                        await self._worker
            except TimeoutError:
                self.complete = False
        snapshot = await disk_call(self.store.snapshot, self.connection.session_id)
        current = snapshot["connections"][-1]
        finished = self.complete and current["final_sample"] == snapshot["saved_samples"]
        await disk_call(self.store.close, self.connection.id, finished=finished)
        # Complete means the entire saved recording, not just its latest connection.
        return finished and all(c["status"] == "finished" for c in snapshot["connections"][:-1])

    async def abort(self) -> None:
        self._stopping.set()
        try:
            if self._worker is not None:
                self._worker.cancel()
                with suppress(asyncio.CancelledError):
                    await self._worker
        finally:
            await disk_call(self.store.close, self.connection.id, finished=False)
