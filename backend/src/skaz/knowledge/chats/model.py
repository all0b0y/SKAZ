"""Domain objects of a chat: messages, their parts and what the user typed.

Parts hold ids that were checked against the library when the answer was
streamed (``chats.resolve``); titles, times and availability are looked up
again whenever a message is shown, so a renamed or deleted source is shown
as it is now. Everything round-trips through plain JSON for the database.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Literal, cast

from ..agents.engine import EngineId, FailureKind

Role = Literal["user", "assistant", "system"]
MessageState = Literal["streaming", "done", "interrupted", "failed", "cancelled"]
RefType = Literal["page", "material", "chat"]
QuoteSource = Literal["page", "material", "chat"]
#: States after which an answer can be asked again ("Resume" / "Regenerate").
FINISHED: frozenset[str] = frozenset({"done", "interrupted", "failed", "cancelled"})


# -- parts ---------------------------------------------------------------------


@dataclass(frozen=True)
class TextPart:
    text: str


@dataclass(frozen=True)
class CitePart:
    material_id: str
    seg: int
    #: The verbatim words of the fragment the agent relied on, checked; ``None`` = the whole fragment.
    quote: str | None = None


@dataclass(frozen=True)
class PagePart:
    page_id: str
    block_id: str | None
    #: Title/kind when the answer was written (shown if the page is gone later).
    title: str
    kind: str


@dataclass(frozen=True)
class ConnectionSide:
    folder_id: str
    text: str
    material_id: str
    seg: int
    quote: str | None = None


@dataclass(frozen=True)
class ConnectionPart:
    sides: tuple[ConnectionSide, ...]
    inference: str
    page_id: str | None = None


@dataclass(frozen=True)
class ToolPart:
    name: str
    label: str


@dataclass(frozen=True)
class PermissionPart:
    """An agent's wiki change waiting for (or decided by) the user; the card reads the request by id."""

    permission_id: str


@dataclass(frozen=True)
class QuestionPart:
    """An agent's question to the user; the block reads the question by id."""

    question_id: str


@dataclass(frozen=True)
class StudyPart:
    """A deck or a test the agent made or showed (0.3.1 S5); the block reads the study block by id."""

    study_id: str
    #: Kind and title when the block was made (the history and previews read these).
    kind: str = "deck"
    title: str = ""


Part = TextPart | CitePart | PagePart | ConnectionPart | ToolPart | PermissionPart | QuestionPart | StudyPart


def part_to_json(part: Part) -> dict[str, Any]:
    if isinstance(part, TextPart):
        return {"type": "text", "text": part.text}
    if isinstance(part, CitePart):
        return {"type": "cite", "material_id": part.material_id, "seg": part.seg, "quote": part.quote}
    if isinstance(part, PagePart):
        return {"type": "page", "page_id": part.page_id, "block_id": part.block_id, "title": part.title,
                "kind": part.kind}
    if isinstance(part, ConnectionPart):
        return {"type": "connection", "inference": part.inference, "page_id": part.page_id,
                "sides": [{"folder_id": side.folder_id, "text": side.text, "material_id": side.material_id,
                           "seg": side.seg, "quote": side.quote} for side in part.sides]}
    if isinstance(part, PermissionPart):
        return {"type": "permission", "id": part.permission_id}
    if isinstance(part, QuestionPart):
        return {"type": "question", "id": part.question_id}
    if isinstance(part, StudyPart):
        return {"type": "study", "id": part.study_id, "kind": part.kind, "title": part.title}
    return {"type": "tool", "name": part.name, "label": part.label}


def part_from_json(data: Mapping[str, Any]) -> Part | None:
    kind = data.get("type")
    if kind == "text":
        return TextPart(str(data.get("text", "")))
    if kind == "cite":
        return CitePart(str(data["material_id"]), int(data["seg"]), _optional(data.get("quote")))
    if kind == "page":
        return PagePart(str(data["page_id"]), _optional(data.get("block_id")), str(data.get("title", "")),
                        str(data.get("kind", "concept")))
    if kind == "connection":
        sides = tuple(ConnectionSide(str(side["folder_id"]), str(side.get("text", "")),
                                     str(side["material_id"]), int(side["seg"]), _optional(side.get("quote")))
                      for side in data.get("sides", []))
        return ConnectionPart(sides, str(data.get("inference", "")), _optional(data.get("page_id")))
    if kind == "tool":
        return ToolPart(str(data.get("name", "")), str(data.get("label", "")))
    if kind == "permission":
        return PermissionPart(str(data["id"]))
    if kind == "question":
        return QuestionPart(str(data["id"]))
    if kind == "study":
        return StudyPart(str(data["id"]), str(data.get("kind", "deck")), str(data.get("title", "")))
    return None


