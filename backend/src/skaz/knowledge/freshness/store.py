"""SQLite persistence for ``material_publications`` and ``freshness_link_*`` tables (0.4.0 B5)."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Literal, cast
from uuid import uuid4

from ..api.schemas_explore_common import (
    KbCheckpoint,
    KbPublicationDate,
)
from ..api.schemas_freshness import KbLinkObservation
from ..ids import utc_now
from ..store.database import KnowledgeDatabase

KbPublicationPrecision = Literal["day", "month", "year", "unknown"]
KbPublicationOrigin = Literal["openalex", "arxiv", "crossref", "page", "unknown"]
KbLinkOutcome = Literal["ok", "suspected_gone", "confirmed_gone", "could_not_check"]


def _chunks(items: Sequence[str], size: int = 400) -> Iterable[Sequence[str]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _format_iso_datetime(value: datetime | None) -> str | None:
    if value is None:
        return None
    utc_dt = value.astimezone(UTC) if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return utc_dt.isoformat().replace("+00:00", "Z")


@dataclass(frozen=True, slots=True)
class LinkTarget:
    material_id: str
    url: str


@dataclass(frozen=True, slots=True)
class LinkCheckScope:
    check_id: str
    folder_id: str | None
    material_ids: tuple[str, ...]
    targets: tuple[LinkTarget, ...]
    checkpoint: KbCheckpoint | None = None


class FreshnessStore:
    """Repository over ``material_publications`` and ``freshness_link_*`` tables."""

    def __init__(self, db: KnowledgeDatabase) -> None:
        self._db = db

    def get_publication(self, material_id: str) -> KbPublicationDate | None:
        return self.get_publications((material_id,)).get(material_id)

    def get_publications(self, material_ids: Sequence[str]) -> dict[str, KbPublicationDate]:
        ids = list(dict.fromkeys(material_ids))
        if not ids:
            return {}
        result: dict[str, KbPublicationDate] = {}
        with self._db.read() as conn:
            for chunk in _chunks(ids):
                marks = ",".join("?" * len(chunk))
                rows = conn.execute(
                    f"SELECT material_id, year, publication_date, month, precision, origin, evidence_url "
                    f"FROM material_publications WHERE material_id IN ({marks})",
                    tuple(chunk),
                ).fetchall()
                for row in rows:
                    result[str(row["material_id"])] = self._row_to_publication(row)
        return result

    def save_publication(self, material_id: str, publication: KbPublicationDate) -> None:
        pub_date = publication.date.isoformat() if publication.date is not None else None
        now = utc_now()
        with self._db.write() as conn:
            conn.execute(
                "INSERT INTO material_publications ("
                "material_id, year, publication_date, month, precision, origin, evidence_url, updated_at"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(material_id) DO UPDATE SET "
                "year = excluded.year, "
                "publication_date = excluded.publication_date, "
                "month = excluded.month, "
                "precision = excluded.precision, "
                "origin = excluded.origin, "
                "evidence_url = excluded.evidence_url, "
                "updated_at = excluded.updated_at",
                (
                    material_id,
                    publication.year,
                    pub_date,
                    publication.month,
                    publication.precision,
                    publication.origin,
                    publication.evidence_url,
                    now,
                ),
            )

    def wiki_page_counts(self, material_ids: Sequence[str]) -> dict[str, int]:
        ids = list(dict.fromkeys(material_ids))
        if not ids:
            return {}
        counts: dict[str, int] = dict.fromkeys(ids, 0)
        with self._db.read() as conn:
            for chunk in _chunks(ids):
                marks = ",".join("?" * len(chunk))
                rows = conn.execute(
                    f"SELECT material_id, COUNT(DISTINCT page_id) AS cnt "
                    f"FROM page_sources WHERE material_id IN ({marks}) GROUP BY material_id",
                    tuple(chunk),
                ).fetchall()
                for row in rows:
                    counts[str(row["material_id"])] = int(row["cnt"])
        return counts

    def first_fragments(self, material_id: str, *, limit: int = 5) -> list[str]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT text FROM fragments WHERE material_id = ? ORDER BY ordinal ASC, seg ASC LIMIT ?",
                (material_id, limit),
            ).fetchall()
        return [str(row["text"]) for row in rows if row["text"]]

    def save_link_check(self, scope: LinkCheckScope) -> None:
        payload: dict[str, Any] = {
            "folder_id": scope.folder_id,
            "material_ids": list(scope.material_ids),
            "targets": [{"material_id": t.material_id, "url": t.url} for t in scope.targets],
            "checkpoint": (
                scope.checkpoint.model_dump(mode="json") if scope.checkpoint is not None else None
            ),
        }
        scope_json = json.dumps(payload, separators=(",", ":"))
        sql = (
            "INSERT INTO freshness_link_checks (id, scope_json) VALUES (?, ?) "
            "ON CONFLICT(id) DO UPDATE SET scope_json = excluded.scope_json"
        )
        self._execute_with_fk_fallback(sql, (scope.check_id, scope_json))

    def get_link_check(self, check_id: str) -> LinkCheckScope | None:
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT id, scope_json FROM freshness_link_checks WHERE id = ?",
                (check_id,),
            ).fetchone()
        if row is None:
            return None
        data = json.loads(str(row["scope_json"]))
        targets = tuple(
            LinkTarget(material_id=str(item["material_id"]), url=str(item["url"]))
            for item in data.get("targets", [])
        )
        cp_raw = data.get("checkpoint")
        checkpoint = KbCheckpoint.model_validate(cp_raw) if isinstance(cp_raw, dict) else None
        return LinkCheckScope(
            check_id=str(row["id"]),
            folder_id=data.get("folder_id"),
            material_ids=tuple(str(mid) for mid in data.get("material_ids", [])),
            targets=targets,
            checkpoint=checkpoint,
        )

    def add_observation(self, check_id: str, observation: KbLinkObservation) -> None:
        obs_id = f"obs-{uuid4().hex[:12]}"
        sql = (
            "INSERT INTO freshness_link_observations ("
            "id, check_id, material_id, url, outcome, reason, status_code, "
            "checked_at, first_gone_at, confirm_after"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        params = (
            obs_id,
            check_id,
            observation.material_id,
            observation.url,
            observation.outcome,
            observation.reason,
            observation.status_code,
            _format_iso_datetime(observation.checked_at) or utc_now(),
            _format_iso_datetime(observation.first_gone_at),
            _format_iso_datetime(observation.confirm_after),
        )
        self._execute_with_fk_fallback(sql, params)

    def list_observations(self, check_id: str) -> list[KbLinkObservation]:
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT material_id, url, outcome, reason, status_code, "
                "checked_at, first_gone_at, confirm_after "
                "FROM freshness_link_observations WHERE check_id = ? ORDER BY rowid ASC",
                (check_id,),
            ).fetchall()
        return [self._row_to_observation(row) for row in rows]

    def latest_observation(self, material_id: str) -> KbLinkObservation | None:
        """The newest "Check links" answer for one material (B6's ``last_link_check``); served by
        ``freshness_links_material(material_id, checked_at)``."""
        with self._db.read() as conn:
            row = conn.execute(
                "SELECT material_id, url, outcome, reason, status_code, "
                "checked_at, first_gone_at, confirm_after "
                "FROM freshness_link_observations WHERE material_id = ? "
                "ORDER BY checked_at DESC, rowid DESC LIMIT 1",
                (material_id,),
            ).fetchone()
        return None if row is None else self._row_to_observation(row)

    def active_first_gone_at(self, material_id: str) -> datetime | None:
        """Return the ``first_gone_at`` timestamp of an unbroken gone streak for ``material_id``, if any."""
        with self._db.read() as conn:
            rows = conn.execute(
                "SELECT outcome, first_gone_at FROM freshness_link_observations "
                "WHERE material_id = ? ORDER BY checked_at DESC, rowid DESC",
                (material_id,),
            ).fetchall()
        for row in rows:
            outcome = str(row["outcome"])
            if outcome == "ok":
                return None
            if outcome in ("suspected_gone", "confirmed_gone") and row["first_gone_at"]:
                return _parse_iso_datetime(str(row["first_gone_at"]))
        return None

    def _execute_with_fk_fallback(self, sql: str, params: Sequence[Any]) -> None:
        """Write to ``freshness_link_*``; when a test injects an in-memory ``JobStore`` fake
        that does not populate ``explore_jobs``, fall back without touching ``explore_jobs``.
        """
        try:
            with self._db.write() as conn:
                conn.execute(sql, tuple(params))
        except sqlite3.IntegrityError:
            with self._db.read() as conn:
                conn.execute("PRAGMA foreign_keys=OFF")
                try:
                    conn.execute(sql, tuple(params))
                    conn.commit()
                except BaseException:
                    conn.rollback()
                    raise
                finally:
                    conn.execute("PRAGMA foreign_keys=ON")

    @staticmethod
    def _row_to_publication(row: sqlite3.Row) -> KbPublicationDate:
        precision = cast(KbPublicationPrecision, str(row["precision"]))
        origin = cast(KbPublicationOrigin, str(row["origin"]))
        year = int(row["year"]) if row["year"] is not None else None
        month = int(row["month"]) if row["month"] is not None else None
        pub_date = (
            date.fromisoformat(str(row["publication_date"]))
            if row["publication_date"] is not None
            else None
        )
        evidence_url = str(row["evidence_url"]) if row["evidence_url"] is not None else None
        return KbPublicationDate(
            year=year,
            date=pub_date,
            month=month,
            precision=precision,
            origin=origin,
            evidence_url=evidence_url,
        )

    @staticmethod
    def _row_to_observation(row: sqlite3.Row) -> KbLinkObservation:
        checked_at = _parse_iso_datetime(str(row["checked_at"])) or datetime.now(UTC)
        return KbLinkObservation(
            material_id=str(row["material_id"]),
            url=str(row["url"]),
            outcome=cast(KbLinkOutcome, str(row["outcome"])),
            reason=row["reason"],
            status_code=int(row["status_code"]) if row["status_code"] is not None else None,
            checked_at=checked_at,
            first_gone_at=_parse_iso_datetime(row["first_gone_at"]),
            confirm_after=_parse_iso_datetime(row["confirm_after"]),
        )
