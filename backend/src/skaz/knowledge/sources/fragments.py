"""Cutting cleaned text into source fragments, and default titles.

A fragment is one paragraph (the source format forbids blank lines inside
it). Paragraphs longer than ``MAX_FRAGMENT_CHARS`` are cut at sentence ends,
then at whitespace, and only as a last resort mid-word — always as exact
slices of the paragraph, so no text is lost: the fragments joined together
equal the paragraph up to whitespace.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from ..library.names import FORBIDDEN_CHARACTERS, MAX_NAME_BYTES
from ..markdown.source import FragmentInput, FragmentRole
from .guard import strip_invisible

MAX_FRAGMENT_CHARS = 1500
TEXT_TITLE_CHARS = 60
DOCUMENT_TITLE_CHARS = 120

#: Same rule as the source format: a line holding only spaces/tabs separates paragraphs.
_PARAGRAPH_BREAK = re.compile(r"\n[ \t]*\n")
_SENTENCE_END = re.compile(r"[.!?…]+[\"'»”’)\]]*(?=\s)")
_WHITESPACE = re.compile(r"\s+")
_TITLE_REPLACEMENTS = {
    "/": "-",
    "\\": "-",
    "|": "-",
    ":": " - ",  # "Lecture 3: Waves" → "Lecture 3 - Waves", "a:b" → "a - b" (QA B20)
    "*": "",
    "?": "",
    '"': "'",
    "<": "",
    ">": "",
    "#": "",
    "^": "",
    "[": "(",
    "]": ")",
}


@dataclass(frozen=True)
class Paragraph:
    """A cleaned paragraph and where it is in the original (paragraph ``index`` or PDF ``page``)."""

    text: str
    index: int | None = None
    page: int | None = None
    #: How it is shown (``heading`` with ``level`` 1–6, ``list_item``, ``quote``, ``code``);
    #: the role never changes ``text``.
    role: FragmentRole = "paragraph"
    level: int | None = None


def split_paragraphs(text: str) -> list[str]:
    """Non-empty paragraphs, trimmed; blank lines (spaces/tabs only) separate them."""
    return [part.strip() for part in _PARAGRAPH_BREAK.split(text) if part.strip()]


def _cut(paragraph: str, start: int, limit: int) -> int:
    """End of the next piece of ``paragraph`` starting at ``start`` (exclusive)."""
    hard = start + limit
    window = paragraph[start:hard]
    ends = [match.end() for match in _SENTENCE_END.finditer(window)]
    if ends and ends[-1] > limit // 3:
        return start + ends[-1]
    space = max(window.rfind(" "), window.rfind("\n"), window.rfind("\t"))
    if space > limit // 3:
        return start + space
    while hard > start + 1 and unicodedata.combining(paragraph[hard]):
        hard -= 1  # never separate a base letter from its accent
    return hard


def split_long(paragraph: str, limit: int = MAX_FRAGMENT_CHARS) -> list[str]:
    pieces: list[str] = []
    start, length = 0, len(paragraph)
    while start < length:
        while start < length and paragraph[start].isspace():
            start += 1
        if start >= length:
            break
        if length - start <= limit:
            pieces.append(paragraph[start:].strip())
            break
        end = _cut(paragraph, start, limit)
        piece = paragraph[start:end].strip()
        if piece:
            pieces.append(piece)
        start = end
    return pieces


def to_fragments(paragraphs: Iterable[Paragraph]) -> list[FragmentInput]:
    fragments: list[FragmentInput] = []
    for paragraph in paragraphs:
        for piece in split_long(paragraph.text):
            fragments.append(
                FragmentInput(
                    text=piece,
                    index=paragraph.index,
                    page=paragraph.page,
                    role=paragraph.role,
                    level=paragraph.level if paragraph.role == "heading" else None,
                )
            )
    return fragments


def text_paragraphs(text: str) -> list[Paragraph]:
    return [Paragraph(part, index=number) for number, part in enumerate(split_paragraphs(text))]


def paragraph_of_offset(text: str, offset: int) -> int:
    """Paragraph index (as ``text_paragraphs`` numbers them) that holds ``offset`` of ``text``."""
    index = -1
    for number, match in enumerate(re.finditer(r"(?:\A|\n[ \t]*\n)\s*(?=\S)", text)):
        if match.end() > offset:
            break
        index = number
    return max(index, 0)


def _fit(name: str, max_chars: int) -> str:
    if len(name) > max_chars:
        cut = name[:max_chars]
        space = max_chars if name[max_chars] == " " else cut.rfind(" ")
        name = (cut[:space] if space > max_chars // 2 else cut).rstrip(" -,.;")
    while len(unicodedata.normalize("NFD", name).encode("utf-8")) > MAX_NAME_BYTES:
        name = name[:-1].rstrip()
    return name


def sanitize_title(raw: str | None, *, max_chars: int = DOCUMENT_TITLE_CHARS) -> str | None:
    """A usable material name made from a document's own title, or ``None`` when nothing is left.

    Only for titles SKAZ derives itself; a name the user typed is validated
    as typed and rejected with a reason instead.
    """
    if not raw:
        return None
    text = unicodedata.normalize("NFC", strip_invisible(raw))
    text = "".join(
        _TITLE_REPLACEMENTS.get(char, char) if char in FORBIDDEN_CHARACTERS else char for char in text
    )
    text = "".join(" " if unicodedata.category(char) in ("Cc", "Cf", "Zl", "Zp") else char for char in text)
    text = _WHITESPACE.sub(" ", text).strip().lstrip(".").strip(" -")
    text = _fit(text, max_chars)
    return text or None


def first_words_title(text: str) -> str | None:
    """Pasted text: its first words, at most ``TEXT_TITLE_CHARS`` characters, cut at a word."""
    for line in text.splitlines():
        if line.strip():
            sentence = re.match(r"\s*(.+?)[.!?…](?:\s|$)", line)
            if sentence is not None and len(sentence.group(1)) <= TEXT_TITLE_CHARS:
                line = sentence.group(1)
            title = sanitize_title(line, max_chars=TEXT_TITLE_CHARS)
            if title:
                return title.rstrip(" .,;:-—")
    return None


def joined(fragments: Sequence[FragmentInput]) -> str:
    return " ".join(fragment.text for fragment in fragments)
