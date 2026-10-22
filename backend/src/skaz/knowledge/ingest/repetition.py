"""Stop a wiki answer that goes round in circles (C1-f, decided 2026-10-20).

Two signs, either one stops the answer: (1) a section (or concept) title repeats within one part —
continuing the item just written, as a new answer may, is allowed; (2) three paragraphs nearly
identical (≥90 % after normalisation) to ones already written. One or two repeats are allowed:
lectures repeat a thought on purpose. Items kept from an earlier answer are remembered but never
stop the run themselves.
"""
from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field

from .pages import match_key

NEAR = 0.9
MAX_NEAR_REPEATS = 3
_WORD = re.compile(r"\w+", re.UNICODE)


class Repeating(Exception):
    """The answer started repeating itself; ``reason`` says which sign."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _shingles(text: str) -> frozenset[str]:
    words = _WORD.findall(text.casefold())
    if len(words) < 3:
        return frozenset({" ".join(words)}) if words else frozenset()
    return frozenset(" ".join(words[i:i + 3]) for i in range(len(words) - 2))


@dataclass
class RepeatGuard:
    _titles: set[str] = field(default_factory=set)
    _last_title: str | None = None
    _paragraphs: list[frozenset[str]] = field(default_factory=list)
    near_repeats: int = 0

    def snapshot(self) -> tuple[frozenset[str], str | None, int, int]:
        return frozenset(self._titles), self._last_title, len(self._paragraphs), self.near_repeats

    def restore(self, state: tuple[frozenset[str], str | None, int, int]) -> None:
        """Forget what an answer that is asked again (a structure repair) brought."""
        titles, self._last_title, paragraphs, self.near_repeats = state
        self._titles = set(titles)
        del self._paragraphs[paragraphs:]

    def new_part(self) -> None:
        """Titles count per part; paragraphs are compared across the whole operation."""
        self._titles = set()

    def remember(self, title: str, texts: Sequence[str]) -> None:
        self._take(title, texts, strict=False)

    def check(self, title: str, texts: Sequence[str]) -> None:
        """Raises :class:`Repeating` when this item makes the answer go round in circles."""
        self._take(title, texts, strict=True)

    def _take(self, title: str, texts: Sequence[str], *, strict: bool) -> None:
        key = match_key(title)
        if strict and key and key in self._titles and key != self._last_title:
            raise Repeating(f"the title “{title.strip()[:80]}” came again in the same part")
        for text in texts:
            shingles = _shingles(text)
            if not shingles:
                continue
            if strict and any(self._near(shingles, seen) for seen in self._paragraphs):
                self.near_repeats += 1
                if self.near_repeats >= MAX_NEAR_REPEATS:
                    raise Repeating(f"{MAX_NEAR_REPEATS} paragraphs repeated ones already written")
            self._paragraphs.append(shingles)
        if key:
            self._titles.add(key)
            self._last_title = key

    @staticmethod
    def _near(a: frozenset[str], b: frozenset[str]) -> bool:
        small, large = sorted((len(a), len(b)))
        if not large or small < NEAR * large:  # Jaccard can't reach 0.9 with sizes this far apart
            return False
        return len(a & b) / len(a | b) >= NEAR
