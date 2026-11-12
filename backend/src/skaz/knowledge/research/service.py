"""``runtime.kb_research``: research tasks (0.4.0 B3). Implements ``ResearchService``.

* A task is a chat of its own plus one funnel run (B2's ``FunnelRunner.start_for_task``); the task owns no
  funnel logic. It starts from «+» (``create``) or from a chat's ``skaz_research_start`` behind a card.
* Before anything is started the research agent turns the description into topics; only those leave the
  machine (C0-1). The card shows them, so Allow allows exactly what is sent. Deny creates nothing.
* EX2 card: «+» asks for a proposal first (``propose``: title + proposed topics, nothing starts); the user
  keeps/edits/removes them, types own ones and picks own topics from the map, and ``create`` starts with
  exactly that card — no derivation. In a chat, Allow carries the card as the user left it
  (``KbResearchDecide.topics``). Each topic is stored with its source and area; the funnel gets the card as
  its search plan (one item per topic), so search and the fit decision use exactly these topics.
* The card waits like ``WebSearchBroker``: no timeout, Allow once / Allow in this chat / Deny, the grant is
  per chat, Stop cancels it, and after a restart nothing waits (``recover``).
* Progress and the final report go into the task's chat: a short note at every stop (with its honest
  reason) and, when the run has finished, a report whose every point names its finding. The run's facts
  (started, paused, completed) are B2's to record; this service records none.
* Quit: B2 pauses runs with ``app_exit`` and resumes only their free steps at the next start; paid steps
  wait for Continue. This service only follows the run (``on_start``) and reports what it sees.

Logs carry ids and states only — never the description, topics or titles.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable, Sequence
from datetime import datetime
from typing import Any, Literal, Protocol

from ...native_io import disk_call
from ..api.contract_routes import ContractFailure
from ..api.schemas_explore import (
    KbFinding,
    KbFindingChannel,
    KbFunnelRun,
    KbFunnelStart,
    KbSearchPlanItem,
)
from ..api.schemas_explore_common import KbContinue, KbExploreJob
from ..api.schemas_research import (
    KbExploreRead,
    KbExploreSnapshot,
    KbResearchCreate,
    KbResearchDecide,
    KbResearchGrant,
    KbResearchPermission,
    KbResearchProposal,
    KbResearchTask,
    KbResearchTasks,
    KbResearchToolResult,
    KbResearchTopic,
)
from ..areas.protocols import AreasService
from ..chats.model import Message, MessageInput, TextPart
from ..errors import KnowledgeError, NotFound
from ..explore.protocols import ExploreService, FunnelRunner
from ..ids import new_id, utc_now
from ..permissions.broker import ALREADY, NOT_WAITING, RESTARTED, STOPPED, PermissionConflict
from ..permissions.store import RunRef
from ..permissions.waits import RunWaits
from ..service import KnowledgeService
from . import RESEARCH_FINISHED
from .agent import Derived, ResearchAgentUnavailable, SummaryPoint
from .parts import permission_view
from .store import CardTopic, PermissionRow, ResearchStore, TaskRow

logger = logging.getLogger(__name__)

POLL_S = 1.0
READ_TASKS = 10
READ_SIGNALS = 30
REPORT_FINDINGS = 5
_ACTIVE = frozenset({"running", "queued"})
_USEFUL = ("contradicts", "new", "extends", "branch")
_LABEL_WORDS = {
    "new": "new",
    "extends": "extends your wiki",
    "contradicts": "contradicts your wiki",
    "branch": "a neighbouring direction",
}
DENIED_NOTE = (
    "The user didn't allow this research task; nothing was started and nothing was sent. Don't start it "
    "again unless the user asks — help with what the library already has."
)
STARTED_NOTE = (
    "The research task runs in its own chat; the user sees its progress and report there. Don't wait for "
    "it. Its findings appear in Explore; read them with skaz_explore_read (task_id) when the user asks."
)
NOT_STARTED = "The research task wasn't started: {reason} Nothing was sent."


class TaskChats(Protocol):
    """What a task needs from ``ChatService``: its own chat and SKAZ's messages in it."""

    async def create(
        self, *, title: str | None = None, engine: Any = None, model: str | None = None,
        effort: str | None = None,
    ) -> Any: ...
    async def summary(self, chat_id: str) -> Any: ...
    async def post_messages(
        self, chat_id: str, messages: Sequence[Message], *, unread: bool = False
    ) -> list[Message]: ...


