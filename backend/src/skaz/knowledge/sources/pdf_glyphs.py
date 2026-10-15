"""Text a PDF font can't turn into letters: decode it when a constant shift does, else leave it out.

A subset TrueType font written with two-byte glyph numbers (``/Identity-H``) and no usable
``/ToUnicode`` map gives the glyph numbers instead of letters. For fonts in the usual Mac glyph
order (Arial, Times…) the number is the Unicode value minus 29, so "HSE University" comes out
as ``+6(␃8QLYHUVLW\\`` (user bug 1016-4). Never keep such text silently:

* a font is *unmapped* when it has no ``/ToUnicode`` and either uses ``/Identity-H``/``-V`` or is
  a symbolic simple font without ``/Differences``;
* its text on a page (all its runs together) is kept when it already reads like language;
* else, when one constant shift turns it into text that reads like language, it is decoded;
* else it is left out and reported as unreadable (never sent to agents, never quoted).

A font that has a map is only touched when its text has control characters or letter statistics
no language produces *and* a constant shift decodes it; it is never left out on statistics alone.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Any

#: Shifts tried, nearest first (29 is the Mac glyph order of most TrueType fonts).
SHIFTS = (29, *[shift for shift in range(1, 65) if shift != 29])
MIN_LETTERS = 4
VOWELS = frozenset("aeiouyAEIOUY")
#: Cyrillic, Greek and other scripts: their letters are judged by the mix of cases only.
_LATIN_MAX = 0x024F


@dataclass(frozen=True)
class Verdict:
    #: ``keep`` (as is), ``decoded`` (shifted by ``shift``) or ``unreadable`` (left out).
    action: str
    shift: int = 0


KEEP = Verdict("keep")
UNREADABLE = Verdict("unreadable")


def _control(char: str) -> bool:
    return unicodedata.category(char) in ("Cc", "Co", "Cn") and char not in "\t\n\r"


def has_control(text: str) -> bool:
    return any(_control(char) for char in text)


def reads_like_language(text: str) -> bool:
    """Letters in a proportion of vowels and cases that running text has; no control characters."""
    if has_control(text):
        return False
    letters = [char for char in text if char.isalpha()]
    if len(letters) < MIN_LETTERS:
        # Too little to judge (numbers, a symbol): only control characters make it unreadable.
        return True
    latin = [char for char in letters if ord(char) <= _LATIN_MAX]
    if len(latin) >= len(letters) / 2:
        vowels = sum(char in VOWELS for char in latin) / len(latin)
        if not 0.2 <= vowels <= 0.65:
            return False
        # Words in Latin script are separated by spaces.
        if len(text) >= 20 and text.count(" ") / len(text) < 0.04:
            return False
    lower = sum(char.islower() for char in letters) / len(letters)
    upper_only = lower == 0 and len(letters) <= 40
    visible = max(1, len(text.replace(" ", "")))
    symbols = sum(1 for char in text if not (char.isalnum() or char.isspace())) / visible
    return (lower >= 0.4 or upper_only) and symbols < 0.2


def looks_garbled(text: str) -> bool:
    """Statistics no language produces: control characters, or capitals without vowels."""
    if has_control(text):
        return True
    latin = [char for char in text if char.isalpha() and ord(char) <= _LATIN_MAX]
    if len(latin) < 12:
        return False
    vowels = sum(char in VOWELS for char in latin) / len(latin)
    upper = sum(char.isupper() for char in latin) / len(latin)
    return vowels < 0.2 and upper > 0.8


def shift_text(text: str, shift: int) -> str:
    out = []
    for char in text:
        code = ord(char)
        out.append(char if char in "\n" or code + shift > 0x10FFFF else chr(code + shift))
    return "".join(out)


def _decoding(text: str) -> int | None:
    for shift in SHIFTS:
        if reads_like_language(shift_text(text, shift)):
            return shift
    return None


def unmapped(font: Any) -> bool:
    """No ``/ToUnicode`` and codes that are glyph numbers (Identity CMap or a symbolic font)."""
    try:
        if font is None or "/ToUnicode" in font:
            return False
        encoding = font.get("/Encoding")
        if font.get("/Subtype") == "/Type0":
            return str(encoding) in ("/Identity-H", "/Identity-V")
        if encoding is not None and "/Differences" in getattr(encoding.get_object(), "keys", dict)():
            return False
        descriptor = font.get("/FontDescriptor")
        flags = int(descriptor.get_object().get("/Flags", 0)) if descriptor is not None else 0
        return bool(flags & 4) and encoding is None
    except (AttributeError, KeyError, TypeError, ValueError):
        return False


def judge(text: str, font: Any) -> Verdict:
    """What to do with everything one font shows on one page (its runs joined by spaces)."""
    if not text.strip():
        return KEEP
    if unmapped(font):
        if reads_like_language(text):
            return KEEP
        shift = _decoding(text)
        return Verdict("decoded", shift) if shift is not None else UNREADABLE
    if looks_garbled(text):
        shift = _decoding(text)
        if shift is not None:
            return Verdict("decoded", shift)
        if has_control(text) and not reads_like_language("".join(c for c in text if not _control(c))):
            return UNREADABLE
    return KEEP
