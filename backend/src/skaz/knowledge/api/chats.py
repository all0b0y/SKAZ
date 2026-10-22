"""``/kb/chats``: general chats (area C1, API-B2 §3).

Errors keep the usual ``{"detail": "…"}`` shape; conflicts the UI branches on
add a machine ``code`` (``ANSWERING``, ``AGENT_UNAVAILABLE`` with ``engine`` and
``action``, ``ALREADY_SAVED`` with ``saved_page_id`` …) next to ``detail``.
"""
from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from ..agents.registry import EngineUnavailable
from ..agents.web import site_of
from ..chats.events import ChatEvent
from ..chats.model import (
    CitePart,
    ConnectionPart,
    Message,
    MessageInput,
    OpenContext,
    PagePart,
    Part,
    PermissionPart,
    QuestionPart,
    Quote,
    Ref,
    StudyPart,
    TextPart,
    WebSearchPart,
)
from ..chats.service import ChatConflict, ChatService, ChatView
from ..errors import KnowledgeError
from ..permissions.broker import PermissionConflict
from ..permissions.store import ControlStore, PermissionRecord, QuestionRecord
from ..permissions.web_search import WebSearchRecord, WebSearchStore
from ..service import KnowledgeService
from ..store.database import MAX_DB_INT
from ..study.service import StudyService
from .deps import kb_call
from .schemas import KbCitation, KbPageRef
from .schemas_chats import (
    KbChat,
    KbChatCreate,
    KbChatEvent,
    KbChatEvents,
    KbChatExport,
    KbChatFilter,
    KbChatLastChoice,
    KbChatListEvents,
    KbChatPatch,
    KbChatSummary,
    KbCitePart,
    KbConnectionFolder,
    KbConnectionPart,
    KbFailure,
    KbMessage,
    KbMessageEdit,
    KbMessageInput,
    KbMessagePart,
    KbOpenContext,
    KbPagePart,
    KbPermissionChange,
    KbPermissionPart,
    KbPermissionSummary,
    KbQuestionOption,
    KbQuestionPart,
    KbQuote,
    KbRef,
    KbSavedAnalysis,
    KbSend,
    KbSendResult,
    KbTextPart,
    KbToolPart,
)
from .schemas_web import KbWebLink, KbWebSearchPart
from .study import study_part

MAX_WAIT_S = 25.0
MAX_LIST = 500


def error_response(error: KnowledgeError) -> JSONResponse:
    content: dict[str, Any] = {"detail": error.message}
    if isinstance(error, ChatConflict):
        content.update(code=error.code, **error.extra)
    elif isinstance(error, PermissionConflict):
        content.update(code=error.code)
    elif isinstance(error, EngineUnavailable):
        content.update(code="AGENT_UNAVAILABLE", engine=error.engine, action=error.action)
    return JSONResponse(status_code=error.status_code, content=content)