class Researcher(Protocol):
    """The research agent (``agent.ResearchAgent``)."""

    async def topics(
        self, description: str, *, engine: str | None = None, model: str | None = None
    ) -> Derived: ...
    async def summary(
        self, description: str, findings: Sequence[KbFinding], *, engine: str | None = None,
        model: str | None = None,
    ) -> list[SummaryPoint]: ...


Listener = Callable[[PermissionRow], None]


def _job(run: KbFunnelRun) -> KbExploreJob:
    """``KbResearchTask.run`` is the plain job (the funnel's own fields stay with the funnel)."""
    return KbExploreJob.model_validate(run.model_dump(include=set(KbExploreJob.model_fields)))


def stop_note(run: KbExploreJob) -> str | None:
    """The task chat's note for a stopped run — honest and short; ``None`` while it runs."""
    reason = run.stop_reason
    if run.state == "cancelled":
        return "Research cancelled. What it found so far stays in Explore."
    if run.state == "error":
        return "Research stopped because something went wrong. What it found so far stays in Explore."
    if run.state != "paused":
        return None
    if reason == "budget":
        limit = run.budget.limit
        return f"Paused after {limit} candidates, the limit of one batch. Continue checks the next {limit}."
    if reason == "user_pause":
        return "Paused. Continue goes on from where it stopped; nothing is checked twice."
    if reason == "app_exit":
        return (
            "Paused because SKAZ was closed. Collecting and sorting go on by themselves at the next start; "
            "checking novelty waits for Continue."
        )
    if reason == "openalex_daily_limit":
        when = f" Try again after {run.retry_at:%Y-%m-%d %H:%M} UTC." if run.retry_at is not None else ""
        return (
            f"Paused: OpenAlex's daily limit is reached.{when} "
            "SKAZ doesn't switch to another source by itself."
        )
    if reason == "decision_model_required":
        return (
            "Paused: no model is chosen to judge whether the works fit this task's topics. "
            "Choose one in this task to go on."
        )
    if reason == "science_consent_required":
        return "Paused: science databases are turned off. Turn them on in Settings → Search, then Continue."
    if reason == "provider_unavailable":
        return "Paused: a science database or the agent didn't answer. Continue tries again."
    return "Paused. Continue goes on from where it stopped."


def counts_line(run: KbExploreJob) -> str:
    counters = run.counters
    line = f"Checked {counters.checked} · on topic {counters.on_topic} · new {counters.new}"
    if counters.covered:
        line += f" · {counters.covered} repeat what you have"
    return line


def report_text(
    run: KbExploreJob, useful: Sequence[KbFinding], points: Sequence[SummaryPoint], problem: str | None
) -> str:
    """The final report: SKAZ's counts and titles; the agent's words only as a point on one finding."""
    lines = [f"Research finished. {counts_line(run)}."]
    if not useful:
        lines.append("")
        lines.append("Nothing new for your wiki this time.")
        return "\n".join(lines)
    noted = {point.finding.id: point.text for point in points}
    ordered = [finding for finding in useful if finding.id in noted]
    ordered += [finding for finding in useful if finding.id not in noted]
    shown = ordered[:REPORT_FINDINGS]
    lines.append("")
    for finding in shown:
        work = finding.work
        year = f" ({work.publication.year})" if work.publication.year is not None else ""
        title = " ".join(work.title.replace("*", "").split())
        line = f"- **{title}**{year} · {_LABEL_WORDS.get(finding.label, finding.label)}"
        if finding.id in noted:
            line += f" — {noted[finding.id]}"
        lines.append(line)
    rest = len(useful) - len(shown)
    lines.append("")
    if rest > 0:
        lines.append(f"{rest} more in Explore → New.")
    else:
        lines.append("All of them are in Explore → New.")
    if problem is not None:
        lines.append(f"I couldn't add notes to these findings: {problem}")
    return "\n".join(lines)


