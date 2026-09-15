"""Protected contextual draft fragments with absolute source-range CAS."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from . import repository as repo
from .schemas import LiveAsrFragment, LiveAsrFragmentsResponse, SegmentSource

if TYPE_CHECKING:  # pragma: no cover
    from .runtime import Runtime


class LiveFragmentMissing(Exception):
    """The requested fragment does not belong to the session."""


class LiveFragmentConflict(Exception):
    """The fragment revision, range, state, or trusted source changed."""


class LiveAsrFragmentService:
    def __init__(self, runtime: Runtime) -> None:
        self._runtime = runtime

    def read(self, session_id: str) -> LiveAsrFragmentsResponse:
        return LiveAsrFragmentsResponse(
            fragments=[self._view(row) for row in repo.list_live_asr_fragments(self._runtime.db, session_id)]
        )

    def source_integrity(
        self, record: repo.LiveAsrFragmentRecord
    ) -> Literal["verified", "missing", "corrupt"]:
        return self._integrity(record)

    def edit(
        self,
        session_id: str,
        fragment_id: str,
        *,
        expected_revision: int,
        range_fingerprint: str,
        text: str,
    ) -> LiveAsrFragment:
        current = self._require(session_id, fragment_id)
        self._assert_range(current, range_fingerprint)
        integrity = self._integrity(current)
        if integrity != "verified":
            raise LiveFragmentConflict("Trusted fragment source audio is required for editing.")
        if current.state == "complete":
            raise LiveFragmentConflict("Completed immutable fragments cannot be edited in this slice.")
        try:
            updated = repo.edit_live_asr_fragment(
                self._runtime.db,
                session_id,
                fragment_id,
                expected_revision=expected_revision,
                text=text.strip(),
            )
        except repo.LiveDraftWriteConflict as error:
            raise LiveFragmentConflict("Fragment revision changed; refresh before editing.") from error
        if updated is None:  # pragma: no cover - guarded, retained for delete race
            raise LiveFragmentMissing
        return self._view(updated)

    def accept(
        self,
        session_id: str,
        fragment_id: str,
        *,
        expected_revision: int,
        range_fingerprint: str,
        idempotency_key: str,
    ) -> LiveAsrFragment:
        current = self._require(session_id, fragment_id)
        self._assert_range(current, range_fingerprint)
        if self._integrity(current) != "verified":
            raise LiveFragmentConflict("Trusted fragment source audio is required for acceptance.")
        try:
            updated = repo.accept_live_asr_fragment(
                self._runtime.db,
                session_id,
                fragment_id,
                expected_revision=expected_revision,
                idempotency_key=idempotency_key,
            )
        except ValueError as error:
            raise LiveFragmentConflict(str(error)) from error
        except repo.LiveDraftWriteConflict as error:
            raise LiveFragmentConflict("Fragment revision changed; refresh before accepting.") from error
        if updated is None:  # pragma: no cover - guarded, retained for delete race
            raise LiveFragmentMissing
        return self._view(updated)

    def _require(self, session_id: str, fragment_id: str) -> repo.LiveAsrFragmentRecord:
        record = repo.get_live_asr_fragment(self._runtime.db, session_id, fragment_id)
        if record is None:
            raise LiveFragmentMissing
        return record

    def _assert_range(self, record: repo.LiveAsrFragmentRecord, supplied: str) -> None:
        if supplied != self._range_fingerprint(record):
            raise LiveFragmentConflict("Fragment audio range changed; refresh before continuing.")

    def _range_fingerprint(self, record: repo.LiveAsrFragmentRecord) -> str:
        sources = repo.fragment_sources(self._runtime.db, record.fragment_id)
        value = {
            "fragment_id": record.fragment_id,
            "start_ms": record.start_ms,
            "observed_end_ms": record.observed_end_ms,
            "protected_through_ms": record.protected_through_ms,
            "sources": [
                {
                    "sequence": source.sequence,
                    "sample_start": source.sample_start,
                    "sample_end": source.sample_end,
                    "sha256": source.sha256,
                }
                for source in sources
            ],
        }
        payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(payload).hexdigest()

    def _integrity(
        self, record: repo.LiveAsrFragmentRecord
    ) -> Literal["verified", "missing", "corrupt"]:
        sources = repo.fragment_sources(self._runtime.db, record.fragment_id)
        if not sources:
            return "corrupt"
        for source in sources:
            chunk = repo.get_chunk(self._runtime.db, record.session_id, source.sequence)
            if chunk is None:
                return "missing"
            if chunk.sha256 != source.sha256:
                return "corrupt"
            try:
                path = Path(chunk.path)
                with path.open("rb") as handle:
                    data = handle.read(self._runtime.config.max_chunk_bytes + 1)
            except FileNotFoundError:
                return "missing"
            except OSError:
                return "corrupt"
            if len(data) > self._runtime.config.max_chunk_bytes:
                return "corrupt"
            if hashlib.sha256(data).hexdigest() != source.sha256:
                return "corrupt"
        return "verified"

    def _view(self, record: repo.LiveAsrFragmentRecord) -> LiveAsrFragment:
        integrity = self._integrity(record)
        sources = repo.fragment_sources(self._runtime.db, record.fragment_id)
        can_edit = record.state != "complete" and integrity == "verified"
        if record.state == "complete":
            edit_reason = "Completed immutable fragments cannot be edited in this slice."
        elif integrity != "verified":
            edit_reason = "Trusted fragment source audio is required for editing."
        else:
            edit_reason = None
        can_accept = (
            record.state == "complete"
            and record.accepted_at is None
            and integrity == "verified"
        )
        if record.accepted_at is not None:
            accept_reason = "Fragment has already been accepted."
        elif record.state != "complete":
            accept_reason = record.state_reason or "Fragment processing is not complete."
        elif integrity != "verified":
            accept_reason = "Trusted fragment source audio is required for acceptance."
        else:
            accept_reason = None
        return LiveAsrFragment(
            fragment_id=record.fragment_id,
            ordinal=record.ordinal,
            start_ms=record.start_ms,
            observed_end_ms=record.observed_end_ms,
            protected_through_ms=record.protected_through_ms,
            text=record.text,
            language=record.language,
            state=record.state,
            state_reason=record.state_reason,
            revision=record.revision,
            draft_revision=record.draft_revision,
            config_revision=record.config_revision,
            range_fingerprint=self._range_fingerprint(record),
            protected=record.protected,
            completion_provenance=record.completion_provenance,
            segment_id=record.segment_id,
            accepted_at=record.accepted_at,
            source_integrity=integrity,
            sources=[
                SegmentSource(
                    sequence=source.sequence,
                    sample_start=source.sample_start,
                    sample_end=source.sample_end,
                    sha256=source.sha256,
                )
                for source in sources
            ],
            can_edit=can_edit,
            edit_disabled_reason=edit_reason,
            can_accept=can_accept,
            accept_disabled_reason=accept_reason,
        )
