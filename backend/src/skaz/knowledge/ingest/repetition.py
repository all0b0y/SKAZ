"""A wiki answer that goes round in circles (WR3, decision 9c; replaces the C1-f guard of 2026-10-20).

Repeats themselves are not a fault: lectures restate a thought on purpose, a concept comes back in a
later part, related concepts share a quote. The duplicate filter (``drafts.place_block``) merges them
and never stops a job. What stops an answer is a loop: :data:`LOOP_RUN` items IN A ROW of one answer
that add nothing new — every statement already kept for the same concept (or same-titled Notes
section) in this run, or no statement at all. Scattered repeats between useful items are no loop.

"The same" is the metric the C1-f guard used: 3-word shingles, Jaccard ≥ :data:`NEAR`, for statements
of at least :data:`MIN_WORDS` words; a shorter one is the same only when its words are identical.
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Generic, TypeVar

NEAR = 0.9
#: Statements shorter than this are compared word for word, never by shingles.
MIN_WORDS = 8
#: Items in a row that add nothing new: a loop.
LOOP_RUN = 3
_WORD = re.compile(r"\w+(?:[.,]\d+)*", re.UNICODE)


@dataclass(frozen=True)
class Mark:
    wording: frozenset[str]
    #: Mathematical punctuation must agree exactly, even when the prose is a near-duplicate.
    notation: tuple[str, ...] = ()

    def __bool__(self) -> bool:
        return bool(self.wording)


class Looping(Exception):
    """An answer wrote :data:`LOOP_RUN` items in a row that add nothing new; ``titles`` are theirs."""

    def __init__(self, titles: Sequence[str]) -> None:
        super().__init__(f"{len(titles)} items in a row added nothing new")
        self.titles = list(titles)


def _words(text: str) -> list[str]:
    return _WORD.findall(text.casefold())


def is_short(text: str) -> bool:
    return len(_words(text)) < MIN_WORDS


def mark(text: str) -> Mark:
    """3-word shingles of a statement, or its whole wording when short; empty for no words."""
    words = _words(text)
    if not words:
        return Mark(frozenset())
    # Ignore ordinary prose punctuation, but keep operators/signs and mathematical grouping.
    # Em/en dashes remain prose punctuation; ASCII '-' also denotes subtraction or a negative root.
    notation = tuple(char for char in text if unicodedata.category(char) == "Sm"
                     or char in "+-*/^%=<>|~()[]{}")
    if len(words) < MIN_WORDS:
        return Mark(frozenset({"=" + " ".join(words)}), notation)
    return Mark(frozenset(" ".join(words[i:i + 3]) for i in range(len(words) - 2)), notation)


def same(a: Mark, b: Mark) -> bool:
    if a.notation != b.notation:
        return False
    small, large = sorted((len(a.wording), len(b.wording)))
    if not small or small < NEAR * large:  # Jaccard can't reach 0.9 with sizes this far apart
        return False
    return len(a.wording & b.wording) / len(a.wording | b.wording) >= NEAR


@dataclass
class LoopDetector:
    """What one Notes/Concepts operation already has, per concept (any of its names) or section title."""

    _entries: list[list[Mark]] = field(default_factory=list)
    _by_key: dict[str, int] = field(default_factory=dict)

    def snapshot(self) -> tuple[tuple[tuple[Mark, ...], ...], dict[str, int]]:
        return tuple(tuple(entry) for entry in self._entries), dict(self._by_key)

    def restore(self, state: tuple[tuple[tuple[Mark, ...], ...], dict[str, int]]) -> None:
        """Forget what an answer that is asked again (a structure repair) brought."""
        entries, by_key = state
        self._entries = [list(entry) for entry in entries]
        self._by_key = dict(by_key)

    def take(self, keys: Sequence[str], texts: Sequence[str]) -> bool:
        """Remember an item; ``True`` when it adds a statement not already kept under its name."""
        names = [key for key in keys if key]
        index = next((self._by_key[key] for key in names if key in self._by_key), None)
        if index is None:
            index = len(self._entries)
            self._entries.append([])
        for key in names:
            self._by_key.setdefault(key, index)
        entry = self._entries[index]
        added = False
        for text in texts:
            marked = mark(text)
            if not marked or any(same(marked, seen) for seen in entry):
                continue
            entry.append(marked)
            added = True
        return added


T = TypeVar("T")


@dataclass
class AnswerRun(Generic[T]):
    """The items of one answer as they stream: ``kept`` (useful ones and the scattered repeats before
    them) and the current run of items that add nothing. :data:`LOOP_RUN` of those raise
    :class:`Looping`; the answer is then cut before the run, which is never kept."""

    detector: LoopDetector
    kept: list[T] = field(default_factory=list)
    useful: int = 0
    _run: list[tuple[T, str]] = field(default_factory=list)

    def add(self, item: T, title: str, keys: Sequence[str], texts: Sequence[str]) -> bool:
        """``True`` when the item is kept now (it moved the answer on)."""
        if self.detector.take(keys, texts):
            self.kept.extend(pending for pending, _title in self._run)
            self._run = []
            self.kept.append(item)
            self.useful += 1
            return True
        self._run.append((item, title))
        if len(self._run) >= LOOP_RUN:
            raise Looping([name for _item, name in self._run])
        return False

    def close(self) -> list[T]:
        """The answer ended: a shorter run at its end is scattered repeats, kept for the filter."""
        self.kept.extend(pending for pending, _title in self._run)
        self._run = []
        return self.kept