class ChatRoute(APIRoute):
    """Domain errors raised by a chat endpoint become plain-English JSON errors (with a code if any)."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def guarded(request: Request) -> Response:
            try:
                return await handler(request)
            except KnowledgeError as error:
                return error_response(error)

        return guarded


router = APIRouter(prefix="/kb/chats", tags=["kb"], route_class=ChatRoute)


def get_chats(request: Request) -> ChatService:
    return cast(ChatService, request.app.state.runtime.kb_chats)


ChatsDep = Annotated[ChatService, Depends(get_chats)]
After = Annotated[int, Query(ge=0, le=MAX_DB_INT)]
Wait = Annotated[float, Query(ge=0, le=MAX_WAIT_S)]


# -- presenting ---------------------------------------------------------------------


class Presenter:
    """Domain messages → API models; titles, times and availability are looked up now."""

    def __init__(self, kb: KnowledgeService) -> None:
        self.kb = kb
        self.controls = ControlStore(kb.db)
        self.web = WebSearchStore(kb.db)
        #: Reads study blocks for their parts (no writes: saving goes through the app's service).
        self.study = StudyService(kb, None, language=lambda: "en")
        self._folders: dict[str, str] = {}

    def citation(self, material_id: str, seg: int, quote: str | None) -> KbCitation:
        found = self.kb.material_repo.fragment_map({(material_id, seg)}).get((material_id, seg))
        if found is None:
            return KbCitation(material_id=material_id, seg=seg, available=False, material_title=None,
                              start_ms=None, end_ms=None, page=None, quote=quote)
        fragment, title = found
        return KbCitation(material_id=material_id, seg=seg, available=True, material_title=title,
                          start_ms=fragment.start_ms, end_ms=fragment.end_ms, page=fragment.page, quote=quote)

    def page_ref(self, page_id: str, title: str = "", kind: str = "concept") -> KbPageRef:
        record = self.kb.page_repo.get(page_id)
        if record is not None:
            title, kind = record.title, record.kind
        return KbPageRef.model_validate({"id": page_id, "kind": kind, "title": title})

    def folder_name(self, folder_id: str) -> str:
        if folder_id not in self._folders:
            folder = self.kb.folder_repo.get(folder_id)
            self._folders[folder_id] = folder.name if folder else ""
        return self._folders[folder_id]

    def part(self, part: Part) -> KbMessagePart:
        if isinstance(part, PermissionPart):
            record = self.controls.permission(part.permission_id)
            return KbMessagePart(permission_part(record) if record is not None
                                 else KbTextPart(type="text", text=""))
        if isinstance(part, QuestionPart):
            found = self.controls.question(part.question_id)
            return KbMessagePart(question_part(found) if found is not None
                                 else KbTextPart(type="text", text=""))
        if isinstance(part, WebSearchPart):
            search = self.web.get(part.search_id)
            return KbMessagePart(web_search_part(search) if search is not None
                                 else KbTextPart(type="text", text=""))
        if isinstance(part, StudyPart):
            block = self.study.store.block(part.study_id)
            return KbMessagePart(study_part(self.study, block, self.citation) if block is not None
                                 else KbTextPart(type="text", text=""))
        if isinstance(part, TextPart):
            return KbMessagePart(KbTextPart(type="text", text=part.text))
        if isinstance(part, CitePart):
            return KbMessagePart(KbCitePart(type="cite",
                                            citation=self.citation(part.material_id, part.seg, part.quote)))
        if isinstance(part, PagePart):
            page = self.page_ref(part.page_id, part.title, part.kind)
            available = self.kb.page_repo.get(part.page_id) is not None
            return KbMessagePart(KbPagePart(type="page", page=page, block_id=part.block_id,
                                            available=available))
        if isinstance(part, ConnectionPart):
            linked = part.page_id is not None and self.kb.page_repo.get(part.page_id) is not None
            folders = [KbConnectionFolder(folder_id=side.folder_id,
                                          folder_name=self.folder_name(side.folder_id), text=side.text,
                                          citation=self.citation(side.material_id, side.seg, side.quote))
                       for side in part.sides]
            return KbMessagePart(KbConnectionPart(
                type="connection", inference=part.inference, folders=folders,
                page=self.page_ref(part.page_id) if linked and part.page_id else None,
            ))
        return KbMessagePart(KbToolPart(type="tool", name=part.name, label=part.label))

    def message(self, message: Message) -> KbMessage:
        given = message.input
        return KbMessage(
            id=message.id, seq=message.seq, role=message.role, created_at=message.created_at,
            engine=message.engine, model=message.model, state=message.state,
            parts=[self.part(part) for part in message.parts],
            failure=KbFailure(kind=message.failure.kind, message=message.failure.message,
                              retry_at=message.failure.retry_at) if message.failure else None,
            saved_page_id=message.saved_page_id,
            input=KbMessageInput(
                text=given.text,
                mentions=[KbRef(type=ref.type, id=ref.id, title=ref.title) for ref in given.mentions],
                quotes=[KbQuote(source=quote.source, id=quote.id, block_id=quote.block_id, seg=quote.seg,
                                message_id=quote.message_id, text=quote.text) for quote in given.quotes],
                attachments=list(given.attachments),
            ) if given is not None else None,
        )

    def event(self, event: ChatEvent) -> KbChatEvent:
        return KbChatEvent(seq=event.seq, type=event.type, message_id=event.message_id, text=event.text,
                           part=self.part(event.part) if event.part is not None else None,
                           message=self.message(event.message) if event.message is not None else None)


def summary(view: ChatView) -> KbChatSummary:
    chat = view.chat
    return KbChatSummary(
        id=chat.id, title=chat.title, pinned=chat.pinned, engine=chat.engine, model=chat.model,
        effort=chat.effort,
        created_at=chat.created_at, updated_at=chat.updated_at, last_preview=chat.last_preview,
        recording_material_id=chat.recording_material_id, folder_ids=list(chat.folder_ids), state=view.state,
        unread=chat.unread, waiting_for_user=view.waiting,
    )


def permission_part(record: PermissionRecord) -> KbPermissionPart:
    preview = record.preview
    found = preview.get("summary")
    raw: dict[str, Any] = found if isinstance(found, dict) else {}
    summary = KbPermissionSummary(added=int(raw.get("added", 0)), changed=int(raw.get("changed", 0)),
                                  removed=int(raw.get("removed", 0)),
                                  user_notes_untouched=bool(raw.get("user_notes_untouched", True)))
    changes = [KbPermissionChange.model_validate(item) for item in preview.get("changes") or []
               if isinstance(item, dict)]
    return KbPermissionPart(
        type="permission", id=record.id, kind=record.kind, engine=record.engine, page_id=record.page_id,
        title=record.title, status=record.status, auto=record.auto, reason=record.reason, summary=summary,
        changes=changes, path=preview.get("path") if isinstance(preview.get("path"), str) else None,
        new_title=preview.get("new_title") if isinstance(preview.get("new_title"), str) else None,
        linking_pages=int(preview.get("linking_pages") or 0),
        links_unlinked=int(preview.get("links_unlinked") or 0),
        undoable=record.status == "allowed" and record.applied and bool(record.undo),
    )


def web_search_part(record: WebSearchRecord) -> KbWebSearchPart:
    links = [KbWebLink(title=link.title, url=link.url, site=site_of(link.url)) for link in record.links]
    return KbWebSearchPart(
        type="web_search", id=record.id, engine=cast(Any, record.engine), query=record.query,
        allowed_domains=list(record.allowed_domains), blocked_domains=list(record.blocked_domains),
        status=record.status, auto=record.auto, reason=record.reason, links=links,
        searcher=cast(Any, record.searcher))


def question_part(record: QuestionRecord) -> KbQuestionPart:
    return KbQuestionPart(
        type="question", id=record.id, engine=record.engine, question=record.question,
        options=[KbQuestionOption(label=option.label, description=option.description,
                                  recommended=option.recommended) for option in record.options],
        allow_other=True, status=record.status, answer=record.answer,
    )


def full_chat(kb: KnowledgeService, view: ChatView) -> KbChat:
    presenter = Presenter(kb)
    return KbChat(**summary(view).model_dump(), messages=[presenter.message(m) for m in view.messages],
                  cursor=view.cursor)


def _messages(kb: KnowledgeService, messages: list[Message]) -> list[KbMessage]:
    presenter = Presenter(kb)
    return [presenter.message(message) for message in messages]


def _send_result(kb: KnowledgeService, pair: tuple[Message, Message]) -> KbSendResult:
    user, assistant = _messages(kb, list(pair))
    return KbSendResult(user=user, assistant=assistant)


def to_input(body: KbSend | KbMessageEdit) -> MessageInput:
    """What the composer sent; an edit carries no context (the question keeps its own)."""
    context = body.context if isinstance(body, KbSend) else KbOpenContext()
    return MessageInput(
        text=body.text,
        mentions=tuple(Ref(ref.type, ref.id, ref.title) for ref in body.mentions),
        quotes=tuple(Quote(quote.source, quote.id, quote.text, quote.block_id, quote.seg, quote.message_id)
                     for quote in body.quotes),
        attachments=tuple(body.attachments),
        context=OpenContext(context.open_page_id, context.open_material_id, context.open_study_id),
    )


# -- routes ---------------------------------------------------------------------------


@router.get("")
async def list_chats(chats: ChatsDep, q: Annotated[str | None, Query(max_length=300)] = None,
                     filter: KbChatFilter = "all", folder_id: str | None = None,
                     limit: Annotated[int, Query(ge=1, le=MAX_LIST)] = MAX_LIST) -> list[KbChatSummary]:
    """Newest activity first; ``q`` searches chat titles and messages."""
    views = await chats.list_chats(query=q, filter=filter, folder_id=folder_id, limit=limit)
    return [summary(view) for view in views]


@router.post("", status_code=201)
async def create_chat(chats: ChatsDep, body: KbChatCreate | None = None) -> KbChat:
    request = body or KbChatCreate()
    view = await chats.create(title=request.title, engine=request.engine, model=request.model,
                              effort=request.effort, recording_material_id=request.recording_material_id)
    return await kb_call(full_chat, chats.kb, view)


@router.put("/last-choice", status_code=204)
async def remember_last_choice(chats: ChatsDep, body: KbChatLastChoice) -> None:
    """The agent, model and reasoning picked in the New chat field: the next new chat starts from them."""
    await chats.remember_choice(body.engine, body.model, body.effort)


@router.get("/events")
async def chat_list_events(chats: ChatsDep, after: After = 0, wait: Wait = 0) -> KbChatListEvents:
    """Changes of the chat list (answering / new answer / renamed …) after the cursor."""
    views, cursor = await chats.list_events(after, wait)
    return KbChatListEvents(chats=[summary(view) for view in views], cursor=cursor)


@router.get("/{chat_id}")
async def read_chat(chat_id: str, chats: ChatsDep) -> KbChat:
    return await kb_call(full_chat, chats.kb, await chats.get(chat_id))


@router.patch("/{chat_id}")
async def change_chat(chat_id: str, body: KbChatPatch, chats: ChatsDep) -> KbChatSummary:
    """Rename, pin, or switch the agent/model/effort (a ``system`` message records the switch)."""
    changes = {name: getattr(body, name) for name in body.model_fields_set}
    for name in ("title", "pinned", "engine"):
        if changes.get(name, ...) is None:
            del changes[name]
    return summary(await chats.patch(chat_id, changes))


@router.delete("/{chat_id}", status_code=204)
async def delete_chat(chat_id: str, chats: ChatsDep) -> None:
    await chats.delete(chat_id)


@router.post("/{chat_id}/read", status_code=204)
async def read_answers(chat_id: str, chats: ChatsDep) -> None:
    await chats.mark_read(chat_id)


@router.post("/{chat_id}/messages", status_code=202)
async def send_message(chat_id: str, body: KbSend, chats: ChatsDep) -> KbSendResult:
    """Starts the answer; follow it with ``GET /kb/chats/{id}/events``."""
    return await kb_call(_send_result, chats.kb, await chats.send(chat_id, to_input(body)))


@router.get("/{chat_id}/events")
async def chat_events(chat_id: str, chats: ChatsDep, after: After = 0, wait: Wait = 0) -> KbChatEvents:
    events, cursor = await chats.events(chat_id, after, wait)

    def present() -> KbChatEvents:
        presenter = Presenter(chats.kb)
        return KbChatEvents(events=[presenter.event(event) for event in events], cursor=cursor)

    return await kb_call(present)


@router.post("/{chat_id}/messages/{message_id}/stop")
async def stop_answer(chat_id: str, message_id: str, chats: ChatsDep) -> KbMessage:
    message = await chats.stop(chat_id, message_id)
    return (await kb_call(_messages, chats.kb, [message]))[0]


@router.post("/{chat_id}/messages/{message_id}/regenerate", status_code=202)
async def regenerate_answer(chat_id: str, message_id: str, chats: ChatsDep) -> KbSendResult:
    """A new answer to the same question; the earlier answer stays."""
    return await kb_call(_send_result, chats.kb, await chats.regenerate(chat_id, message_id))


@router.post("/{chat_id}/messages/{message_id}/resume", status_code=202)
async def resume_answer(chat_id: str, message_id: str, chats: ChatsDep) -> KbSendResult:
    """After an interrupted answer: the same question is answered again from the start."""
    return await kb_call(_send_result, chats.kb, await chats.resume(chat_id, message_id))


@router.post("/{chat_id}/messages/{message_id}/edit", status_code=202)
async def edit_question(chat_id: str, message_id: str, body: KbMessageEdit, chats: ChatsDep) -> KbSendResult:
    """Your question, changed: every later message goes and it is answered again (409 while answering)."""
    return await kb_call(_send_result, chats.kb, await chats.edit(chat_id, message_id, to_input(body)))


@router.post("/{chat_id}/messages/{message_id}/save")
async def save_answer(chat_id: str, message_id: str, chats: ChatsDep) -> KbSavedAnalysis:
    """The answer becomes an analysis page in ``Wiki/Analyses``; a second save is 409 ``ALREADY_SAVED``.
    A diagram without material citations is left out and named in ``warning``."""
    page_id, kind, title, warning = await chats.save_message(chat_id, message_id)
    return KbSavedAnalysis.model_validate({"id": page_id, "kind": kind, "title": title, "warning": warning})


@router.post("/{chat_id}/save")
async def save_chat(chat_id: str, chats: ChatsDep) -> KbSavedAnalysis:
    """The whole chat (each question with its latest finished answer) as one analysis page."""
    page_id, kind, title, warning = await chats.save_chat(chat_id)
    return KbSavedAnalysis.model_validate({"id": page_id, "kind": kind, "title": title, "warning": warning})


@router.get("/{chat_id}/export")
async def export_chat(chat_id: str, chats: ChatsDep) -> KbChatExport:
    exported = await chats.export(chat_id)
    return KbChatExport(file_name=exported.file_name, markdown=exported.markdown)
