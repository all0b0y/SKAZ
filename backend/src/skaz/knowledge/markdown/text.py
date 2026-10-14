"""Text normalisation shared by block hashes, quote checks and search."""
from __future__ import annotations

import hashlib
import re
import unicodedata

_WHITESPACE = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    """NFC, every whitespace run collapsed to one space, trimmed. Case is preserved."""
    return _WHITESPACE.sub(" ", unicodedata.normalize("NFC", text)).strip()


def block_hash(text: str) -> str:
    """First 12 hex digits of sha256 over the normalised block text (no marker, no block id)."""
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()[:12]


def quote_in_fragment(quote: str, fragment_text: str) -> bool:
    """A "from source" quote must be a verbatim substring of the fragment text.

    Callers pass the fragment text with the accepted recognition corrections
    already applied; this check never guesses at near matches.
    """
    needle = normalize_text(quote)
    return bool(needle) and needle in normalize_text(fragment_text)


def format_timestamp(ms: int) -> str:
    """``mm:ss`` below one hour, ``hh:mm:ss`` from one hour on."""
    seconds = max(0, ms) // 1000
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def name_key(name: str) -> str:
    """Collision key for names on the default macOS volume: NFC/NFD- and case-insensitive."""
    return unicodedata.normalize("NFC", name).casefold()
