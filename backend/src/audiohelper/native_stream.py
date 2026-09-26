"""Bounded native live transport; only transcript and transport clocks persist."""
from __future__ import annotations

import asyncio
from contextlib import suppress

from . import native_recovery
from .gateways.soniox import SonioxConfig, SonioxGateway, SonioxGatewayError, SonioxSession
from .live_store import LiveConflict, LiveConnection, LiveStore
from .native_io import disk_call, drain_on_cancel
from .native_recovery import RecoveryBudget, ReplayBuffer

FINISH_TIMEOUT_S = 10.0
SEND_TIMEOUT_S = 2.0


class NativeStream:
    def __init__(self, store: LiveStore, connection: LiveConnection, api_key: str | None) -> None:
        self.store = store
        self.connection = connection
        self.state = "connecting" if api_key else "unavailable"
        self.complete = False
        self._storage_lock = asyncio.Lock()
        self._key = api_key
        self._provider_disabled = False
        self.buffer = ReplayBuffer(connection.sample_rate, connection.start_sample)
        self.recovery = RecoveryBudget()
        self.failure_reason: str | None = None
        self._wake = asyncio.Event()
        self._overflow = asyncio.Event()
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
                # Notify the client to stop capture; keep transport open for its tail.
                return
        else:
            await asyncio.Event().wait()

    def offer(self, pcm: bytes) -> None:
        self.check()
        if self._provider_disabled or self.state == "unavailable" or self._stopping.is_set():
            return
        try:
            self.buffer.append(pcm)
            self._wake.set()
        except BufferError as error:
            self.failure_reason = str(error)
            self._overflow.set()
            if self._worker is not None:
                self._worker.cancel()

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
            if self._opened_provider:
                self.connection = await disk_call(self.store.reconnect, self.connection.id)
            self._opened_provider = True
            self._submitted_samples = 0
            self.state = "streaming"
            self.recovery.connected(asyncio.get_running_loop().time())

    async def _receive(self, session: SonioxSession) -> None:
        ordinal = 0
        async for event in session.events():
            if event.total_audio_proc_ms * self.connection.sample_rate > self._submitted_samples * 1000:
                raise LiveConflict("Provider progress exceeds submitted audio.")
            await disk_call(self.store.save_event, self.connection.id, ordinal=ordinal, event=event)
            self.buffer.confirm(self.connection.start_sample
                                + event.final_audio_proc_ms * self.connection.sample_rate // 1000)
            ordinal += 1
            if event.finished:
                self.complete = True

    async def _send(self, session: SonioxSession) -> None:
        cursor = self.buffer.start
        while True:
            self._wake.clear()
            pcm = self.buffer.read(cursor, self.connection.sample_rate * 2 // 2)
            if pcm:
                cursor += len(pcm) // 2
                self._submitted_samples += len(pcm) // 2
                async with asyncio.timeout(SEND_TIMEOUT_S):
                    await session.send_audio(pcm)
            elif self._stopping.is_set():
                await session.finish()
                return
            else:
                await self._wake.wait()

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
            if not self._stopping.is_set() and not self.complete:
                raise SonioxGatewayError("Soniox stream interrupted.", retryable=session.failure_retryable)
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
        try:
            while not self._stopping.is_set():
                try:
                    delay = self.recovery.next_delay()
                except TimeoutError as error:
                    self.failure_reason = str(error)
                    return
                initial = self.recovery.attempt == 1 and not self._opened_provider
                self.state = "connecting" if initial else "reconnecting"
                self.complete = False
                try:
                    await asyncio.sleep(delay)
                    async with asyncio.timeout(native_recovery.OPEN_TIMEOUT_S):
                        self._session = await SonioxGateway(api_key=self._key, config=config).open()
                    await drain_on_cancel(self._activate(config))
                    await self._connected(self._session)
                    if self.complete or self._stopping.is_set():
                        return
                except SonioxGatewayError as error:
                    self.failure_reason = str(error)
                    if not error.retryable:
                        return
                except TimeoutError:
                    self.failure_reason = "Soniox connection timed out."
                except LiveConflict:
                    self.failure_reason = "Transcription timing could not be verified."
                    return
                finally:
                    self.recovery.disconnected(asyncio.get_running_loop().time())
                    if self._session is not None:
                        await self._session.aclose()
                        self._session = None
        except asyncio.CancelledError:
            if not self._overflow.is_set():
                raise
        finally:
            self.buffer.clear()
            self.state = "unavailable"

    async def disable_provider(self) -> None:
        """Revoke cloud access without closing local storage or replaying audio."""
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
        self.buffer.clear()

    async def finish(self) -> bool:
        self._stopping.set()
        if self._worker is not None:
            try:
                async with asyncio.timeout(FINISH_TIMEOUT_S):
                    if self.state == "streaming":
                        self._wake.set()
                    else:
                        self._worker.cancel()
                    with suppress(asyncio.CancelledError):
                        await self._worker
            except TimeoutError:
                self.complete = False
        self.buffer.clear()
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
            self.buffer.clear()
            await disk_call(self.store.close, self.connection.id, finished=False)
