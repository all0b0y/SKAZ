"""B1 storage: ``science_works`` (work cache), ``science_egress`` (the journal), ``science_paid_checks``,
and the B1 app settings (switch, consent, hint, the OpenAlex day ledger, the taxonomy cache).

Synchronous; the async callers wrap each call in ``disk_call``. The OpenAlex key is not here: it lives in
the app's secret store.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from ..api.schemas_science import (
    KbScienceEgress,
    KbSciencePayload,
    KbScienceProvider,
    KbScienceWork,
)
from ..errors import KnowledgeError
from ..ids import new_id
from ..store.database import KnowledgeDatabase
from ..store.repositories import SettingsRepository
from .protocols import TaxonomyNode

ENABLED = "science.enabled"
CONSENT_AT = "science.consent_at"
HINT_DISMISSED = "science.full_text_hint_dismissed"
LEDGER = "science.openalex.ledger"
TAXONOMY = "science.taxonomy."
TAXONOMY_MAX_AGE = timedelta(days=30)
_LEDGER_LOCK = threading.Lock()


class BadCursor(KnowledgeError):
    status_code = 422


@dataclass(frozen=True)
class PaidCheck:
    checked_at: datetime | None
    alternatives: list[str]
    suggestion_shown_at: datetime | None


def stamp(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_stamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def next_midnight(now: datetime) -> datetime:
    day = now.astimezone(UTC).date() + timedelta(days=1)
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


class ScienceStore:
    def __init__(self, db: KnowledgeDatabase, settings: SettingsRepository) -> None:
        self.db = db
        self.settings = settings

    # -- settings --------------------------------------------------------------------------------------

    def enabled(self) -> bool:
        return self.settings.get(ENABLED, False) is True

    def consent_at(self) -> datetime | None:
        return parse_stamp(self.settings.get(CONSENT_AT))

    def set_enabled(self, enabled: bool, now: datetime) -> None:
        """Turning on records the consent time; turning off withdraws it."""
        self.settings.set(ENABLED, enabled)
        self.settings.set(CONSENT_AT, stamp(now) if enabled else None)

    def hint_dismissed(self) -> bool:
        return self.settings.get(HINT_DISMISSED, False) is True

    def dismiss_hint(self) -> None:
        self.settings.set(HINT_DISMISSED, True)

    # -- the OpenAlex day ledger -----------------------------------------------------------------------

    def _ledger(self, now: datetime) -> dict[str, Any]:
        raw = self.settings.get(LEDGER, {})
        ledger = dict(raw) if isinstance(raw, dict) else {}
        today = now.astimezone(UTC).date().isoformat()
        if ledger.get("day") != today:
            blocked = parse_stamp(ledger.get("blocked_until"))
            ledger = {
                "day": today,
                "usd": 0.0,
                "blocked_until": stamp(blocked) if blocked is not None and blocked > now else None,
            }
        return ledger

    def reserve(self, cost: float, allowance: float, now: datetime) -> datetime | None:
        """Books ``cost`` for today, or returns when the day's budget is available again (nothing booked)."""
        with _LEDGER_LOCK:
            ledger = self._ledger(now)
            blocked = parse_stamp(ledger.get("blocked_until"))
            if blocked is not None and blocked > now:
                return blocked
            spent = float(ledger.get("usd") or 0.0)
            if cost > 0 and spent + cost > allowance + 1e-9:
                return next_midnight(now)
            ledger["usd"] = round(spent + cost, 6)
            self.settings.set(LEDGER, ledger)
            return None

    def block_until(self, until: datetime, now: datetime) -> None:
        """OpenAlex said the day's budget is spent: no OpenAlex request leaves before ``until``."""
        with _LEDGER_LOCK:
            ledger = self._ledger(now)
            ledger["blocked_until"] = stamp(until)
            self.settings.set(LEDGER, ledger)

    def spent_today(self, now: datetime) -> float:
        return float(self._ledger(now).get("usd") or 0.0)

    # -- egress journal -------------------------------------------------------------------------------

    def journal_open(
        self,
        provider: KbScienceProvider,
        operation: str,
        host: str,
        payload: KbSciencePayload,
        run_id: str | None,
        now: datetime,
    ) -> str:
        """Written BEFORE the request leaves (outcome ``sent``)."""
        record_id = new_id("egress")
        with self.db.write() as conn:
            conn.execute(
                "INSERT INTO science_egress(id, requested_at, provider, operation, destination_host, "
                "topics_json, dois_json, ids_json, outcome, status_code, run_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', NULL, ?)",
                (
                    record_id,
                    stamp(now),
                    provider,
                    operation,
                    host,
                    json.dumps(payload.topics),
                    json.dumps(payload.dois),
                    json.dumps(payload.ids),
                    run_id,
                ),
            )
        return record_id

    def journal_close(self, record_id: str, outcome: str, status_code: int | None) -> None:
        with self.db.write() as conn:
            conn.execute(
                "UPDATE science_egress SET outcome = ?, status_code = ? WHERE id = ?",
                (outcome, status_code, record_id),
            )

    def journal(self, cursor: str | None, limit: int) -> tuple[list[KbScienceEgress], str | None]:
        """Newest first (insertion order breaks ties); the cursor is the last row's ``requested_at~rowid``."""
        where, args = "", tuple[str, ...]()
        if cursor:
            at, sep, last_row = cursor.partition("~")
            if not sep or parse_stamp(at) is None or not last_row.isdigit():
                raise BadCursor("Bad journal cursor")
            where = "WHERE (requested_at < ? OR (requested_at = ? AND rowid < ?))"
            args = (at, at, last_row)
        with self.db.read() as conn:
            rows = conn.execute(
                f"SELECT rowid AS row_no, * FROM science_egress {where} "
                "ORDER BY requested_at DESC, rowid DESC LIMIT ?",
                (*args, limit + 1),
            ).fetchall()
        records = [
            KbScienceEgress(
                id=row["id"],
                requested_at=parse_stamp(row["requested_at"]) or datetime.now(UTC),
                provider=row["provider"],
                operation=row["operation"],
                destination_host=row["destination_host"],
                payload=KbSciencePayload(
                    topics=json.loads(row["topics_json"]),
                    dois=json.loads(row["dois_json"]),
                    ids=json.loads(row["ids_json"]),
                ),
                outcome=row["outcome"],
                status_code=row["status_code"],
                run_id=row["run_id"],
            )
            for row in rows[:limit]
        ]
        last = rows[limit - 1] if len(rows) > limit else None
        return records, (f"{last['requested_at']}~{last['row_no']}" if last is not None else None)

    # -- works -----------------------------------------------------------------------------------------

    def save_works(self, works: Sequence[KbScienceWork], now: datetime) -> None:
        if not works:
            return
        with self.db.write() as conn:
            for work in works:
                data = work.model_dump(mode="json")
                conn.execute(
                    "INSERT INTO science_works("
                    "id, provider, provider_id, doi, arxiv_id, metadata_json, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET doi = excluded.doi, "
                    "arxiv_id = excluded.arxiv_id, metadata_json = excluded.metadata_json, "
                    "updated_at = excluded.updated_at",
                    (
                        work.id,
                        work.provider,
                        work.provider_id,
                        work.doi,
                        work.arxiv_id,
                        json.dumps(data, ensure_ascii=False),
                        stamp(now),
                    ),
                )

    def _works(self, where: str, args: Sequence[Any]) -> list[KbScienceWork]:
        with self.db.read() as conn:
            rows = conn.execute(
                f"SELECT metadata_json FROM science_works WHERE {where}", tuple(args)
            ).fetchall()
        return [KbScienceWork.model_validate_json(row["metadata_json"]) for row in rows]

    def work(self, work_id: str) -> KbScienceWork | None:
        found = self._works("id = ?", (work_id,))
        return found[0] if found else None

    def works(self, work_ids: Sequence[str]) -> dict[str, KbScienceWork]:
        if not work_ids:
            return {}
        marks = ",".join("?" for _ in work_ids)
        return {work.id: work for work in self._works(f"id IN ({marks})", list(work_ids))}

    def work_by_doi(self, doi: str) -> KbScienceWork | None:
        found = self._works("doi = ? ORDER BY provider = 'openalex' DESC", (doi,))
        return found[0] if found else None

    def work_by_arxiv(self, arxiv_id: str) -> KbScienceWork | None:
        found = self._works("arxiv_id = ? ORDER BY provider = 'openalex' DESC", (arxiv_id,))
        return found[0] if found else None

    # -- paid checks (decision 3c″) ------------------------------------------------------------------

    def paid_check(self, work_id: str) -> PaidCheck | None:
        with self.db.read() as conn:
            row = conn.execute("SELECT * FROM science_paid_checks WHERE work_id = ?", (work_id,)).fetchone()
        if row is None:
            return None
        return PaidCheck(
            parse_stamp(row["checked_at"]),
            list(json.loads(row["alternatives_json"])),
            parse_stamp(row["suggestion_shown_at"]),
        )

    def save_paid_check(self, work_id: str, checked_at: datetime, alternatives: Sequence[str]) -> None:
        with self.db.write() as conn:
            conn.execute(
                "INSERT INTO science_paid_checks(work_id, checked_at, alternatives_json) VALUES (?, ?, ?) "
                "ON CONFLICT(work_id) DO UPDATE SET checked_at = excluded.checked_at, "
                "alternatives_json = excluded.alternatives_json",
                (work_id, stamp(checked_at), json.dumps(list(alternatives))),
            )

    def mark_suggestion(self, work_id: str, at: datetime) -> bool:
        """``True`` only for the first caller: the suggestion is shown at most once per work."""
        with self.db.write() as conn:
            done = conn.execute(
                "UPDATE science_paid_checks SET suggestion_shown_at = ? "
                "WHERE work_id = ? AND suggestion_shown_at IS NULL",
                (stamp(at), work_id),
            )
            return bool(done.rowcount)

    # -- taxonomy cache -------------------------------------------------------------------------------

    def taxonomy(self, parent_id: str | None, now: datetime) -> list[TaxonomyNode] | None:
        raw = self.settings.get(TAXONOMY + (parent_id or "root"))
        if not isinstance(raw, dict):
            return None
        fetched = parse_stamp(raw.get("fetched_at"))
        if fetched is None or now - fetched > TAXONOMY_MAX_AGE:
            return None
        return [TaxonomyNode(**node) for node in raw.get("nodes") or ()]

    def save_taxonomy(self, parent_id: str | None, nodes: Sequence[TaxonomyNode], now: datetime) -> None:
        self.settings.set(
            TAXONOMY + (parent_id or "root"),
            {
                "fetched_at": stamp(now),
                "nodes": [
                    {
                        "taxonomy_id": n.taxonomy_id,
                        "parent_id": n.parent_id,
                        "level": n.level,
                        "name": n.name,
                        "children_total": n.children_total,
                    }
                    for n in nodes
                ],
            },
        )
