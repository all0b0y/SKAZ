"""Bounded native live transport; only transcript and transport clocks persist.

The stream is provider-neutral: it opens sessions through a
:class:`~.gateways.live_session.LiveSessionOpener` and reopens the *same* provider
after a retryable failure. It never switches to another provider.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import suppress

from . import native_recovery
from .gateways import LiveAsrError
from .gateways.live_session import LiveAsrSession, LiveSessionOpener
from .live_store import LiveConflict, LiveConnection, LiveStore
from .native_io import disk_call, drain_on_cancel
from .native_recovery import RecoveryBudget, ReplayBuffer

logger = logging.getLogger(__name__)

#: How long Stop waits for a worker that is not streaming (connecting, loading).
CANCEL_WAIT_S = 2.0
SEND_TIMEOUT_S = 2.0


class NativeStream:
    def __init__(
        self, store: LiveStore, connection: LiveConnection, opener: LiveSessionOpener | None, *,
        unavailable_reason: str | None = None, cloud: bool = True, api_key_provider: str | None = None,
    ) -> None:
        self.store = store
        self.connection = connection
        self.state = "connecting" if opener else "unavailable"
        self.complete = False
        self._storage_lock = asyncio.Lock()
        self._opener = opener
        self.provider = opener.provider if opener else None
        #: Consent revocation stops only streams that send audio off this computer.
        self.cloud = cloud
        self.api_key_provider = api_key_provider
        self._label = opener.label if opener else "Transcription"
        self._provider_disabled = False
        self.buffer = ReplayBuffer(connection.sample_rate, connection.start_sample)
        self.recovery = RecoveryBudget()
        self.failure_reason: str | None = None if opener else unavailable_reason
        #: Why the last finish() could not call the recording completely transcribed.
        self.incomplete_reason: str | None = None
        self._wake = asyncio.Event()
        self._overflow = asyncio.Event()
        self._stopping = asyncio.Event()
        self._forced = asyncio.Event()
        self.forced = False
        self._submitted_samples = 0
        self._opened_provider = False
        self._session: LiveAsrSession | None = None
        self._worker = asyncio.create_task(self._run()) if opener else None

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

    async def _activate(self) -> None:
        async with self._storage_lock:
            if self._opened_provider:
                self.connection = await disk_call(self.store.reconnect, self.connection.id)
            self._opened_provider = True
            self._submitted_samples = 0
            self.state = "streaming"
            self.recovery.connected(asyncio.get_running_loop().time())

    async def _receive(self, session: LiveAsrSession) -> None:
        ordinal = 0
        async for event in session.events():
            excess = event.total_audio_proc_ms * self.connection.sample_rate - self._submitted_samples * 1000
            # A provider's final clock may round the last fraction of a millisecond up.
            if excess > 0 and not (event.finished and excess <= self.connection.sample_rate):
                raise LiveConflict("Provider progress exceeds submitted audio.")
            await disk_call(self.store.save_event, self.connection.id, ordinal=ordinal, event=event)
            confirmed = (self.connection.start_sample
                         + event.final_audio_proc_ms * self.connection.sample_rate // 1000)
            self.buffer.confirm(min(confirmed, self.buffer.end))  # rounded-up final millisecond
            ordinal += 1
            if event.finished:
                self.complete = True

    async def _send(self, session: LiveAsrSession) -> None:
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
                # Wait for the provider's own "finished", not a clock; the user can
                # still force the end (force_finish), and a dead link ends by itself.
                await session.finish(timeout_s=None)
                return
            else:
                await self._wake.wait()

    async def _connected(self, session: LiveAsrSession) -> None:
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
                reason = getattr(session, "failure_message", None) or f"{self._label} stream interrupted."
                raise LiveAsrError(reason, retryable=session.failure_retryable)
        finally:
            for task in (sender, receiver, overflow):
                task.cancel()
            await asyncio.gather(sender, receiver, overflow, return_exceptions=True)
            await session.aclose()
            self._session = None

    async def _run(self) -> None:
        opener = self._opener
        assert opener is not None
        try:
            # After Stop, keep (re)connecting while captured audio is still
            # unconfirmed: a provider still connecting or loading its model must
            # transcribe what was recorded, not lose it.
            while not self._stopping.is_set() or self._unconfirmed():
                try:
                    delay = self.recovery.next_delay()
                except TimeoutError:
                    # Keep the last concrete provider reason; it says what to fix.
                    self.failure_reason = self.failure_reason or (
                        f"{self._label} connection failed after three attempts.")
                    return
                initial = self.recovery.attempt == 1 and not self._opened_provider
                self.state = "connecting" if initial else "reconnecting"
                self.complete = False
                try:
                    await asyncio.sleep(delay)
                    async with asyncio.timeout(opener.open_timeout_s or native_recovery.OPEN_TIMEOUT_S):
                        self._session = await opener.open()
                    await drain_on_cancel(self._activate())
                    session = self._session
                    await self._connected(session)
                    if self.complete:
                        return
                    if self._stopping.is_set():
                        # The provider ended without "finished" after Stop.
                        self.failure_reason = (getattr(session, "failure_message", None)
                                               or f"{self._label} ended before confirming the transcript.")
                        if not session.failure_retryable or not self._unconfirmed():
                            return
                except LiveAsrError as error:
                    self.failure_reason = str(error)
                    if not error.retryable:
                        return
                except TimeoutError:
                    self.failure_reason = f"{self._label} connection timed out."
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

    def _unconfirmed(self) -> bool:
        return self.buffer.end > self.buffer.start

    @property
    def pending_ms(self) -> int:
        """Captured audio the provider has not confirmed as final yet."""
        return (self.buffer.end - self.buffer.start) * 1000 // self.connection.sample_rate

    def force_finish(self) -> None:
        """The user chose to stop waiting for the provider's final confirmation."""
        self._forced.set()

    async def disable_provider(self) -> None:
        """Revoke cloud access without closing local storage or replaying audio."""
        self._provider_disabled = True
        self._opener = None
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
        """Finalize: wait until the provider confirms the transcript (or fails).

        There is no clock here. The provider's own status ends the wait:
        ``finished``, a failure, retries exhausted, or a dead connection. The only
        other way out is the user's explicit :meth:`force_finish`.
        """
        self._stopping.set()
        self._wake.set()
        if self._worker is not None:
            forced = asyncio.create_task(self._forced.wait())
            try:
                await asyncio.wait({self._worker, forced}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                forced.cancel()
            if self._worker.done():
                if not self._worker.cancelled():
                    self._worker.result()  # Storage errors must stop capture, not become ASR errors.
            else:
                self.forced = True
                self.complete = False
                self._worker.cancel()
                await self._settle_worker(CANCEL_WAIT_S)
        self.buffer.clear()
        snapshot = await disk_call(self.store.snapshot, self.connection.session_id)
        current = snapshot["connections"][-1]
        finished = self.complete and current["final_sample"] == snapshot["saved_samples"]
        await disk_call(self.store.close, self.connection.id, finished=finished)
        # Complete means the entire saved recording, not just its latest connection.
        earlier_complete = all(c["status"] == "finished" for c in snapshot["connections"][:-1])
        self.incomplete_reason = self._incomplete_reason(
            snapshot, current, finished=finished, earlier_complete=earlier_complete,
        )
        if self.incomplete_reason:
            logger.warning("Live transcription incomplete at stop: %s", self.incomplete_reason)
        return finished and earlier_complete

    def _incomplete_reason(
        self, snapshot: dict[str, object], current: dict[str, object], *, finished: bool,
        earlier_complete: bool,
    ) -> str | None:
        """A sanitized, specific reason, so an incomplete Stop can be diagnosed."""
        if finished and earlier_complete:
            return None
        if snapshot.get("saved_samples") == current.get("start_sample") and earlier_complete:
            return None  # nothing was captured in this stretch
        rate = self.connection.sample_rate
        if not finished:
            if self._worker is None:
                return self.failure_reason or "Transcription was not running for this recording."
            if self.forced:
                return f"finished by you before {self._label} confirmed the rest of the transcript"
            if not self.complete:
                return self.failure_reason or f"{self._label} did not confirm the end of the stream."
            final_ms = int(str(current.get("final_sample", 0))) * 1000 // rate
            saved_ms = int(str(snapshot.get("saved_samples", 0))) * 1000 // rate
            return f"{self._label} confirmed {final_ms} ms of {saved_ms} ms of audio."
        return "An earlier part of this recording (before a pause or reconnect) was not fully transcribed."

    async def _settle_worker(self, timeout: float) -> bool:
        """Wait a bounded time for the provider worker; True when it ended by itself.

        The wait is not a cancellation of this coroutine: a local provider can be
        inside an uninterruptible thread (a model load or a decode), and awaiting a
        cancelled task waits for that thread. Stop must be acknowledged within the
        desktop's budget regardless; a late worker finds its connection closed and
        cannot write to it.
        """
        worker = self._worker
        assert worker is not None
        done, _pending = await asyncio.wait({worker}, timeout=timeout)
        if not done:
            worker.cancel()
            return False
        if not worker.cancelled():
            worker.result()  # Storage errors must stop capture, not become ASR errors.
        return True

    async def abort(self) -> None:
        self._stopping.set()
        try:
            if self._worker is not None:
                self._worker.cancel()
                await self._settle_worker(CANCEL_WAIT_S)
        finally:
            self.buffer.clear()
            await disk_call(self.store.close, self.connection.id, finished=False)
