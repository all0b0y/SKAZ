"""``PermissionBroker``: an agent's wiki change waits for the user (decisions P2, P3, P4).

* ``request`` creates the card and waits without a timeout until the user answers or
  the answer is stopped (``cancel_run``); a kind the user allowed for the whole chat
  ("Allow in this chat": create, edit or rename — never delete) is allowed at once
  and recorded as automatic (the card shows a row with Undo).
* ``decide`` answers a pending request once; a second answer is 409.
* Every change of a request goes to ``listeners`` (the chat shows it as a part update).
* After a restart nothing waits any more: ``recover`` marks what was pending as cancelled.

Logs carry ids, kinds, engines and states — never the change itself or the user's reason.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from typing import Any, Literal

from ...native_io import disk_call
from ..errors import KnowledgeError, NotFound
from ..ids import new_id
from ..ids import utc_now as _now
from .store import (
    GRANTABLE,
    ControlStore,
    PermissionKind,
    PermissionRecord,
    RunRef,
)
from .waits import RunWaits

log = logging.getLogger(__name__)

Decision = Literal["allow", "allow_chat", "deny"]
STOPPED = "The answer was stopped before you decided."
RESTARTED = "SKAZ was closed before you decided."
NOT_WAITING = "The agent is no longer waiting for this answer."
ALWAYS_ASKS = "Deleting a page always asks: “Allow in this chat” doesn't cover it."
ALREADY = "This request was already answered."
MAX_REASON = 500


class PermissionConflict(KnowledgeError):
    status_code = 409

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


class PermissionInvalid(KnowledgeError):
    status_code = 422


@dataclass(frozen=True)
class Verdict:
    """What the waiting tool learns: ``allowed`` (by the user or a chat grant), ``denied``, ``cancelled``."""

    status: Literal["allowed", "denied", "cancelled"]
    permission: PermissionRecord

    @property
    def reason(self) -> str | None:
        return self.permission.reason


Listener = Callable[[PermissionRecord], None]


class PermissionBroker:
    def __init__(self, store: ControlStore, waits: RunWaits, *, clock: Callable[[], str] = _now) -> None:
        self.store = store
        self.waits = waits
        self._clock = clock
        self._futures: dict[str, asyncio.Future[PermissionRecord]] = {}
        self.listeners: list[Listener] = []

    def _notify(self, record: PermissionRecord) -> None:
        for listener in list(self.listeners):
            try:
                listener(record)
            except Exception as error:  # a listener must never break the agent's call
                log.error("Permission listener failed for %s: %s", record.id, type(error).__name__)

    def recover(self) -> int:
        """Startup: requests (and questions) left pending by an earlier process can't be answered now."""
        permissions, questions = self.store.cancel_all_pending(self._clock(), RESTARTED)
        if permissions or questions:
            log.info("Cancelled %d permission requests and %d questions left by an earlier start",
                     permissions, questions)
        return permissions

    def get(self, permission_id: str) -> PermissionRecord:
        record = self.store.permission(permission_id)
        if record is None:
            raise NotFound("Permission request not found.")
        return record

    def waiting_chats(self) -> set[str]:
        return {record.chat_id for record in self.store.pending_permissions()}

    async def request(self, run: RunRef, kind: PermissionKind, *, page_id: str | None, title: str,
                      preview: Mapping[str, Any]) -> Verdict:
        now = self._clock()
        base = PermissionRecord(
            id=new_id("perm"), chat_id=run.chat_id, message_id=run.message_id, run_id=run.run_id,
            engine=run.engine, kind=kind, page_id=page_id, title=title, preview=dict(preview),
            status="pending", reason=None, auto=False, applied=False, created_at=now, decided_at=None,
        )
        if kind in GRANTABLE and await disk_call(self.store.granted, run.chat_id, kind):
            record = replace(base, status="allowed", auto=True, decided_at=now)
            await disk_call(self.store.add_permission, record)
            log.info("Permission %s (%s, %s) allowed by the chat's grant", record.id, kind, run.engine)
            self._notify(record)
            return Verdict("allowed", record)
        future: asyncio.Future[PermissionRecord] = asyncio.get_running_loop().create_future()
        self._futures[base.id] = future
        await disk_call(self.store.add_permission, base)
        log.info("Permission %s (%s, %s) waits for the user", base.id, kind, run.engine)
        self.waits.begin(run.run_id)
        try:
            self._notify(base)
            decided = await future
        except asyncio.CancelledError:
            # The waiting call was abandoned (the answer task was cancelled): nobody can apply it now.
            stopped = self.store.update_permission(base.id, expect=("pending",), status="cancelled",
                                                   reason=STOPPED, decided_at=self._clock())
            if stopped is not None:
                self._notify(stopped)
            raise
        finally:
            self.waits.end(run.run_id)
            self._futures.pop(base.id, None)
        status = decided.status if decided.status in ("allowed", "denied") else "cancelled"
        return Verdict(status, decided)

    async def decide(self, permission_id: str, decision: Decision,
                     reason: str | None = None) -> PermissionRecord:
        record = await disk_call(self.get, permission_id)
        if record.status != "pending":
            raise PermissionConflict(ALREADY, "ALREADY_DECIDED")
        if decision == "allow_chat" and record.kind not in GRANTABLE:
            raise PermissionInvalid(ALWAYS_ASKS)
        clean = (reason or "").strip()[:MAX_REASON] or None
        future = self._futures.get(permission_id)
        if future is None or future.done():
            stale = await disk_call(self.store.update_permission, permission_id, expect=("pending",),
                                    status="cancelled", reason=NOT_WAITING, decided_at=self._clock())
            if stale is not None:
                self._notify(stale)
            raise PermissionConflict(NOT_WAITING, "NOT_WAITING")
        status = "denied" if decision == "deny" else "allowed"
        updated = await disk_call(self.store.update_permission, permission_id, expect=("pending",),
                                  status=status, reason=clean if status == "denied" else None,
                                  decided_at=self._clock())
        if updated is None:
            raise PermissionConflict(ALREADY, "ALREADY_DECIDED")
        if decision == "allow_chat":
            await disk_call(self.store.grant, record.chat_id, record.kind, self._clock())
        log.info("Permission %s %s by the user (%s)", permission_id, status, decision)
        if not future.done():
            future.set_result(updated)
        self._notify(updated)
        return updated

    async def cancel_run(self, run_id: str, reason: str = STOPPED) -> int:
        """Stop of the answer: every request of the run that still waits is cancelled; the agent gets that."""
        pending = await disk_call(self.store.pending_permissions, run_id=run_id)
        count = 0
        for record in pending:
            updated = await disk_call(self.store.update_permission, record.id, expect=("pending",),
                                      status="cancelled", reason=reason, decided_at=self._clock())
            if updated is None:
                continue
            count += 1
            future = self._futures.get(record.id)
            if future is not None and not future.done():
                future.set_result(updated)
            self._notify(updated)
        if count:
            log.info("Cancelled %d permission requests of run %s", count, run_id)
        return count

    async def settle(self, permission_id: str, **fields: Any) -> PermissionRecord | None:
        """Record what happened after the decision (applied + Undo snapshot, or why it could not be)."""
        updated = await disk_call(self.store.update_permission, permission_id, **fields)
        if updated is not None:
            self._notify(updated)
        return updated

    def close(self) -> None:
        for future in list(self._futures.values()):
            with contextlib.suppress(asyncio.InvalidStateError):
                future.cancel()
