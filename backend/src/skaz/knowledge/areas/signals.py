"""Append-only factual signals store (decision 3e′: no scores, no inferences, nothing into «Я»)."""

from __future__ import annotations

import sqlite3
from collections.abc import Sequence

from pydantic import ValidationError

from ..api.contract_routes import ContractFailure
from ..api.schemas_areas import KbFactualSignal, KbSignalEntity, KbSignals
from ..ids import new_id, utc_now_ms
from ..store.database import KnowledgeDatabase
from .protocols import SignalDraft


def _row_to_signal(row: sqlite3.Row) -> KbFactualSignal:
    return KbFactualSignal.model_validate(
        {
            "id": row["id"],
            "subject": {"kind": row["subject_kind"], "id": row["subject_id"]},
            "predicate": row["predicate"],
            "object": {"kind": row["object_kind"], "id": row["object_id"]},
            "occurred_at": row["occurred_at"],
            "origin": row["origin"],
            "value": row["value"],
            "evidence_id": row["evidence_id"],
            "supersedes_id": row["supersedes_id"],
        }
    )


class SignalStore:
    """Implements ``SignalRecorder`` over ``explore_signals``."""

    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    def record(self, draft: SignalDraft) -> KbFactualSignal:
        if not draft.evidence_id.strip():
            raise ContractFailure(422, "invalid_request")
        signal_id = new_id("signal")
        occurred_at = utc_now_ms()
        try:
            signal = KbFactualSignal.model_validate(
                {
                    "id": signal_id,
                    "subject": (
                        draft.subject.model_dump()
                        if isinstance(draft.subject, KbSignalEntity)
                        else draft.subject
                    ),
                    "predicate": draft.predicate,
                    "object": (
                        draft.object.model_dump()
                        if isinstance(draft.object, KbSignalEntity)
                        else draft.object
                    ),
                    "occurred_at": occurred_at,
                    "origin": draft.origin,
                    "value": draft.value,
                    "evidence_id": draft.evidence_id,
                    "supersedes_id": draft.supersedes_id,
                }
            )
        except ValidationError as exc:
            raise ContractFailure(422, "invalid_request") from exc

        with self.db.write() as conn:
            if signal.supersedes_id is not None:
                exists = conn.execute(
                    "SELECT 1 FROM explore_signals WHERE id = ?",
                    (signal.supersedes_id,),
                ).fetchone()
                if exists is None:
                    raise ContractFailure(422, "invalid_request")
            conn.execute(
                "INSERT INTO explore_signals("
                "id, subject_kind, subject_id, predicate, object_kind, object_id, "
                "occurred_at, origin, value, evidence_id, supersedes_id"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    signal.id,
                    signal.subject.kind,
                    signal.subject.id,
                    signal.predicate,
                    signal.object.kind,
                    signal.object.id,
                    occurred_at,
                    signal.origin,
                    signal.value,
                    signal.evidence_id,
                    signal.supersedes_id,
                ),
            )
        return signal

    def latest_id_for_object(
        self,
        object_kind: str,
        object_id: str,
        predicates: Sequence[str] | None = None,
    ) -> str | None:
        clauses = ["object_kind = ?", "object_id = ?"]
        params: list[object] = [object_kind, object_id]
        if predicates:
            marks = ",".join("?" for _ in predicates)
            clauses.append(f"predicate IN ({marks})")
            params.extend(predicates)
        sql = (
            f"SELECT id FROM explore_signals WHERE {' AND '.join(clauses)} "
            "ORDER BY occurred_at DESC, rowid DESC LIMIT 1"
        )
        with self.db.read() as conn:
            row = conn.execute(sql, params).fetchone()
        return str(row["id"]) if row is not None else None

    def list_signals(self, cursor: str | None = None, limit: int = 50) -> KbSignals:
        if limit < 1 or limit > 100:
            raise ContractFailure(422, "invalid_request")
        with self.db.read() as conn:
            if cursor is not None:
                anchor = conn.execute(
                    "SELECT occurred_at, rowid FROM explore_signals WHERE id = ?",
                    (cursor,),
                ).fetchone()
                if anchor is None:
                    raise ContractFailure(422, "invalid_request")
                rows = conn.execute(
                    "SELECT * FROM explore_signals "
                    "WHERE occurred_at < ? OR (occurred_at = ? AND rowid < ?) "
                    "ORDER BY occurred_at DESC, rowid DESC LIMIT ?",
                    (anchor["occurred_at"], anchor["occurred_at"], anchor["rowid"], limit + 1),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM explore_signals ORDER BY occurred_at DESC, rowid DESC LIMIT ?",
                    (limit + 1,),
                ).fetchall()

        has_more = len(rows) > limit
        page = rows[:limit]
        next_cursor = str(page[-1]["id"]) if has_more and page else None
        return KbSignals(signals=[_row_to_signal(row) for row in page], next_cursor=next_cursor)
