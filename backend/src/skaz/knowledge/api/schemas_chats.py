"""Pydantic models of ``/kb/chats`` and ``/kb/mentions`` (area C1, API-B2 §3).

Response models have no defaults unless the contract marks the field optional
(``?``): every other field is always present (``null`` when empty).
"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel

from ..store.database import MAX_DB_INT
from .schemas import KbCitation, KbPageRef
from .schemas_agents import KbEngineId
from .schemas_study import KbStudyPart

KbChatState = Literal["idle", "answering"]
KbChatFilter = Literal["all", "pinned", "recording"]
KbMessageRole = Literal["user", "assistant", "system"]
KbMessageState = Literal["streaming", "done", "interrupted", "failed", "cancelled"]
KbFailureKind = Literal["limit", "auth", "incompatible", "network", "cancelled", "other"]
KbChatEventType = Literal["message", "delta", "part", "state", "title", "part_update"]
KbPermissionKind = Literal["create", "edit", "rename", "delete"]
KbPermissionStatus = Literal["pending", "allowed", "denied", "cancelled", "undone"]
KbQuestionStatus = Literal["pending", "answered", "superseded", "cancelled"]

MAX_TEXT = 100_000
MAX_ITEMS = 50


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KbRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["page", "material", "chat"]
    id: str = Field(min_length=1, max_length=200)
    title: str = Field(max_length=1_000)


class KbQuote(BaseModel):
    """A quote token in the question. ``source: "chat"`` is an earlier AI answer: context, not evidence."""

    model_config = ConfigDict(extra="forbid")

    source: Literal["page", "material", "chat"]
    id: str = Field(min_length=1, max_length=200)
    block_id: str | None = Field(default=None, max_length=200)
    seg: int | None = Field(default=None, ge=1, le=MAX_DB_INT)
    message_id: str | None = Field(default=None, max_length=200)
    text: str = Field(min_length=1, max_length=20_000)


# -- message parts ---------------------------------------------------------------


class KbTextPart(BaseModel):
    type: Literal["text"]
    #: Markdown; render it with the safe renderer (never as HTML).
    text: str


class KbCitePart(BaseModel):
    type: Literal["cite"]
    citation: KbCitation


class KbPagePart(BaseModel):
    type: Literal["page"]
    page: KbPageRef
    block_id: str | None
    #: ``False`` once the page is gone from the wiki: the chip says so instead of opening a dead end.
    available: bool = True


class KbConnectionFolder(BaseModel):
    folder_id: str
    folder_name: str
    text: str
    citation: KbCitation


class KbConnectionPart(BaseModel):
    type: Literal["connection"]
    folders: list[KbConnectionFolder]
    #: The agent's own conclusion (shown as "agent inference").
    inference: str
    page: KbPageRef | None


class KbToolPart(BaseModel):
    type: Literal["tool"]
    #: SKAZ tool name (``skaz_read_page``…).
    name: str
    #: What the agent looked at, e.g. "Read page Entropy" (library titles: show as text).
    label: str


class KbPermissionSummary(BaseModel):
    added: int
    changed: int
    removed: int
    #: Always true for an agent's change: the user's own notes are never changed or removed.
    user_notes_untouched: bool


class KbPermissionChange(BaseModel):
    op: Literal["add", "replace", "remove"]
    block_id: str | None
    #: "Added" / "Changed" / "Removed".
    label: str
    #: Readable block text (citation links left out); ``null`` for an added / removed side.
    before: str | None
    after: str | None
    #: from_source / connection / explanation / user_note (the wiki label of the block).
    block_kind: str | None


class KbPermissionPart(BaseModel):
    """An agent's wiki change: waits for Allow / Allow in this chat / Deny, then shows what happened."""

    type: Literal["permission"]
    id: str
    kind: KbPermissionKind
    engine: KbEngineId
    #: ``null`` for a page that is still to be created.
    page_id: str | None
    title: str
    status: KbPermissionStatus
    #: Allowed by an earlier "Allow in this chat" (the feed shows a row with Undo).
    auto: bool
    #: Deny: the user's reason for the agent; cancelled: why.
    reason: str | None
    summary: KbPermissionSummary
    changes: list[KbPermissionChange]
    #: Library-relative path of the page (``Wiki/Concepts/<Title>.md``).
    path: str | None = None
    #: Rename: the title it would get.
    new_title: str | None = None
    #: Rename / delete: how many other pages link to it (their links follow / are unlinked).
    linking_pages: int = 0
    #: Delete: how many links to it get unlinked.
    links_unlinked: int = 0
    #: The change was applied and can still be undone (``POST /kb/permissions/{id}/undo``).
    undoable: bool = False


class KbQuestionOption(BaseModel):
    label: str
    description: str
    recommended: bool


class KbQuestionPart(BaseModel):
    """An agent's question; answer now or later — or just write a message (it closes the question)."""

    type: Literal["question"]
    id: str
    engine: KbEngineId
    question: str
    #: Up to 4, the recommended one first.
    options: list[KbQuestionOption]
    allow_other: bool
    status: KbQuestionStatus
    #: The chosen option's label or the user's own answer; ``null`` while pending or superseded.
    answer: str | None


