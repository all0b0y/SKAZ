"""The user edits wiki pages (decisions 6, 21, 22; API-B2 §2.4).

* Editing an agent block makes it ``user_edited`` ("edited by you"): ingest
  never rewrites it again. A ``user_note`` stays the user's.
* New text is always a ``user_note`` owned by the user.
* Only the user's own notes can be deleted here; agent statements are changed
  by the agent (``recheck``) or edited, never silently dropped. A connection SKAZ
  wrote between two concepts can be deleted too: it is remembered and never
  suggested again (C1-a, user decision 2026-10-21, 4 — ``WikiService`` records it).

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
from .connections import LINK_PREFIX
from .pages_io import page_path, reindex, rewrite

_PARAGRAPH_SPLIT = re.compile(r"(\n[ \t]*\n)")
_HEADING_LINE = re.compile(r"^#{1,6}[ \t]", re.MULTILINE)
_TRAILING_ID = re.compile(r"\s\^[A-Za-z0-9-]+\s*$")
_UNMARKED = re.compile(r"u-([1-9]\d*)")
#: A wikilink: target (with an optional ``#anchor``) and an optional ``|label``.
_LINK = re.compile(r"\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]")
_CITATION_TARGET = re.compile(r"#\^seg-\d+$")
#: A fenced code block (a ```mermaid diagram, D-11): its empty lines are not paragraph breaks.
_FENCED = re.compile(r"^ {0,3}(`{3,}|~{3,})[^\n]*\n.*?^ {0,3}\1[ \t]*$", re.MULTILINE | re.DOTALL)
_FENCE_CLOSE = re.compile(r"(?:^|\n) {0,3}(?:`{3,}|~{3,})[ \t]*$")


class InvalidText(KnowledgeError):
    status_code = 422


def clean_user_text(text: str) -> str:
    """The user's paragraph as it will be stored; rejected (never rewritten) when it would break the page."""
    value = unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not value:
        raise InvalidText("The text is empty.")
    # Plain words for what would break the page (QA C15).
    if re.search(r"\n[ \t]*\n", _FENCED.sub("", value)):
        raise InvalidText("Keep this to one paragraph: an empty line starts a new one. Add the rest as a "
                          "new note with “My note”.")
    if "%% skaz:" in value:
        raise InvalidText("Remove the “%% skaz: … %%” part: SKAZ writes those marks itself.")
    if _HEADING_LINE.search(value):
        raise InvalidText("A line can't start with “#”: that would be a new heading on the page.")
    if _TRAILING_ID.search(value):
        raise InvalidText("Remove the “^…” at the end: SKAZ uses that mark to find a paragraph.")
    return value


def note_paragraphs(text: str) -> list[str]:
    """A new note may be several paragraphs: each becomes a note of its own (QA C15)."""
    value = unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n")
    pieces = [piece.strip() for piece in re.split(r"\n[ \t]*\n", value) if piece.strip()]
    return [clean_user_text(piece) for piece in pieces] or [clean_user_text(value)]


def _link_label(target: str, label: str | None) -> str:
    return label if label is not None else target.split("#", 1)[0].rsplit("/", 1)[-1]


def readable_text(body: str) -> str:
    """What the editor shows (as the page does): links read as their labels, citation links left out.

    The citations themselves live in the block marker and are shown as footnotes next to the block.
    """
    def show(match: re.Match[str]) -> str:
        target, label = match.group(1).strip(), match.group(2)
        return "" if _CITATION_TARGET.search(target) else _link_label(target, label)

    return re.sub(r"[ \t]{2,}", " ", _LINK.sub(show, body)).strip()


