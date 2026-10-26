"""What every block shares: the item's source fields, text cleaning, and checking items one by one.

A block is validated in two steps, so one bad item never breaks the whole block:

1. the *envelope* (the block's own fields, item lists as plain lists) — any error here breaks
   the block ("This block couldn't be drawn" + Ask the agent to fix);
2. each item on its own against its strict model, and its sources against the library —
   an invalid item, or one whose sources don't exist, is hidden and counted.

Each block module declares its envelope, the full input model the agent sees (the envelope with
typed item lists, for ``skaz_answer_blocks``) and its output model (what is stored and drawn).
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypeVar

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .md import Refs

#: Item ids the agent may choose (P2 addresses items by id); SKAZ numbers the others.
ID_PATTERN = r"^[A-Za-z0-9_-]{1,40}$"
MAX_CITES = 4
TITLE_CHARS = 200
_TOKEN = re.compile(r"⟦([^⟦⟧]*)⟧")
_WHITESPACE = re.compile(r"\s+")


class BlockError(Exception):
    """The whole block can't be drawn; ``str(error)`` is plain English for the user and the agent."""


class Strict(BaseModel):
    """The agent's data: no unknown fields, surrounding spaces ignored."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


LINK_CHARS = 60


class BlockIn(Strict):
    """Fields every block has; each block adds ``type: Literal["<name>"]`` and its own fields.

    ``beside`` and ``link`` place the block among the blocks of the same answer (decision 2): next to
    the block right before it, or under it with a labelled arrow from it.
    """

    title: str | None = Field(default=None, min_length=1, max_length=TITLE_CHARS,
                              description="Optional short heading over the block, in the answer's language.")
    beside: bool = Field(
        default=False, strict=True,
        description=("true to put this block beside the block right before it (side by side, up to 3 in a "
                     "row) — only for short blocks that are read together, and only when the user asks for "
                     "a layout or the blocks are clearly parallel."))
    link: str | None = Field(
        default=None, min_length=1, max_length=LINK_CHARS,
        description=("A short label for an arrow from the block right before this one to this block "
                     "(\"why it happened\"), in the answer's language. Only between two blocks with no text "
                     "between them."))


class ItemIn(Strict):
    """Where an item comes from: ``cite`` (checked against the library) or ``basis: \"agent\"``."""

    id: str | None = Field(default=None, pattern=ID_PATTERN,
                           description="Optional stable id of the item (letters, digits, - and _).")
    cite: str | list[str] | None = Field(
        default=None,
        description=("Where this item comes from: a fragment \"m:<material_id>:<seg>\" (optionally "
                     "\"m:<material_id>:<seg>|<exact words>\"), a wiki page \"p:<page_id>\" or "
                     "\"p:<page_id>#<block_id>\", or the URL of a web search result in this chat. "
                     f"Up to {MAX_CITES} as a list."),
    )
    basis: Literal["agent"] | None = Field(
        default=None, description="\"agent\" when the item is your own general knowledge, not from a source.")

    @model_validator(mode="after")
    def _one_basis(self) -> ItemIn:
        if self.cite is not None and self.basis is not None:
            raise ValueError("Give either cite or basis, not both.")
        cites = [self.cite] if isinstance(self.cite, str) else self.cite or []
        if len(cites) > MAX_CITES or any(not cite.strip() or len(cite) > 2_000 for cite in cites):
            raise ValueError(f"cite: one to {MAX_CITES} non-empty references.")
        return self


class KbBlockItem(BaseModel):
    """An item as drawn: its stable id and where it comes from."""

    id: str
    #: Indexes into the block's ``sources``; empty when ``agent`` is true.
    src: list[int]
    #: The agent's own knowledge, not from the user's materials.
    agent: bool


class Checker(Protocol):
    """Checks one reference against the library and this chat (``chats.blocks``)."""

    def source(self, ref: str) -> int | None:
        """Index of the source in the block's list (added once), or ``None`` when it does not exist."""
        ...

    def timed(self, index: int) -> bool:
        """Whether source ``index`` is a recording fragment with a start time."""
        ...


def clean(text: str) -> str:
    """Plain one-line text: no reference tokens, no invisible format characters, spaces collapsed."""
    value = unicodedata.normalize("NFC", _TOKEN.sub("", text)).replace("⟦", "").replace("⟧", "")
    value = "".join(char for char in value if unicodedata.category(char) != "Cf")
    return _WHITESPACE.sub(" ", value).strip()


def tokens(text: str) -> list[str]:
    """References the agent put inside the text (``⟦m:…⟧``) instead of ``cite``."""
    return [body.strip() for body in _TOKEN.findall(text) if body.strip()]


ItemT = TypeVar("ItemT", bound=ItemIn)


@dataclass(frozen=True)
class Checked:
    """An item that is drawn: its stable id and where it comes from."""

    id: str
    src: list[int]
    agent: bool

    def out(self) -> dict[str, Any]:
        return {"id": self.id, "src": self.src, "agent": self.agent}