class KbMessagePart(RootModel[Annotated[KbTextPart | KbCitePart | KbPagePart | KbConnectionPart | KbToolPart
                                        | KbPermissionPart | KbQuestionPart | KbStudyPart,
                                        Field(discriminator="type")]]):
    pass


# -- messages and chats ----------------------------------------------------------


class KbFailure(BaseModel):
    kind: KbFailureKind
    #: Plain words for the "Answer interrupted" card.
    message: str
    #: When a limit resets (ISO-8601 UTC), if the agent said so.
    retry_at: str | None


class KbMessageInput(BaseModel):
    text: str
    mentions: list[KbRef]
    quotes: list[KbQuote]
    #: Material ids attached with "+" (created by /kb/materials/* or /kb/imports first).
    attachments: list[str]


class KbMessage(BaseModel):
    id: str
    #: Order of the message in its chat (1, 2, 3…).
    seq: int
    role: KbMessageRole
    created_at: str
    #: Agent that wrote an answer (or that a ``system`` switch message names).
    engine: KbEngineId | None
    model: str | None
    state: KbMessageState
    parts: list[KbMessagePart]
    failure: KbFailure | None
    #: Wiki page this answer was saved to ("Save to wiki").
    saved_page_id: str | None
    #: User messages only: what was in the composer.
    input: KbMessageInput | None


class KbChatSummary(BaseModel):
    id: str
    title: str
    pinned: bool
    engine: KbEngineId
    model: str | None
    effort: str | None
    created_at: str
    updated_at: str
    last_preview: str
    #: Chat opened by "Record" for this recording (the agent knows it).
    recording_material_id: str | None
    folder_ids: list[str]
    state: KbChatState
    #: A new answer the user has not opened yet.
    unread: bool
    #: An agent's permission request or question in this chat waits for the user ("Waiting for you").
    #: Always sent; the default only keeps 0.3.0 clients and fixtures that don't know it valid.
    waiting_for_user: bool = False


class KbChat(KbChatSummary):
    messages: list[KbMessage]
    #: Pass as ``after`` to ``GET /kb/chats/{id}/events``.
    cursor: int


class KbChatCreate(_Request):
    title: str | None = Field(default=None, max_length=200)
    #: ``null`` = the default agent (Settings → Models).
    engine: KbEngineId | None = None
    model: str | None = Field(default=None, max_length=200)
    effort: str | None = Field(default=None, max_length=50)
    recording_material_id: str | None = Field(default=None, max_length=200)


class KbChatPatch(_Request):
    title: str | None = Field(default=None, max_length=200)
    pinned: bool | None = None
    engine: KbEngineId | None = None
    #: ``null`` = the agent's default model.
    model: str | None = Field(default=None, max_length=200)
    effort: str | None = Field(default=None, max_length=50)


class KbOpenContext(_Request):
    open_page_id: str | None = Field(default=None, max_length=200)
    open_material_id: str | None = Field(default=None, max_length=200)
    #: The deck or test block open now ("Agent sees", W2): the agent is told its card or question.
    open_study_id: str | None = Field(default=None, max_length=200)


class KbSend(_Request):
    text: str = Field(min_length=1, max_length=MAX_TEXT)
    mentions: list[KbRef] = Field(default_factory=list, max_length=MAX_ITEMS)
    quotes: list[KbQuote] = Field(default_factory=list, max_length=MAX_ITEMS)
    attachments: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(default_factory=list,
                                                                                  max_length=MAX_ITEMS)
    context: KbOpenContext = Field(default_factory=KbOpenContext)


class KbSendResult(BaseModel):
    user: KbMessage
    assistant: KbMessage


class KbChatEvent(BaseModel):
    """``delta`` appends ``text`` to the message's last text part; ``part`` appends a new part;
    ``part_update`` replaces the message's part with the same ``type`` and ``id`` (permission, question,
    study)."""

    seq: int
    type: KbChatEventType
    #: ``null`` for chat-level events (``title``).
    message_id: str | None
    text: str | None = None
    part: KbMessagePart | None = None
    message: KbMessage | None = None


class KbChatEvents(BaseModel):
    events: list[KbChatEvent]
    cursor: int


class KbChatListEvents(BaseModel):
    """Chats changed since the cursor (all chats when the cursor is unknown to the server)."""

    chats: list[KbChatSummary]
    cursor: int


class KbChatExport(BaseModel):
    file_name: str
    markdown: str


class KbMentions(BaseModel):
    pages: list[KbPageRef]
    materials: list[KbRef]
    chats: list[KbRef]


class KbPermissionDecide(_Request):
    decision: Literal["allow", "allow_chat", "deny"]
    #: Deny: an optional reason for the agent.
    reason: str | None = Field(default=None, max_length=500)


class KbQuestionAnswer(_Request):
    """Exactly one: the index of an option, or the user's own answer."""

    option_index: int | None = Field(default=None, ge=0, le=3)
    text: str | None = Field(default=None, min_length=1, max_length=10_000)
