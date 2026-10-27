"""W-2: an agent's web search waits for the user before it is sent (query-only, decision W-a).

* :meth:`WebSearchBroker.request` records the exact query as a card and waits — without a
  timeout — for Allow once / Allow in this chat / Deny, or until the answer is stopped. A chat
  with "Allow in this chat" gets the query allowed at once; SKAZ still holds and records it
  (``auto``), so every query stays visible and query-only.
* The grant lives in ``web_search_grants`` (one row per chat): it survives a restart, ends with
  the chat or when the user revokes it, and never covers another chat or a wiki job.
* After a restart nothing waits any more: :meth:`recover` cancels what was pending.

N7: the user's search rules (``search_rules``) are snapshot on each request when it is asked; an
engine that filters by domain gets them as its domain filters (the verdict), and every result is
screened before it is recorded or given to the agent — the hidden links are only counted per site.

Logs carry ids, engines and states — never the query or the links.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sqlite3
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from typing import Any, Literal, cast

from ...native_io import disk_call
from ..agents.web import WebLink, WebQuery, WebVerdict, clean_links
from ..errors import NotFound
from ..ids import new_id
from ..ids import utc_now as _now
from ..store.database import KnowledgeDatabase
from .broker import ALREADY, NOT_WAITING, RESTARTED, STOPPED, PermissionConflict
from .search_rules import ActiveRules, engine_domains, screen
from .store import RunRef
from .waits import RunWaits

log = logging.getLogger(__name__)

WebStatus = Literal["pending", "allowed", "denied", "cancelled"]
WebDecision = Literal["allow", "allow_chat", "deny"]
#: N7: every site the agent asked to search is outside the user's rules — nothing was sent.
OUTSIDE_RULES = ("Every site you asked to search is blocked or outside the user's allowed sites; nothing "
                 "was sent. Search without those sites, or say what is missing.")
DENIED = ("The user didn't allow this web search; nothing was sent. Don't search for it again unless "
          "the user asks — answer from the library or say what is missing.")
CANCELLED = "The web search was cancelled; nothing was sent."
#: Q1 n78 H-2: the agent's own search (Claude Code's WebSearch) under the user's hard search rules.
NATIVE_HELD = ("The user's search rules (blocked sites or «only these sites») are on in this chat, so SKAZ "
               "doesn't use your own web search here: SKAZ couldn't remove the links they rule out before "
               "you see them. Nothing was sent. Search with skaz_web_search if you have it in this chat; "
               "otherwise tell the user their search rules prevent this search.")


@dataclass(frozen=True)
class WebSearchRecord:
    id: str
    chat_id: str
    message_id: str
    run_id: str
    engine: str
    query: str
    allowed_domains: tuple[str, ...]
    blocked_domains: tuple[str, ...]
    status: WebStatus
    auto: bool
    reason: str | None
    links: tuple[WebLink, ...]
    created_at: str
    decided_at: str | None
    #: W-3b: the agent whose own search runs it (``None``: the asking agent's own search).
    searcher: str | None = None
    #: N7: the user's rules in force for this query (``None``: none were set, or an older record).
    rules: ActiveRules | None = None
    #: N7: links the rules removed from the result, per site.
    hidden: tuple[tuple[str, int], ...] = ()


def _hidden(raw: object) -> tuple[tuple[str, int], ...]:
    data = json.loads(raw) if isinstance(raw, str) and raw else {}
    return tuple((str(site), int(count)) for site, count in data.items()
                 if isinstance(count, int)) if isinstance(data, dict) else ()


def _record(row: sqlite3.Row) -> WebSearchRecord:
    domains = json.loads(row["domains"] or "{}")
    links = json.loads(row["links"] or "[]")
    return WebSearchRecord(
        id=row["id"], chat_id=row["chat_id"], message_id=row["message_id"], run_id=row["run_id"],
        engine=row["engine"], query=row["query"],
        allowed_domains=tuple(domains.get("allowed") or ()),
        blocked_domains=tuple(domains.get("blocked") or ()),
        status=cast(WebStatus, row["status"]), auto=bool(row["auto"]), reason=row["reason"],
        links=tuple(WebLink(str(item.get("title", "")), str(item.get("url", ""))) for item in links
                    if isinstance(item, dict)),
        created_at=row["created_at"], decided_at=row["decided_at"], searcher=row["searcher"],
        rules=ActiveRules.from_json(json.loads(row["rules"])) if row["rules"] else None,
        hidden=_hidden(row["hidden"]),
    )


class WebSearchStore:
    """Plain repository; callers run it off the event loop (``disk_call``)."""

    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    def add(self, record: WebSearchRecord) -> None:
        domains = {"allowed": list(record.allowed_domains), "blocked": list(record.blocked_domains)}
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO web_search_requests(id, chat_id, message_id, run_id, engine, query, domains, "
                "status, auto, reason, links, created_at, decided_at, searcher, rules) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (record.id, record.chat_id, record.message_id, record.run_id, record.engine, record.query,
                 json.dumps(domains), record.status, int(record.auto), record.reason, "[]", record.created_at,
                 record.decided_at, record.searcher,
                 json.dumps(record.rules.to_json(), ensure_ascii=False) if record.rules else None))

    def get(self, search_id: str) -> WebSearchRecord | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM web_search_requests WHERE id = ?",
                                     (search_id,)).fetchone()
        return _record(row) if row else None

    def update(self, search_id: str, *, expect: Sequence[str] | None = None,
               **fields: Any) -> WebSearchRecord | None:
        if not set(fields) <= {"status", "reason", "decided_at", "links", "hidden"}:
            raise ValueError("Unknown web search fields")
        values = dict(fields)
        if "links" in values:
            values["links"] = json.dumps([{"title": link.title, "url": link.url} for link in values["links"]],
                                         ensure_ascii=False)
        if "hidden" in values:
            values["hidden"] = json.dumps(dict(values["hidden"]), ensure_ascii=False)
        query = f"UPDATE web_search_requests SET {', '.join(f'{name} = ?' for name in values)} WHERE id = ?"
        params: list[Any] = [*values.values(), search_id]
        if expect:
            query += f" AND status IN ({','.join('?' for _ in expect)})"
            params += list(expect)
        with self.db.write() as connection:
            changed = connection.execute(query, params).rowcount
        return self.get(search_id) if changed else None

    def pending(self, *, run_id: str | None = None) -> list[WebSearchRecord]:
        query = "SELECT * FROM web_search_requests WHERE status = 'pending'"
        params: tuple[str, ...] = ()
        if run_id is not None:
            query, params = query + " AND run_id = ?", (run_id,)
        with self.db.read() as connection:
            return [_record(row) for row in connection.execute(query, params).fetchall()]

    def waiting_chats(self) -> set[str]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT DISTINCT chat_id FROM web_search_requests WHERE status = 'pending'").fetchall()
        return {row[0] for row in rows}

    def grant(self, chat_id: str, now: str) -> None:
        with self.db.write() as connection:
            connection.execute("INSERT OR IGNORE INTO web_search_grants(chat_id, granted_at) VALUES (?, ?)",
                               (chat_id, now))

    def granted_at(self, chat_id: str) -> str | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT granted_at FROM web_search_grants WHERE chat_id = ?",
                                     (chat_id,)).fetchone()
        return str(row[0]) if row else None

    def revoke(self, chat_id: str) -> bool:
        with self.db.write() as connection:
            deleted = connection.execute("DELETE FROM web_search_grants WHERE chat_id = ?", (chat_id,))
            return deleted.rowcount > 0

    def cancel_all_pending(self, now: str, reason: str) -> int:
        with self.db.write() as connection:
            return connection.execute(
                "UPDATE web_search_requests SET status = 'cancelled', reason = ?, decided_at = ? "
                "WHERE status = 'pending'", (reason, now)).rowcount


Listener = Callable[[WebSearchRecord], None]
#: N7: the rules for a search about to be asked in a chat (spends a «Search everywhere once»).
RulesSource = Callable[[str], ActiveRules]


class WebSearchBroker:
    def __init__(self, store: WebSearchStore, waits: RunWaits, *, clock: Callable[[], str] = _now,
                 rules: RulesSource | None = None) -> None:
        self.store = store
        #: N7: set by the runtime once the rules store exists (``None``: no rules, e.g. in tests).
        self.rules = rules
        #: The rules in force now, without spending anything (Q1 H-2: may the agent's own search run?).
        self.current: RulesSource | None = None
        self.waits = waits
        self._clock = clock
        self._futures: dict[str, asyncio.Future[WebSearchRecord]] = {}
        self.listeners: list[Listener] = []

    def _notify(self, record: WebSearchRecord) -> None:
        for listener in list(self.listeners):
            try:
                listener(record)
            except Exception as error:  # a listener must never break the agent's call
                log.error("Web search listener failed for %s: %s", record.id, type(error).__name__)

    def recover(self) -> int:
        """Startup: queries left pending by an earlier process can't be answered now."""
        count = self.store.cancel_all_pending(self._clock(), RESTARTED)
        if count:
            log.info("Cancelled %d web searches left by an earlier start", count)
        return count

    async def native_held(self, chat_id: str) -> bool:
        """The user's hard rules keep the asking agent's own search off in this chat (Q1 n78 H-2)."""
        if self.current is None:
            return False
        return (await disk_call(self.current, chat_id)).hard

    def get(self, search_id: str) -> WebSearchRecord:
        record = self.store.get(search_id)
        if record is None:
            raise NotFound("Web search not found.")
        return record

    async def request(self, run: RunRef, query: WebQuery) -> WebSearchRecord:
        now = self._clock()
        rules = await disk_call(self.rules, run.chat_id) if self.rules is not None else None
        allowed, blocked = query.allowed_domains, query.blocked_domains
        refused = False
        if rules is not None and query.searcher is None:
            # The asking agent's own search filters by domain (Claude Code): the card shows what is sent.
            sent = engine_domains(rules, allowed, blocked)
            allowed, blocked, refused = sent.allowed, sent.blocked, sent.refused
        base = WebSearchRecord(
            id=new_id("web"), chat_id=run.chat_id, message_id=run.message_id, run_id=run.run_id,
            engine=str(run.engine), query=query.query, allowed_domains=allowed,
            blocked_domains=blocked, status="pending", auto=False, reason=None, links=(),
            created_at=now, decided_at=None, searcher=query.searcher,
            rules=None if rules is None or rules.empty else rules)
        if refused:
            record = replace(base, status="denied", auto=True, reason=OUTSIDE_RULES, decided_at=now)
            await disk_call(self.store.add, record)
            log.info("Web search %s (%s) refused by the user's search rules", record.id, record.engine)
            self._notify(record)
            return record
        if await disk_call(self.store.granted_at, run.chat_id) is not None:
            record = replace(base, status="allowed", auto=True, decided_at=now)
            await disk_call(self.store.add, record)
            log.info("Web search %s (%s) allowed by the chat's grant", record.id, record.engine)
            self._notify(record)
            return record
        future: asyncio.Future[WebSearchRecord] = asyncio.get_running_loop().create_future()
        self._futures[base.id] = future
        await disk_call(self.store.add, base)
        log.info("Web search %s (%s) waits for the user", base.id, base.engine)
        self.waits.begin(run.run_id)
        try:
            self._notify(base)
            return await future
        except asyncio.CancelledError:
            stopped = await asyncio.shield(disk_call(self.store.update, base.id, expect=("pending",),
                                                     status="cancelled", reason=STOPPED,
                                                     decided_at=self._clock()))
            if stopped is not None:
                self._notify(stopped)
            raise
        finally:
            self.waits.end(run.run_id)
            self._futures.pop(base.id, None)

    async def decide(self, search_id: str, decision: WebDecision) -> WebSearchRecord:
        record = await disk_call(self.get, search_id)
        if record.status != "pending":
            raise PermissionConflict(ALREADY, "ALREADY_DECIDED")
        future = self._futures.get(search_id)
        if future is None or future.done():
            stale = await disk_call(self.store.update, search_id, expect=("pending",), status="cancelled",
                                    reason=NOT_WAITING, decided_at=self._clock())
            if stale is not None:
                self._notify(stale)
            raise PermissionConflict(NOT_WAITING, "NOT_WAITING")
        status = "denied" if decision == "deny" else "allowed"
        updated = await disk_call(self.store.update, search_id, expect=("pending",), status=status,
                                  decided_at=self._clock())
        if updated is None:
            raise PermissionConflict(ALREADY, "ALREADY_DECIDED")
        if decision == "allow_chat":
            await disk_call(self.store.grant, record.chat_id, self._clock())
        log.info("Web search %s %s by the user (%s)", search_id, status, decision)
        if not future.done():
            future.set_result(updated)
        self._notify(updated)
        return updated

    async def cancel_run(self, run_id: str, reason: str = STOPPED) -> int:
        count = 0
        for record in await disk_call(self.store.pending, run_id=run_id):
            updated = await disk_call(self.store.update, record.id, expect=("pending",), status="cancelled",
                                      reason=reason, decided_at=self._clock())
            if updated is None:
                continue
            count += 1
            future = self._futures.get(record.id)
            if future is not None and not future.done():
                future.set_result(updated)
            self._notify(updated)
        return count

    async def record_links(self, search_id: str, links: Sequence[WebLink]) -> WebSearchRecord | None:
        """Keep the links the user's rules allow (N7); the hidden ones are only counted per site."""
        record = await disk_call(self.store.get, search_id)
        screened = screen(clean_links(links), record.rules if record is not None else None)
        updated = await disk_call(self.store.update, search_id, expect=("allowed",), links=screened.kept,
                                  hidden=screened.hidden)
        if updated is not None:
            self._notify(updated)
        return updated

    def close(self) -> None:
        for future in list(self._futures.values()):
            with contextlib.suppress(asyncio.InvalidStateError):
                future.cancel()


@dataclass(frozen=True)
class ChatWebGate:
    """The web gate of one chat answer (``AgentTurn.web``)."""

    broker: WebSearchBroker
    run: RunRef

    async def approve(self, query: WebQuery) -> WebVerdict:
        if query.searcher is None and await self.broker.native_held(self.run.chat_id):
            # Refused before any card: the chat searches through ``skaz_web_search`` (it says so).
            return WebVerdict(False, NATIVE_HELD)
        record = await self.broker.request(self.run, query)
        if record.status == "allowed":
            if record.rules is None:
                return WebVerdict(True, search_id=record.id)
            return WebVerdict(True, search_id=record.id, allowed_domains=record.allowed_domains,
                              blocked_domains=record.blocked_domains, rules=record.rules)
        if record.status == "denied":
            return WebVerdict(False, record.reason or DENIED, search_id=record.id)
        return WebVerdict(False, CANCELLED, search_id=record.id)

    async def results(self, search_id: str, links: Sequence[WebLink]) -> WebSearchRecord | None:
        """Record the links; returns the card with only the links the user's rules allow (N7)."""
        return await self.broker.record_links(search_id, links)
