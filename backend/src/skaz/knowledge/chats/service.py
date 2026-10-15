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
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC
from typing import Any, Literal

from ...native_io import disk_call
from ..agents.engine import (
    AgentEngine,
    AgentEvent,
    AgentTurn,
    Completed,
    EngineId,
    Failed,
    TextDelta,
    ToolCall,
    TurnMessage,
)
from ..agents.registry import ENGINE_NAMES, EngineRegistry, EngineUnavailable
from ..agents.tools import ToolRegistry
from ..errors import KnowledgeError, NotFound
from ..ids import new_id
from ..ingest.protocols import IdentityTextLayer, TextLayer
from ..ingest.settings import read_settings
from ..markdown.text import name_key
from ..service import KnowledgeService
from .analysis import AnalysisWriter, Section
from .context import ContextBuilder, history, instructions
from .events import ChatEvent, ChatFeed, ListFeed
from .export import ChatExport, export_chat
from .model import (
    FINISHED,
    Chat,
    CitePart,
    ConnectionPart,
    Failure,
    Message,
    MessageInput,
    MessageState,
    Part,
    TextPart,
)
from .parsing import CiteToken, ConnectionOut, Output, PageToken, StreamParser, TextOut
from .resolve import MaterialReader, Resolver
from .store import RESTART_REASON, ChatRepository
from .text import DEFAULT_TITLE, auto_title, preview, utc_now

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


