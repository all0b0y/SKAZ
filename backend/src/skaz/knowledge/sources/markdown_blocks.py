"""A ``.md`` file's blocks with their display roles (QA B3; the same roles as X8's HTML and PDF).

Headings, list items, quotes, fenced code and pipe tables keep their role; the
text is what a reader sees (``#``, ``-``, ``>`` and fences go, inline links
keep their words). Lines of one paragraph are joined with a space, as Markdown
reads a single line break. A fragment never holds a blank line (the source
format), so code is cut at its blank lines like ``html.code_text`` does.
Nothing here is a full CommonMark parser: anything unusual is a paragraph.

Obsidian notes (M1): their own syntax is cleaned, never shown as text. YAML front matter is
skipped; ``[[note|alias]]`` keeps its words, ``![[embed]]`` and ``#tags`` go, as do ``%%comments%%``
and block ids (`` ^id``); ``==marks==`` keep their text. A callout (``> [!note] Title``) stays a
quote that starts with its title. Numbered source marks like ``[32]`` stay.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..markdown.source import FragmentRole
from .fragments import Paragraph

_HEADING = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_BULLET = re.compile(r"^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$")
_ORDERED = re.compile(r"^ {0,3}(\d{1,9}[.)])[ \t]+")
_QUOTE = re.compile(r"^ {0,3}>[ \t]?(.*)$")
_RULE = re.compile(r"^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$")
_TABLE_SEPARATOR = re.compile(r"^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$")
_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_STRONG = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1")
_CODE_SPAN = re.compile(r"`([^`\n]+)`")
_EMBED = re.compile(r"!\[\[[^\]\n]*\]\]")
_WIKILINK = re.compile(r"\[\[([^\]|\n]*)(?:\|([^\]\n]*))?\]\]")
_COMMENT = re.compile(r"%%.*?%%", re.S)
_HIGHLIGHT = re.compile(r"==(?=\S)(.+?)(?<=\S)==")
_BLOCK_ID = re.compile(r"[ \t]+\^[A-Za-z0-9-]+[ \t]*$")
#: ``#tag`` and ``#nested/tag`` (not ``#1``, not a heading: those need a space after ``#``).
_TAG = re.compile(r"(?<![\w&/#])#[\w/-]*[^\W\d_][\w/-]*")
_CALLOUT = re.compile(r"^\[!([A-Za-z-]+)\][+-]?[ \t]*(.*)$")
_FRONT_MATTER_END = re.compile(r"^(?:---|\.\.\.)[ \t]*$")


@dataclass(frozen=True)
class MarkdownBlock:
    paragraph: Paragraph
    #: Offset of the block's first character in the text, to place layer-2 findings.
    offset: int


def _wikilink(match: re.Match[str]) -> str:
    """``[[note#Heading|alias]]`` → ``alias``; ``[[note#Heading]]`` → ``note › Heading``."""
    alias = (match.group(2) or "").strip()
    if alias:
        return alias
    target, _, anchor = match.group(1).partition("#")
    anchor = anchor.lstrip("^")
    if anchor and not match.group(1).split("#", 1)[1].startswith("^"):
        return f"{target.strip()} › {anchor.strip()}" if target.strip() else anchor.strip()
    return target.strip()


def obsidian_text(text: str) -> str:
    """Obsidian's own inline syntax out of a line of text (links keep their words); code spans stay."""
    pieces = re.split(r"(`[^`\n]+`)", text)
    return re.sub(r"[ \t]{2,}", " ", "".join(
        piece if piece.startswith("`") and piece.endswith("`") and len(piece) > 1 else _obsidian(piece)
        for piece in pieces)).strip()


def _obsidian(text: str) -> str:
    text = _COMMENT.sub("", text)
    text = _EMBED.sub("", text)
    text = _WIKILINK.sub(_wikilink, text)
    text = _HIGHLIGHT.sub(lambda m: m.group(1), text)
    text = _BLOCK_ID.sub("", text)
    return _TAG.sub("", text)


def inline_text(text: str) -> str:
    """Links and images keep their words; ``**strong**`` and `` `code` `` lose their marks."""
    text = obsidian_text(text)
    text = _IMAGE.sub(lambda m: m.group(1), text)
    text = _LINK.sub(lambda m: m.group(1), text)
    text = _STRONG.sub(lambda m: m.group(2), text)
    return _CODE_SPAN.sub(lambda m: m.group(1), text)


def _is_table_row(line: str) -> bool:
    return "|" in line and line.strip() != "|"


def markdown_blocks(text: str) -> list[MarkdownBlock]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    starts: list[int] = []
    position = 0
    for line in lines:
        starts.append(position)
        position += len(line) + 1
    blocks: list[MarkdownBlock] = []
    # YAML front matter (``---`` … ``---``) of Obsidian notes: metadata, not text.
    skip_until = 0
    if lines and lines[0].strip() == "---":
        for number in range(1, min(len(lines), 200)):
            if _FRONT_MATTER_END.match(lines[number]):
                skip_until = number + 1
                break

    def add(body: str, role: FragmentRole, line_no: int, level: int | None = None) -> None:
        body = body.strip()
        if body:
            blocks.append(MarkdownBlock(Paragraph(body, index=len(blocks), role=role, level=level),
                                        starts[line_no]))

    index = skip_until
    while index < len(lines):
        line = lines[index]
        if not line.strip() or _RULE.match(line):
            index += 1
            continue
        fence = _FENCE.match(line)
        if fence:
            marker = fence.group(1)
            body: list[str] = []
            first = index + 1
            index += 1
            while index < len(lines) and not lines[index].lstrip().startswith(marker[0] * len(marker)):
                body.append(lines[index].rstrip())
                index += 1
            index += 1  # the closing fence (or the end of the file)
            chunk: list[str] = []
            chunk_start = first
            for offset, code_line in enumerate([*body, ""]):
                if code_line.strip():
                    if not chunk:
                        chunk_start = first + offset
                    chunk.append(code_line)
                elif chunk:
                    add("\n".join(chunk).strip("\n"), "code", min(chunk_start, len(lines) - 1))
                    chunk = []
            continue
        heading = _HEADING.match(line)
        if heading:
            add(inline_text(heading.group(2)), "heading", index, len(heading.group(1)))
            index += 1
            continue
        if (_is_table_row(line) and index + 1 < len(lines) and _TABLE_SEPARATOR.match(lines[index + 1])
                and "|" in lines[index + 1]):
            first = index
            rows = [line.strip(), lines[index + 1].strip()]
            index += 2
            while index < len(lines) and lines[index].strip() and _is_table_row(lines[index]):
                rows.append(lines[index].strip())
                index += 1
            add("\n".join(rows), "table", first)
            continue
        quote = _QUOTE.match(line)
        if quote:
            first = index
            parts: list[str] = []
            callout = _CALLOUT.match(quote.group(1).strip())
            if callout:
                # ``> [!abstract] Коротко`` → a quote that starts "Коротко:" (the type when untitled).
                title = obsidian_text(callout.group(2)) or callout.group(1).replace("-", " ").capitalize()
                parts.append(f"{title}:")
                index += 1
            while index < len(lines) and (match := _QUOTE.match(lines[index])):
                inner = match.group(1)
                while (nested := _QUOTE.match(inner)) is not None:
                    inner = nested.group(1)
                if inner.strip():
                    parts.append(inner.strip())
                elif parts:  # a blank quoted line ends one quoted paragraph
                    add(inline_text(" ".join(parts)), "quote", first)
                    parts, first = [], index + 1
                index += 1
            add(inline_text(" ".join(parts)), "quote", first)
            continue
        bullet = _BULLET.match(line)
        if bullet:
            first = index
            ordered = _ORDERED.match(line)
            parts = [(ordered.group(1) + " " if ordered else "") + bullet.group(1).strip()]
            index += 1
            # Continuation lines are indented (or lazy text right under the item).
            while (index < len(lines) and lines[index].strip() and not _BULLET.match(lines[index])
                   and not _HEADING.match(lines[index]) and not _FENCE.match(lines[index])
                   and not _QUOTE.match(lines[index])):
                parts.append(lines[index].strip())
                index += 1
            add(inline_text(" ".join(parts)), "list_item", first)
            continue
        first = index
        parts = []
        while (index < len(lines) and lines[index].strip() and not _HEADING.match(lines[index])
               and not _FENCE.match(lines[index]) and not _BULLET.match(lines[index])
               and not _QUOTE.match(lines[index]) and not _RULE.match(lines[index])):
            parts.append(lines[index].strip())
            index += 1
        add(inline_text(" ".join(parts)), "paragraph", first)
    return blocks


def block_of_offset(blocks: list[MarkdownBlock], offset: int) -> int:
    """Index of the block that holds ``offset`` (the last one starting at or before it)."""
    found = 0
    for block in blocks:
        if block.offset > offset:
            break
        found = block.paragraph.index or 0
    return found