class ResearchTasks:
    def __init__(
        self,
        kb: KnowledgeService,
        store: ResearchStore,
        *,
        funnel: FunnelRunner,
        explore: ExploreService,
        areas: AreasService,
        chats: TaskChats,
        agent: Researcher,
        waits: RunWaits,
        runs: Callable[[str], RunRef | None],
        clock: Callable[[], str] = utc_now,
        poll_s: float = POLL_S,
    ) -> None:
        self.kb = kb
        self.store = store
        self.funnel = funnel
        self.explore = explore
        self.areas = areas
        self.chats = chats
        self.agent = agent
        self.waits = waits
        #: The chat answer a tool call belongs to (``ChatService.run_ref``).
        self.runs = runs
        self._clock = clock
        self._poll_s = poll_s
        self._listeners: list[Listener] = []
        self._futures: dict[str, asyncio.Future[PermissionRow]] = {}
        self._deciding: dict[str, asyncio.Lock] = {}
        self._watchers: dict[str, asyncio.Task[None]] = {}
        self._reporting: dict[str, asyncio.Lock] = {}
        #: Tasks followed since a restart and not continued by the user: their report is written without
        #: an agent run (after Quit only free steps go on by themselves, user decision B2-7).
        self._unattended: set[str] = set()
        #: task id → its run, so a run whose task went with its deleted chat is stopped.
        self._runs_of: dict[str, str] = {}
        self._closing = False

    # -- plumbing ---------------------------------------------------------------------------------------

    def _ensure_ready(self) -> None:
        if self.kb.view().state == "not_configured":
            raise ContractFailure(503, "not_ready")

    def add_listener(self, listener: Listener) -> None:
        self._listeners.append(listener)

    def _notify(self, record: PermissionRow) -> None:
        for listener in list(self._listeners):
            try:
                listener(record)
            except Exception as error:  # a listener never breaks the agent's call
                logger.error("Research card listener failed for %s: %s", record.id, type(error).__name__)

    def _task_row(self, task_id: str) -> TaskRow:
        row = self.store.task(task_id)
        if row is None:
            raise NotFound("This research task wasn't found.")
        return row

    async def _view(self, row: TaskRow) -> KbResearchTask:
        run = await self.funnel.run(row.job_id)
        return KbResearchTask(
            id=row.id,
            title=row.title,
            description=row.description,
            chat_id=row.chat_id,
            origin_chat_id=row.origin_chat_id,
            area_id=row.area_id,
            topics=[_topic_view(topic) for topic in row.card],
            run=_job(run),
            finding_count=run.counters.new,
            created_at=_when(row.created_at),
            updated_at=max(_when(row.updated_at), run.updated_at),
        )

    async def card(self, permission_id: str) -> KbResearchPermission:
        row = await disk_call(self.store.permission, permission_id)
        if row is None:
            raise NotFound("This research request wasn't found.")
        return await self._card(row)

    async def task_of_chat(self, chat_id: str) -> str | None:
        row = await disk_call(self.store.task_of_chat, chat_id)
        return row.id if row is not None else None

    async def _card(self, row: PermissionRow) -> KbResearchPermission:
        task = await disk_call(self.store.task, row.task_id) if row.task_id is not None else None
        job = _job(await self.funnel.run(task.job_id)) if task is not None else None
        return permission_view(row, task, job)

    # -- ResearchService: tasks ------------------------------------------------------------------------

    async def propose(self, body: KbResearchCreate) -> KbResearchProposal:
        """«+» → New research task, before anything starts: the chat agent's title and proposed topics for
        the description. Only the chat agent sees the description; nothing is searched, no task or chat."""
        self._ensure_ready()
        derived = await self._derive(body.description, engine=None, model=None)
        return KbResearchProposal(
            title=derived.title, topics=[_topic_view(topic) for topic in _proposed(derived.topics)]
        )

    async def create(self, body: KbResearchCreate) -> KbResearchTask:
        """«+» → New research task. With the card (``topics``) it starts with exactly those topics, no
        derivation; without it the chat agent derives them and they start as proposed."""
        self._ensure_ready()
        if body.topics is not None:
            card = final_card(body.topics)
            row = await self._start(body, (body.title or "").strip() or card_title(card), card, origin=None)
        else:
            derived = await self._derive(body.description, engine=None, model=None)
            row = await self._start(body, derived.title, _proposed(derived.topics), origin=None)
        return await self._view(row)

    async def tasks(self, cursor: str | None = None, limit: int = 30) -> KbResearchTasks:
        self._ensure_ready()
        offset = _offset(cursor)
        rows, more = await disk_call(self.store.tasks, offset, max(1, min(limit, 100)))
        return KbResearchTasks(
            tasks=[await self._view(row) for row in rows],
            next_cursor=str(offset + len(rows)) if more else None,
        )

    async def task(self, task_id: str) -> KbResearchTask:
        self._ensure_ready()
        return await self._view(await disk_call(self._task_row, task_id))

    async def pause(self, task_id: str) -> KbResearchTask:
        self._ensure_ready()
        row = await disk_call(self._task_row, task_id)
        await self.funnel.pause(row.job_id)
        await self._follow_once(row.id)
        return await self._view(row)

    async def resume(self, task_id: str, body: KbContinue) -> KbResearchTask:
        self._ensure_ready()
        row = await disk_call(self._task_row, task_id)
        await self.funnel.resume(row.job_id, body)
        self._unattended.discard(row.id)
        self._watch(row.id)
        return await self._view(row)

    async def cancel(self, task_id: str) -> KbResearchTask:
        self._ensure_ready()
        row = await disk_call(self._task_row, task_id)
        await self.funnel.cancel(row.job_id)
        await self._follow_once(row.id)
        return await self._view(row)

    # -- ResearchService: cards and grants ------------------------------------------------------------

    async def decide(self, request_id: str, body: KbResearchDecide) -> KbResearchPermission:
        self._ensure_ready()
        lock = self._deciding.setdefault(request_id, asyncio.Lock())
        async with lock:
            record = await disk_call(self.store.permission, request_id)
            if record is None:
                raise NotFound("This research request wasn't found.")
            if record.status != "pending":
                raise PermissionConflict(ALREADY, "ALREADY_DECIDED")
            future = self._futures.get(request_id)
            if future is None or future.done():
                stale = await disk_call(
                    self.store.update_permission, request_id, expect=("pending",), status="cancelled",
                    reason=NOT_WAITING, decided_at=self._clock(),
                )
                if stale is not None:
                    self._notify(stale)
                raise PermissionConflict(NOT_WAITING, "NOT_WAITING")
            if body.decision == "deny":
                updated = await disk_call(
                    self.store.update_permission, request_id, expect=("pending",), status="denied",
                    decided_at=self._clock(),
                )
            else:
                # The card as the user left it (EX2); ``None`` = as proposed. A card that can't be sent
                # (a blank topic) keeps waiting, as below.
                card = final_card(body.topics) if body.topics is not None else _proposed(record.topics)
                # Started first: if it can't start (science off, no agent) the card keeps waiting and the
                # user sees why; Allow stays possible once that is fixed.
                task = await self._start(
                    KbResearchCreate.model_validate(dict(record.arguments)),
                    _title_of(record),
                    card,
                    origin=record.chat_id,
                )
                # The pointer shows what left, not what was proposed.
                updated = await disk_call(
                    self.store.update_permission, request_id, expect=("pending",), status="allowed",
                    decided_at=self._clock(), task_id=task.id, topics=[topic.text for topic in card],
                )
                if updated is None:  # stopped meanwhile: the task it started must not go on unseen
                    with contextlib.suppress(KnowledgeError, ContractFailure):
                        await self.funnel.cancel(task.job_id)
                elif body.decision == "allow_chat":
                    await disk_call(self.store.grant, record.chat_id, self._clock())
            if updated is None:
                raise PermissionConflict(ALREADY, "ALREADY_DECIDED")
            logger.info("Research card %s %s by the user", request_id, updated.status)
            if not future.done():
                future.set_result(updated)
            self._notify(updated)
            return await self._card(updated)

    async def grant(self, chat_id: str) -> KbResearchGrant:
        self._ensure_ready()
        await self._chat_exists(chat_id)
        granted = await disk_call(self.store.granted_at, chat_id)
        return KbResearchGrant(
            chat_id=chat_id, allowed=granted is not None, granted_at=_when(granted) if granted else None
        )

    async def revoke_grant(self, chat_id: str) -> KbResearchGrant:
        self._ensure_ready()
        await self._chat_exists(chat_id)
        await disk_call(self.store.revoke, chat_id)
        return KbResearchGrant(chat_id=chat_id, allowed=False, granted_at=None)

    async def _chat_exists(self, chat_id: str) -> None:
        await self.chats.summary(chat_id)  # NotFound for a chat that isn't there

    # -- ResearchService: the agent's read ------------------------------------------------------------

    async def read(self, body: KbExploreRead) -> KbExploreSnapshot:
        """``skaz_explore_read`` / ``POST /kb/explore/read``: the map (one level), findings, facts and
        tasks. Writes nothing of its own; ``cursor`` and ``limit`` page the findings."""
        self._ensure_ready()
        if body.task_id is not None:
            rows, more = [await disk_call(self._task_row, body.task_id)], False
        else:
            rows, more = await disk_call(self.store.tasks, 0, READ_TASKS)
        return KbExploreSnapshot(
            map=await self.areas.map(parent_id=body.area_id),
            findings=await self.explore.findings(
                area_id=body.area_id, task_id=body.task_id, cursor=body.cursor, limit=body.limit
            ),
            signals=await self.areas.signals(limit=READ_SIGNALS),
            tasks=KbResearchTasks(
                tasks=[await self._view(row) for row in rows], next_cursor=str(READ_TASKS) if more else None
            ),
        )

    # -- the tool --------------------------------------------------------------------------------------

    async def start_tool(self, run: RunRef, body: KbResearchCreate) -> KbResearchToolResult:
        """``skaz_research_start``: topics first, then the card; waits for the user without a timeout."""
        self._ensure_ready()
        chat = (await self.chats.summary(run.chat_id)).chat
        derived = await self._derive(body.description, engine=str(run.engine), model=chat.model)
        now = self._clock()
        base = PermissionRow(
            id=new_id("research"), chat_id=run.chat_id, message_id=run.message_id, run_id=run.run_id,
            engine=str(run.engine), arguments=body.model_dump(mode="json", exclude_none=True),
            topics=derived.topics, title=derived.title, status="pending", auto=False, reason=None,
            task_id=None, created_at=now, decided_at=None,
        )
        if await disk_call(self.store.granted_at, run.chat_id) is not None:
            return await self._start_granted(base, body, derived)
        future: asyncio.Future[PermissionRow] = asyncio.get_running_loop().create_future()
        self._futures[base.id] = future
        await disk_call(self.store.add_permission, base)
        logger.info("Research card %s (%s) waits for the user", base.id, base.engine)
        self.waits.begin(run.run_id)
        try:
            self._notify(base)
            decided = await future
        except asyncio.CancelledError:
            stopped = await asyncio.shield(disk_call(
                self.store.update_permission, base.id, expect=("pending",), status="cancelled",
                reason=STOPPED, decided_at=self._clock(),
            ))
            if stopped is not None:
                self._notify(stopped)
            raise
        finally:
            self.waits.end(run.run_id)
            self._futures.pop(base.id, None)
        return await self._result(decided)

    async def _start_granted(
        self, base: PermissionRow, body: KbResearchCreate, derived: Derived
    ) -> KbResearchToolResult:
        """"Allow in this chat": SKAZ still records the card (``auto``), so every start stays visible."""
        await disk_call(self.store.add_permission, base)
        try:
            task = await self._start(body, derived.title, _proposed(derived.topics), origin=base.chat_id)
        except (KnowledgeError, ContractFailure) as error:
            reason = start_problem(error)
            updated = await disk_call(
                self.store.update_permission, base.id, status="cancelled", auto=True, reason=reason,
                decided_at=self._clock(),
            )
        else:
            updated = await disk_call(
                self.store.update_permission, base.id, status="allowed", auto=True, task_id=task.id,
                decided_at=self._clock(),
            )
        assert updated is not None
        logger.info("Research card %s (%s) %s by the chat's grant", base.id, base.engine, updated.status)
        self._notify(updated)
        return await self._result(updated)

    async def _result(self, record: PermissionRow) -> KbResearchToolResult:
        task = None
        if record.status == "allowed" and record.task_id is not None:
            task = await self._view(await disk_call(self._task_row, record.task_id))
        status: Literal["started", "denied", "cancelled"] = (
            "started" if task is not None else "denied" if record.status == "denied" else "cancelled"
        )
        return KbResearchToolResult(status=status, task=task, permission_id=record.id)

    def waiting_chats(self) -> set[str]:
        """Blocking: chats with a card waiting for the user ("Waiting for you")."""
        return self.store.waiting_chats()

    async def cancel_run(self, run_id: str, reason: str = STOPPED) -> int:
        """Stop / close of a chat answer: its waiting cards end as cancelled; nothing starts."""
        count = 0
        for record in await disk_call(self.store.pending, run_id=run_id):
            updated = await disk_call(
                self.store.update_permission, record.id, expect=("pending",), status="cancelled",
                reason=reason, decided_at=self._clock(),
            )
            if updated is None:
                continue
            count += 1
            future = self._futures.get(record.id)
            if future is not None and not future.done():
                future.set_result(updated)
            self._notify(updated)
        return count

    def recover(self) -> Sequence[str]:
        """After a restart nothing waits any more: pending cards are cancelled; returns their ids."""
        ids = self.store.cancel_all_pending(self._clock(), RESTARTED)
        if ids:
            logger.info("Cancelled %d research cards left by an earlier start", len(ids))
        return ids

    # -- starting a task ---------------------------------------------------------------------------------

    async def _derive(self, description: str, *, engine: str | None, model: str | None) -> Derived:
        try:
            return await self.agent.topics(description, engine=engine, model=model)
        except ResearchAgentUnavailable:
            raise ContractFailure(502, "provider_unavailable") from None

    async def _start(
        self, body: KbResearchCreate, title: str, card: Sequence[CardTopic], *, origin: str | None
    ) -> TaskRow:
        """The run first (a refused consent leaves nothing behind), then the task's chat and row."""
        task_id = new_id("task")
        texts = [topic.text for topic in card]
        funnel_body = funnel_start(body, card)
        run = await self.funnel.start_for_task(task_id, title, funnel_body)
        try:
            engine = model = effort = None
            if origin is not None:  # a task started from a chat answers with that chat's agent
                origin_chat = (await self.chats.summary(origin)).chat
                engine, model, effort = origin_chat.engine, origin_chat.model, origin_chat.effort
            view = await self.chats.create(title=title, engine=engine, model=model, effort=effort)
            chat_id = str(view.chat.id)
            now = self._clock()
            row = TaskRow(
                id=task_id, title=title, description=body.description, chat_id=chat_id,
                origin_chat_id=origin, area_id=body.area_id, job_id=run.id,
                request={
                    "topics": texts,
                    "card": [topic.dump() for topic in card],
                    "funnel": funnel_body.model_dump(mode="json"),
                },
                reported=None, created_at=now, updated_at=now,
            )
            await disk_call(self.store.add_task, row)
        except BaseException:
            with contextlib.suppress(Exception):
                await self.funnel.cancel(run.id)
            raise
        await self._post(row, [
            Message(id=new_id("msg"), chat_id=chat_id, seq=0, role="user", state="done", created_at=now,
                    parts=(TextPart(body.description),), input=MessageInput(text=body.description)),
            self._note(row, "Searching scientific databases for: " + " · ".join(texts)
                       + ". Only these topics leave your computer."),
        ])
        logger.info("Research task %s started (run %s)", task_id, run.id)
        self._watch(task_id)
        return row

    # -- following a run ---------------------------------------------------------------------------------

    async def on_start(self) -> list[str]:
        """App start (after B2's ``on_start``): follow the tasks whose runs go on, report missed stops."""
        if self.kb.view().state == "not_configured":
            return []
        followed: list[str] = []
        rows = await disk_call(self.store.all_tasks)
        known = {row.id for row in rows}
        for job in (await self.explore.jobs(active=True)).jobs:
            if job.owner == "research" and job.task_id is not None and job.task_id not in known:
                await self._stop_orphan(job.id)
        for row in rows:
            try:
                run = await self.funnel.run(row.job_id)
            except (KnowledgeError, ContractFailure):
                continue
            if run.state in _ACTIVE or _report_key(run) != row.reported:
                self._unattended.add(row.id)
                self._watch(row.id)
                followed.append(row.id)
        return followed

    async def _stop_orphan(self, job_id: str) -> None:
        """A run left without its task (its chat was deleted): nobody can see or continue it, so it stops;
        its findings stay in Explore, ungrouped."""
        with contextlib.suppress(KnowledgeError, ContractFailure):
            run = await self.funnel.run(job_id)
            if run.state not in ("done", "cancelled", "error"):
                await self.funnel.cancel(job_id)
                logger.info("Research run %s cancelled: its task's chat was deleted", job_id)

    def _watch(self, task_id: str) -> None:
        current = self._watchers.get(task_id)
        if self._closing or (current is not None and not current.done()):
            return
        task = asyncio.get_running_loop().create_task(self._follow(task_id), name=f"research-{task_id}")
        self._watchers[task_id] = task
        task.add_done_callback(
            lambda done: self._watchers.pop(task_id, None) if self._watchers.get(task_id) is done else None
        )

    async def _follow(self, task_id: str) -> None:
        try:
            while not self._closing:
                if not await self._follow_once(task_id):
                    return
                await asyncio.sleep(self._poll_s)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.error("Following research task %s failed: %s", task_id, type(error).__name__)

    async def settled(self, task_id: str) -> None:
        """Wait until the task's follower has reported and stopped (tests)."""
        task = self._watchers.get(task_id)
        if task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.shield(task)

    async def _follow_once(self, task_id: str) -> bool:
        """Report the run's state if it changed; ``True`` while the run is still going."""
        lock = self._reporting.setdefault(task_id, asyncio.Lock())
        async with lock:
            row = await disk_call(self.store.task, task_id)
            if row is None:  # the task's chat was deleted, and the task with it (C0 open question 3)
                job_id = self._runs_of.pop(task_id, None)
                if job_id is not None:
                    await self._stop_orphan(job_id)
                return False
            self._runs_of[task_id] = row.job_id
            run = _job(await self.funnel.run(row.job_id))
            if run.state in _ACTIVE:
                return True
            if run.stop_reason == "app_exit" and self._closing:
                return False  # Quit: the next start reports it, once B2 has resumed the free steps
            key = _report_key(run)
            if key == row.reported:
                return False
            if run.state == "done":
                await self._report_done(row, run, paid=row.id not in self._unattended)
            else:
                note = stop_note(run)
                if note is not None:
                    await self._post(row, [self._note(row, note)])
            await disk_call(self.store.set_reported, row.id, key, self._clock())
            return False

    async def _report_done(self, row: TaskRow, run: KbExploreJob, *, paid: bool) -> None:
        findings = await self.explore.findings(task_id=row.id, limit=100)
        useful = [
            finding
            for group in findings.groups
            for finding in group.findings
            if finding.label in _USEFUL
        ]
        useful.sort(key=lambda finding: _USEFUL.index(finding.label))
        points: list[SummaryPoint] = []
        problem: str | None = None
        if useful and paid:
            chat = (await self.chats.summary(row.chat_id)).chat
            try:
                points = await self.agent.summary(
                    row.description, useful[:REPORT_FINDINGS], engine=str(chat.engine), model=chat.model
                )
            except ResearchAgentUnavailable as error:
                problem = error.message
        elif useful:
            problem = "SKAZ was closed before I could write them. Ask me here to go through them."
        chat = (await self.chats.summary(row.chat_id)).chat
        text = report_text(run, useful, points, problem)
        message = Message(
            id=new_id("msg"), chat_id=row.chat_id, seq=0, role="assistant", state="done",
            created_at=self._clock(), parts=(TextPart(text),), engine=chat.engine, model=chat.model,
        )
        await disk_call(self.store.touch, row.id, self._clock())
        await self.chats.post_messages(row.chat_id, [message], unread=True)
        counters = run.counters
        await disk_call(
            self.kb.notify,
            RESEARCH_FINISHED,
            row.title,
            body=f"{counters.new} new · {counters.covered} repeat what you have",
            payload={"job_id": row.job_id, "task_id": row.id, "chat_id": row.chat_id},
        )
        logger.info("Research task %s finished and reported", row.id)

    def _note(self, row: TaskRow, text: str) -> Message:
        return Message(id=new_id("msg"), chat_id=row.chat_id, seq=0, role="system", state="done",
                       created_at=self._clock(), parts=(TextPart(text),))

    async def _post(self, row: TaskRow, messages: Sequence[Message]) -> None:
        try:
            await self.chats.post_messages(row.chat_id, messages)
        except NotFound:  # the task's chat was deleted meanwhile (the task goes with it)
            return

    async def aclose(self) -> None:
        """Quit: stop following (B2 pauses the runs; the next start reports what happened)."""
        self._closing = True
        watchers = list(self._watchers.values())
        for task in watchers:
            task.cancel()
        await asyncio.gather(*watchers, return_exceptions=True)
        for future in list(self._futures.values()):
            if not future.done():
                future.cancel()

    # -- chat summaries (``KbJobSummary.chat_id``) ------------------------------------------------------

    def chats_of(self, task_ids: Sequence[str]) -> dict[str, str]:
        """Blocking: task id → its chat, for the jobs list and the tray."""
        return self.store.chats_of(task_ids)