class ChatService:
    def __init__(self, kb: KnowledgeService, *, agents: Callable[[], EngineRegistry], tools: ToolRegistry,
                 text_layer: Callable[[], TextLayer] | None = None, checkpoint_s: float = CHECKPOINT_S,
                 stop_timeout_s: float = STOP_TIMEOUT_S) -> None:
        self.kb = kb
        self.repo = ChatRepository(kb.db)
        self._agents = agents
        self.tools = tools
        self._text_layer = text_layer or (lambda: IdentityTextLayer())
        self._checkpoint_s = checkpoint_s
        self._stop_timeout_s = stop_timeout_s
        #: Answers that were streaming when SKAZ stopped are "interrupted" (resumable) from now on.
        self.recovered = self.repo.interrupt_streaming()
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

        return [ChatView(chat, self.state_of(chat.id)) for chat in await disk_call(load)]

    async def get(self, chat_id: str) -> ChatView:
        chat = await self._chat(chat_id)
        messages = await disk_call(self.repo.messages, chat_id)
        return ChatView(chat, self.state_of(chat_id), self._live(messages), self._feed(chat_id).cursor)

    async def summary(self, chat_id: str) -> ChatView:
        return ChatView(await self._chat(chat_id), self.state_of(chat_id))

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
        chats = await disk_call(self.repo.list_all, ids=changed)
        return [ChatView(chat, self.state_of(chat.id)) for chat in chats], cursor

    # -- creating and changing --------------------------------------------------

    async def create(self, *, title: str | None = None, engine: EngineId | None = None,
                     model: str | None = None, effort: str | None = None,
                     recording_material_id: str | None = None) -> ChatView:
        chosen: EngineId = engine or self.registry.default()
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
            view = await self.registry.view(engine)
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
            notes.append(await self._switch_note(chat, engine, model, effort))
        if not updates:
            return ChatView(chat, self.state_of(chat_id))
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
        self._list.touch(chat_id)
        return await self.summary(chat_id)

    async def _switch_note(self, chat: Chat, engine: EngineId, model: str | None, effort: str | None) -> str:
        label = await self._model_label(engine, model)
        if engine != chat.engine:
            return f"Switched to {ENGINE_NAMES[engine]}" + (f" · {label}" if label else "")
        if model != chat.model:
            return f"Model changed to {label or 'the default model'}"
        return f"Effort set to {effort or 'default'}"

    async def _model_label(self, engine: EngineId, model: str | None) -> str | None:
        if model is None:
            return None
        with contextlib.suppress(Exception):
            view = await self.registry.view(engine)
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
        await disk_call(self.repo.delete, chat_id)
        self._feeds.pop(chat_id, None)
        self._list.touch(chat_id)

    async def mark_read(self, chat_id: str) -> None:
        chat = await self._chat(chat_id)
        if chat.unread:
            await disk_call(self.repo.update, chat_id, unread=False)
            self._list.touch(chat_id)

    # -- asking ---------------------------------------------------------------------

    async def send(self, chat_id: str, given: MessageInput) -> tuple[Message, Message]:
        chat = await self._chat(chat_id)
        self._reserve(chat_id)
        try:
            engine = await self.registry.require(chat.engine)
            prior = await disk_call(self.repo.messages, chat_id)
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
            engine = await self.registry.require(chat.engine)
            messages = await disk_call(self.repo.messages, chat_id)
            prior = [message for message in messages if message.seq < question.seq]
            now = utc_now()
            (answer,) = await disk_call(self.repo.add_messages, [self._new_answer(chat, question.id, now)],
                                        {"updated_at": now, "unread": False})
        except BaseException:
            self._reserved.discard(chat_id)
            raise
        self._feed(chat_id).emit("message", answer.id, message=answer)
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
        run = _Run(chat.id, answer.id, engine, answer, saved_at=time.monotonic())
        self._runs[chat.id] = run
        self._reserved.discard(chat.id)
        run.task = asyncio.create_task(self._drive(run, chat, question, list(prior)),
                                       name=f"kb-chat-{chat.id}")
        self._list.touch(chat.id)

    # -- one answer -------------------------------------------------------------------

    async def _drive(self, run: _Run, chat: Chat, question: Message, prior: list[Message]) -> None:
        reader = MaterialReader(self.kb, self._text_layer())
        resolver = Resolver(self.kb, reader)
        builder = ContextBuilder(self.kb, reader)
        parser = StreamParser()
        stream: AsyncIterator[AgentEvent] | None = None
        terminal: Completed | Failed | None = None
        try:
            assert question.input is not None
            request = await disk_call(builder.request, chat, question.input, self._other_chat)
            language = await disk_call(self._wiki_language)
            turn = AgentTurn(run_id=run.run_id, messages=(*history(prior), TurnMessage("user", request)),
                             instructions=instructions(language), tools=self.tools.specs(), model=chat.model,
                             effort=chat.effort)
            stream = run.engine.run(turn)
            async for event in stream:
                if isinstance(event, TextDelta):
                    await self._apply(run, parser.feed(event.text), resolver)
                elif isinstance(event, ToolCall):
                    self._add_part(run, await disk_call(resolver.tool, event.name, event.arguments))
                elif isinstance(event, Completed | Failed):
                    terminal = event
                    break
                await self._checkpoint(run)
            await self._apply(run, parser.finish(), resolver)
        except asyncio.CancelledError:
            terminal = Failed(run.run_id, "cancelled", STOPPED)
            with contextlib.suppress(Exception):
                await run.engine.interrupt(run.run_id)
        except Exception:
            log.exception("Chat answer %s failed", run.run_id)
            terminal = Failed(run.run_id, "other", UNEXPECTED)
        finally:
            closer = getattr(stream, "aclose", None)
            if callable(closer):
                with contextlib.suppress(BaseException):
                    await closer()
            await self._finish(run, terminal)

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
        state, failure = _outcome(terminal)
        if state == "cancelled" and run.closing:
            state, failure = "interrupted", Failure("other", RESTART_REASON)
        if state == "done" and not any(not isinstance(part, TextPart) or part.text.strip()
                                       for part in run.message.parts):
            state, failure = "failed", Failure("other", EMPTY_ANSWER)
        message = replace(run.message, state=state, failure=failure)
        run.message = message
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
        except Exception:
            log.exception("Saving the end of chat answer %s failed", run.run_id)
        finally:
            if self._runs.get(run.chat_id) is run:
                del self._runs[run.chat_id]
        if not run.deleted:
            self._feed(run.chat_id).emit("state", message.id, message=message)
            self._list.touch(run.chat_id)

    def _answer_folders(self, parts: Sequence[Part]) -> list[str]:
        folders: list[str] = []
        for part in parts:
            if isinstance(part, CitePart):
                record = self.kb.material_repo.get(part.material_id)
                if record is not None:
                    folders.append(record.folder_id)
            elif isinstance(part, ConnectionPart):
                folders.extend(side.folder_id for side in part.sides)
        return folders

    # -- stopping ---------------------------------------------------------------------

    async def stop(self, chat_id: str, message_id: str) -> Message:
        await self._chat(chat_id)
        run = self._runs.get(chat_id)
        if run is not None and run.message.id == message_id:
            await self._stop_run(run)
        return await self._message(chat_id, message_id)

    async def _stop_run(self, run: _Run) -> None:
        task = run.task
        with contextlib.suppress(Exception):
            await run.engine.interrupt(run.run_id)
        if task is None:
            return
        try:
            await asyncio.wait_for(asyncio.shield(task), self._stop_timeout_s)
        except TimeoutError:
            task.cancel()  # the engine ignored the interrupt: stop waiting for it
            await asyncio.gather(task, return_exceptions=True)
        except Exception:
            log.exception("Stopping chat answer %s failed", run.run_id)

    async def close(self) -> None:
        self._closing = True
        runs = list(self._runs.values())
        for run in runs:
            run.closing = True
        await asyncio.gather(*(self._stop_run(run) for run in runs), return_exceptions=True)

    def active_runs(self) -> set[str]:
        return {run.run_id for run in self._runs.values()}

    # -- wiki and export ------------------------------------------------------------

    def _writer(self) -> AnalysisWriter:
        settings = read_settings(self.kb.settings)
        return AnalysisWriter(self.kb, MaterialReader(self.kb, self._text_layer()), settings.language)

    async def save_message(self, chat_id: str, message_id: str) -> tuple[str, str, str]:
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
        return record.id, record.kind, record.title

    async def save_chat(self, chat_id: str) -> tuple[str, str, str]:
        chat = await self._chat(chat_id)
        messages = self._live(await disk_call(self.repo.messages, chat_id))
        answers: dict[str, Message] = {}
        for message in messages:
            if message.role == "assistant" and message.state == "done" and message.reply_to:
                answers[message.reply_to] = message  # the latest finished answer to each question
        sections = [Section(message.input.text, answers[message.id].parts) for message in messages
                    if message.role == "user" and message.input is not None and message.id in answers]
        record = await disk_call(self._writer().save, [chat.title], sections, chat_id)
        return record.id, record.kind, record.title

    async def export(self, chat_id: str) -> ChatExport:
        chat = await self._chat(chat_id)
        messages = self._live(await disk_call(self.repo.messages, chat_id))
        return await disk_call(export_chat, self.kb, chat, messages, utc_now)

    # -- @-mentions -------------------------------------------------------------------

    def mentions(self, query: str, limit: int = MENTION_LIMIT) -> MentionResults:
        key = name_key(query.strip())

        def hit(*names: str | None) -> bool:
            return not key or any(name and key in name_key(name) for name in names)

        pages = [(page.id, page.kind, page.title) for page in self.kb.page_repo.list_all()
                 if hit(page.title, page.original, *page.aliases)][:limit]
        materials = [(record.id, record.title) for record in self.kb.materials() if hit(record.title)][:limit]
        chats = [(chat.id, chat.title) for chat in self.repo.list_all() if hit(chat.title)][:limit]
        return MentionResults(tuple(pages), tuple(materials), tuple(chats))


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
