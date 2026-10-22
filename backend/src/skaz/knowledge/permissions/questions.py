"""``QuestionBroker``: an agent's question waits for the user's answer (decisions S13, Q-A1–Q-A3).

* ``ask`` shows the question block and waits without a timeout until the user picks an
  option, writes an answer, writes their own chat message instead, or the answer is stopped.
* The user's own chat message while a question waits closes it (``superseded``); the agent
  gets "The user didn't pick an option and wrote: …" and answers that message.
* An option picked later (after ``superseded`` or ``cancelled``) is sent as a new chat
  message "Answer to the question: …" (``late_answer``, the chat service's ``send``).

Every engine's native question (Hermes ``clarify`` over ACP ``elicitation/create``) and the
SKAZ fallback tool ``skaz_ask_user`` come here, so the chat shows one block for all three.
Logs carry ids and states only — never the question, the options or the answer.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Literal

from ...native_io import disk_call
from ..errors import KnowledgeError, NotFound
from ..ids import new_id
from ..ids import utc_now as _now
from .broker import PermissionConflict
from .store import ControlStore, QuestionOption, QuestionRecord, RunRef
from .waits import RunWaits

log = logging.getLogger(__name__)

OWN_WORDS = "The user didn't pick an option and wrote: {text}"
LATE = "Answer to the question: {answer}"
MAX_OPTIONS = 4
MAX_ANSWER = 10_000
ANSWERED = "This question is already answered."


class QuestionInvalid(KnowledgeError):
    status_code = 422


@dataclass(frozen=True)
class Reply:
    """What the waiting agent gets."""

    status: Literal["answered", "cancelled"]
    #: The chosen option's label, the user's own answer, or "The user didn't pick an option and wrote: …".
    text: str | None
    option_index: int | None = None


Listener = Callable[[QuestionRecord], None]
LateAnswer = Callable[[str, str], Awaitable[None]]


class QuestionBroker:
    def __init__(self, store: ControlStore, waits: RunWaits, *, clock: Callable[[], str] = _now) -> None:
        self.store = store
        self.waits = waits
        self._clock = clock
        self._futures: dict[str, asyncio.Future[Reply]] = {}
        self.listeners: list[Listener] = []
        #: ``(chat_id, text)`` → a new user message in that chat (set by the chat service).
        self.late_answer: LateAnswer | None = None

    def _notify(self, record: QuestionRecord) -> None:
        for listener in list(self.listeners):
            try:
                listener(record)
            except Exception as error:
                log.error("Question listener failed for %s: %s", record.id, type(error).__name__)

    def get(self, question_id: str) -> QuestionRecord:
        record = self.store.question(question_id)
        if record is None:
            raise NotFound("Question not found.")
        return record

    def waiting_chats(self) -> set[str]:
        return {record.chat_id for record in self.store.pending_questions()}

    def waiting_in(self, chat_id: str) -> bool:
        """Questions of a chat that some run still waits for (an answer can still reach the agent)."""
        return any(record.id in self._futures for record in self.store.pending_questions(chat_id=chat_id))

    async def ask(self, run: RunRef, question: str, options: Sequence[QuestionOption]) -> Reply:
        text = " ".join(question.split())
        if not text:
            raise QuestionInvalid("The question is empty.")
        clean = tuple(QuestionOption(" ".join(option.label.split())[:200],
                                     " ".join(option.description.split())[:500], option.recommended)
                      for option in options if option.label.strip())[:MAX_OPTIONS]
        # The recommended option comes first (Q-A3).
        clean = tuple(sorted(clean, key=lambda option: not option.recommended))
        record = QuestionRecord(id=new_id("q"), chat_id=run.chat_id, message_id=run.message_id,
                                run_id=run.run_id, engine=run.engine, question=text[:4_000], options=clean,
                                status="pending", answer=None, created_at=self._clock(), answered_at=None)
        future: asyncio.Future[Reply] = asyncio.get_running_loop().create_future()
        self._futures[record.id] = future
        await disk_call(self.store.add_question, record)
        log.info("Question %s (%s) waits for the user", record.id, run.engine)
        self.waits.begin(run.run_id)
        try:
            self._notify(record)
            return await future
        except asyncio.CancelledError:
            stopped = self.store.update_question(record.id, expect=("pending",), status="cancelled",
                                                 answered_at=self._clock())
            if stopped is not None:
                self._notify(stopped)
            raise
        finally:
            self.waits.end(run.run_id)
            self._futures.pop(record.id, None)

    async def answer(self, question_id: str, *, option_index: int | None = None,
                     text: str | None = None) -> QuestionRecord:
        record = await disk_call(self.get, question_id)
        if (option_index is None) == (text is None or not text.strip()):
            raise QuestionInvalid("Pick one option or write an answer.")
        if option_index is not None and not 0 <= option_index < len(record.options):
            raise QuestionInvalid("There is no such option.")
        if record.status == "answered":
            raise PermissionConflict(ANSWERED, "ALREADY_ANSWERED")
        chosen = record.options[option_index].label if option_index is not None else " ".join(
            (text or "").split())[:MAX_ANSWER]
        future = self._futures.get(question_id)
        if record.status == "pending" and future is not None and not future.done():
            updated = await disk_call(self.store.update_question, question_id, expect=("pending",),
                                      status="answered", answer=chosen, answered_at=self._clock())
            if updated is None:
                raise PermissionConflict(ANSWERED, "ALREADY_ANSWERED")
            future.set_result(Reply("answered", chosen, option_index))
            log.info("Question %s answered", question_id)
            self._notify(updated)
            return updated
        # Nobody waits any more (the user wrote their own message, or the answer stopped): a new message.
        if self.late_answer is None:
            raise PermissionConflict("The agent is no longer waiting for this answer.", "NOT_WAITING")
        await self.late_answer(record.chat_id, LATE.format(answer=chosen))
        updated = await disk_call(self.store.update_question, question_id,
                                  expect=("pending", "superseded", "cancelled"), status="answered",
                                  answer=chosen, answered_at=self._clock())
        if updated is None:
            raise PermissionConflict(ANSWERED, "ALREADY_ANSWERED")
        log.info("Question %s answered later, as a new message", question_id)
        self._notify(updated)
        return updated

    async def supersede(self, chat_id: str, text: str) -> list[QuestionRecord]:
        """The user wrote their own message while questions of this chat wait: each is closed with it."""
        closed: list[QuestionRecord] = []
        for record in await disk_call(self.store.pending_questions, chat_id=chat_id):
            future = self._futures.get(record.id)
            updated = await disk_call(self.store.update_question, record.id, expect=("pending",),
                                      status="superseded", answered_at=self._clock())
            if updated is None:
                continue
            if future is not None and not future.done():
                future.set_result(Reply("answered", OWN_WORDS.format(text=text)))
            log.info("Question %s closed by the user's own message", record.id)
            self._notify(updated)
            closed.append(updated)
        return closed

    async def cancel_run(self, run_id: str) -> int:
        count = 0
        for record in await disk_call(self.store.pending_questions, run_id=run_id):
            updated = await disk_call(self.store.update_question, record.id, expect=("pending",),
                                      status="cancelled", answered_at=self._clock())
            if updated is None:
                continue
            count += 1
            future = self._futures.get(record.id)
            if future is not None and not future.done():
                future.set_result(Reply("cancelled", None))
            self._notify(updated)
        if count:
            log.info("Cancelled %d questions of run %s", count, run_id)
        return count
