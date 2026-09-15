"""Durable, revisable live-ASR draft state isolated from final transcript data."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from . import repository as repo
from .gateways.asr import TranscriptWord
from .schemas import (
    AsrPreviewSource,
    LiveAsrDraftResponse,
    LiveAsrDraftSnapshot,
    LiveAsrFinality,
    LiveAsrFinalityStatus,
    LiveAsrResumeCompatibility,
    LiveAsrSourceIntegrity,
    Segment,
)
from .window_asr import (
    PreparedPreview,
    PreviewSourceConflict,
    PreviewSourceMissing,
    PreviewStale,
    PreviewTooLarge,
    WindowAsrPreview,
)

if TYPE_CHECKING:  # pragma: no cover
    from .runtime import Runtime


class LiveDraftBusy(Exception):
    """A live draft update is already admitted; no pending job was queued."""


class LiveDraftConflict(Exception):
    """The requested revision or trusted snapshot is stale."""


class LiveDraftMissing(Exception):
    """The session or a required durable source disappeared."""


class LiveDraftTooLarge(Exception):
    """The decoder result cannot fit the bounded durable draft."""


class LiveTailFinalizationError(Exception):
    """A bounded source-ended pass could not safely materialize the tail."""

    def __init__(self, reason: str, detail: str) -> None:
        self.reason = reason
        super().__init__(detail)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _digest(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _source_fingerprint(prepared: PreparedPreview) -> str:
    return _sources_fingerprint(prepared.sources)


def _sources_fingerprint(
    sources: tuple[AsrPreviewSource, ...] | list[AsrPreviewSource],
) -> str:
    return _digest([source.model_dump(mode="json") for source in sources])


def _config_values_fingerprint(
    *,
    model: str,
    requested_language: str,
    speech_gate_enabled: bool,
    config_revision: int,
    live_finality_enabled: bool,
    live_finality_guard_ms: int,
) -> str:
    fingerprint: dict[str, object] = {
        "provider": "local-whisper",
        "model": model,
        "requested_language": requested_language,
        "speech_gate_enabled": speech_gate_enabled,
        "config_revision": config_revision,
    }
    if live_finality_enabled:
        fingerprint["live_finality"] = {
            "enabled": True,
            "guard_ms": live_finality_guard_ms,
        }
    return _digest(fingerprint)


def _config_fingerprint(
    prepared: PreparedPreview, *, live_finality_enabled: bool, live_finality_guard_ms: int
) -> str:
    return _config_values_fingerprint(
        model=prepared.model,
        requested_language=prepared.requested_language,
        speech_gate_enabled=prepared.speech_gate_enabled,
        config_revision=prepared.config_revision,
        live_finality_enabled=live_finality_enabled,
        live_finality_guard_ms=live_finality_guard_ms,
    )


def _snapshot(record: repo.LiveAsrDraftRecord) -> LiveAsrDraftSnapshot:
    return LiveAsrDraftSnapshot.model_validate_json(record.snapshot_json)


@dataclass(frozen=True)
class _StableWord:
    text: str
    token: str
    start_ms: int
    end_ms: int


def _normalise_word(text: str) -> str:
    return unicodedata.normalize("NFKC", text.strip()).casefold().rstrip(",?.")


def _validated_words(
    evidence: tuple[TranscriptWord, ...] | None, *, duration_ms: int
) -> tuple[list[_StableWord] | None, str | None]:
    if evidence is None:
        return None, "word_timestamps_unavailable"
    words: list[_StableWord] = []
    previous_start = -1
    previous_end = -1
    for word in evidence:
        if not math.isfinite(word.start_s) or not math.isfinite(word.end_s):
            return None, "invalid_word_timestamps"
        start_ms = round(word.start_s * 1000)
        end_ms = round(word.end_s * 1000)
        token = _normalise_word(word.text)
        if (
            not token
            or start_ms < 0
            or end_ms <= start_ms
            or end_ms > duration_ms
            or start_ms < previous_start
            or end_ms < previous_end
        ):
            return None, "invalid_word_timestamps"
        words.append(_StableWord(word.text, token, start_ms, end_ms))
        previous_start = start_ms
        previous_end = end_ms
    return words, None


def _words_json(words: list[_StableWord]) -> str:
    return json.dumps(
        [
            {"text": word.text, "token": word.token, "start_ms": word.start_ms, "end_ms": word.end_ms}
            for word in words
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _words_from_json(value: str) -> list[_StableWord]:
    return [_StableWord(**item) for item in json.loads(value)]


def _spans_compatible(first: _StableWord, second: _StableWord) -> bool:
    overlaps = first.start_ms < second.end_ms and second.start_ms < first.end_ms
    close = abs(first.start_ms - second.start_ms) <= 250 and abs(first.end_ms - second.end_ms) <= 250
    return first.token == second.token and (overlaps or close)


def _common_prefix(first: list[_StableWord], second: list[_StableWord]) -> int:
    count = 0
    for left, right in zip(first, second, strict=False):
        if not _spans_compatible(left, right):
            break
        count += 1
    return count


def _stable_prefix_matches(
    state: repo.LiveAsrFinalityRecord | None,
    stable_tokens: list[str],
    words: list[_StableWord],
    *,
    window_start_ms: int,
) -> bool:
    if not stable_tokens:
        return True
    if state is None or state.previous_window_start_ms != window_start_ms:
        return False
    reference = _words_from_json(state.previous_words_json)
    if len(reference) < len(stable_tokens) or len(words) < len(stable_tokens):
        return False
    return all(
        token == current.token and _spans_compatible(previous, current)
        for token, previous, current in zip(
            stable_tokens,
            reference[: len(stable_tokens)],
            words[: len(stable_tokens)],
            strict=True,
        )
    )


def _eligible_prefix(words: list[_StableWord], window_duration_ms: int, guard_ms: int) -> int:
    boundary = window_duration_ms - guard_ms
    count = 0
    for word in words:
        if word.end_ms > boundary:
            break
        count += 1
    return count


@dataclass(frozen=True)
class _RolloverResult:
    tokens: list[str]
    text: str
    token_offset: int
    blocked_reason: str | None


def _absolute_spans_compatible(
    previous: _StableWord,
    current: _StableWord,
    *,
    previous_anchor_ms: int,
    current_anchor_ms: int,
) -> bool:
    shifted = _StableWord(
        text=current.text,
        token=current.token,
        start_ms=current.start_ms + current_anchor_ms - previous_anchor_ms,
        end_ms=current.end_ms + current_anchor_ms - previous_anchor_ms,
    )
    return _spans_compatible(previous, shifted)


def _rollover_active_prefix(
    state: repo.LiveAsrFinalityRecord,
    stable_tokens: list[str],
    words: list[_StableWord],
    *,
    new_anchor_ms: int,
) -> _RolloverResult:
    previous_anchor = state.previous_window_start_ms
    if previous_anchor is None or new_anchor_ms <= previous_anchor:
        return _RolloverResult(stable_tokens, state.stable_text, 0, "window_start_changed")
    if new_anchor_ms >= state.stable_frontier_ms:
        return _RolloverResult(
            stable_tokens,
            state.stable_text,
            0,
            "rollover_after_stable_frontier",
        )

    reference = _words_from_json(state.previous_words_json)
    committed = reference[: len(stable_tokens)]
    first_overlap = next(
        (
            index
            for index, word in enumerate(committed)
            if previous_anchor + word.end_ms > new_anchor_ms
        ),
        None,
    )
    if first_overlap is None:
        return _RolloverResult(
            stable_tokens, state.stable_text, 0, "rollover_overlap_unverified"
        )
    overlap = committed[first_overlap:]
    split_word = previous_anchor + overlap[0].start_ms < new_anchor_ms
    if len(words) < len(overlap):
        reason = (
            "rollover_word_boundary_ambiguous" if split_word else "rollover_overlap_unverified"
        )
        return _RolloverResult(stable_tokens, state.stable_text, 0, reason)
    for index, (previous, current) in enumerate(
        zip(overlap, words[: len(overlap)], strict=True)
    ):
        if previous.token != stable_tokens[first_overlap + index] or not _absolute_spans_compatible(
            previous,
            current,
            previous_anchor_ms=previous_anchor,
            current_anchor_ms=new_anchor_ms,
        ):
            reason = (
                "rollover_word_boundary_ambiguous"
                if split_word and index == 0
                else "rollover_overlap_unverified"
            )
            return _RolloverResult(stable_tokens, state.stable_text, 0, reason)
    active_words = words[: len(overlap)]
    return _RolloverResult(
        [word.token for word in active_words],
        "".join(word.text for word in active_words).strip(),
        first_overlap,
        None,
    )


class LiveAsrDraftService:
    """Read/update seam for one bounded snapshot and zero queued decoder jobs."""

    def __init__(self, preview: WindowAsrPreview, runtime: Runtime) -> None:
        self._preview = preview
        self._runtime = runtime
        self._update_slot = asyncio.Lock()

    def read(self, session_id: str) -> LiveAsrDraftResponse:
        record = repo.get_live_asr_draft(self._runtime.db, session_id)
        if record is None:
            return LiveAsrDraftResponse(draft=None)
        snapshot = _snapshot(record)
        integrity = self._source_integrity(record, snapshot)
        return self._saved_response(record, source_integrity=integrity)

    def is_current_config(self, record: repo.LiveAsrDraftRecord) -> bool:
        try:
            snapshot = _snapshot(record)
        except (ValueError, TypeError):
            return False
        settings, revision = self._runtime.settings_store.load_asr_snapshot()
        profile = settings.profile("asr")
        if profile.provider != "local-whisper":
            return False
        current_fingerprint = _config_values_fingerprint(
            model=profile.model,
            requested_language=settings.transcript_language,
            speech_gate_enabled=self._runtime.local_speech_gate,
            config_revision=revision,
            live_finality_enabled=self._runtime.live_finality_enabled,
            live_finality_guard_ms=self._runtime.config.live_finality_guard_ms,
        )
        return (
            snapshot.config_fingerprint == record.config_fingerprint
            and snapshot.config_revision == record.config_revision
            and current_fingerprint == record.config_fingerprint
        )

    def _source_integrity(
        self, record: repo.LiveAsrDraftRecord, snapshot: LiveAsrDraftSnapshot
    ) -> LiveAsrSourceIntegrity:
        if (
            snapshot.source_fingerprint != record.source_fingerprint
            or _sources_fingerprint(snapshot.sources) != record.source_fingerprint
        ):
            return LiveAsrSourceIntegrity(
                status="corrupt",
                trusted=False,
                detail="Saved draft source audio failed integrity validation.",
            )
        try:
            sources = self._preview.inspect_source(
                record.session_id, record.first_sequence, record.last_sequence
            )
        except PreviewSourceMissing:
            return LiveAsrSourceIntegrity(
                status="missing",
                trusted=False,
                detail="Saved draft source audio is missing.",
            )
        except (PreviewSourceConflict, PreviewTooLarge):
            return LiveAsrSourceIntegrity(
                status="corrupt",
                trusted=False,
                detail="Saved draft source audio failed integrity validation.",
            )
        if _sources_fingerprint(sources) != record.source_fingerprint:
            return LiveAsrSourceIntegrity(
                status="corrupt",
                trusted=False,
                detail="Saved draft source audio failed integrity validation.",
            )
        return LiveAsrSourceIntegrity(status="verified", trusted=True)

    def _resume_compatibility(
        self,
        record: repo.LiveAsrDraftRecord,
        source_integrity: LiveAsrSourceIntegrity,
    ) -> LiveAsrResumeCompatibility:
        if not source_integrity.trusted:
            return LiveAsrResumeCompatibility(
                status="source_unavailable",
                can_resume=False,
                requires_redecode=False,
                detail="Trusted source audio is required before this historical draft can resume.",
            )
        settings, _revision = self._runtime.settings_store.load_asr_snapshot()
        local_selected = settings.profile("asr").provider == "local-whisper"
        if self.is_current_config(record):
            return LiveAsrResumeCompatibility(
                status="compatible",
                can_resume=local_selected,
                requires_redecode=False,
            )
        return LiveAsrResumeCompatibility(
            status="config_changed",
            can_resume=local_selected,
            requires_redecode=True,
            detail=(
                "Current ASR settings differ; explicit resume will re-decode trusted source audio."
            ),
        )

    def _saved_response(
        self,
        record: repo.LiveAsrDraftRecord,
        *,
        source_integrity: LiveAsrSourceIntegrity | None = None,
    ) -> LiveAsrDraftResponse:
        snapshot = _snapshot(record)
        integrity = source_integrity or LiveAsrSourceIntegrity(status="verified", trusted=True)
        finalized_segments: list[Segment] | None = None
        if self._runtime.live_finality_enabled:
            finality = repo.get_live_asr_finality(self._runtime.db, record.session_id)
            ids = (
                list(json.loads(finality.last_segment_ids_json))
                if finality is not None and finality.last_revision == record.revision
                else []
            )
            finalized_segments = repo.segments_by_ids(
                self._runtime.db, record.session_id, ids
            )
        return LiveAsrDraftResponse(
            draft=snapshot,
            finalized_segments=finalized_segments,
            source_integrity=integrity,
            resume_compatibility=self._resume_compatibility(record, integrity),
        )

    async def update(
        self,
        session_id: str,
        first_sequence: int,
        last_sequence: int,
        expected_revision: int,
    ) -> LiveAsrDraftResponse:
        if self._update_slot.locked():
            raise LiveDraftBusy("Another live ASR draft update is already running.")
        async with self._update_slot:
            current = repo.get_live_asr_draft(self._runtime.db, session_id)
            expected_fragment_guard = repo.fragment_guard(self._runtime.db, session_id)
            prepared = self._preview.inspect(session_id, first_sequence, last_sequence)
            source_fingerprint = _source_fingerprint(prepared)
            config_fingerprint = _config_fingerprint(
                prepared,
                live_finality_enabled=self._runtime.live_finality_enabled,
                live_finality_guard_ms=self._runtime.config.live_finality_guard_ms,
            )
            if current is not None and (
                current.source_fingerprint == source_fingerprint
                and current.config_fingerprint == config_fingerprint
                and expected_revision in (current.revision - 1, current.revision)
            ):
                return self._saved_response(current)

            actual_revision = current.revision if current is not None else 0
            if expected_revision != actual_revision:
                raise LiveDraftConflict(
                    f"Expected live ASR draft revision {expected_revision}; "
                    f"current revision is {actual_revision}."
                )

            try:
                timed = (
                    await self._preview.decode_with_word_evidence(prepared)
                    if self._runtime.live_finality_enabled
                    else None
                )
                preview = timed.response if timed is not None else await self._preview.decode(prepared)
            except PreviewStale as error:
                if repo.get_session(self._runtime.db, session_id) is None:
                    raise LiveDraftMissing(
                        "Session was deleted while live ASR was running."
                    ) from error
                raise LiveDraftConflict(str(error)) from error
            if len(preview.text) > self._runtime.config.max_live_draft_chars:
                raise LiveDraftTooLarge("Live ASR draft text exceeds the configured character limit.")
            revision = actual_revision + 1
            epoch = (
                1
                if current is None
                else current.epoch + (current.config_fingerprint != config_fingerprint)
            )
            updated_at = _now()
            if timed is not None:
                return self._commit_finality(
                    current=current,
                    prepared=prepared,
                    preview=preview,
                    evidence=timed.words,
                    source_fingerprint=source_fingerprint,
                    config_fingerprint=config_fingerprint,
                    revision=revision,
                    epoch=epoch,
                    updated_at=updated_at,
                    expected_fragment_guard=expected_fragment_guard,
                )
            snapshot = LiveAsrDraftSnapshot(
                **preview.model_dump(),
                revision=revision,
                epoch=epoch,
                updated_at=updated_at,
                source_fingerprint=source_fingerprint,
                config_fingerprint=config_fingerprint,
                config_revision=prepared.config_revision,
            )
            record = repo.LiveAsrDraftRecord(
                session_id=session_id,
                revision=revision,
                epoch=epoch,
                first_sequence=first_sequence,
                last_sequence=last_sequence,
                source_fingerprint=source_fingerprint,
                config_fingerprint=config_fingerprint,
                config_revision=prepared.config_revision,
                snapshot_json=snapshot.model_dump_json(),
                updated_at=updated_at,
            )
            try:
                repo.write_live_asr_draft(
                    self._runtime.db,
                    record,
                    expected_revision=current.revision if current is not None else None,
                    expected_config_revision=prepared.config_revision,
                )
            except repo.LiveDraftSessionMissing as error:
                raise LiveDraftMissing("Session was deleted while live ASR was running.") from error
            except repo.FinalWriterConflict as error:
                raise LiveDraftConflict(str(error)) from error
            except repo.LiveDraftWriteConflict as error:
                raise LiveDraftConflict(
                    "Live ASR draft or ASR configuration changed while decoding."
                ) from error
            return self._saved_response(record)

    async def finalize_source_ended(self, session_id: str) -> LiveAsrDraftResponse:
        """Run one bounded, provenance-marked EOF pass over the retained draft source."""
        if self._update_slot.locked():
            raise LiveTailFinalizationError(
                "decoder_busy", "The contextual decoder is still processing another window."
            )
        async with self._update_slot:
            current = repo.get_live_asr_draft(self._runtime.db, session_id)
            if current is None:
                raise LiveTailFinalizationError(
                    "finality_blocked", "No retained contextual draft is available to finalize."
                )
            snapshot = _snapshot(current)
            integrity = self._source_integrity(current, snapshot)
            if not integrity.trusted:
                raise LiveTailFinalizationError(
                    "source_missing" if integrity.status == "missing" else "source_conflict",
                    integrity.detail or "Trusted source audio is unavailable.",
                )
            if not self.is_current_config(current):
                raise LiveTailFinalizationError(
                    "config_changed", "ASR configuration changed before tail finalization."
                )
            fragments = [
                fragment
                for fragment in repo.list_live_asr_fragments(self._runtime.db, session_id)
                if fragment.state in {"open", "error"}
            ]
            if not fragments:
                raise LiveTailFinalizationError(
                    "finality_blocked", "No trusted open fragment is available to finalize."
                )
            for fragment in fragments:
                if self._runtime.live_fragments.source_integrity(fragment) != "verified":
                    raise LiveTailFinalizationError(
                        "source_conflict", "A fragment source failed integrity validation."
                    )
            expected_fragment_guard = repo.fragment_guard(self._runtime.db, session_id)
            prepared = self._preview.inspect(
                session_id, current.first_sequence, current.last_sequence
            )
            if _source_fingerprint(prepared) != current.source_fingerprint:
                raise LiveTailFinalizationError(
                    "source_conflict", "The retained tail source fingerprint changed."
                )
            timed = await self._preview.decode_source_ended_final_pass(prepared)
            if timed.provenance != "source_ended_final_pass":  # pragma: no cover - type invariant
                raise LiveTailFinalizationError(
                    "finality_blocked", "The decoder result is not an explicit final pass."
                )
            preview = timed.response
            duration = preview.window.end_ms - preview.window.start_ms
            words, invalid_reason = _validated_words(timed.words, duration_ms=duration)
            if invalid_reason is not None or not words:
                raise LiveTailFinalizationError(
                    "finality_blocked",
                    f"Source-ended word evidence is unavailable: {invalid_reason or 'no_speech'}.",
                )
            state = repo.get_live_asr_finality(self._runtime.db, session_id)
            stable_tokens = list(json.loads(state.stable_tokens_json)) if state is not None else []
            if stable_tokens and not _stable_prefix_matches(
                state,
                stable_tokens,
                words,
                window_start_ms=preview.window.start_ms,
            ):
                raise LiveTailFinalizationError(
                    "finality_blocked", "Source-ended result does not preserve the stable prefix."
                )

            absolute_words = [
                _StableWord(
                    text=word.text,
                    token=word.token,
                    start_ms=preview.window.start_ms + word.start_ms,
                    end_ms=preview.window.start_ms + word.end_ms,
                )
                for word in words
            ]
            writes: list[repo.SourceEndedFragmentWrite] = []
            for fragment in fragments:
                if fragment.protected and any(
                    word.start_ms < fragment.protected_through_ms < word.end_ms
                    for word in absolute_words
                ):
                    raise LiveTailFinalizationError(
                        "finality_blocked",
                        "Source-ended timestamps cross a protected fragment boundary.",
                    )
                matched = [
                    word
                    for word in absolute_words
                    if word.end_ms > fragment.start_ms - 250
                    and word.start_ms < fragment.observed_end_ms + 250
                ]
                if (
                    not matched
                    or matched[0].start_ms > fragment.start_ms + 250
                    or matched[-1].end_ms < fragment.observed_end_ms - 250
                ):
                    raise LiveTailFinalizationError(
                        "finality_blocked",
                        "Source-ended timestamps cannot be aligned to a protected fragment range.",
                    )
                if fragment.protected:
                    segment = repo.new_segment(
                        fragment.start_ms,
                        fragment.observed_end_ms,
                        fragment.text,
                        fragment.language or preview.language,
                    )
                    sources = tuple(repo.fragment_sources(self._runtime.db, fragment.fragment_id))
                    replace_range = False
                else:
                    segment = repo.new_segment(
                        matched[0].start_ms,
                        matched[-1].end_ms,
                        "".join(word.text for word in matched).strip(),
                        preview.language,
                    )
                    sources = tuple(self._segment_sources(preview, segment))
                    replace_range = True
                if not segment.text.strip() or not sources:
                    raise LiveTailFinalizationError(
                        "finality_blocked", "Source-ended result has no bounded text/source range."
                    )
                writes.append(
                    repo.SourceEndedFragmentWrite(
                        fragment_id=fragment.fragment_id,
                        expected_revision=fragment.revision,
                        segment=segment,
                        sources=sources,
                        replace_unprotected_range=replace_range,
                    )
                )

            updated_at = _now()
            revision = current.revision + 1
            final_ids = [item.segment.id for item in writes]
            stable_frontier = max(item.segment.end_ms for item in writes)
            stable_text = " ".join(
                part
                for part in (
                    state.stable_text if state is not None else "",
                    *(item.segment.text for item in writes),
                )
                if part
            )
            finality_view = LiveAsrFinality(
                enabled=True,
                status="advanced",
                stable_frontier_ms=stable_frontier,
                active_anchor_ms=preview.window.start_ms,
                stable_token_offset=state.stable_token_offset if state is not None else 0,
            )
            snapshot_payload = preview.model_dump()
            snapshot_payload["text"] = ""
            updated_snapshot = LiveAsrDraftSnapshot(
                **snapshot_payload,
                revision=revision,
                epoch=current.epoch,
                updated_at=updated_at,
                source_fingerprint=current.source_fingerprint,
                config_fingerprint=current.config_fingerprint,
                config_revision=current.config_revision,
                text_scope="unstable_tail",
                finality=finality_view,
            )
            updated_record = repo.LiveAsrDraftRecord(
                session_id=session_id,
                revision=revision,
                epoch=current.epoch,
                first_sequence=current.first_sequence,
                last_sequence=current.last_sequence,
                source_fingerprint=current.source_fingerprint,
                config_fingerprint=current.config_fingerprint,
                config_revision=current.config_revision,
                snapshot_json=updated_snapshot.model_dump_json(),
                updated_at=updated_at,
            )
            finality_record = repo.LiveAsrFinalityRecord(
                session_id=session_id,
                stable_text=stable_text,
                stable_tokens_json=json.dumps(
                    [word.token for word in words], ensure_ascii=False, separators=(",", ":")
                ),
                stable_frontier_ms=stable_frontier,
                active_anchor_ms=preview.window.start_ms,
                stable_token_offset=state.stable_token_offset if state is not None else 0,
                agreement_epoch=current.epoch,
                previous_window_start_ms=preview.window.start_ms,
                previous_window_end_ms=preview.window.end_ms,
                previous_words_json=_words_json(words),
                last_revision=revision,
                last_segment_ids_json=json.dumps(final_ids, separators=(",", ":")),
                updated_at=updated_at,
            )
            try:
                repo.write_source_ended_finalization(
                    self._runtime.db,
                    updated_record,
                    finality_record,
                    expected_revision=current.revision,
                    expected_config_revision=current.config_revision,
                    expected_fragment_guard=expected_fragment_guard,
                    fragments=tuple(writes),
                )
            except repo.LiveDraftSessionMissing as error:
                raise LiveDraftMissing("Session was deleted during tail finalization.") from error
            except (repo.LiveDraftWriteConflict, repo.FinalWriterConflict) as error:
                raise LiveDraftConflict(
                    "Draft, fragment, source writer, or ASR configuration changed during tail finalization."
                ) from error
            return self._saved_response(updated_record)

    def _commit_finality(
        self,
        *,
        current: repo.LiveAsrDraftRecord | None,
        prepared: PreparedPreview,
        preview: object,
        evidence: tuple[TranscriptWord, ...] | None,
        source_fingerprint: str,
        config_fingerprint: str,
        revision: int,
        epoch: int,
        updated_at: str,
        expected_fragment_guard: str,
    ) -> LiveAsrDraftResponse:
        from .schemas import AsrPreviewResponse

        assert isinstance(preview, AsrPreviewResponse)
        window_start = preview.window.start_ms
        window_end = preview.window.end_ms
        duration = window_end - window_start
        words, invalid_reason = _validated_words(evidence, duration_ms=duration)
        state = repo.get_live_asr_finality(self._runtime.db, prepared.session_id)
        stable_text = state.stable_text if state is not None else ""
        stable_tokens = list(json.loads(state.stable_tokens_json)) if state is not None else []
        stable_frontier = state.stable_frontier_ms if state is not None else 0
        active_anchor = state.active_anchor_ms if state is not None else window_start
        stable_token_offset = state.stable_token_offset if state is not None else 0
        status: LiveAsrFinalityStatus = "awaiting_agreement"
        blocked_reason: str | None = None
        segment: Segment | None = None
        source_records: list[repo.SegmentSourceRecord] = []
        fragment_completion: repo.FragmentCompletion | None = None
        previous_words: list[_StableWord] = []

        if invalid_reason is not None:
            status = "blocked"
            blocked_reason = invalid_reason
            words = None
        elif state is not None and state.previous_window_start_ms != window_start:
            if not stable_tokens:
                active_anchor = window_start
                status = "awaiting_agreement"
            else:
                assert words is not None
                rollover = _rollover_active_prefix(
                    state,
                    stable_tokens,
                    words,
                    new_anchor_ms=window_start,
                )
                if rollover.blocked_reason is not None:
                    status = "blocked"
                    blocked_reason = rollover.blocked_reason
                else:
                    stable_tokens = rollover.tokens
                    stable_text = rollover.text
                    stable_token_offset += rollover.token_offset
                    active_anchor = window_start
                    status = "awaiting_agreement"
        elif words is not None and not _stable_prefix_matches(
            state, stable_tokens, words, window_start_ms=window_start
        ):
            status = "blocked"
            blocked_reason = "stable_prefix_mismatch"
        elif not words:
            status = "stable" if stable_tokens else "awaiting_agreement"
            blocked_reason = "no_speech" if not stable_tokens else None
        elif state is None or state.agreement_epoch != epoch:
            status = "awaiting_agreement"
        elif state.previous_window_end_ms is None or window_end <= state.previous_window_end_ms:
            status = "blocked"
            blocked_reason = "audio_not_extended"
        else:
            previous_words = _words_from_json(state.previous_words_json)
            common = _common_prefix(previous_words, words)
            assert state.previous_window_start_ms is not None
            previous_duration = state.previous_window_end_ms - state.previous_window_start_ms
            candidate = min(
                common,
                _eligible_prefix(
                    previous_words,
                    previous_duration,
                    self._runtime.config.live_finality_guard_ms,
                ),
                _eligible_prefix(words, duration, self._runtime.config.live_finality_guard_ms),
            )
            if candidate < len(stable_tokens):
                status = "blocked"
                blocked_reason = "stable_prefix_mismatch"
            elif candidate > len(stable_tokens):
                new_words = words[len(stable_tokens) : candidate]
                text = ""
                if new_words and window_start + new_words[0].start_ms < stable_frontier:
                    status = "blocked"
                    blocked_reason = "new_word_before_stable_frontier"
                else:
                    text = "".join(word.text for word in new_words).strip()
                if blocked_reason is None and text:
                    candidate_start = window_start + new_words[0].start_ms
                    candidate_end = window_start + new_words[-1].end_ms
                    open_fragment = self._matching_open_fragment(
                        prepared.session_id,
                        candidate_start,
                        candidate_end,
                    )
                    if open_fragment is not None and open_fragment.protected:
                        segment = repo.new_segment(
                            open_fragment.start_ms,
                            open_fragment.observed_end_ms,
                            open_fragment.text,
                            open_fragment.language or preview.language,
                        )
                        source_records = repo.fragment_sources(
                            self._runtime.db, open_fragment.fragment_id
                        )
                        fragment_completion = repo.FragmentCompletion(
                            fragment_id=open_fragment.fragment_id,
                            expected_revision=open_fragment.revision,
                            provenance="live_agreement",
                        )
                    else:
                        segment = repo.new_segment(
                            candidate_start,
                            candidate_end,
                            text,
                            preview.language,
                        )
                        source_records = self._segment_sources(preview, segment)
                        if open_fragment is not None:
                            fragment_completion = repo.FragmentCompletion(
                                fragment_id=open_fragment.fragment_id,
                                expected_revision=open_fragment.revision,
                                provenance="live_agreement",
                            )
                    stable_tokens.extend(word.token for word in new_words)
                    stable_text = " ".join(
                        part for part in (stable_text, segment.text) if part
                    )
                    stable_frontier = segment.end_ms
                    status = "advanced"
            else:
                status = "stable"

        whole_window = words is None or blocked_reason in {
            "stable_prefix_mismatch",
            "window_start_changed",
            "new_word_before_stable_frontier",
            "rollover_after_stable_frontier",
            "rollover_overlap_unverified",
            "rollover_word_boundary_ambiguous",
        }
        tail_start = 0 if whole_window else len(stable_tokens)
        draft_text = (
            "".join(word.text for word in words[tail_start:]).strip()
            if words is not None
            else preview.text
        )
        open_fragment_write: repo.OpenFragmentWrite | None = None
        if words is not None and not whole_window:
            remaining_words = words[tail_start:]
            protected_through = max(
                (
                    fragment.protected_through_ms
                    for fragment in repo.list_live_asr_fragments(
                        self._runtime.db, prepared.session_id
                    )
                    if fragment.state == "open" and fragment.protected
                ),
                default=stable_frontier,
            )
            remaining_words = [
                word
                for word in remaining_words
                if window_start + word.start_ms >= protected_through
            ]
            if remaining_words:
                tail_text = "".join(word.text for word in remaining_words).strip()
                tail_start_ms = window_start + remaining_words[0].start_ms
                tail_end_ms = window_start + remaining_words[-1].end_ms
                if tail_text and tail_end_ms > tail_start_ms:
                    open_fragment_write = repo.OpenFragmentWrite(
                        start_ms=tail_start_ms,
                        observed_end_ms=tail_end_ms,
                        text=tail_text,
                        language=preview.language,
                        draft_revision=revision,
                        config_revision=prepared.config_revision,
                        sources=tuple(
                            self._segment_sources(
                                preview,
                                Segment(
                                    id="fragment-source-range",
                                    start_ms=tail_start_ms,
                                    end_ms=tail_end_ms,
                                    text=tail_text,
                                    language=preview.language,
                                ),
                            )
                        ),
                    )
        finality_view = LiveAsrFinality(
            enabled=True,
            status=status,
            blocked_reason=blocked_reason,
            stable_frontier_ms=stable_frontier,
            active_anchor_ms=active_anchor,
            stable_token_offset=stable_token_offset,
        )
        snapshot_payload = preview.model_dump()
        snapshot_payload["text"] = draft_text
        snapshot = LiveAsrDraftSnapshot(
            **snapshot_payload,
            revision=revision,
            epoch=epoch,
            updated_at=updated_at,
            source_fingerprint=source_fingerprint,
            config_fingerprint=config_fingerprint,
            config_revision=prepared.config_revision,
            text_scope="whole_window" if whole_window else "unstable_tail",
            finality=finality_view,
        )
        record = repo.LiveAsrDraftRecord(
            session_id=prepared.session_id,
            revision=revision,
            epoch=epoch,
            first_sequence=prepared.records[0].sequence,
            last_sequence=prepared.records[-1].sequence,
            source_fingerprint=source_fingerprint,
            config_fingerprint=config_fingerprint,
            config_revision=prepared.config_revision,
            snapshot_json=snapshot.model_dump_json(),
            updated_at=updated_at,
        )
        preserve_previous_evidence = (
            state is not None
            and blocked_reason is not None
            and (
                blocked_reason.startswith("rollover_")
                or blocked_reason
                in {"word_timestamps_unavailable", "invalid_word_timestamps"}
            )
        )
        preserved_state = state if preserve_previous_evidence else None
        finality_record = repo.LiveAsrFinalityRecord(
            session_id=prepared.session_id,
            stable_text=stable_text,
            stable_tokens_json=json.dumps(stable_tokens, ensure_ascii=False, separators=(",", ":")),
            stable_frontier_ms=stable_frontier,
            active_anchor_ms=active_anchor,
            stable_token_offset=stable_token_offset,
            agreement_epoch=(
                preserved_state.agreement_epoch if preserved_state is not None else epoch
            ),
            previous_window_start_ms=(
                preserved_state.previous_window_start_ms
                if preserved_state is not None
                else window_start if words is not None else None
            ),
            previous_window_end_ms=(
                preserved_state.previous_window_end_ms
                if preserved_state is not None
                else window_end if words is not None else None
            ),
            previous_words_json=(
                preserved_state.previous_words_json
                if preserved_state is not None
                else _words_json(words or [])
            ),
            last_revision=revision,
            last_segment_ids_json=json.dumps([segment.id] if segment is not None else []),
            updated_at=updated_at,
        )
        try:
            repo.write_live_asr_final_update(
                self._runtime.db,
                record,
                finality_record,
                expected_revision=current.revision if current is not None else None,
                expected_config_revision=prepared.config_revision,
                segment=segment,
                sources=source_records,
                expected_fragment_guard=expected_fragment_guard,
                open_fragment=open_fragment_write,
                fragment_completion=fragment_completion,
            )
        except repo.LiveDraftSessionMissing as error:
            raise LiveDraftMissing("Session was deleted while live ASR was running.") from error
        except repo.FinalWriterConflict as error:
            raise LiveDraftConflict(str(error)) from error
        except repo.LiveDraftWriteConflict as error:
            raise LiveDraftConflict(
                "Live ASR draft or ASR configuration changed while decoding."
            ) from error
        return self._saved_response(record)

    def _matching_open_fragment(
        self, session_id: str, candidate_start: int, candidate_end: int
    ) -> repo.LiveAsrFragmentRecord | None:
        for fragment in repo.list_live_asr_fragments(self._runtime.db, session_id):
            if fragment.state != "open":
                continue
            if (
                candidate_start <= fragment.start_ms + 250
                and candidate_end >= fragment.observed_end_ms - 250
            ):
                return fragment
        return None

    @staticmethod
    def _segment_sources(preview: object, segment: Segment) -> list[repo.SegmentSourceRecord]:
        from .schemas import AsrPreviewResponse

        assert isinstance(preview, AsrPreviewResponse)
        records: list[repo.SegmentSourceRecord] = []
        for source in preview.sources:
            intersection_start = max(segment.start_ms, source.start_ms)
            intersection_end = min(segment.end_ms, source.end_ms)
            if intersection_start >= intersection_end:
                continue
            records.append(
                repo.SegmentSourceRecord(
                    sequence=source.sequence,
                    sample_start=round(
                        (intersection_start - source.start_ms) * source.sample_rate / 1000
                    ),
                    sample_end=round(
                        (intersection_end - source.start_ms) * source.sample_rate / 1000
                    ),
                    sha256=source.sha256,
                )
            )
        return records
