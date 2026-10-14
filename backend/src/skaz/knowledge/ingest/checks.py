"""Mechanical checks of model output before anything is written.

Layer 4 (statements): a ``from_source`` block needs at least one cite, and
every cite must name an existing, not excluded fragment of this material whose
text contains the quote verbatim (``quote_in_fragment``). A ``connection``
cites its side(s) in this material and links the other side; ``explanation``
carries no cites. A failing block is dropped whole.

Layer 5 (output): any text that reads as an instruction to an AI is dropped
(block, or the whole concept page when its title/aliases are affected).

Model text is also made inert for the page format: no wikilinks/embeds, no
Obsidian comments (``%%``, which would forge SKAZ markers), no block ids, no
headings, one paragraph.
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from ..markdown.page import BlockKind
from ..markdown.source import Fragment
from ..markdown.text import normalize_text, quote_in_fragment
from .model import BlockOut
from .protocols import InstructionDetector

_TRAILING_BLOCK_ID = re.compile(r"\s+\^[A-Za-z0-9-]+$")
_WHITESPACE = re.compile(r"\s+")
MAX_TITLE_CHARS = 120
#: A quote must carry real evidence: a few characters ("a", "is") are in almost any
#: fragment. Shorter quotes pass only when they are the whole fragment.
MIN_QUOTE_CHARS = 12


def clean_text(text: str) -> str:
    """One inert Markdown paragraph from model text ('' when nothing is left)."""
    value = unicodedata.normalize("NFC", text)
    # Invisible format characters (zero-width, bidi overrides, Unicode tags, soft hyphen).
    value = "".join(char for char in value if unicodedata.category(char) != "Cf")
    value = value.replace("%%", "%").replace("[[", "[").replace("]]", "]")
    value = _WHITESPACE.sub(" ", value).strip()
    while True:
        stripped = _TRAILING_BLOCK_ID.sub("", value)
        if stripped == value:
            break
        value = stripped
    if value.startswith("#"):
        value = "\\" + value
    if value.startswith(("---", "===")):
        value = "\\" + value
    return value


def clean_title(text: str) -> str:
    """A section or page title: one line, no Markdown control at the start, bounded length."""
    value = clean_text(text).lstrip("\\#").strip()
    if len(value) > MAX_TITLE_CHARS:
        value = value[:MAX_TITLE_CHARS].rstrip()
    return value


@dataclass(frozen=True)
class CheckedBlock:
    kind: BlockKind
    text: str
    #: Cited fragments of this material, de-duplicated, in the order the model gave them.
    segs: tuple[int, ...]
    #: Page titles the model linked (connections only); resolved when pages are planned.
    links: tuple[str, ...] = ()


@dataclass
class CheckStats:
    """Counts only — never the rejected text (it may be poisoned or private)."""

    dropped: Counter[str]
    blocked: int = 0

    @classmethod
    def empty(cls) -> CheckStats:
        return cls(Counter())

    @property
    def dropped_total(self) -> int:
        return sum(self.dropped.values())


def check_statement(block: BlockOut, fragments: Mapping[int, Fragment],
                    excluded: frozenset[int]) -> CheckedBlock | str:
    """The checked block, or the reason it is dropped (layer 4)."""
    text = clean_text(block.text)
    if not text:
        return "empty_text"
    if block.kind == "explanation":
        return CheckedBlock("explanation", text, ())
    if not block.cites:
        return "no_cite"
    segs: list[int] = []
    for cite in block.cites:
        if cite.seg in excluded:
            return "excluded_fragment"
        fragment = fragments.get(cite.seg)
        if fragment is None:
            return "unknown_fragment"
        if not quote_in_fragment(cite.quote, fragment.text):
            return "quote_not_in_source"
        if len(normalize_text(cite.quote)) < min(MIN_QUOTE_CHARS, len(normalize_text(fragment.text))):
            return "quote_too_short"
        if cite.seg not in segs:
            segs.append(cite.seg)
    if block.kind == "from_source":
        return CheckedBlock("from_source", text, tuple(segs))
    links = tuple(dict.fromkeys(title for title in (clean_title(link) for link in block.links) if title))
    if len(segs) < 2 and not links:
        return "connection_one_side"
    return CheckedBlock("connection", text, tuple(segs), links)


def connection_complete(block: CheckedBlock, resolved_links: Sequence[object]) -> bool:
    """Both sides present: two fragments of this source, or a fragment and an existing page."""
    return block.kind != "connection" or len(block.segs) >= 2 or bool(resolved_links)


def flags_instructions(detector: InstructionDetector, *texts: str) -> bool:
    """Layer 5: True when any of the texts reads as an instruction to an AI."""
    return any(text and detector.detect(normalize_text(text)) for text in texts)
