"""Study blocks, card states, reviews and test attempts in ``knowledge.sqlite3`` (schema ``study`` v1).

A plain repository; callers run it off the event loop (``disk_call``).
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Literal, cast

from ..store.database import KnowledgeDatabase
from .scheduling import CardState, load_fsrs

BlockKind = Literal["deck", "test"]
Origin = Literal["agent", "show"]
SaveStatus = Literal["none", "pending", "saved", "denied"]
Place = Literal["chat", "panel", "window"]
Side = Literal["question", "answer"]


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class StudyBlock:
    id: str
    chat_id: str
    message_id: str
    kind: BlockKind
    title: str
    engine: str | None
    origin: Origin
    payload: Mapping[str, Any]
    page_id: str | None
    mode: str
    folder_id: str | None
    save_status: SaveStatus
    save_reason: str | None
    place: Place
    position: int
    side: Side
    state: Mapping[str, Any]
    created_at: str
    updated_at: str


def _block(row: sqlite3.Row) -> StudyBlock:
    return StudyBlock(
        id=row["id"],
        chat_id=row["chat_id"],
        message_id=row["message_id"],
        kind=cast(BlockKind, row["kind"]),
        title=row["title"],
        engine=row["engine"],
        origin=cast(Origin, row["origin"]),
        payload=json.loads(row["payload"] or "{}"),
        page_id=row["page_id"],
        mode=row["mode"],
        folder_id=row["folder_id"],
        save_status=cast(SaveStatus, row["save_status"]),
        save_reason=row["save_reason"],
        place=cast(Place, row["place"]),
        position=int(row["position"]),
        side=cast(Side, row["side"]),
        state=json.loads(row["state"] or "{}"),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _card(row: sqlite3.Row) -> CardState:
    return CardState(
        card_id=row["card_id"],
        page_id=row["page_id"],
        fsrs=load_fsrs(row["fsrs"]),
        lapses=int(row["lapses"]),
        reps=int(row["reps"]),
        suspended=bool(row["suspended"]),
        marked_hard=bool(row["marked_hard"]),
    )


@dataclass(frozen=True)
class Review:
    card_id: str
    page_id: str
    folder_id: str
    rating: int
    mode: str
    scheduled: bool
    was_new: bool
    reviewed_at: str
    local_day: str


@dataclass(frozen=True)
class Attempt:
    id: str
    block_id: str
    page_id: str | None
    answers: Mapping[str, Any] = field(default_factory=dict)
    correct: float | None = None
    total: int = 0
    started_at: str = ""
    finished_at: str | None = None


_BLOCK_FIELDS = {
    "title",
    "payload",
    "page_id",
    "mode",
    "folder_id",
    "save_status",
    "save_reason",
    "place",
    "position",
    "side",
    "state",
    "updated_at",
}


class StudyStore:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    # -- blocks ---------------------------------------------------------------------------------

    def add_block(self, block: StudyBlock) -> None:
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO study_blocks(id, chat_id, message_id, kind, title, engine, origin, payload, "
                "page_id, mode, folder_id, save_status, save_reason, place, position, side, state, "
                "created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    block.id,
                    block.chat_id,
                    block.message_id,
                    block.kind,
                    block.title,
                    block.engine,
                    block.origin,
                    _dump(dict(block.payload)),
                    block.page_id,
                    block.mode,
                    block.folder_id,
                    block.save_status,
                    block.save_reason,
                    block.place,
                    block.position,
                    block.side,
                    _dump(dict(block.state)),
                    block.created_at,
                    block.updated_at,
                ),
            )

    def block(self, block_id: str) -> StudyBlock | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM study_blocks WHERE id = ?", (block_id,)).fetchone()
        return _block(row) if row else None

    def blocks_of_chat(self, chat_id: str) -> list[StudyBlock]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT * FROM study_blocks WHERE chat_id = ? ORDER BY created_at, id", (chat_id,)
            ).fetchall()
        return [_block(row) for row in rows]

    def update_block(self, block_id: str, **fields: Any) -> StudyBlock | None:
        if not set(fields) <= _BLOCK_FIELDS:
            raise ValueError("Unknown study block fields")
        values = {
            key: _dump(dict(value)) if key in ("payload", "state") else value for key, value in fields.items()
        }
        sets = ", ".join(f"{key} = ?" for key in values)
        with self.db.write() as connection:
            connection.execute(f"UPDATE study_blocks SET {sets} WHERE id = ?", (*values.values(), block_id))
            row = connection.execute("SELECT * FROM study_blocks WHERE id = ?", (block_id,)).fetchone()
        return _block(row) if row else None

    def others_away(self, chat_id: str, keep: str) -> list[StudyBlock]:
        """The chat's other blocks that are beside the chat or in a window (A-4: one at a time)."""
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT * FROM study_blocks WHERE chat_id = ? AND id != ? AND place != 'chat'",
                (chat_id, keep),
            ).fetchall()
        return [_block(row) for row in rows]

    def away_anywhere(self, keep: str) -> list[StudyBlock]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT * FROM study_blocks WHERE id != ? AND place != 'chat'", (keep,)
            ).fetchall()
        return [_block(row) for row in rows]

    # -- cards ----------------------------------------------------------------------------------

    def cards(self, card_ids: Sequence[str]) -> dict[str, CardState]:
        if not card_ids:
            return {}
        out: dict[str, CardState] = {}
        with self.db.read() as connection:
            for start in range(0, len(card_ids), 500):
                chunk = list(card_ids[start : start + 500])
                marks = ",".join("?" for _ in chunk)
                for row in connection.execute(f"SELECT * FROM study_cards WHERE card_id IN ({marks})", chunk):
                    out[row["card_id"]] = _card(row)
        return out

    def cards_of_page(self, page_id: str) -> dict[str, CardState]:
        with self.db.read() as connection:
            rows = connection.execute("SELECT * FROM study_cards WHERE page_id = ?", (page_id,)).fetchall()
        return {row["card_id"]: _card(row) for row in rows}

    def put_cards(self, states: Iterable[CardState], now: str) -> None:
        with self.db.write() as connection:
            for state in states:
                due = state.due.isoformat(timespec="seconds") if state.due is not None else None
                connection.execute(
                    "INSERT INTO study_cards(card_id, page_id, fsrs, lapses, reps, suspended, marked_hard, "
                    "due, "
                    "updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET "
                    "page_id = excluded.page_id, fsrs = excluded.fsrs, lapses = excluded.lapses, "
                    "reps = excluded.reps, suspended = excluded.suspended, "
                    "marked_hard = excluded.marked_hard, "
                    "due = excluded.due, updated_at = excluded.updated_at",
                    (
                        state.card_id,
                        state.page_id,
                        _dump(state.fsrs) if state.fsrs is not None else None,
                        state.lapses,
                        state.reps,
                        int(state.suspended),
                        int(state.marked_hard),
                        due,
                        now,
                    ),
                )

    def forget_page_cards(self, page_id: str) -> None:
        with self.db.write() as connection:
            connection.execute("DELETE FROM study_cards WHERE page_id = ?", (page_id,))

    # -- reviews --------------------------------------------------------------------------------

    def add_reviews(self, reviews: Iterable[Review]) -> None:
        with self.db.write() as connection:
            connection.executemany(
                "INSERT INTO study_reviews(card_id, page_id, folder_id, rating, mode, scheduled, was_new, "
                "reviewed_at, local_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        r.card_id,
                        r.page_id,
                        r.folder_id,
                        r.rating,
                        r.mode,
                        int(r.scheduled),
                        int(r.was_new),
                        r.reviewed_at,
                        r.local_day,
                    )
                    for r in reviews
                ],
            )

    def new_today(self, local_day: str) -> dict[str, int]:
        """New cards started today, by folder (the S8 limit, per folder — Q14)."""
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT folder_id, COUNT(DISTINCT card_id) FROM study_reviews "
                "WHERE local_day = ? AND was_new = 1 "
                "GROUP BY folder_id",
                (local_day,),
            ).fetchall()
        return {str(row[0]): int(row[1]) for row in rows}

    # -- attempts -------------------------------------------------------------------------------

    def put_attempt(self, attempt: Attempt) -> None:
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO study_attempts(id, block_id, page_id, answers, correct, total, started_at, "
                "finished_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET answers = excluded.answers, "
                "correct = excluded.correct, total = excluded.total, finished_at = excluded.finished_at, "
                "page_id = excluded.page_id",
                (
                    attempt.id,
                    attempt.block_id,
                    attempt.page_id,
                    _dump(dict(attempt.answers)),
                    attempt.correct,
                    attempt.total,
                    attempt.started_at,
                    attempt.finished_at,
                ),
            )

    def attempts(self, block_id: str) -> list[Attempt]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT * FROM study_attempts WHERE block_id = ? ORDER BY started_at, id", (block_id,)
            ).fetchall()
        return [
            Attempt(
                row["id"],
                row["block_id"],
                row["page_id"],
                json.loads(row["answers"] or "{}"),
                row["correct"],
                int(row["total"]),
                row["started_at"],
                row["finished_at"],
            )
            for row in rows
        ]


def with_place(block: StudyBlock, place: Place) -> StudyBlock:
    return replace(block, place=place)