def _report_key(run: KbExploreJob) -> str:
    revision = run.checkpoint.revision if run.checkpoint is not None else 0
    return f"{run.state}:{run.stop_reason or ''}:{revision}"


def _title_of(record: PermissionRow) -> str:
    """The title for a card's task: the one the agent gave with the topics."""
    return record.title or _capital(record.topics[0])


def _capital(text: str) -> str:
    return text[:1].upper() + text[1:]


def card_title(card: Sequence[CardTopic]) -> str:
    """A task started from the «+» card without the proposal's title: its first topic names it."""
    return _capital(card[0].text)


def _proposed(topics: Sequence[str]) -> list[CardTopic]:
    return [CardTopic(text=topic, source="proposed") for topic in topics]


def _topic_view(topic: CardTopic) -> KbResearchTopic:
    return KbResearchTopic(text=topic.text[:72], source=topic.source, area_id=topic.area_id)


def final_card(topics: Sequence[KbResearchTopic]) -> list[CardTopic]:
    """The card as the user left it, sent as it is: spaces tidied and the same topic once (the first one
    wins). Nothing is filtered or reworded — the user saw and chose every word. A blank topic is refused
    (422) before anything starts."""
    card: list[CardTopic] = []
    seen: set[str] = set()
    for topic in topics:
        text = " ".join(topic.text.replace("\x00", " ").split())
        if not text:
            raise ContractFailure(422, "invalid_request")
        if text.casefold() in seen:
            continue
        seen.add(text.casefold())
        card.append(CardTopic(text=text, source=topic.source, area_id=topic.area_id))
    if not card:
        raise ContractFailure(422, "invalid_request")
    return card


