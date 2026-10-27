"""P3: an item's key ideas and its «Unclear» mark (``study_items``, schema ``study_items`` v1).

A plain repository keyed by the item's block id (``c-…``); callers run it off the event loop.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from ..store.database import KnowledgeDatabase

ItemKind = Literal["question", "card"]


@dataclass(frozen=True)
class ItemRow:
    item_id: str
    kind: ItemKind
    #: ``None``: no key ideas yet (an old test, or an item that is not an open question).
    ideas: tuple[Mapping[str, Any], ...] | None
    unclear: bool
    unclear_at: str | None
    block_id: str | None
    page_id: str | None
    updated_at: str


def _row(row: Any) -> ItemRow:
    ideas = json.loads(row["ideas"]) if row["ideas"] else None
    return ItemRow(
        item_id=row["item_id"],
        kind="card" if row["kind"] == "card" else "question",
        ideas=tuple(ideas) if isinstance(ideas, list) else None,
        unclear=bool(row["unclear"]),
        unclear_at=row["unclear_at"],
        block_id=row["block_id"],
        page_id=row["page_id"],
        updated_at=row["updated_at"],
    )


class StudyItems:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    def get(self, item_ids: Sequence[str]) -> dict[str, ItemRow]:
        if not item_ids:
            return {}
        out: dict[str, ItemRow] = {}
        with self.db.read() as connection:
            for start in range(0, len(item_ids), 500):
                chunk = list(item_ids[start : start + 500])
                marks = ",".join("?" for _ in chunk)
                for row in connection.execute(f"SELECT * FROM study_items WHERE item_id IN ({marks})", chunk):
                    out[row["item_id"]] = _row(row)
        return out

    def one(self, item_id: str) -> ItemRow | None:
        return self.get([item_id]).get(item_id)

    def put_ideas(
        self,
        item_id: str,
        ideas: Sequence[Mapping[str, Any]],
        *,
        now: str,
        block_id: str | None,
        page_id: str | None,
    ) -> None:
        data = json.dumps([dict(idea) for idea in ideas], ensure_ascii=False, separators=(",", ":"))
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO study_items(item_id, kind, ideas, block_id, page_id, updated_at) "
                "VALUES (?, 'question', ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET "
                "ideas = excluded.ideas, updated_at = excluded.updated_at",
                (item_id, data, block_id, page_id, now),
            )

    def set_unclear(
        self,
        item_ids: Sequence[str],
        kind: ItemKind,
        on: bool,
        *,
        now: str,
        block_id: str | None,
        pages: Mapping[str, str | None],
    ) -> None:
        """Mark or clear; the item remembers the block (and page) it was marked in last."""
        with self.db.write() as connection:
            for item_id in item_ids:
                page_id = pages.get(item_id)
                connection.execute(
                    "INSERT INTO study_items(item_id, kind, unclear, unclear_at, block_id, page_id, "
                    "updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET "
                    "unclear = excluded.unclear, unclear_at = excluded.unclear_at, "
                    "block_id = COALESCE(excluded.block_id, study_items.block_id), "
                    "page_id = COALESCE(excluded.page_id, study_items.page_id), "
                    "updated_at = excluded.updated_at",
                    (item_id, kind, int(on), now if on else None, block_id, page_id, now),
                )

    def set_page(self, item_ids: Sequence[str], page_id: str) -> None:
        """A deck or test was saved: its items now live on that page too."""
        with self.db.write() as connection:
            connection.executemany(
                "UPDATE study_items SET page_id = ? WHERE item_id = ?",
                [(page_id, item_id) for item_id in item_ids],
            )

    def unclear(self) -> list[ItemRow]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT * FROM study_items WHERE unclear = 1 ORDER BY unclear_at, rowid"
            ).fetchall()
        return [_row(row) for row in rows]
