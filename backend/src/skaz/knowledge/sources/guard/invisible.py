"""Layer 2 over any text: remove what a reader cannot see.

Removed with a finding (meaningful — can hide or reorder content):
Unicode tags U+E0000–E007F (the hidden ASCII is decoded into the finding),
bidi embedding/override/isolate controls U+202A–202E and U+2066–2069,
interlinear annotation controls U+FFF9–FFFB, runs of ≥ 4 zero-width
characters and runs of ≥ 2 variation selectors (both can encode data).

Removed silently: shorter zero-width runs (U+200B–200D, U+2060, U+FEFF), the
soft hyphen, every other format (``Cf``) character and control characters
other than newline and tab. Kept: the direction marks U+200E, U+200F, U+061C
(they reorder nothing on their own and right-to-left text needs them) and a
single variation selector (emoji presentation, CJK variants).

Line and paragraph separators become ``\\n`` / a blank line, so the paragraph
split downstream sees them.
"""

from __future__ import annotations

import functools
import re
import unicodedata
from dataclasses import dataclass

from .findings import Finding, FindingKind, visible_repr

_ZERO_WIDTH = frozenset({0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF})
_BIDI = frozenset({*range(0x202A, 0x202F), *range(0x2066, 0x206A)})
_ANNOTATION = frozenset({0xFFF9, 0xFFFA, 0xFFFB})
_KEEP_FORMAT = frozenset({0x200E, 0x200F, 0x061C})
ZERO_WIDTH_RUN = 4
VARIATION_RUN = 2
_CONTEXT = 40


def _is_tag(code: int) -> bool:
    return 0xE0000 <= code <= 0xE007F


def _is_variation(code: int) -> bool:
    return 0xFE00 <= code <= 0xFE0F or 0xE0100 <= code <= 0xE01EF


def _klass(char: str) -> str:
    """``keep`` or the removal class of one character."""
    code = ord(char)
    if char in "\n\t":
        return "keep"
    if _is_tag(code):
        return "tag"
    if code in _BIDI:
        return "bidi"
    if code in _ZERO_WIDTH:
        return "zero_width"
    if code in _ANNOTATION:
        return "annotation"
    if _is_variation(code):
        return "variation"
    if code in _KEEP_FORMAT:
        return "keep"
    category = unicodedata.category(char)
    if category in ("Cf", "Cc", "Cs", "Co", "Cn") and not (category == "Cn" and code < 0xE0000):
        return "silent"
    return "keep"


@functools.cache
def _candidates() -> re.Pattern[str]:
    """Every character ``_klass`` does not keep, plus every astral one (decided per character).

    Built once from ``_klass`` itself over the BMP (~70 ms), so it can't drift from it. Text
    between two candidates is copied as is: a pasted book is not classified letter by letter
    in Python (QA E14 — ~0.5 s per 2 MB of paste went here).
    """
    ranges: list[tuple[int, int]] = []
    for code in range(0x10000):
        if _klass(chr(code)) == "keep":
            continue
        if ranges and ranges[-1][1] == code - 1:
            ranges[-1] = (ranges[-1][0], code)
        else:
            ranges.append((code, code))
    parts = [re.escape(chr(low)) if low == high else f"{re.escape(chr(low))}-{re.escape(chr(high))}"
             for low, high in ranges]
    return re.compile("[" + "".join(parts) + "\U00010000-\U0010FFFF]")


@dataclass(frozen=True)
class Cleaned:
    text: str
    findings: tuple[Finding, ...]
    #: Characters removed in total (silent removals included).
    removed: int


def _normalise_breaks(text: str) -> str:
    return (
        text.replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\u0085", "\n")
        .replace("\u2028", "\n")
        .replace("\u2029", "\n\n")
    )


def _context(source: str, start: int, end: int) -> str:
    return visible_repr(source[max(0, start - _CONTEXT) : end + _CONTEXT])


def clean_invisible(text: str, *, index: int | None = None, page: int | None = None) -> Cleaned:
    """The visible text and what was removed from it (offsets point into the cleaned text)."""
    source = _normalise_breaks(text)
    out: list[str] = []
    out_len = 0
    findings: list[Finding] = []
    aggregated: dict[str, tuple[int, int, int]] = {}  # class -> (count, first offset, first source pos)
    removed = 0
    position, length = 0, len(source)
    candidates = _candidates()
    while position < length:
        candidate = candidates.search(source, position)
        if candidate is None:
            out.append(source[position:])
            out_len += length - position
            break
        if candidate.start() > position:
            out.append(source[position:candidate.start()])
            out_len += candidate.start() - position
            position = candidate.start()
        klass = _klass(source[position])
        if klass == "keep":
            out.append(source[position])
            out_len += 1
            position += 1
            continue
        end = position
        while end < length and _klass(source[end]) == klass:
            end += 1
        run = source[position:end]
        if klass == "variation" and len(run) < VARIATION_RUN:
            out.append(run)
            out_len += len(run)
            position = end
            continue
        removed += len(run)
        if klass == "tag":
            hidden = "".join(chr(ord(char) - 0xE0000) for char in run if 0xE0020 <= ord(char) <= 0xE007E)
            findings.append(
                Finding(
                    kind="unicode_tags",
                    index=index,
                    page=page,
                    offset=out_len,
                    detail=f"Removed {len(run)} invisible Unicode tag characters spelling out hidden text.",
                    original=visible_repr(hidden) if hidden.strip() else _context(source, position, end),
                )
            )
        elif klass in ("bidi", "annotation", "variation") or (
            klass == "zero_width" and len(run) >= ZERO_WIDTH_RUN
        ):
            count, first, first_pos = aggregated.get(klass, (0, out_len, position))
            aggregated[klass] = (count + len(run), first, first_pos)
        position = end
    descriptions: dict[str, tuple[FindingKind, str]] = {
        "bidi": (
            "bidi_control",
            "Removed {n} bidirectional control characters that can reorder the text shown.",
        ),
        "annotation": ("interlinear_annotation", "Removed {n} interlinear annotation characters."),
        "variation": (
            "variation_selector_run",
            "Removed {n} stacked variation selectors that can carry hidden data.",
        ),
        "zero_width": (
            "zero_width_run",
            "Removed {n} zero-width characters in long runs that can carry hidden data.",
        ),
    }
    for klass, (count, first, first_pos) in aggregated.items():
        kind, template = descriptions[klass]
        findings.append(
            Finding(
                kind=kind,
                index=index,
                page=page,
                offset=first,
                detail=template.format(n=count),
                original=_context(source, first_pos, first_pos + 1),
            )
        )
    findings.sort(key=lambda item: item.offset or 0)
    return Cleaned("".join(out), tuple(findings), removed)


def strip_invisible(text: str) -> str:
    """Only the cleaned text (titles, labels)."""
    return clean_invisible(text).text
