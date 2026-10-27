"""``runtime.kb_chats``: general chats (area C1).

* No filter of areas: the agent finds its way through the wiki with the SKAZ
  tools; it is told what is open next to the chat and whether a recording is
  running (decisions 26, 34 and the v3/v4 chat).
* No queues: chats answer in parallel; one chat answers one question at a
  time (``ANSWERING``).
* No silent substitution: the chat's own agent runs, or the request fails with
  the agent's plain reason. Switching the agent writes a ``system`` message and
  the next agent receives the conversation.
* An answer stopped by a limit or an error is ``interrupted`` with the reason;
  "Resume" asks the same question again from the start.
* Ids in answers are checked before they become chips (``chats.resolve``).
* Nothing reaches the wiki unless the user saves it (``chats.analysis``).
* N6: with an agent that keeps live sessions (Codex) a chat is one agent session: SKAZ sends only the
  new message (plus ``[context]`` notes), reverts the session in place for edit / regenerate / resume,
  or starts a new one seeded with the history (``chats.live``). Old sessions are deleted with the
  chat, on an engine switch and on sign-out (a durable, retried list).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import sqlite3
import time
from collections.abc import AsyncIterator, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal, cast

from ...native_io import disk_call
from ..agents import update_gate
from ..agents.engine import (
    AgentEngine,
    AgentEvent,
    AgentTurn,
    Compacted,
    Completed,
    EngineId,
    Failed,
    SessionBound,
    SessionDeleteDeferred,
    TextDelta,
    ToolCall,
    ToolSpec,
    TurnMessage,
    session_support,
)
from ..agents.last_choice import LastChoice
from ..agents.registry import ENGINE_NAMES, EngineRegistry, EngineUnavailable
from ..agents.tools import ToolRegistry
from ..agents.usage_log import RunUsage, UsageLog
from ..agents.web import NATIVE_WEB, web_instructions, web_support
from ..answer_blocks import usage as block_usage
from ..answer_blocks.part import BlockPart, MaterialSource, drawing
from ..errors import KnowledgeError, NotFound
from ..ids import new_id
from ..ingest.protocols import IdentityTextLayer, TextLayer
from ..ingest.settings import read_settings
from ..keyed_locks import KeyedLocks
from ..logsafe import error_note
from ..markdown.text import name_key
from ..me import MeError
from ..me.access import me_store
from ..me.prompt import held_after_turn, marks, needs_reseed, snapshot, with_me
from ..permissions.ask_tool import ASK_TOOL, NATIVE_QUESTIONS
from ..permissions.broker import RESTARTED, PermissionBroker
from ..permissions.broker import STOPPED as STOPPED_WAIT
from ..permissions.questions import QuestionBroker
from ..permissions.search_rules import SearchRulesStore, rules_instructions
from ..permissions.store import PermissionRecord, QuestionRecord, RunRef
from ..permissions.web_search import ChatWebGate, WebSearchBroker, WebSearchRecord
from ..permissions.web_tool import WEB_TOOL
from ..service import KnowledgeService
from ..skills.settings import enabled_skills
from ..study.scheduling import Mode
from ..study.store import StudyBlock
from .analysis import AnalysisWriter, Section
from .blocks import AnswerBlocks, finish_drawing
from .context import ContextBuilder, history, instructions
from .events import ChatEvent, ChatFeed, ListFeed
from .export import ChatExport, export_chat
from .fix_part import WikiFixPart
from .live import (
    BASE_INSTRUCTIONS,
    COMPACTED_NOTE,
    MAX_DELETE_ATTEMPTS,
    START,
    LiveSession,
    SessionContext,
    SessionDecision,
    SessionStore,
    cited_materials,
    context_note,
    keys,
    live_entries,
    plan_session,
)
from .model import (
    FINISHED,
    Chat,
    CitePart,
    ConnectionPart,
    Failure,
    MemoryPart,
    Message,
    MessageInput,
    MessageState,
    Part,
    PermissionPart,
    QuestionPart,
    StudyPart,
    TextPart,
    WebSearchPart,
)
from .parsing import BlockData, BlockStart, CiteToken, ConnectionOut, Output, PageToken, StreamParser, TextOut
from .resolve import MaterialReader, Resolver
from .selection import check_selection
from .store import RESTART_REASON, WIKI_STUDY_CHAT_ID, ChatRepository
from .summary import ChatSummaries
from .text import DEFAULT_TITLE, auto_title, preview, utc_now

if TYPE_CHECKING:  # the study service imports chats (C-17); only annotations name it here
    from ..study.service import StudyService

log = logging.getLogger(__name__)

ChatState = Literal["idle", "answering"]
ListFilter = Literal["all", "pinned", "recording"]
ANSWERING = "The agent is still answering in this chat. Stop it or wait for the answer."
STOPPED = "You stopped the answer."
UNEXPECTED = "The agent stopped unexpectedly. Try again."
NO_TERMINAL = "The agent stopped without finishing the answer."
EMPTY_ANSWER = "The agent returned an empty answer."
CHECKPOINT_S = 2.0
STOP_TIMEOUT_S = 10.0
#: App shutdown: an answer gets this long to stop after the interrupt, then what it streamed so far is
#: saved as interrupted and it is cancelled (the knowledge shutdown deadline is 2.5 s in total).
CLOSE_STOP_S = 1.0
#: Sign-out waits this long for the engine's sessions to be deleted; the rest stays queued (N6).
END_SESSIONS_WAIT_S = 20.0
MENTION_LIMIT = 8
#: Failure kinds that leave the question open for "Resume" (decision on limits).
_INTERRUPTING = frozenset({"limit", "network", "auth", "incompatible"})


class ChatConflict(KnowledgeError):
    """409 with a machine code the UI can branch on (``ANSWERING``, ``ALREADY_SAVED`` …)."""

    status_code = 409

    def __init__(self, message: str, code: str, **extra: str) -> None:
        super().__init__(message)
        self.code = code
        self.extra = extra


class ChatInvalid(KnowledgeError):
    status_code = 422


@dataclass(frozen=True)
class ChatView:
    chat: Chat
    state: ChatState
    messages: tuple[Message, ...] = ()
    cursor: int = 0
    #: A permission request or a question of this chat waits for the user ("Waiting for you").
    waiting: bool = False


@dataclass(frozen=True)
class MentionResults:
    pages: tuple[tuple[str, str, str], ...]
    materials: tuple[tuple[str, str], ...]
    chats: tuple[tuple[str, str], ...]


@dataclass
class _Run:
    chat_id: str
    run_id: str
    engine: AgentEngine
    message: Message
    task: asyncio.Task[None] | None = None
    #: The service is shutting down: a stop here leaves the question resumable.
    closing: bool = False
    deleted: bool = False
    saved_at: float = 0.0
    #: Counters for ``agent_usage`` (never text): when it began, what was sent, tools it called.
    started_at: float = 0.0
    prompt_characters: int = 0
    tool_calls: int = 0
    #: The user (or shutdown) stopped this answer: no reseed starts after it.
    stopping: bool = False
    #: N6: the question, the live-session plan and what to record once the answer is ``done``.
    question: Message | None = None
    decision: SessionDecision | None = None
    session: LiveSession | None = None
    context: SessionContext | None = None
    #: (message id, digest) of the history a ``start`` seeds the new session with.
    seeded: tuple[tuple[str, str], ...] = ()
    bound: SessionBound | None = None
    compacted: bool = False
    #: Text or a tool call reached the user: the run can't be retried silently.
    produced: bool = False
    #: The user's own messages that answered the agent's question during this run (the agent got them
    #: inside its turn): recorded as held with the answer, in chat order.
    absorbed: list[Message] = field(default_factory=list)


class ChatService:
    def __init__(self, kb: KnowledgeService, *, agents: Callable[[], EngineRegistry], tools: ToolRegistry,
                 text_layer: Callable[[], TextLayer] | None = None, checkpoint_s: float = CHECKPOINT_S,
                 stop_timeout_s: float = STOP_TIMEOUT_S, close_stop_s: float = CLOSE_STOP_S,
                 permissions: PermissionBroker | None = None,
                 questions: QuestionBroker | None = None,
                 study: StudyService | None = None,
                 web: WebSearchBroker | None = None) -> None:
        self.kb = kb
        self.repo = ChatRepository(kb.db)
        self.usage_log = UsageLog(kb.db)
        self.summaries = ChatSummaries(kb.db, self.usage_log)
        #: N6: each chat's live agent session and the agent sessions waiting to be deleted.
        self.sessions = SessionStore(kb.db)
        self._deleting: asyncio.Task[None] | None = None
        self._delete_again = False
        self._delete_lock = asyncio.Lock()
        #: The next pass after a backoff (a failed deletion's retry time).
        self._delete_timer: asyncio.TimerHandle | None = None
        #: The start-up sweep of agents' local sessions nothing knows (``sweep_sessions``).
        self._sweeping: asyncio.Task[None] | None = None
        #: An engine SKAZ is installing / repairing now: its queued deletions wait (no attempt counted).
        #: The runtime wires it to the install tasks; an update that holds the agent counts as well.
        self.hold_deletions: Callable[[str], bool] = lambda _engine: False
        self._agents = agents
        self.tools = tools
        self._text_layer = text_layer or (lambda: IdentityTextLayer())
        self._checkpoint_s = checkpoint_s
        self._stop_timeout_s = stop_timeout_s
        self._close_stop_s = close_stop_s
        #: One "Save to wiki" per answer at a time: a double click must not write two analysis pages.
        self._saving = KeyedLocks()
        #: One part change of a saved answer at a time (read-modify-write of its parts).
        self._parts = KeyedLocks()
        #: Answers that were streaming when SKAZ stopped are "interrupted" (resumable) from now on.
        self.recovered = self.repo.interrupt_streaming()
        #: Agents' wiki changes wait here for the user (phase P); nothing waits across a restart.
        self.permissions = permissions
        if permissions is not None:
            permissions.recover()
            permissions.listeners.append(self._on_permission)
        #: Agents' questions (native or ``skaz_ask_user``) wait here; the composer stays free.
        self.questions = questions
        if questions is not None:
            questions.listeners.append(self._on_question)
            questions.late_answer = self._late_answer
        #: Decks and tests in chats (0.3.1 S): a block's change is a part update of its message.
        self.study = study
        if study is not None:
            study.listeners.append(self._on_study)
        #: W-2: agents' web searches wait here for the user before they are sent (chats only).
        self.web = web
        if web is not None:
            web.recover()
            web.listeners.append(self._on_web)
        self._feeds: dict[str, ChatFeed] = {}
        self._list = ListFeed()
        self._runs: dict[str, _Run] = {}
        #: Chats between "send accepted" and "run started" (also answer ``ANSWERING``).
        self._reserved: set[str] = set()
        self._closing = False

    @property
    def registry(self) -> EngineRegistry:
        return self._agents()

    # -- plumbing ---------------------------------------------------------------

    def _feed(self, chat_id: str) -> ChatFeed:
        feed = self._feeds.get(chat_id)
        if feed is None:
            feed = self._feeds[chat_id] = ChatFeed()
        return feed

    def state_of(self, chat_id: str) -> ChatState:
        return "answering" if chat_id in self._runs or chat_id in self._reserved else "idle"

    def _waiting_chats(self) -> set[str]:
        """Chats with a pending permission request or question (one query; a worker thread)."""
        store = self.permissions.store if self.permissions is not None else (
            self.questions.store if self.questions is not None else None)
        waiting = store.waiting_chats() if store is not None else set()
        return waiting | (self.web.store.waiting_chats() if self.web is not None else set())

    def _view(self, chat: Chat, waiting: set[str], messages: tuple[Message, ...] = (),
              cursor: int = 0) -> ChatView:
        return ChatView(chat, self.state_of(chat.id), messages, cursor, chat.id in waiting)

    # -- agents' permission requests and questions (0.3.1 P) ----------------------------

    def _on_part(self, chat_id: str, message_id: str, part: Part) -> None:
        """A new card goes into the streaming answer; a changed one is sent whole (``part_update``)."""
        run = self._runs.get(chat_id)
        if run is not None and run.message.id == message_id and part not in run.message.parts:
            self._add_part(run, part)
        else:
            self._feed(chat_id).emit("part_update", message_id, part=part)
        self._list.touch(chat_id)

    def _on_permission(self, record: PermissionRecord) -> None:
        self._on_part(record.chat_id, record.message_id, PermissionPart(record.id))

    def _on_web(self, record: WebSearchRecord) -> None:
        self._on_part(record.chat_id, record.message_id, WebSearchPart(record.id))

    def _on_question(self, record: QuestionRecord) -> None:
        self._on_part(record.chat_id, record.message_id, QuestionPart(record.id))

    def _on_study(self, block: StudyBlock) -> None:
        self._on_part(block.chat_id, block.message_id, StudyPart(block.id, block.kind, block.title))

    # -- parts that SKAZ tools add to or change in an answer (N6 «Я», P2 «Fix in wiki») ------------

    async def add_part(self, chat_id: str, message_id: str, part: Part) -> None:
        """Add ``part`` to an answer: the streaming one gets it in memory (``part`` event; its final save
        keeps it); an answer that ended meanwhile gets it saved (``message`` event)."""
        async with self._parts.hold(message_id):
            run = self._runs.get(chat_id)
            if run is not None and run.message.id == message_id:
                self._add_part(run, part)
                self._list.touch(chat_id)
                return
            stored = await disk_call(self.repo.message, chat_id, message_id)
            if stored is None:
                return  # the chat or the answer is gone
            message = stored.with_parts([*stored.parts, part])
            await disk_call(self.repo.save_message, message)
        self._feed(chat_id).emit("message", message.id, message=message)
        self._list.touch(chat_id)

    async def update_part(self, chat_id: str, message_id: str, part: Part) -> Message | None:
        """Replace the answer's part with the same identity as ``part`` (``_same_part``) and send the whole
        message again (``message`` event). Returns the message, or ``None`` when it is gone.

        Safe against the final save of an answer that is still streaming: while its run exists the change
        goes into the run's message, and ``_finish`` saves the run's latest message (again if a change
        landed during its own save) before the run is dropped. After that the stored message is changed."""
        async with self._parts.hold(message_id):
            run = self._runs.get(chat_id)
            if run is not None and run.message.id == message_id:
                run.message = run.message.with_parts(_swap_part(run.message.parts, part))
                message = run.message
            else:
                stored = await disk_call(self.repo.message, chat_id, message_id)
                if stored is None:
                    return None
                message = stored.with_parts(_swap_part(stored.parts, part))
                await disk_call(self.repo.save_message, message)
        self._feed(chat_id).emit("message", message.id, message=message)
        self._list.touch(chat_id)
        return message

    async def study_from_deck(self, study: StudyService, page_id: str, mode: Mode,
                              card_ids: Sequence[str] | None,
                              chat_id: str | None = None) -> tuple[str, StudyBlock]:
        """"Study" / "Take the test" on a deck or test page (S12; bug 1, 2026-10-26).

        The block lives beside the chat only: it belongs to SKAZ's own wiki-study thread
        (:data:`WIKI_STUDY_CHAT_ID`, never listed), not to the chat that happens to be open — so it
        never joins that chat's thread. ``chat_id`` is accepted for older callers and ignored.
        Opening it again goes on where it stopped: an unfinished pass (the same page, mode and cards)
        or the test with its answers and result (Retake starts a new attempt). Open answers are
        checked by the agent a new chat would get now — the default agent with its last model and
        effort — fixed for the block when it is made.
        """
        del chat_id
        record = await disk_call(self.kb.page_repo.get, page_id)
        if record is None or record.kind not in ("deck", "test"):
            raise NotFound("This page is not a deck.")
        chat = await self._wiki_study_chat()
        for block in reversed(await disk_call(study.store.blocks_of_chat, chat.id)):
            if block.page_id != page_id or block.origin != "show":
                continue
            if record.kind == "test" or (block.mode == mode and card_ids is None
                                         and block.position < len(block.payload.get("order") or ())):
                return chat.id, block
            break
        engine = await disk_call(self.registry.default)
        last = await disk_call(LastChoice(self.registry.settings).get, engine)
        model, effort = last if last is not None else (None, None)
        try:
            await self._check_model(engine, model, effort)
        except ChatInvalid:
            model, effort = None, None  # a remembered model the agent no longer offers: its own default
        message_id = new_id("msg")
        ref = RunRef(run_id="", chat_id=chat.id, message_id=message_id, engine=engine)
        block = await disk_call(study.show_saved, ref, [page_id], mode, card_ids, notify=False)
        payload = {**block.payload, "agent": {"engine": engine, "model": model, "effort": effort}}
        fixed = await disk_call(study.store.update_block, block.id, payload=payload)
        block = fixed if fixed is not None else block
        now = utc_now()
        message = Message(id=message_id, chat_id=chat.id, seq=0, role="system", state="done", created_at=now,
                          parts=(StudyPart(block.id, block.kind, block.title),), engine=engine)
        (added,) = await disk_call(self.repo.add_messages, [message], {"updated_at": now})
        self._feed(chat.id).emit("message", added.id, message=added)
        return chat.id, block

    async def _wiki_study_chat(self) -> Chat:
        """SKAZ's own thread of the blocks opened from the wiki (made once; never in the chat list)."""
        chat = await disk_call(self.repo.get, WIKI_STUDY_CHAT_ID)
        if chat is not None:
            return chat
        now = utc_now()
        chat = Chat(id=WIKI_STUDY_CHAT_ID, title="Studied from the wiki", title_auto=False, pinned=False,
                    engine=await disk_call(self.registry.default), model=None, effort=None,
                    recording_material_id=None, folder_ids=(), unread=False, last_preview="",
                    created_at=now, updated_at=now)
        with contextlib.suppress(sqlite3.IntegrityError):  # made meanwhile by another request
            await disk_call(self.repo.create, chat)
        made = await disk_call(self.repo.get, WIKI_STUDY_CHAT_ID)
        assert made is not None
        return made

    async def _late_answer(self, chat_id: str, text: str) -> None:
        """An option picked after the agent stopped waiting: a new question in the chat (Q-A2)."""
        await self.send(chat_id, MessageInput(text=text))

    async def _answer_question(self, chat: Chat, run: _Run, given: MessageInput) -> tuple[Message, Message]:
        """The user wrote their own message while the agent waits for an answer: it closes the question."""
        if given.selection is not None:  # P2: checked like any question's selection
            given = replace(given, selection=check_selection(await disk_call(self.repo.messages, chat.id),
                                                             given.selection))
        now = utc_now()
        user = Message(id=new_id("msg"), chat_id=chat.id, seq=0, role="user", state="done", created_at=now,
                       parts=(TextPart(given.text),), input=given)
        (user,) = await disk_call(self.repo.add_messages, [user],
                                  {"updated_at": now, "last_preview": preview(user.parts), "unread": False})
        self._feed(chat.id).emit("message", user.id, message=user)
        # N6: the agent gets this message inside its running turn (the question's answer), so its live
        # session holds it: recorded with the answer — the next question must not reseed over it.
        if self._runs.get(chat.id) is run:
            run.absorbed.append(user)
        assert self.questions is not None
        await self.questions.supersede(chat.id, given.text)
        return user, run.message

    def _reserve(self, chat_id: str) -> None:
        if self._closing:
            raise ChatConflict("SKAZ is closing. Ask again after it starts.", "CLOSING")
        if self.state_of(chat_id) == "answering":
            raise ChatConflict(ANSWERING, "ANSWERING")
        self._reserved.add(chat_id)

    async def _chat(self, chat_id: str) -> Chat:
        chat = await disk_call(self.repo.get, chat_id)
        if chat is None:
            raise NotFound("Chat not found.")
        return chat

    async def _message(self, chat_id: str, message_id: str) -> Message:
        run = self._runs.get(chat_id)
        if run is not None and run.message.id == message_id:
            return run.message
        message = await disk_call(self.repo.message, chat_id, message_id)
        if message is None:
            raise NotFound("Message not found.")
        return message

    def _live(self, messages: Iterable[Message]) -> tuple[Message, ...]:
        """Stored messages with the answer that is streaming right now shown as it is in memory."""
        live = {run.message.id: run.message for run in self._runs.values()}
        return tuple(live.get(message.id, message) for message in messages)

    def _wiki_language(self) -> str | None:
        settings = read_settings(self.kb.settings)
        return settings.language if settings.language_chosen else None

    # -- reading ----------------------------------------------------------------

    async def list_chats(self, *, query: str | None = None, filter: ListFilter = "all",
                   folder_id: str | None = None, limit: int | None = None) -> list[ChatView]:
        def load() -> list[Chat]:
            ids = self.repo.search(query) if query and query.strip() else None
            return self.repo.list_all(pinned_only=filter == "pinned", recording_only=filter == "recording",
                                      folder_id=folder_id, ids=ids, limit=limit)

        chats, waiting = await disk_call(lambda: (load(), self._waiting_chats()))
        return [self._view(chat, waiting) for chat in chats]

    async def get(self, chat_id: str) -> ChatView:
        chat = await self._chat(chat_id)
        messages, waiting = await disk_call(lambda: (self.repo.messages(chat_id), self._waiting_chats()))
        return self._view(chat, waiting, self._live(messages), self._feed(chat_id).cursor)

    async def summary(self, chat_id: str) -> ChatView:
        chat = await self._chat(chat_id)
        return self._view(chat, await disk_call(self._waiting_chats))

    async def events(self, chat_id: str, after: int, wait: float) -> tuple[list[ChatEvent], int]:
        await self._chat(chat_id)
        feed = self._feed(chat_id)
        await feed.wait(after, wait)
        events = feed.after(after)
        if events is not None:
            return events, feed.cursor
        # A cursor this feed can't serve: a snapshot of every message instead.
        cursor = feed.cursor
        chat = await disk_call(self.repo.get, chat_id)
        if chat is None:
            raise NotFound("Chat not found.")
        messages = self._live(await disk_call(self.repo.messages, chat_id))
        snapshot = [ChatEvent(cursor, "title", None, text=chat.title)]
        snapshot += [ChatEvent(cursor, "message", message.id, message=message) for message in messages]
        return snapshot, cursor

    async def list_events(self, after: int, wait: float) -> tuple[list[ChatView], int]:
        await self._list.wait(after, wait)
        changed = self._list.after(after)
        cursor = self._list.cursor
        if changed is None:
            return await self.list_chats(), cursor
        chats, waiting = await disk_call(lambda: (self.repo.list_all(ids=changed), self._waiting_chats()))
        return [self._view(chat, waiting) for chat in chats], cursor

    # -- creating and changing --------------------------------------------------

    async def create(self, *, title: str | None = None, engine: EngineId | None = None,
                     model: str | None = None, effort: str | None = None,
                     recording_material_id: str | None = None) -> ChatView:
        chosen: EngineId = engine if engine is not None else await disk_call(self.registry.default)
        if engine is None and model is None and effort is None:
            # Bug 5: a chat SKAZ makes itself (a recording's chat) starts from the agent's last choice,
            # as New chat does — its model and effort show in the field and can be changed. A remembered
            # model the agent no longer offers leaves the chat on the agent's own default.
            last = await disk_call(LastChoice(self.registry.settings).get, chosen)
            if last is not None:
                try:
                    await self._check_model(chosen, *last)
                    model, effort = last
                except ChatInvalid:
                    pass
        await self._check_model(chosen, model, effort)
        folder_ids: tuple[str, ...] = ()
        title_auto = True
        name = (title or "").strip()
        if recording_material_id is not None:
            record = await disk_call(self.kb.material_repo.get, recording_material_id)
            if record is None:
                raise NotFound("Material not found.")
            if record.kind != "recording":
                raise ChatInvalid("This material is not a recording.")
            folder_ids = (record.folder_id,)
            name = name or record.title
        if name:
            title_auto = False
        now = utc_now()
        chat = Chat(id=new_id("chat"), title=name or DEFAULT_TITLE, title_auto=title_auto, pinned=False,
                    engine=chosen, model=model, effort=effort, recording_material_id=recording_material_id,
                    folder_ids=folder_ids, unread=False, last_preview="", created_at=now, updated_at=now)
        await disk_call(self.repo.create, chat)
        # An explicit choice; "as set in the agent" in New chat is remembered when it is picked.
        if model is not None:
            await disk_call(LastChoice(self.registry.settings).remember, chosen, model, effort)
        self._list.touch(chat.id)
        return ChatView(chat, "idle", (), self._feed(chat.id).cursor)

    async def _check_model(self, engine: EngineId, model: str | None, effort: str | None) -> None:
        """Refuse a model/effort the agent doesn't offer — never skip the check, never pick another one.

        ``model=None`` is the agent's default model: the one chosen in the agent
        itself, else the first it lists (what the composer shows). When the
        agent's models can't be read now, the request fails with the agent's
        reason and a fixing action (``AGENT_UNAVAILABLE``) instead of passing.
        """
        if model is None and effort is None:
            return
        name = ENGINE_NAMES[engine]
        try:
            view = await self.registry.known_view(engine)
        except Exception as error:
            log.warning("Checking the models of %s failed (%s)", engine, type(error).__name__)
            raise EngineUnavailable(engine, f"SKAZ couldn't check {name}'s models. Try again.",
                                    "check") from error
        if not view.models:
            reason = view.status.reason if view.state != "ready" and view.status.reason else (
                f"{name} didn't list its models, so SKAZ can't check this choice. Check {name} again.")
            raise EngineUnavailable(engine, reason, view.action or "check")
        ids = [option.id for option in view.models]
        if model is not None and model not in ids:
            raise ChatInvalid(f"{name} has no model “{model}”. Choose one of its models.")
        chosen = model or (view.current_model if view.current_model in ids else ids[0])
        option = next(option for option in view.models if option.id == chosen)
        if effort is not None and effort not in option.efforts:
            if not option.efforts:
                raise ChatInvalid(f"{option.label} of {name} has no effort levels. Leave the effort unset.")
            raise ChatInvalid(f"{option.label} of {name} has no “{effort}” effort level.")

    async def remember_choice(self, engine: EngineId, model: str | None, effort: str | None) -> None:
        """A choice made in the New chat field, before the chat exists: checked like a chat's."""
        await self.registry.require(engine)
        await self._check_model(engine, model, effort)
        await disk_call(LastChoice(self.registry.settings).remember, engine, model, effort)

    async def patch(self, chat_id: str, changes: Mapping[str, Any]) -> ChatView:
        chat = await self._chat(chat_id)
        updates: dict[str, Any] = {}
        notes: list[str] = []
        if "title" in changes:
            title = str(changes["title"] or "").strip()
            if not title:
                raise ChatInvalid("A chat needs a name.")
            updates.update(title=title, title_auto=False)
        if "pinned" in changes:
            updates["pinned"] = bool(changes["pinned"])
        engine: EngineId = changes.get("engine") or chat.engine
        engine_changed = engine != chat.engine
        model = changes.get("model", None if engine_changed else chat.model)
        effort = changes.get("effort", None if engine_changed else chat.effort)
        if engine_changed:
            await self.registry.require(engine)  # 409 with the agent's own reason; nothing is switched
        if engine_changed or model != chat.model or effort != chat.effort:
            await self._check_model(engine, model, effort)
            updates.update(engine=engine, model=model, effort=effort)
            note = await self._switch_note(chat, engine, model)
            if note is not None:
                notes.append(note)
            await disk_call(LastChoice(self.registry.settings).remember, engine, model, effort)
        if not updates:
            return await self.summary(chat_id)
        now = utc_now()
        system = [Message(id=new_id("msg"), chat_id=chat_id, seq=0, role="system", state="done",
                          created_at=now, parts=(TextPart(note),), engine=engine, model=model, effort=effort)
                  for note in notes]
        if system:
            updates["updated_at"] = now
            added = await disk_call(self.repo.add_messages, system, updates)
        else:
            await disk_call(self.repo.update, chat_id, **updates)
            added = []
        feed = self._feed(chat_id)
        for message in added:
            feed.emit("message", message.id, message=message)
        if "title" in updates:
            feed.emit("title", None, text=updates["title"])
        if engine_changed and await disk_call(self.sessions.drop, chat_id):
            self._kick_deletions()  # the old agent's session goes; the new agent starts seeded
        self._list.touch(chat_id)
        return await self.summary(chat_id)

    async def _switch_note(self, chat: Chat, engine: EngineId, model: str | None) -> str | None:
        """The record of a change of agent or model; an effort change alone leaves none (2026-10-21)."""
        if engine == chat.engine and model == chat.model:
            return None
        label = await self._model_label(engine, model)
        if engine != chat.engine:
            return f"Switched to {ENGINE_NAMES[engine]}" + (f" · {label}" if label else "")
        return f"Model changed to {label or 'the default model'}"

    async def _model_label(self, engine: EngineId, model: str | None) -> str | None:
        if model is None:
            return None
        with contextlib.suppress(Exception):
            view = await self.registry.known_view(engine)
            for option in view.models:
                if option.id == model:
                    return option.label
        return model

    async def delete(self, chat_id: str) -> None:
        await self._chat(chat_id)
        run = self._runs.get(chat_id)
        if run is not None:
            run.deleted = True
            await self._stop_run(run)
        await disk_call(self.repo.delete, chat_id)  # its live session is queued for deletion (cascade)
        self._feeds.pop(chat_id, None)
        self._list.touch(chat_id)
        self._kick_deletions()

    async def mark_read(self, chat_id: str) -> None:
        chat = await self._chat(chat_id)
        if chat.unread:
            await disk_call(self.repo.update, chat_id, unread=False)
            self._list.touch(chat_id)

    # -- asking ---------------------------------------------------------------------

    async def send(self, chat_id: str, given: MessageInput) -> tuple[Message, Message]:
        chat = await self._chat(chat_id)
        run = self._runs.get(chat_id)
        if run is not None and self.questions is not None and \
                await disk_call(self.questions.waiting_in, chat_id):
            return await self._answer_question(chat, run, given)
        self._reserve(chat_id)
        try:
            engine = await self.registry.require_known(chat.engine)  # bug 7: no fresh check first
            prior = await disk_call(self.repo.messages, chat_id)
            if given.selection is not None:  # P2: only ids that exist in the stored answer
                given = replace(given, selection=check_selection(prior, given.selection))
            now = utc_now()
            user = Message(id=new_id("msg"), chat_id=chat_id, seq=0, role="user", state="done",
                           created_at=now, parts=(TextPart(given.text),), input=given)
            answer = self._new_answer(chat, user.id, now)
            updates: dict[str, Any] = {"updated_at": now, "last_preview": preview(user.parts),
                                       "unread": False}
            if chat.title_auto and not any(message.role == "user" for message in prior):
                updates["title"] = auto_title(given.text)
            folders = await disk_call(self._input_folders, given)
            merged = tuple(dict.fromkeys((*chat.folder_ids, *folders)))
            if merged != chat.folder_ids:
                updates["folder_ids"] = merged
            user, answer = await disk_call(self.repo.add_messages, [user, answer], updates)
        except BaseException:
            self._reserved.discard(chat_id)
            raise
        feed = self._feed(chat_id)
        feed.emit("message", user.id, message=user)
        feed.emit("message", answer.id, message=answer)
        if "title" in updates:
            feed.emit("title", None, text=updates["title"])
        self._start(chat, engine, answer, user, prior)
        return user, answer

    async def regenerate(self, chat_id: str, message_id: str) -> tuple[Message, Message]:
        return await self._ask_again(chat_id, message_id, resume=False)

    async def resume(self, chat_id: str, message_id: str) -> tuple[Message, Message]:
        return await self._ask_again(chat_id, message_id, resume=True)

    async def _ask_again(self, chat_id: str, message_id: str, *, resume: bool) -> tuple[Message, Message]:
        chat = await self._chat(chat_id)
        self._reserve(chat_id)
        try:
            target = await self._message(chat_id, message_id)
            if target.role != "assistant":
                raise ChatInvalid("Only an answer can be asked again.")
            if resume and target.state not in ("interrupted", "failed"):
                raise ChatConflict("Only an interrupted answer can be resumed.", "NOT_INTERRUPTED")
            if target.state not in FINISHED:
                raise ChatConflict(ANSWERING, "ANSWERING")
            question = await disk_call(self.repo.message, chat_id, target.reply_to or "")
            if question is None or question.input is None:
                raise ChatConflict("The question of this answer is no longer in the chat.", "NO_QUESTION")
            engine = await self.registry.require_known(chat.engine)  # bug 7: no fresh check first
            messages = await disk_call(self.repo.messages, chat_id)
            prior = [message for message in messages if message.seq < question.seq]
            now = utc_now()
            fresh = self._new_answer(chat, question.id, now)
            chat_update = {"updated_at": now, "unread": False}
            if resume:  # the interrupted answer gives its place to the new one (2026-10-21)
                answer = await disk_call(self.repo.replace_answer, target, fresh, chat_update)
            else:
                (answer,) = await disk_call(self.repo.add_messages, [fresh], chat_update)
        except BaseException:
            self._reserved.discard(chat_id)
            raise
        if resume:
            self._feed(chat_id).emit("removed", target.id)
        self._feed(chat_id).emit("message", answer.id, message=answer)
        self._start(chat, engine, answer, question, prior)
        return question, answer

    async def edit(self, chat_id: str, message_id: str, given: MessageInput) -> tuple[Message, Message]:
        """Your question, changed in place (2026-10-21): every later message of the chat goes (answers,
        records, later questions) and it is answered again by the chat's current agent and model.
        Saved wiki pages stay. The question keeps what was open when it was first asked."""
        chat = await self._chat(chat_id)
        self._reserve(chat_id)
        try:
            target = await self._message(chat_id, message_id)
            if target.role != "user":
                raise ChatInvalid("Only your own question can be edited.")
            engine = await self.registry.require_known(chat.engine)  # bug 7: no fresh check first
            messages = await disk_call(self.repo.messages, chat_id)
            prior = [message for message in messages if message.seq < target.seq]
            context = target.input.context if target.input is not None else given.context
            # The question keeps its selection too (P2): the edit changes the words.
            kept = target.input.selection if target.input is not None else None
            question = replace(target, parts=(TextPart(given.text),),
                               input=replace(given, context=context, selection=kept))
            now = utc_now()
            updates: dict[str, Any] = {"updated_at": now, "last_preview": preview(question.parts),
                                       "unread": False}
            folders = await disk_call(self._input_folders, given)
            merged = tuple(dict.fromkeys((*chat.folder_ids, *folders)))
            if merged != chat.folder_ids:
                updates["folder_ids"] = merged
            removed, answer = await disk_call(self.repo.rewrite_from, question,
                                              self._new_answer(chat, question.id, now), updates)
        except BaseException:
            self._reserved.discard(chat_id)
            raise
        feed = self._feed(chat_id)
        for gone in removed:
            feed.emit("removed", gone)
        feed.emit("message", question.id, message=question)
        feed.emit("message", answer.id, message=answer)
        self._start(chat, engine, answer, question, prior)
        return question, answer

    @staticmethod
    def _new_answer(chat: Chat, question_id: str, now: str) -> Message:
        return Message(id=new_id("msg"), chat_id=chat.id, seq=0, role="assistant", state="streaming",
                       created_at=now, engine=chat.engine, model=chat.model, effort=chat.effort,
                       reply_to=question_id)

    def _input_folders(self, given: MessageInput) -> list[str]:
        folders: list[str] = []
        material_ids = [ref.id for ref in given.mentions if ref.type == "material"] + list(given.attachments)
        material_ids += [quote.id for quote in given.quotes if quote.source == "material"]
        for material_id in material_ids:
            record = self.kb.material_repo.get(material_id)
            if record is not None:
                folders.append(record.folder_id)
        page_ids = [ref.id for ref in given.mentions if ref.type == "page"]
        page_ids += [quote.id for quote in given.quotes if quote.source == "page"]
        for page_id in page_ids:
            page = self.kb.page_repo.get(page_id)
            if page is not None:
                folders.extend(page.folders)
        return folders

    def _start(self, chat: Chat, engine: AgentEngine, answer: Message, question: Message,
               prior: Sequence[Message]) -> None:
        now = time.monotonic()
        run = _Run(chat.id, answer.id, engine, answer, saved_at=now, started_at=now)
        self._runs[chat.id] = run
        self._reserved.discard(chat.id)
        run.task = asyncio.create_task(self._drive(run, chat, question, list(prior)),
                                       name=f"kb-chat-{chat.id}")
        self._list.touch(chat.id)

    # -- one answer -------------------------------------------------------------------

    def _tools_for(self, chat: Chat) -> tuple[ToolSpec, ...]:
        """The turn's SKAZ tools: ``skaz_ask_user`` only where the agent's own question tool can't work;
        ``skaz_web_search`` (W-3b) only where the agent's own search isn't held (and SKAZ holds searches)."""
        # N6 «Я»: ``skaz_me_edit`` / ``skaz_me_skill`` (registered by the runtime, ``me.tools.attach``) are in
        # every chat turn's tools (a live session's tools never change); a switched-off «Я» is refused when
        # called. Never outside chats.
        dropped: set[str] = set()
        if chat.engine in NATIVE_QUESTIONS:
            dropped.add(ASK_TOOL)
        if self.web is None or chat.engine in NATIVE_WEB:
            dropped.add(WEB_TOOL)
        return tuple(spec for spec in self.tools.specs() if spec.name not in dropped)

    async def _drive(self, run: _Run, chat: Chat, question: Message, prior: list[Message]) -> None:
        reader = MaterialReader(self.kb, self._text_layer())
        resolver = Resolver(self.kb, reader)
        builder = ContextBuilder(self.kb, reader, self.study)
        parser = StreamParser()
        stream: AsyncIterator[AgentEvent] | None = None
        terminal: Completed | Failed | None = None
        run.question = question
        try:
            assert question.input is not None
            request = await disk_call(builder.request, chat, question.input, self._other_chat)
            language = await disk_call(self._wiki_language)
            # Read when the turn is built: switching a skill applies from the next answer (H3).
            skills = await disk_call(enabled_skills, self.kb.settings)
            # N6 «Я»: read when the turn is built too; chats are the only turns that carry it (decision 15).
            me = await disk_call(snapshot, me_store(self.kb))
            # W-2: the agent's own web search, only where SKAZ can hold each query before it is sent;
            # W-3b: the other agents search only through ``skaz_web_search`` (their own search stays off).
            native = run.engine.id in NATIVE_WEB
            web = web_support(run.engine)
            gate = (ChatWebGate(self.web, RunRef(run.run_id, run.chat_id, run.message.id, run.engine.id))
                    if self.web is not None and native and web.available else None)
            told = instructions(language, skills)
            web_text = web_instructions(web, tool=not native) if self.web is not None else ""
            if web_text:  # N7: the chat's search rules (kept by SKAZ in code; the text tells the agent why)
                rules = await disk_call(SearchRulesStore(self.kb.db, self.kb.settings).active, chat.id)
                web_text = "\n\n".join(part for part in (web_text, rules_instructions(rules)) if part)
            if web_text:
                told = f"{told}\n\n{web_text}"
            told = with_me(told, me)  # after every SKAZ rule; a live session gets later changes as notes
            # N6: continue / revert the chat's live session, or start a new seeded one. The context also
            # records the tool set and fixed instructions a session starts with (a change reseeds once).
            context: SessionContext | None = None
            if session_support(run.engine).live:
                gone = await disk_call(self._gone_materials, prior)
                context = SessionContext(language, tuple(skill.id for skill in skills), web_text, gone,
                                         marks(me), me, tools=tuple(sorted(spec.name for spec in
                                                                           self._tools_for(chat))),
                                         base=BASE_INSTRUCTIONS)
            entries = await self._plan_session(run, chat, prior, context)
            if run.decision is not None:
                run.context = context
            reseeded = False
            while True:
                turn = await self._turn(run, chat, prior, entries, request, told, gate, skills)
                run.prompt_characters = len(turn.instructions) + sum(len(item.content)
                                                                     for item in turn.messages)
                stream = run.engine.run(turn)
                lost = False
                async for event in stream:
                    if isinstance(event, TextDelta):
                        run.produced = True
                        await self._apply(run, parser.feed(event.text), resolver)
                    elif isinstance(event, ToolCall):
                        run.produced = True
                        run.tool_calls += 1
                        self._add_part(run, await disk_call(resolver.tool, event.name, event.arguments))
                    elif isinstance(event, SessionBound):
                        await self._bound(run, event)
                    elif isinstance(event, Compacted):
                        await self._compacted(run)
                    elif isinstance(event, Completed | Failed):
                        lost = (isinstance(event, Failed) and event.session_lost and not run.produced
                                and run.decision is not None and run.decision.plan.mode != "start")
                        if lost and (reseeded or run.stopping):
                            lost = False  # at most one reseed per answer, none after a stop
                            event = (Failed(run.run_id, "cancelled", STOPPED) if run.stopping else event)
                        terminal = None if lost else event
                        break
                    await self._checkpoint(run)
                if not lost:
                    break
                # The live session can't be continued: one new session seeded with the history instead.
                closer = getattr(stream, "aclose", None)
                if callable(closer):
                    with contextlib.suppress(Exception):
                        await closer()
                stream = None
                reseeded = True
                log.info("Chat answer %s: the agent session could not be continued; starting a new one",
                         run.run_id)
                if await disk_call(self.sessions.drop, chat.id):
                    self._kick_deletions()
                run.decision, run.session, run.bound = SessionDecision(START), None, None
                run.seeded = tuple(keys(entries))
            await self._apply(run, parser.finish(), resolver)
        except asyncio.CancelledError:
            terminal = Failed(run.run_id, "cancelled", STOPPED)
            with contextlib.suppress(Exception):
                await run.engine.interrupt(run.run_id)
        except Exception as error:
            log.error("Chat answer %s failed: %s", run.run_id, error_note(error))
            terminal = Failed(run.run_id, "other", UNEXPECTED)
        finally:
            closer = getattr(stream, "aclose", None)
            if callable(closer):
                with contextlib.suppress(BaseException):
                    await closer()
            await self._finish(run, terminal)

    # -- the live agent session (N6) ---------------------------------------------------

    async def _plan_session(self, run: _Run, chat: Chat, prior: Sequence[Message],
                            now: SessionContext | None = None) -> list[tuple[str, TurnMessage]]:
        """Decide how this answer uses the chat's agent session (``chats.live.plan_session``); an old
        session that can't be used is dropped here and queued for deletion. Returns the history a live
        session must hold (with message ids)."""
        support = session_support(run.engine)
        session = await disk_call(self.sessions.get, chat.id)
        if not support.live:
            if session is not None and await disk_call(self.sessions.drop, chat.id):
                self._kick_deletions()  # another engine's session: this engine can't use it
            return []
        entries = live_entries(prior)
        history_keys = keys(entries)
        decision = plan_session(session, run.engine.id, support, history_keys, now)
        assert decision is not None
        if decision.replace and await disk_call(self.sessions.drop, chat.id):
            self._kick_deletions()
        run.decision = decision
        run.session = None if decision.replace else session
        run.seeded = tuple(history_keys) if decision.plan.mode == "start" else ()
        return entries

    def _gone_materials(self, prior: Sequence[Message]) -> tuple[str, ...]:
        """Materials this chat cited that are no longer in the library (decision 10)."""
        return tuple(sorted(material_id for material_id in cited_materials(prior)
                            if self.kb.material_repo.get(material_id) is None))

    async def _turn(self, run: _Run, chat: Chat, prior: Sequence[Message],
                    entries: Sequence[tuple[str, TurnMessage]], request: str, told: str,
                    gate: ChatWebGate | None, skills: Sequence[Any]) -> AgentTurn:
        decision = run.decision
        summary: str | None = None
        if decision is None or decision.plan.mode == "start":
            # Stateless engines get the history every time; a new live session gets it once as its seed.
            earlier = history(prior) if decision is None else tuple(turn for _, turn in entries)
            # A long chat: what left the history window, retold by this chat's own agent (slice 5);
            # never on a live continue — the agent compacts its own conversation (decision 13).
            summary = await self.summaries.for_turn(chat.id, earlier, run.engine, chat.model, chat.effort)
            messages: tuple[TurnMessage, ...] = (*earlier, TurnMessage("user", request))
        else:
            before = run.session.context if run.session is not None else None
            note = context_note(before, run.context, skills) if run.context is not None else ""
            messages = (TurnMessage("user", f"{note}\n\n{request}" if note else request),)
        return AgentTurn(run_id=run.run_id, messages=messages, instructions=told, tools=self._tools_for(chat),
                         web=gate, model=chat.model, effort=chat.effort, history_summary=summary,
                         session=decision.plan if decision is not None else None)

    async def _bound(self, run: _Run, event: SessionBound) -> None:
        """The agent took this turn into a session: remember it at once (a crash mid-answer then still
        knows the turn to revert, or the session to delete)."""
        if run.decision is None or run.context is None:
            return  # a stateless turn: nothing to keep
        run.bound = event
        await disk_call(self.sessions.bind, run.chat_id, run.engine.id, event.session_id, run.message.model,
                        event.turn_id, run.decision.plan, run.context)

    async def _compacted(self, run: _Run) -> None:
        """The agent compacted the conversation: a thin "History compressed" line in the chat (once)."""
        if run.compacted or run.deleted:
            return
        run.compacted = True
        now = utc_now()
        note = Message(id=new_id("msg"), chat_id=run.chat_id, seq=0, role="system", state="done",
                       created_at=now, parts=(TextPart(COMPACTED_NOTE),), engine=run.engine.id)
        try:
            (added,) = await disk_call(self.repo.add_messages, [note], {})
        except Exception as error:
            log.error("Saving the compaction note of chat answer %s failed: %s", run.run_id,
                      error_note(error))
            return
        self._feed(run.chat_id).emit("message", added.id, message=added)

    async def _record(self, run: _Run, message: Message) -> None:
        """A ``done`` answer of a live session: the session now holds its question and answer too —
        and the user's own messages that answered the agent's question meanwhile (in chat order).

        «Я»: the session's marks stay those of the turn's start, unless the agent changed «Я» in this
        turn — then they are «Я» after the turn (it saw its own edits), and an always-on skill it wrote
        counts as held even if it is empty or off by now; a session that so holds something switched off
        or cleared is dropped at once (decision 6)."""
        bound, decision, question = run.bound, run.decision, run.question
        if bound is None or decision is None or question is None or run.context is None:
            return
        items = [*run.seeded] if decision.plan.mode == "start" else []
        items += keys(live_entries([question, message, *run.absorbed]))
        context = run.context
        try:
            written = {part.skill_id for part in message.parts if isinstance(part, MemoryPart)}
            now = marks(await disk_call(snapshot, me_store(self.kb))) if written else None
            if now is not None:
                context = replace(context, me=held_after_turn(context.me, now, written))
            if not await disk_call(self.sessions.record, run.chat_id, bound.session_id, bound.turn_id, items,
                                   context):
                run.bound = None  # this answer no longer holds it
                self._kick_deletions()  # the session was dropped meanwhile (sign-out): delete it now
            elif now is not None and needs_reseed(context.me, now):
                # E.g. Undo of the agent's profile line landed while the answer was finishing.
                if await disk_call(self.sessions.drop, run.chat_id):
                    run.bound = None
                    self._kick_deletions()
        except Exception as error:
            log.error("Recording the agent session of chat answer %s failed: %s", run.run_id,
                      error_note(error))

    def _kick_deletions(self) -> None:
        """Delete queued agent sessions in the background (a pass is running: one more after it)."""
        if self._closing:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._deleting is not None and not self._deleting.done():
            self._delete_again = True
            return
        self._deleting = loop.create_task(self._deletion_loop(), name="kb-chat-session-deletions")

    async def _deletion_loop(self) -> None:
        while True:
            self._delete_again = False
            try:
                await self.delete_sessions()
            except Exception as error:
                log.error("Deleting agent sessions failed: %s", error_note(error))
            if not self._delete_again or self._closing:
                break
        try:
            self._schedule_retry(await disk_call(self.sessions.next_due))
        except Exception as error:
            log.error("Scheduling the next agent session deletion failed: %s", error_note(error))

    def _schedule_retry(self, due: datetime | None) -> None:
        """One pass when the earliest backed-off deletion is due (while SKAZ runs)."""
        if self._delete_timer is not None:
            self._delete_timer.cancel()
            self._delete_timer = None
        if due is None or self._closing:
            return
        delay = max((due - self.sessions.clock()).total_seconds(), 1.0)
        self._delete_timer = asyncio.get_running_loop().call_later(delay, self._kick_deletions)

    def start(self) -> None:
        """App start: every agent session left queued by an earlier run is tried once (whatever its
        backoff), and the agents' local sessions that no chat and no deletion entry knows are swept."""
        try:
            self.sessions.due_now()
        except Exception as error:
            log.error("Reading the agent sessions to delete failed: %s", error_note(error))
        self._kick_deletions()
        with contextlib.suppress(RuntimeError):  # no running loop: nothing to sweep in the background
            self._sweeping = asyncio.get_running_loop().create_task(self.sweep_sessions(),
                                                                    name="kb-chat-session-sweep")

    async def sweep_sessions(self) -> None:
        """Ask each engine that keeps local session files (``sweep_sessions``) to remove those of
        sessions no chat holds and no deletion waits for (a crash between their start and the record)."""
        engines = cast(Mapping[str, AgentEngine], self.registry.engines)
        for engine_id, engine in engines.items():
            sweep = getattr(engine, "sweep_sessions", None)
            if not callable(sweep) or self._closing:
                continue
            try:
                known = await disk_call(self.sessions.known, engine_id)
                await sweep(lambda session_id, known=known: session_id in known)
            except Exception as error:
                log.warning("Sweeping the %s sessions failed: %s", engine_id, error_note(error))

    def _deletions_held(self, engine_id: str, engine: object) -> bool:
        """The agent is being installed, repaired or updated: its sessions wait (no attempt counted)."""
        try:
            return bool(self.hold_deletions(engine_id)) or bool(update_gate.blocked(engine))
        except Exception:
            return False

    async def delete_sessions(self) -> int:
        """One pass over the due "agent sessions to delete"; returns how many are still queued.

        A failure counts an attempt and the next one waits (``DELETE_BACKOFF``); after
        ``MAX_DELETE_ATTEMPTS`` the session is given up (logged by engine and id only) and the engine
        drops SKAZ's own local traces of it (``forget_session``). An agent that is missing (the engine
        raises ``SessionDeleteDeferred``), being installed / repaired / updated costs no attempt. A
        session a running answer is bound to waits for the next pass; one whose engine can't delete
        sessions now (not wired) stays queued."""
        async with self._delete_lock:
            pending = await disk_call(self.sessions.pending, due=True)
            busy = {run.bound.session_id for run in self._runs.values() if run.bound is not None}
            engines = cast(Mapping[str, AgentEngine], self.registry.engines)
            for entry in pending:
                engine = engines.get(entry.engine)
                deleter = getattr(engine, "delete_session", None)
                if entry.session_id in busy or not callable(deleter) or \
                        self._deletions_held(entry.engine, engine):
                    continue
                try:
                    await deleter(entry.session_id)
                except asyncio.CancelledError:
                    raise
                except SessionDeleteDeferred:
                    continue  # the agent isn't there now: not an attempt
                except Exception as error:
                    attempts = await disk_call(self.sessions.failed, entry.engine, entry.session_id)
                    if attempts >= MAX_DELETE_ATTEMPTS:
                        log.warning("Giving up deleting %s session %s after %d attempts", entry.engine,
                                    entry.session_id, attempts)
                        await self._forget_session(engine, entry.engine, entry.session_id)
                    else:
                        log.info("Deleting %s session %s failed (%s); retried later", entry.engine,
                                 entry.session_id, type(error).__name__)
                    continue
                await disk_call(self.sessions.deleted, entry.engine, entry.session_id)
            return len(await disk_call(self.sessions.pending))

    @staticmethod
    async def _forget_session(engine: object, engine_id: str, session_id: str) -> None:
        """A given-up session: the engine drops SKAZ's own local traces of it (lists, kept prompts)."""
        forget = getattr(engine, "forget_session", None)
        if not callable(forget):
            return
        try:
            result: Any = forget(session_id)
            if asyncio.iscoroutine(result):
                await result
        except Exception as error:
            log.warning("Forgetting %s session %s failed: %s", engine_id, session_id, error_note(error))

    async def drop_me_sessions(self) -> int:
        """«Я» changed (decision 6): every chat's session that holds an always-on skill (Profile, How to
        work with me) the user switched off or cleared — or holds them while «Я» is off now — is dropped
        at once (queued for deletion; the next answer seeds a new one). Returns how many."""
        now = marks(await disk_call(snapshot, me_store(self.kb)))
        rows = await disk_call(self.sessions.contexts)
        dropped = 0
        for chat_id, held in rows:
            if held is None or not needs_reseed(held.me, now):
                continue
            if await disk_call(self.sessions.drop, chat_id):
                dropped += 1  # an answer running in it records nothing (``record`` finds no row)
        if dropped:
            self._kick_deletions()
        return dropped

    async def end_sessions(self, engine: EngineId, wait_s: float = END_SESSIONS_WAIT_S) -> None:
        """Sign-out of an engine (decision 9): every chat's session with it is deleted (bounded wait;
        what is left stays queued and is retried). Its chats start new seeded sessions later."""
        dropped = await disk_call(self.sessions.drop_engine, engine)
        if dropped == 0 and not await disk_call(self.sessions.pending):
            return
        try:
            await asyncio.wait_for(self.delete_sessions(), wait_s)
        except TimeoutError:
            log.warning("Deleting the %s sessions took too long; the rest are retried later", engine)

    def _other_chat(self, chat_id: str) -> tuple[str, Sequence[Message]] | None:
        chat = self.repo.get(chat_id)
        return (chat.title, self.repo.messages(chat_id)) if chat is not None else None

    async def _apply(self, run: _Run, outputs: Sequence[Output], resolver: Resolver) -> None:
        for output in outputs:
            if isinstance(output, TextOut):
                self._append_text(run, output.text)
            elif isinstance(output, CiteToken):
                cite = await disk_call(resolver.cite, output)
                if cite is not None:
                    self._add_part(run, cite)
            elif isinstance(output, PageToken):
                page = await disk_call(resolver.page, output)
                if page is not None:
                    self._add_part(run, page)
            elif isinstance(output, ConnectionOut):
                connection = await disk_call(resolver.connection, output.payload)
                if isinstance(connection, TextPart):
                    self._append_text(run, connection.text)
                else:
                    self._add_part(run, connection)
            elif isinstance(output, BlockStart):
                self._add_part(run, drawing(new_id("blk")))  # P1: a placeholder while the block streams
            elif isinstance(output, BlockData):
                await self._answer_block(run, output, resolver)

    async def _answer_block(self, run: _Run, output: BlockData, resolver: Resolver) -> None:
        """P1: the block's data arrived: checked, it replaces its placeholder (``part_update``)."""
        pending = next((part for part in reversed(run.message.parts)
                        if isinstance(part, BlockPart) and part.state == "drawing"), None)
        block_id = pending.block_id if pending is not None else new_id("blk")
        part = await disk_call(AnswerBlocks(self.kb, resolver, run.chat_id).resolve, output.payload, block_id,
                               output.cut)
        if pending is None:
            self._add_part(run, part)
        else:
            run.message = run.message.with_parts([part if item is pending else item
                                                  for item in run.message.parts])
            self._feed(run.chat_id).emit("part_update", run.message.id, part=part)
        try:
            await disk_call(block_usage.record, self.kb.settings, part)
        except Exception as error:  # the counter never touches the answer
            log.error("Counting an answer block failed: %s", error_note(error))

    def _append_text(self, run: _Run, text: str) -> None:
        if not text:
            return
        parts = list(run.message.parts)
        if parts and isinstance(parts[-1], TextPart):
            parts[-1] = TextPart(parts[-1].text + text)
            run.message = run.message.with_parts(parts)
            self._feed(run.chat_id).emit("delta", run.message.id, text=text)
            return
        self._add_part(run, TextPart(text))

    def _add_part(self, run: _Run, part: Part) -> None:
        run.message = run.message.with_parts([*run.message.parts, part])
        self._feed(run.chat_id).emit("part", run.message.id, part=part)

    async def _checkpoint(self, run: _Run) -> None:
        if time.monotonic() - run.saved_at < self._checkpoint_s:
            return
        run.saved_at = time.monotonic()
        await disk_call(self.repo.save_message, run.message)

    async def _finish(self, run: _Run, terminal: Completed | Failed | None) -> None:
        await self._cancel_waits(run.run_id)
        run.message = run.message.with_parts(finish_drawing(run.message.parts))  # P1: a block left unfinished
        state, failure = _outcome(terminal)
        if state == "cancelled" and run.closing:
            state, failure = "interrupted", Failure("other", RESTART_REASON)
        if state == "done" and not any(not isinstance(part, TextPart) or part.text.strip()
                                       for part in run.message.parts):
            state, failure = "failed", Failure("other", EMPTY_ANSWER)
        message = replace(run.message, state=state, failure=failure)
        run.message = message
        await self._log_usage(run, state, terminal)
        if state == "done" and not run.deleted:
            await self._record(run, message)  # a failed/stopped answer records nothing (its turn is the tail)
        try:
            if not run.deleted:
                chat = await disk_call(self.repo.get, run.chat_id)
                updates: dict[str, Any] = {}
                if chat is not None:
                    folders = await disk_call(self._answer_folders, message.parts)
                    merged = tuple(dict.fromkeys((*chat.folder_ids, *folders)))
                    updates = {"updated_at": utc_now(), "unread": state != "cancelled"}
                    if merged != chat.folder_ids:
                        updates["folder_ids"] = merged
                    if message.parts:
                        updates["last_preview"] = preview(message.parts)
                await disk_call(self.repo.save_message, message, updates)
                # A part changed during the awaits above (e.g. Undo of a «Я» edit, ``update_part``): save
                # the run's latest message — no await between the last check and dropping the run.
                while run.message is not message:
                    message = replace(run.message, state=state, failure=failure)
                    run.message = message
                    await disk_call(self.repo.save_message, message)
        except Exception as error:
            log.error("Saving the end of chat answer %s failed: %s", run.run_id, error_note(error))
        finally:
            if self._runs.get(run.chat_id) is run:
                del self._runs[run.chat_id]
        if not run.deleted:
            self._feed(run.chat_id).emit("state", message.id, message=message)
            self._list.touch(run.chat_id)
        elif run.bound is not None:
            # A deleted chat's answer held its session until now: a pass may have skipped it as busy.
            self._kick_deletions()

    async def _log_usage(self, run: _Run, state: str, terminal: Completed | Failed | None) -> None:
        """One ``agent_usage`` row per answer; a failure to write it never touches the answer."""
        record = RunUsage(
            kind="chat", engine=run.engine.id, model=run.message.model, effort=run.message.effort,
            outcome=state, usage=terminal.usage if isinstance(terminal, Completed) else None,
            tool_calls=run.tool_calls, prompt_characters=run.prompt_characters,
            duration_ms=round((time.monotonic() - run.started_at) * 1000),
            chat_id=run.chat_id, message_id=run.message.id)
        try:
            await disk_call(self.usage_log.record, record)
        except Exception as error:
            log.error("Saving the usage of chat answer %s failed: %s", run.run_id, error_note(error))

    def _answer_folders(self, parts: Sequence[Part]) -> list[str]:
        folders: list[str] = []
        for part in parts:
            if isinstance(part, CitePart):
                record = self.kb.material_repo.get(part.material_id)
                if record is not None:
                    folders.append(record.folder_id)
            elif isinstance(part, ConnectionPart):
                folders.extend(side.folder_id for side in part.sides)
            elif isinstance(part, BlockPart):  # P1: materials cited only in an answer block count too
                for source in part.sources:
                    if isinstance(source, MaterialSource):
                        record = self.kb.material_repo.get(source.material_id)
                        if record is not None:
                            folders.append(record.folder_id)
        return folders

    # -- stopping ---------------------------------------------------------------------

    async def stop(self, chat_id: str, message_id: str) -> Message:
        await self._chat(chat_id)
        run = self._runs.get(chat_id)
        if run is not None and run.message.id == message_id:
            await self._stop_run(run)
        return await self._message(chat_id, message_id)

    async def _cancel_waits(self, run_id: str, *, closing: bool = False) -> None:
        """What the run still waits for (permissions, questions) ends as cancelled; the agent learns it."""
        reason = RESTARTED if closing else STOPPED_WAIT
        try:
            if self.permissions is not None:
                await self.permissions.cancel_run(run_id, reason)
            if self.questions is not None:
                await self.questions.cancel_run(run_id)
            if self.web is not None:
                await self.web.cancel_run(run_id, reason)
        except Exception as error:
            log.error("Cancelling the requests of chat answer %s failed: %s", run_id, error_note(error))

    def run_ref(self, run_id: str) -> RunRef | None:
        """The chat answer an agent run belongs to (tools learn their chat this way)."""
        for run in self._runs.values():
            if run.run_id == run_id:
                return RunRef(run.run_id, run.chat_id, run.message.id, run.engine.id)
        return None

    async def _stop_run(self, run: _Run) -> None:
        run.stopping = True
        task = run.task
        await self._cancel_waits(run.run_id)
        with contextlib.suppress(Exception):
            await run.engine.interrupt(run.run_id)
        if task is None:
            return
        try:
            await asyncio.wait_for(asyncio.shield(task), self._stop_timeout_s)
        except TimeoutError:
            task.cancel()  # the engine ignored the interrupt: stop waiting for it
            await asyncio.gather(task, return_exceptions=True)
        except Exception as error:
            log.error("Stopping chat answer %s failed: %s", run.run_id, error_note(error))

    async def close(self) -> None:
        """App shutdown: every answer ends as interrupted (resumable) with the text it streamed so far,
        within ``close_stop_s`` per answer, before the database closes."""
        self._closing = True
        runs = list(self._runs.values())
        for run in runs:
            run.closing = True
        await asyncio.gather(*(self._close_run(run) for run in runs), return_exceptions=True)
        if self._delete_timer is not None:
            self._delete_timer.cancel()
            self._delete_timer = None
        for task in (self._deleting, self._sweeping):
            if task is not None and not task.done():  # what is left stays queued for the next start
                task.cancel()
                await asyncio.wait({task}, timeout=self._close_stop_s)

    async def _close_run(self, run: _Run) -> None:
        run.stopping = True
        await self._cancel_waits(run.run_id, closing=True)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(run.engine.interrupt(run.run_id), self._close_stop_s)
        task = run.task
        if task is None:
            return
        done, _ = await asyncio.wait({task}, timeout=self._close_stop_s)  # never cancels the answer itself
        if done:
            return
        # The engine ignored the interrupt: keep what was streamed, honestly marked, before cancelling.
        interrupted = replace(run.message, state="interrupted", failure=Failure("other", RESTART_REASON),
                              parts=tuple(finish_drawing(run.message.parts)))  # P1: no block left drawing
        try:
            await disk_call(self.repo.save_message, interrupted)
        except Exception as error:
            log.error("Saving interrupted chat answer %s failed: %s", run.run_id, error_note(error))
        task.cancel()
        done, _ = await asyncio.wait({task}, timeout=self._close_stop_s / 2)
        if not done:
            log.warning("chat answer %s was still running at shutdown (saved as interrupted)", run.run_id)

    def active_runs(self) -> set[str]:
        return {run.run_id for run in self._runs.values()}

    # -- wiki and export ------------------------------------------------------------

    def _writer(self) -> AnalysisWriter:
        settings = read_settings(self.kb.settings)
        return AnalysisWriter(self.kb, MaterialReader(self.kb, self._text_layer()), settings.language)

    async def save_message(self, chat_id: str, message_id: str) -> tuple[str, str, str, str | None]:
        """The answer as an analysis page; a repeated (also a concurrent) save is 409 ``ALREADY_SAVED``
        naming the page the first one wrote. The last item is the warning about what was left out."""
        async with self._saving.hold(message_id):
            return await self._save_message(chat_id, message_id)

    async def _save_message(self, chat_id: str, message_id: str) -> tuple[str, str, str, str | None]:
        chat = await self._chat(chat_id)
        message = await self._message(chat_id, message_id)
        if message.role != "assistant" or message.state != "done":
            raise ChatConflict("Only a finished answer can be saved to the wiki.", "NOT_FINISHED")
        saved_id = message.saved_page_id
        saved = await disk_call(self.kb.page_repo.get, saved_id) if saved_id else None
        if saved is not None:
            raise ChatConflict("This answer is already saved in the wiki.", "ALREADY_SAVED",
                               saved_page_id=saved.id)
        question = await disk_call(self.repo.message, chat_id, message.reply_to or "")
        question_text = question.input.text if question is not None and question.input is not None else ""
        writer = self._writer()
        record = await disk_call(writer.save, [question_text, chat.title],
                                 [Section(question_text, message.parts)], chat_id)
        updated = replace(message, saved_page_id=record.id)
        await disk_call(self.repo.save_message, updated)
        self._feed(chat_id).emit("state", updated.id, message=updated)
        return record.id, record.kind, record.title, writer.warning

    async def save_chat(self, chat_id: str) -> tuple[str, str, str, str | None]:
        chat = await self._chat(chat_id)
        messages = self._live(await disk_call(self.repo.messages, chat_id))
        answers: dict[str, Message] = {}
        for message in messages:
            if message.role == "assistant" and message.state == "done" and message.reply_to:
                answers[message.reply_to] = message  # the latest finished answer to each question
        sections = [Section(message.input.text, answers[message.id].parts) for message in messages
                    if message.role == "user" and message.input is not None and message.id in answers]
        writer = self._writer()
        record = await disk_call(writer.save, [chat.title], sections, chat_id)
        return record.id, record.kind, record.title, writer.warning

    async def export(self, chat_id: str) -> ChatExport:
        chat = await self._chat(chat_id)
        messages = self._live(await disk_call(self.repo.messages, chat_id))
        return await disk_call(export_chat, self.kb, chat, messages, utc_now)

    # -- @-mentions -------------------------------------------------------------------

    def mentions(self, query: str, limit: int = MENTION_LIMIT) -> MentionResults:
        # Every word of the query must be in the name, in any order ("B5 qual" → "B5 · quality check").
        words = name_key(query).split()

        def hit(*names: str | None) -> bool:
            return not words or any(name and all(word in name_key(name) for word in words) for name in names)

        pages = [(page.id, page.kind, page.title) for page in self.kb.page_repo.list_all()
                 if hit(page.title, page.original, *page.aliases)][:limit]
        materials = [(record.id, record.title) for record in self.kb.materials() if hit(record.title)][:limit]
        chats = [(chat.id, chat.title) for chat in self.repo.list_all() if hit(chat.title)][:limit]
        return MentionResults(tuple(pages), tuple(materials), tuple(chats))