def funnel_start(body: KbResearchCreate, card: Sequence[CardTopic]) -> KbFunnelStart:
    """The seam to B2/X2: the card is the run's search plan, one item per topic, its words exactly the
    topic (only these leave, C0-1); a topic picked from the map carries its area, so its hidden OpenAlex
    label narrows the search and its materials seed continuations and neighbours. No query is derived."""
    picked = body.area_id is not None or any(topic.area_id for topic in card)
    channels: list[KbFindingChannel] = ["continues", "branches", "search"] if picked else ["search"]
    return KbFunnelStart(
        area_id=body.area_id,
        query="",
        dates=body.dates,
        channels=channels,
        plan=[
            KbSearchPlanItem(area_id=topic.area_id, label=topic.text, terms=[topic.text]) for topic in card
        ],
    )


def _when(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def start_problem(error: BaseException) -> str:
    """Why a task couldn't start, in words for the card and the agent (never the error's own text)."""
    if isinstance(error, ContractFailure):
        if error.code == "consent_required":
            return "science databases are turned off (Settings → Search)."
        if error.code == "not_ready":
            return "SKAZ isn't ready to search yet."
        return "a science database or the agent didn't answer."
    if isinstance(error, KnowledgeError):
        return error.message
    return "something went wrong."


def _offset(cursor: str | None) -> int:
    if cursor is None:
        return 0
    if not cursor.isdigit() or len(cursor) > 9:
        raise ContractFailure(422, "invalid_request")
    return int(cursor)


__all__ = ["RESEARCH_FINISHED", "ResearchTasks"]
