"""Explicit, bounded scheduler for contextual local live-ASR updates."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from itertools import pairwise
from typing import TYPE_CHECKING, Literal

from . import repository as repo
from .gateways import ProviderError, ProviderNotConfigured
from .live_asr import (
    LiveDraftBusy,
    LiveDraftConflict,
    LiveDraftMissing,
    LiveDraftTooLarge,
    LiveTailFinalizationError,
)
from .schemas import (
    LiveAsrAdvanceResponse,
    LiveAsrProcessedWindow,
    LiveAsrSchedulerBlockReason,
    LiveAsrSchedulerState,
    LiveAsrSchedulerStatus,
)
from .window_asr import (
    PreviewBusy,
    PreviewDecodeFailed,
    PreviewSourceConflict,
    PreviewSourceMissing,
    PreviewStale,
    PreviewTooLarge,
)

if TYPE_CHECKING:  # pragma: no cover
    from .runtime import Runtime

logger = logging.getLogger(__name__)
_MAX_ACCEPTED_COUNT = 2**31 - 1


class LiveSchedulerUnavailable(Exception):
    """The explicit local finality+gate capability is not currently available."""


class LiveSchedulerBusy(Exception):
    """A different session owns the one process-wide scheduler admission."""


class LiveSchedulerConflict(Exception):
    """The admitted job's frozen ASR configuration is no longer current."""


@dataclass(frozen=True)
class _FrozenConfig:
    provider: str
    model: str
    language: str
    speech_gate_enabled: bool
    finality_enabled: bool
    finality_guard_ms: int
    settings_revision: int


@dataclass(frozen=True)
class _Selection:
    first_sequence: int
    last_sequence: int
    start_ms: int
    end_ms: int
    reason: Literal["initial", "extend", "rollover", "retry"]
    earlier_anchor: int | None = None


@dataclass(frozen=True)
class _Plan:
    selection: _Selection | None
    block_reason: LiveAsrSchedulerBlockReason | None = None
    complete: bool = False


@dataclass(frozen=True)
class _DurableStatus:
    target_sequence: int | None
    target_end_ms: int | None
    processed: LiveAsrProcessedWindow | None
    stable_frontier_ms: int
    source_ended: bool
    available_audio_processed: bool
    incomplete: bool
    state: LiveAsrSchedulerState
    block_reason: LiveAsrSchedulerBlockReason | None
    recovery_required: bool
    source_continuity_verified: bool