#: The id field of each part kind that can be changed in place (``ChatService.update_part``).
_PART_IDS: dict[type, str] = {MemoryPart: "edit_id", PermissionPart: "permission_id",
                              QuestionPart: "question_id", StudyPart: "study_id", WebSearchPart: "search_id",
                              WikiFixPart: "fix_id"}



def memory_view(kb: KnowledgeService, part: MemoryPart) -> tuple[str, str]:
    """(skill title, summary) of a «Я» chip as shown. The stored part holds a generic label only (the
    chat database is plain SQLite); the edit's own words come from the «Я» vault — or the generic ones
    once the vault no longer has the edit (trimmed, erased). Blocking: call it off the event loop."""
    try:
        edit = me_store(kb).edit(part.edit_id)
    except MeError:
        return part.skill_title, part.summary
    return edit.skill_title or part.skill_title, edit.summary or part.summary

def _same_part(a: Part, b: Part) -> bool:
    field = _PART_IDS.get(type(a))
    return field is not None and type(a) is type(b) and getattr(a, field) == getattr(b, field)


def _swap_part(parts: Sequence[Part], part: Part) -> tuple[Part, ...]:
    if type(part) not in _PART_IDS:
        raise ValueError(f"A {type(part).__name__} can't be changed in place.")
    return tuple(part if _same_part(old, part) else old for old in parts)


def _outcome(terminal: Completed | Failed | None) -> tuple[MessageState, Failure | None]:
    if isinstance(terminal, Completed):
        return "done", None
    if terminal is None:
        return "failed", Failure("other", NO_TERMINAL)
    retry_at = None
    if terminal.retry_at is not None:
        moment = terminal.retry_at if terminal.retry_at.tzinfo else terminal.retry_at.replace(tzinfo=UTC)
        retry_at = moment.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    failure = Failure(terminal.kind, terminal.message, retry_at)
    if terminal.kind == "cancelled":
        return "cancelled", failure
    if terminal.kind in _INTERRUPTING:
        return "interrupted", failure
    return "failed", failure