def relink(previous: str, text: str) -> str:
    """The user's edited readable text with the block's links put back (QA C4).

    The editor shows a block without wikilinks; saving that text must not silently drop the
    page links (graph edges) or the readable citation links of the ``.md``. Every page/material
    link whose label is still in the text becomes the link again (first free whole-word match,
    in the old order); the citation links are appended at the end, as the agent wrote them.
    Links the user typed themselves are kept as they are.
    """
    if " ".join(text.split()) == " ".join(readable_text(previous).split()):
        return previous  # nothing changed but the links being hidden: the block as it was
    taken: list[tuple[int, int]] = [match.span() for match in _LINK.finditer(text)]
    out = text
    citations: list[str] = []
    cursor = 0
    for match in _LINK.finditer(previous):
        raw, target, label = match.group(0), match.group(1).strip(), match.group(2)
        if _CITATION_TARGET.search(target):
            citations.append(raw)
            continue
        if raw in out:
            continue
        shown = _link_label(target, label).strip()
        if not shown:
            continue
        pattern = re.compile(rf"(?<!\w){re.escape(shown)}(?!\w)")
        found = None
        for start in (cursor, 0):
            for candidate in pattern.finditer(out, start):
                if not any(a < candidate.end() and candidate.start() < b for a, b in taken):
                    found = candidate
                    break
            if found is not None:
                break
        if found is None:
            continue  # the user removed the words: the link goes with them
        a, b = found.span()
        out = out[:a] + raw + out[b:]
        shift = len(raw) - (b - a)
        taken = [(x + shift if x >= b else x, y + shift if y >= b else y) for x, y in taken]
        taken.append((a, a + len(raw)))
        cursor = a + len(raw)
    missing = [raw for raw in dict.fromkeys(citations) if raw not in out]
    if not missing:
        return out
    # After a closing fence (a diagram) the links go on a line of their own: on the fence line
    # they would leave the fence open.
    gap = "\n" if _FENCE_CLOSE.search(out) else " "
    return f"{out}{gap}{' '.join(missing)}"


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


def _replace_unmarked(
    document: PageDocument, ordinal: int, text: str | None, *, keep_links: bool = False
) -> PageDocument:
    found = _locate_unmarked(document, ordinal)
    if found is None:
        raise NotFound("This part of the page is no longer there. Reopen the page.")
    index, pieces, position = found
    if text is not None and keep_links:
        text = relink(pieces[position].strip("\n"), text)
    pieces[position] = _with_piece(pieces[position], text) if text is not None else ""
    parts = list(document.parts)
    parts[index] = RawText("".join(pieces))
    return replace(document, parts=parts)


def is_connection(block: Block) -> bool:
    """A connection SKAZ wrote between two concepts (edited by the user or not)."""
    return block.kind == "connection" and block.id.startswith(LINK_PREFIX)


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
            return _replace_unmarked(document, ordinal, clean, keep_links=True)
        index = _block_index(document, block_id)
        if index is None:
            raise NotFound("Block not found.")
        block = document.parts[index]
        assert isinstance(block, Block)
        body = relink(block.body, clean)
        if body == block.body:
            return document  # saved unchanged: the block stays the agent's, byte for byte
        owner = "user_edited" if block.owner == "agent" else block.owner
        updated = replace(block, body=body, raw=None).remarked(owner=owner)
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
    """A new ``user_note`` (one per paragraph, in order); returns the first block id."""
    blocks = [
        Block.create(new_note_id(), "user_note", piece, owner="user") for piece in note_paragraphs(text)
    ]
    library, path = page_path(kb, page_id)
    block = blocks[0]

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
                rest = [RawText(tail)] if tail.strip() else []
                parts[index : index + 1] = [RawText(head), *blocks, *rest]
            else:
                after = _block_index(document, after_block_id)
                if after is None:
                    raise NotFound("Block not found.")
                parts[after + 1 : after + 1] = blocks
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
            parts[end:end] = blocks
        else:
            insert_into_section(parts, "user_note", document.meta.language or "en", blocks)
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
        if block.owner != "user" and not is_connection(block):
            raise ProtectedItem(
                "Only your own notes and connections can be deleted. Edit the statement or ask the agent "
                "to recheck it."
            )
        parts = [part for i, part in enumerate(document.parts) if i != index]
        return replace(document, parts=spaced(parts))

    rewrite(library, path, build)
    reindex(kb, library, path)