class Items:
    """Checks the items of one block; counts the hidden ones and keeps ids unique."""

    def __init__(self, checker: Checker) -> None:
        self.checker = checker
        self.hidden = 0
        self.shown = 0
        self._ids: set[str] = set()

    def hide(self, count: int = 1) -> None:
        self.hidden += count

    def item(self, model: type[ItemT], raw: Any, default_id: str,
             accept: Callable[[ItemT, list[int]], list[int] | None] | None = None,
             ) -> tuple[Checked, ItemT] | None:
        """``raw`` as a drawn item (its text fields cleaned), or ``None`` (counted hidden). ``accept`` may
        reorder the sources or refuse the item (a timeline event without a date needs a recording)."""
        try:
            item = model.model_validate(raw)
        except ValidationError:
            self.hide()
            return None
        # The item's own text fields only: no dump of nested data (a tree node's children may nest deep).
        texts = {name: value for name in type(item).model_fields
                 if isinstance(value := getattr(item, name), str) and name not in ("id", "cite", "basis")}
        if item.cite is not None:
            refs = [item.cite] if isinstance(item.cite, str) else list(item.cite)
        else:
            refs = [ref for value in texts.values() for ref in tokens(value)]
        cleaned = {name: clean(value) for name, value in texts.items()}
        if any(not value and model.model_fields[name].is_required() for name, value in cleaned.items()):
            self.hide()
            return None
        item = item.model_copy(update={name: value or None for name, value in cleaned.items()})
        src: list[int] = []
        for ref in refs[:MAX_CITES]:
            index = self.checker.source(ref)
            if index is not None and index not in src:
                src.append(index)
        agent = not refs and item.basis == "agent"
        if not src and not agent:
            self.hide()  # no source, or none of its sources exists
            return None
        if accept is not None:
            accepted = accept(item, src)
            if accepted is None:
                self.hide()
                return None
            src = accepted
        self.shown += 1
        return Checked(self._unique(item.id or default_id), src, agent), item

    def many(self, model: type[ItemT], raws: list[Any], prefix: str,
             accept: Callable[[ItemT, list[int]], list[int] | None] | None = None,
             ) -> list[tuple[Checked, ItemT]]:
        """Each of ``raws`` checked on its own (ids ``<prefix>N``), the hidden ones left out."""
        out: list[tuple[Checked, ItemT]] = []
        for n, raw in enumerate(raws, start=1):
            checked = self.item(model, raw, f"{prefix}{n}", accept)
            if checked is not None:
                out.append(checked)
        return out

    def ident(self, wanted: str) -> str:
        """A unique id for a non-item part of the block (a compare row)."""
        return self._unique(wanted)

    def _unique(self, wanted: str) -> str:
        candidate, n = wanted, 2
        while candidate in self._ids:
            candidate, n = f"{wanted}-{n}", n + 1
        self._ids.add(candidate)
        return candidate


def required(checked: tuple[Checked, ItemT] | None, what: str) -> tuple[Checked, ItemT]:
    """A part the block means nothing without (a definition, a verdict): hidden, it breaks the block."""
    if checked is None:
        raise BlockError(f"{what} couldn't be shown: it needs valid data and a source that exists (cite) "
                         "or basis \"agent\".")
    return checked


def envelope(model: type[BlockIn], data: dict[str, Any]) -> Any:
    """The block's own fields, strictly; an error breaks the block with a short reason. Its title is
    cleaned like an item's text (no reference tokens or invisible characters; empty → none)."""
    try:
        block = model.model_validate(data)
    except ValidationError as error:
        raise BlockError(describe(error)) from error
    return block.model_copy(update={"title": clean(block.title) or None}) if block.title else block


def describe(error: ValidationError) -> str:
    parts = []
    for item in error.errors()[:3]:
        location = ".".join(str(piece) for piece in item.get("loc", ()))
        message = str(item.get("msg", "invalid value")).removeprefix("Value error, ")
        parts.append(f"{location}: {message}" if location else message)
    return "Invalid block data: " + "; ".join(parts)


@dataclass(frozen=True)
class BlockSpec:
    """One block type: a schema module declares it, ``registry`` lists it (one line)."""

    name: str
    #: One line for the block index in the chat instructions (~15–25 tokens).
    when: str
    #: The full input model the agent fills (shown by ``skaz_answer_blocks``).
    schema: type[BlockIn]
    #: One realistic example (the ``skaz_answer_blocks`` answer shows it as a fenced block).
    example: dict[str, Any]
    #: The validated block from the agent's data; raises ``BlockError`` when it can't be drawn.
    build: Callable[[dict[str, Any], Items], BaseModel]
    #: The drawn block as plain Markdown lines (decision 11): Copy, chat export, saved analysis pages.
    markdown: Callable[[Any, Refs], list[str]]