def parts_from_json(items: Sequence[Mapping[str, Any]]) -> list[Part]:
    return [part for part in (part_from_json(item) for item in items) if part is not None]


def _optional(value: Any) -> str | None:
    return None if value is None else str(value)


# -- input ---------------------------------------------------------------------


@dataclass(frozen=True)
class Ref:
    type: RefType
    id: str
    title: str


@dataclass(frozen=True)
class Quote:
    source: QuoteSource
    id: str
    text: str
    block_id: str | None = None
    seg: int | None = None
    message_id: str | None = None


@dataclass(frozen=True)
class OpenContext:
    """What the user had open next to the chat when sending (decision: the agent knows it)."""

    page_id: str | None = None
    material_id: str | None = None
    #: The deck or test block open now (0.3.1 W2 "Agent sees").
    study_id: str | None = None


@dataclass(frozen=True)
class MessageInput:
    text: str
    mentions: tuple[Ref, ...] = ()
    quotes: tuple[Quote, ...] = ()
    #: Material ids added through "+" (already created by ``/kb/materials/*`` or ``/kb/imports``).
    attachments: tuple[str, ...] = ()
    context: OpenContext = field(default_factory=OpenContext)

    def to_json(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "mentions": [{"type": ref.type, "id": ref.id, "title": ref.title} for ref in self.mentions],
            "quotes": [{"source": quote.source, "id": quote.id, "text": quote.text,
                        "block_id": quote.block_id, "seg": quote.seg, "message_id": quote.message_id}
                       for quote in self.quotes],
            "attachments": list(self.attachments),
            "context": {"page_id": self.context.page_id, "material_id": self.context.material_id,
                        "study_id": self.context.study_id},
        }

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> MessageInput:
        context = data.get("context") or {}
        return cls(
            text=str(data.get("text", "")),
            mentions=tuple(Ref(cast(RefType, item["type"]), str(item["id"]), str(item.get("title", "")))
                           for item in data.get("mentions", [])),
            quotes=tuple(Quote(cast(QuoteSource, item["source"]), str(item["id"]), str(item.get("text", "")),
                               _optional(item.get("block_id")),
                               int(item["seg"]) if item.get("seg") is not None else None,
                               _optional(item.get("message_id")))
                         for item in data.get("quotes", [])),
            attachments=tuple(str(item) for item in data.get("attachments", [])),
            context=OpenContext(_optional(context.get("page_id")), _optional(context.get("material_id")),
                                _optional(context.get("study_id"))),
        )


# -- messages and chats --------------------------------------------------------


@dataclass(frozen=True)
class Failure:
    kind: FailureKind
    message: str
    #: ISO-8601 UTC, when a limit resets (if the engine said so).
    retry_at: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {"kind": self.kind, "message": self.message, "retry_at": self.retry_at}

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> Failure:
        return cls(cast(FailureKind, data.get("kind", "other")), str(data.get("message", "")),
                   _optional(data.get("retry_at")))


@dataclass(frozen=True)
class Message:
    id: str
    chat_id: str
    seq: int
    role: Role
    state: MessageState
    created_at: str
    parts: tuple[Part, ...] = ()
    engine: EngineId | None = None
    model: str | None = None
    effort: str | None = None
    failure: Failure | None = None
    input: MessageInput | None = None
    reply_to: str | None = None
    saved_page_id: str | None = None

    def with_parts(self, parts: Sequence[Part]) -> Message:
        return replace(self, parts=tuple(parts))


@dataclass(frozen=True)
class Chat:
    id: str
    title: str
    title_auto: bool
    pinned: bool
    engine: EngineId
    model: str | None
    effort: str | None
    recording_material_id: str | None
    folder_ids: tuple[str, ...]
    unread: bool
    last_preview: str
    created_at: str
    updated_at: str