class LiveAsrScheduler:
    """One admitted session with one running update and one coalesced target."""

    def __init__(self, runtime: Runtime) -> None:
        self._runtime = runtime
        self._lock = asyncio.Lock()
        self._session_id: str | None = None
        self._frozen: _FrozenConfig | None = None
        self._task: asyncio.Task[None] | None = None
        self._accepted_count = 0
        self._state: LiveAsrSchedulerState = "idle"
        self._target_sequence: int | None = None
        self._target_end_ms: int | None = None
        self._processed: LiveAsrProcessedWindow | None = None
        self._stable_frontier_ms = 0
        self._block_reason: LiveAsrSchedulerBlockReason | None = None
        self._attempted_windows: set[tuple[int, int]] = set()
        self._final_pass_attempted: set[tuple[str, int]] = set()

    def capable(self) -> bool:
        settings, _revision = self._runtime.settings_store.load_asr_snapshot()
        return bool(
            settings.profile("asr").provider == "local-whisper"
            and self._runtime.live_finality_enabled
            and self._runtime.local_speech_gate
        )

    def status(self, session_id: str) -> LiveAsrSchedulerStatus:
        durable = self._durable_status(session_id)
        visible = self._session_id == session_id
        target = durable.target_sequence
        target_end = durable.target_end_ms
        processed = self._processed if visible and self._processed is not None else durable.processed
        frontier = self._stable_frontier_ms if visible else durable.stable_frontier_ms
        state = self._state if visible else durable.state
        block_reason = self._block_reason if visible else durable.block_reason
        recovery_required = (
            state in {"stalled", "stopped"} and block_reason not in {None, "cancelled"}
        ) if visible else durable.recovery_required
        available_audio_processed = bool(
            target is not None and processed is not None and processed.last_sequence >= target
        )
        if durable.source_ended and durable.incomplete and state == "complete":
            state = "stalled"
            block_reason = "finality_blocked"
            recovery_required = True
        return LiveAsrSchedulerStatus(
            capable=self.capable(),
            accepted_count=self._accepted_count if visible else 0,
            status=state,
            captured_target_sequence=target,
            processed_window=processed,
            stable_frontier_ms=frontier,
            lag_ms=max(0, target_end - frontier) if target_end is not None else None,
            block_reason=block_reason,
            source_ended=durable.source_ended,
            recovery_required=recovery_required,
            available_audio_processed=available_audio_processed,
            source_continuity_verified=durable.source_continuity_verified,
        )

    def source_ended(self, session_id: str) -> None:
        """Schedule one bounded EOF pass after the durable stopped-session ACK."""
        if self._session_id == session_id and self._task is not None and not self._task.done():
            return
        durable = self._durable_status(session_id)
        if not durable.incomplete:
            return
        draft = repo.get_live_asr_draft(self._runtime.db, session_id)
        if draft is None or (session_id, draft.revision) in self._final_pass_attempted:
            self._stall("finality_blocked")
            return
        try:
            frozen = self._freeze()
        except LiveSchedulerUnavailable:
            self._stall("config_changed")
            return
        self._session_id = session_id
        self._frozen = frozen
        self._target_sequence = durable.target_sequence
        self._target_end_ms = durable.target_end_ms
        self._processed = durable.processed
        self._state = "scheduled"
        self._block_reason = None
        self._task = asyncio.create_task(self._run_source_ended(session_id, frozen))

    async def advance(self, session_id: str, through_sequence: int) -> LiveAsrAdvanceResponse:
        frozen = self._freeze()
        async with self._lock:
            if (
                self._session_id is not None
                and self._task is not None
                and not self._task.done()
                and self._session_id != session_id
            ):
                raise LiveSchedulerBusy("Another session has an admitted live ASR scheduler job.")
            # Authenticate persisted source before admission or same-session coalescing.
            endpoint = self._runtime.window_asr.inspect(
                session_id, through_sequence, through_sequence
            )
            session = repo.get_session(self._runtime.db, session_id)
            draft = repo.get_live_asr_draft(self._runtime.db, session_id)
            if session is not None and session.status == "stopped" and draft is not None:
                # Only this explicit API action re-arms a failed EOF pass.
                self._final_pass_attempted.discard((session_id, draft.revision))
            target_end = endpoint.records[-1].end_ms
            if self._session_id is not None and self._task is not None and not self._task.done():
                if self._frozen != frozen:
                    self._state = "stopped"
                    self._block_reason = "config_changed"
                    self._task.cancel()
                    raise LiveSchedulerConflict("The admitted ASR configuration changed.")
                if self._target_sequence is None or through_sequence > self._target_sequence:
                    self._target_sequence = through_sequence
                    self._target_end_ms = target_end
                self._accepted_count = min(_MAX_ACCEPTED_COUNT, self._accepted_count + 1)
                return LiveAsrAdvanceResponse(scheduler=self.status(session_id))

            self._session_id = session_id
            self._frozen = frozen
            self._accepted_count = 1
            self._state = "scheduled"
            self._target_sequence = through_sequence
            self._target_end_ms = target_end
            self._processed = None
            self._stable_frontier_ms = self._durable_frontier(session_id)
            self._block_reason = None
            self._attempted_windows.clear()
            self._task = asyncio.create_task(self._run(session_id, frozen))
            return LiveAsrAdvanceResponse(scheduler=self.status(session_id))

    def close(self) -> asyncio.Task[None] | None:
        """Request cancellation without pretending a non-cancellable decoder already exited."""
        task = self._task
        if task is not None and not task.done():
            self._state = "stopped"
            self._block_reason = "cancelled"
            task.cancel()
            return task
        return None

    def _freeze(self) -> _FrozenConfig:
        settings, revision = self._runtime.settings_store.load_asr_snapshot()
        profile = settings.profile("asr")
        if (
            profile.provider != "local-whisper"
            or not self._runtime.live_finality_enabled
            or not self._runtime.local_speech_gate
        ):
            raise LiveSchedulerUnavailable(
                "Live scheduling requires the selected local-whisper profile, finality, and speech gate."
            )
        return _FrozenConfig(
            provider=profile.provider,
            model=profile.model,
            language=settings.transcript_language,
            speech_gate_enabled=self._runtime.local_speech_gate,
            finality_enabled=self._runtime.live_finality_enabled,
            finality_guard_ms=self._runtime.config.live_finality_guard_ms,
            settings_revision=revision,
        )

    def _is_current(self, frozen: _FrozenConfig) -> bool:
        try:
            return self._freeze() == frozen
        except LiveSchedulerUnavailable:
            return False

    async def _run(self, session_id: str, frozen: _FrozenConfig) -> None:
        try:
            while True:
                if repo.get_session(self._runtime.db, session_id) is None:
                    self._stop("session_missing")
                    return
                if not self._is_current(frozen):
                    self._stop("config_changed")
                    return
                target = self._target_sequence
                if target is None:  # pragma: no cover - admission always supplies one
                    self._stop("source_missing")
                    return
                try:
                    plan = self._plan(session_id, target)
                except PreviewSourceMissing:
                    self._stall("source_missing")
                    return
                except PreviewSourceConflict:
                    self._stall("source_conflict")
                    return
                except PreviewTooLarge:
                    self._stall("source_limit")
                    return
                except ProviderNotConfigured:
                    self._stop("config_changed" if not self._is_current(frozen) else "decoder_failed")
                    return
                if plan.block_reason is not None:
                    self._stall(plan.block_reason)
                    return
                if plan.complete:
                    await self._finish(session_id, frozen)
                    return
                selection = plan.selection
                assert selection is not None
                outcome = await self._execute(session_id, frozen, selection)
                if outcome == "retry_rollover" and selection.earlier_anchor is not None:
                    try:
                        retry = self._selection(
                            session_id,
                            selection.earlier_anchor,
                            selection.last_sequence,
                            "rollover",
                        )
                    except PreviewSourceMissing:
                        outcome = "source_missing"
                    except PreviewSourceConflict:
                        outcome = "source_conflict"
                    except PreviewTooLarge:
                        outcome = "source_limit"
                    else:
                        outcome = await self._execute(session_id, frozen, retry)
                if outcome is not None:
                    self._stall("no_safe_anchor" if outcome == "retry_rollover" else outcome)
                    return
                if (
                    self._target_sequence is not None
                    and selection.last_sequence >= self._target_sequence
                ):
                    await self._finish(session_id, frozen)
                    return
        except asyncio.CancelledError:
            self._state = "stopped"
            self._block_reason = "cancelled"
            raise
        except Exception:
            logger.error("live_asr_scheduler_unexpected_failure session_id=%s", session_id)
            self._stall("decoder_failed")
        finally:
            async with self._lock:
                if self._session_id == session_id and self._task is asyncio.current_task():
                    self._frozen = None
                    self._task = None

    async def _execute(
        self, session_id: str, frozen: _FrozenConfig, selection: _Selection
    ) -> LiveAsrSchedulerBlockReason | Literal["retry_rollover"] | None:
        key = (selection.first_sequence, selection.last_sequence)
        if key in self._attempted_windows:
            return "awaiting_source_extension"
        self._attempted_windows.add(key)
        logger.info(
            "live_asr_scheduler_decision first_sequence=%d last_sequence=%d start_ms=%d end_ms=%d reason=%s",
            selection.first_sequence,
            selection.last_sequence,
            selection.start_ms,
            selection.end_ms,
            selection.reason,
        )
        current = repo.get_live_asr_draft(self._runtime.db, session_id)
        expected_revision = current.revision if current is not None else 0
        self._state = "running"
        self._block_reason = None
        try:
            response = await self._runtime.live_asr.update(
                session_id,
                selection.first_sequence,
                selection.last_sequence,
                expected_revision,
            )
        except PreviewSourceMissing:
            return "source_missing"
        except (PreviewSourceConflict, PreviewStale):
            return "source_conflict"
        except (PreviewTooLarge, LiveDraftTooLarge):
            return "source_limit"
        except PreviewBusy:
            return "decoder_busy"
        except LiveDraftBusy:
            return "live_update_busy"
        except LiveDraftMissing:
            return "session_missing"
        except LiveDraftConflict:
            return "config_changed" if not self._is_current(frozen) else "finality_blocked"
        except ProviderNotConfigured:
            return "config_changed" if not self._is_current(frozen) else "decoder_failed"
        except (ProviderError, PreviewDecodeFailed):
            return "decoder_failed"

        if repo.get_session(self._runtime.db, session_id) is None:
            return "session_missing"
        if not self._is_current(frozen):
            return "config_changed"
        self._processed = LiveAsrProcessedWindow(
            first_sequence=selection.first_sequence,
            last_sequence=selection.last_sequence,
            start_ms=selection.start_ms,
            end_ms=selection.end_ms,
        )
        self._stable_frontier_ms = self._durable_frontier(session_id)
        finality = response.draft.finality if response.draft is not None else None
        if finality is not None:
            self._stable_frontier_ms = finality.stable_frontier_ms
            if (
                selection.reason == "rollover"
                and finality.status == "blocked"
                and finality.blocked_reason
                in {"rollover_overlap_unverified", "rollover_word_boundary_ambiguous"}
            ):
                return "retry_rollover"
            if finality.status == "blocked":
                return "finality_blocked"
        return None

    def _plan(self, session_id: str, target: int) -> _Plan:
        draft = repo.get_live_asr_draft(self._runtime.db, session_id)
        if draft is not None and target <= draft.last_sequence:
            if not self._runtime.live_asr.is_current_config(draft):
                return _Plan(
                    selection=self._selection(
                        session_id, draft.first_sequence, draft.last_sequence, "retry"
                    )
                )
            session = repo.get_session(self._runtime.db, session_id)
            if session is not None and session.status == "stopped" and self._draft_has_text(draft):
                return _Plan(selection=None, complete=True)
            return _Plan(selection=None, complete=True)
        query_anchor = draft.first_sequence if draft is not None else 0
        records = repo.chunks_in_sequence_range(
            self._runtime.db,
            session_id,
            query_anchor,
            target,
            limit=self._runtime.config.max_preview_chunks + 1,
        )
        anchor = draft.first_sequence if draft is not None else records[0].sequence if records else 0
        if not records or records[0].sequence != anchor:
            return _Plan(selection=None, block_reason="source_missing")
        for previous, current in pairwise(records):
            if current.sequence != previous.sequence + 1 or current.start_ms != previous.end_ms:
                return _Plan(selection=None, block_reason="source_missing")

        maximum_chunks = self._runtime.config.max_preview_chunks
        fitting: list[repo.ChunkRecord] = []
        for record in records[:maximum_chunks]:
            if record.end_ms - records[0].start_ms > self._runtime.config.max_chunk_seconds * 1000:
                break
            fitting.append(record)
        if not fitting:
            return _Plan(selection=None, block_reason="source_limit")

        current_last = draft.last_sequence if draft is not None else None
        chosen = fitting[-1]
        cap_ms = self._runtime.config.max_chunk_seconds * 1000
        if (
            draft is None
            and len(fitting) > 1
            and (chosen.sequence < target or chosen.end_ms - records[0].start_ms >= cap_ms)
        ):
            # The first evidence window must leave one bounded right extension for agreement.
            chosen = fitting[-2]
        if current_last is None or chosen.sequence > current_last:
            return _Plan(
                selection=self._selection(
                    session_id,
                    anchor,
                    chosen.sequence,
                    "initial" if draft is None else "extend",
                )
            )

        state = repo.get_live_asr_finality(self._runtime.db, session_id)
        if state is None or state.stable_frontier_ms <= records[0].start_ms:
            return _Plan(selection=None, block_reason="no_safe_anchor")
        overlap = max(self._runtime.config.live_finality_guard_ms, 1)
        next_record = records[current_last - anchor + 1]
        candidates = [
            record
            for record in records[1:]
            if record.sequence <= current_last
            and record.start_ms < state.stable_frontier_ms
            and record.start_ms <= state.stable_frontier_ms - overlap
            and next_record.end_ms - record.start_ms
            <= self._runtime.config.max_chunk_seconds * 1000
        ]
        if not candidates:
            return _Plan(selection=None, block_reason="no_safe_anchor")
        selected = candidates[-1]
        earlier = candidates[-2].sequence if len(candidates) > 1 else None
        return _Plan(
            selection=self._selection(
                session_id,
                selected.sequence,
                current_last,
                "rollover",
                earlier_anchor=earlier,
            )
        )

    def _selection(
        self,
        session_id: str,
        first: int,
        last: int,
        reason: Literal["initial", "extend", "rollover", "retry"],
        *,
        earlier_anchor: int | None = None,
    ) -> _Selection:
        prepared = self._runtime.window_asr.inspect(session_id, first, last)
        return _Selection(
            first_sequence=first,
            last_sequence=last,
            start_ms=prepared.records[0].start_ms,
            end_ms=prepared.records[-1].end_ms,
            reason=reason,
            earlier_anchor=earlier_anchor,
        )

    def _durable_frontier(self, session_id: str) -> int:
        state = repo.get_live_asr_finality(self._runtime.db, session_id)
        return state.stable_frontier_ms if state is not None else 0

    @staticmethod
    def _draft_has_text(draft: repo.LiveAsrDraftRecord) -> bool:
        try:
            return bool(draft.snapshot_json and json.loads(draft.snapshot_json)["text"].strip())
        except (KeyError, TypeError, ValueError):
            return True

    def _durable_status(self, session_id: str) -> _DurableStatus:
        session = repo.get_session(self._runtime.db, session_id)
        bounds = repo.chunk_bounds(self._runtime.db, session_id)
        frontier = self._durable_frontier(session_id)
        source_ended = session is not None and session.status == "stopped"
        if bounds is None:
            return _DurableStatus(
                target_sequence=None,
                target_end_ms=None,
                processed=None,
                stable_frontier_ms=frontier,
                source_ended=source_ended,
                available_audio_processed=False,
                incomplete=False,
                state="idle",
                block_reason=None,
                recovery_required=False,
                source_continuity_verified=True,
            )
        first, last = bounds
        if not self.capable() and (session is None or session.mode != "contextual_local"):
            return _DurableStatus(
                target_sequence=last.sequence,
                target_end_ms=last.end_ms,
                processed=None,
                stable_frontier_ms=frontier,
                source_ended=source_ended,
                available_audio_processed=False,
                incomplete=True,
                state="idle",
                block_reason=None,
                recovery_required=False,
                source_continuity_verified=True,
            )
        draft = repo.get_live_asr_draft(self._runtime.db, session_id)
        processed: LiveAsrProcessedWindow | None = None
        draft_text = False
        if draft is not None:
            try:
                snapshot = json.loads(draft.snapshot_json)
                processed = LiveAsrProcessedWindow(
                    first_sequence=draft.first_sequence,
                    last_sequence=draft.last_sequence,
                    start_ms=int(snapshot["window"]["start_ms"]),
                    end_ms=int(snapshot["window"]["end_ms"]),
                )
                draft_text = bool(str(snapshot["text"]).strip())
            except (KeyError, TypeError, ValueError):
                draft_text = True
        available_audio_processed = bool(
            processed is not None and processed.last_sequence >= last.sequence
        )
        incomplete = not available_audio_processed or draft_text
        records = repo.chunks_in_sequence_range(
            self._runtime.db,
            session_id,
            first.sequence,
            last.sequence,
            limit=self._runtime.config.max_preview_chunks + 1,
        )
        source_gap = any(
            current.sequence != previous.sequence + 1 or current.start_ms != previous.end_ms
            for previous, current in pairwise(records)
        )
        source_continuity_verified = (
            len(records) <= self._runtime.config.max_preview_chunks
            and bool(records)
            and records[0].sequence == first.sequence
            and records[-1].sequence == last.sequence
            and not source_gap
        )
        if source_gap:
            state: LiveAsrSchedulerState = "stalled"
            reason: LiveAsrSchedulerBlockReason | None = "source_missing"
            recovery_required = True
        elif source_ended and incomplete:
            state = "stalled"
            reason = "finality_blocked"
            recovery_required = True
        elif (
            incomplete
            and draft is not None
            and not self._runtime.live_asr.is_current_config(draft)
        ):
            state = "stopped"
            reason = "config_changed"
            recovery_required = True
        elif incomplete:
            state = "stalled"
            reason = "decoder_failed"
            recovery_required = True
        else:
            state = "complete"
            reason = None
            recovery_required = False
        return _DurableStatus(
            target_sequence=last.sequence,
            target_end_ms=last.end_ms,
            processed=processed,
            stable_frontier_ms=frontier,
            source_ended=source_ended,
            available_audio_processed=available_audio_processed,
            incomplete=incomplete,
            state=state,
            block_reason=reason,
            recovery_required=recovery_required,
            source_continuity_verified=source_continuity_verified,
        )

    async def _finish(self, session_id: str, frozen: _FrozenConfig) -> None:
        durable = self._durable_status(session_id)
        if durable.source_ended and durable.incomplete:
            await self._finalize_source_ended(session_id, frozen)
            return
        self._state = "complete"
        self._block_reason = None

    async def _run_source_ended(self, session_id: str, frozen: _FrozenConfig) -> None:
        try:
            await self._finalize_source_ended(session_id, frozen)
        finally:
            async with self._lock:
                if self._session_id == session_id and self._task is asyncio.current_task():
                    self._frozen = None
                    self._task = None

    async def _finalize_source_ended(self, session_id: str, frozen: _FrozenConfig) -> None:
        draft = repo.get_live_asr_draft(self._runtime.db, session_id)
        if draft is None:
            self._stall("finality_blocked")
            return
        key = (session_id, draft.revision)
        if key in self._final_pass_attempted:
            self._stall("finality_blocked")
            return
        self._final_pass_attempted.add(key)
        if not self._is_current(frozen):
            self._stall("config_changed")
            return
        self._state = "running"
        self._block_reason = None
        try:
            response = await self._runtime.live_asr.finalize_source_ended(session_id)
        except LiveTailFinalizationError as error:
            repo.mark_live_asr_fragments_error(self._runtime.db, session_id, error.reason)
            reason = error.reason if error.reason in {
                "source_missing", "source_conflict", "config_changed", "decoder_busy"
            } else "finality_blocked"
            self._stall(reason)  # type: ignore[arg-type]
            return
        except PreviewSourceMissing:
            repo.mark_live_asr_fragments_error(self._runtime.db, session_id, "source_missing")
            self._stall("source_missing")
            return
        except (PreviewSourceConflict, PreviewStale, LiveDraftConflict):
            repo.mark_live_asr_fragments_error(self._runtime.db, session_id, "source_conflict")
            self._stall("source_conflict")
            return
        except PreviewTooLarge:
            repo.mark_live_asr_fragments_error(self._runtime.db, session_id, "source_limit")
            self._stall("source_limit")
            return
        except (ProviderError, ProviderNotConfigured, PreviewDecodeFailed):
            repo.mark_live_asr_fragments_error(self._runtime.db, session_id, "decoder_failed")
            self._stall("decoder_failed")
            return
        draft_view = response.draft
        self._stable_frontier_ms = (
            draft_view.finality.stable_frontier_ms
            if draft_view is not None and draft_view.finality is not None
            else self._durable_frontier(session_id)
        )
        self._state = "complete"
        self._block_reason = None

    def _stall(self, reason: LiveAsrSchedulerBlockReason) -> None:
        self._state = "stalled"
        self._block_reason = reason

    def _stop(self, reason: LiveAsrSchedulerBlockReason) -> None:
        self._state = "stopped"
        self._block_reason = reason
