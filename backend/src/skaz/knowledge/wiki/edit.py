"""The user edits wiki pages (decisions 6, 21, 22; API-B2 §2.4).

* Editing an agent block makes it ``user_edited`` ("edited by you"): ingest
  never rewrites it again. A ``user_note`` stays the user's.
* New text is always a ``user_note`` owned by the user.
* Only the user's own notes can be deleted here; agent statements are changed
  by the agent (``recheck``) or edited, never silently dropped.

Unmarked paragraphs (``u-<n>``: text typed in Obsidian without a marker) are
the user's too and can be edited, followed by a note, or deleted in place.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import replace
from uuid import uuid4

from ..errors import KnowledgeError, NotFound, ProtectedItem
from ..ingest.pages import insert_into_section, match_key, spaced
from ..markdown.page import Block, Heading, PageDocument, Part, RawText
from ..service import KnowledgeService
from .pages_io import page_path, reindex, rewrite

_PARAGRAPH_SPLIT = re.compile(r"(\n[ \t]*\n)")
_HEADING_LINE = re.compile(r"^#{1,6}[ \t]", re.MULTILINE)
_TRAILING_ID = re.compile(r"\s\^[A-Za-z0-9-]+\s*$")
_UNMARKED = re.compile(r"u-([1-9]\d*)")


class InvalidText(KnowledgeError):
    status_code = 422


def clean_user_text(text: str) -> str:
    """The user's paragraph as it will be stored; rejected (never rewritten) when it would break the page."""
    value = unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not value:
        raise InvalidText("The text is empty.")
    if re.search(r"\n[ \t]*\n", value):
        raise InvalidText("A note is one paragraph. Add another note for the next paragraph.")
    if "%% skaz:" in value:
        raise InvalidText("The text can't contain SKAZ markers.")
    if _HEADING_LINE.search(value):
        raise InvalidText("A note can't contain headings.")
    if _TRAILING_ID.search(value):
        raise InvalidText("The text can't end with a block id.")
    return value


def new_note_id() -> str:
    return f"c-u-{uuid4().hex[:12]}"


def _paragraph_pieces(text: str) -> list[str]:
    """Paragraphs at even positions, the blank-line separators at odd positions."""
    return _PARAGRAPH_SPLIT.split(text.replace("\r\n", "\n"))


def _locate_unmarked(document: PageDocument, ordinal: int) -> tuple[int, list[str], int] | None:
    """(part index, its pieces, piece index) of the ``ordinal``-th unmarked paragraph."""
    seen = 0
    for index, part in enumerate(document.parts):
        if not isinstance(part, RawText):
            continue
        pieces = _paragraph_pieces(part.text)
        for position in range(0, len(pieces), 2):
            if pieces[position].strip("\n").strip():
                seen += 1
                if seen == ordinal:
                    return index, pieces, position
    return None


def _with_piece(piece: str, text: str) -> str:
    """Replace a paragraph's text but keep the newlines around it."""
    lead = piece[: len(piece) - len(piece.lstrip("\n"))]
    trail = piece[len(piece.rstrip("\n")) :]
    return f"{lead}{text}{trail}"


def _unmarked_ordinal(block_id: str) -> int | None:
    match = _UNMARKED.fullmatch(block_id)
    return int(match.group(1)) if match else None


def _replace_unmarked(document: PageDocument, ordinal: int, text: str | None) -> PageDocument:
    found = _locate_unmarked(document, ordinal)
    if found is None:
        raise NotFound("This part of the page is no longer there. Reopen the page.")
    index, pieces, position = found
    pieces[position] = _with_piece(pieces[position], text) if text is not None else ""
    parts = list(document.parts)
    parts[index] = RawText("".join(pieces))
    return replace(document, parts=parts)


def _block_index(document: PageDocument, block_id: str) -> int | None:
    return next(
        (
            index
            for index, part in enumerate(document.parts)
            if isinstance(part, Block) and part.id == block_id
        ),
        None,
    )


def _level(part: Part) -> int:
    """Heading level; 7 for anything that is not a heading (never ends a section)."""
    return part.level if isinstance(part, Heading) else 7


def update_block(kb: KnowledgeService, page_id: str, block_id: str, text: str) -> None:
    clean = clean_user_text(text)
    library, path = page_path(kb, page_id)

    def build(document: PageDocument) -> PageDocument:
        ordinal = _unmarked_ordinal(block_id)
        if ordinal is not None:
            return _replace_unmarked(document, ordinal, clean)
        index = _block_index(document, block_id)
        if index is None:
            raise NotFound("Block not found.")
        block = document.parts[index]
        assert isinstance(block, Block)
        owner = "user_edited" if block.owner == "agent" else block.owner
        updated = replace(block, body=clean, raw=None).remarked(owner=owner)
        parts = list(document.parts)
        parts[index] = updated
        return replace(document, parts=spaced(parts))

    rewrite(library, path, build)
    reindex(kb, library, path)


def add_note(
    kb: KnowledgeService,
    page_id: str,
    text: str,
    *,
    after_block_id: str | None = None,
    section: str | None = None,
) -> str:
    """A new ``user_note``; returns its block id."""
    clean = clean_user_text(text)
    library, path = page_path(kb, page_id)
    block = Block.create(new_note_id(), "user_note", clean, owner="user")

    def build(document: PageDocument) -> PageDocument:
        parts: list[Part] = list(document.parts)
        if after_block_id:
            ordinal = _unmarked_ordinal(after_block_id)
            if ordinal is not None:
                found = _locate_unmarked(document, ordinal)
                if found is None:
                    raise NotFound("Block not found.")
                index, pieces, position = found
                head, tail = "".join(pieces[: position + 1]), "".join(pieces[position + 1 :])
                parts[index : index + 1] = [RawText(head), block, *([RawText(tail)] if tail.strip() else [])]
            else:
                after = _block_index(document, after_block_id)
                if after is None:
                    raise NotFound("Block not found.")
                parts.insert(after + 1, block)
        elif section:
            key = match_key(section)
            heading = next(
                (
                    i
                    for i, part in enumerate(parts)
                    if isinstance(part, Heading) and match_key(part.title) == key
                ),
                None,
            )
            if heading is None:
                raise NotFound("Section not found.")
            level = _level(parts[heading])
            end = next(
                (i for i in range(heading + 1, len(parts)) if _level(parts[i]) <= level),
                len(parts),
            )
            parts.insert(end, block)
        else:
            insert_into_section(parts, "user_note", document.meta.language or "en", [block])
        return replace(document, parts=spaced(parts))

    rewrite(library, path, build)
    reindex(kb, library, path)
    return block.id


def delete_note(kb: KnowledgeService, page_id: str, block_id: str) -> None:
    library, path = page_path(kb, page_id)

    def build(document: PageDocument) -> PageDocument:
        ordinal = _unmarked_ordinal(block_id)
        if ordinal is not None:
            return _replace_unmarked(document, ordinal, None)
        index = _block_index(document, block_id)
        if index is None:
            raise NotFound("Block not found.")
        block = document.parts[index]
        assert isinstance(block, Block)
        if block.owner != "user":
            raise ProtectedItem(
                "Only your own notes can be deleted. Edit the statement or ask the agent to recheck it."
            )
        parts = [part for i, part in enumerate(document.parts) if i != index]
        return replace(document, parts=spaced(parts))

    rewrite(library, path, build)
    reindex(kb, library, path)
