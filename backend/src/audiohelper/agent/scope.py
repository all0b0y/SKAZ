"""Which part of the recording a question is about.

"What did I miss?" means the last few minutes, not the whole session. An explicit
number of minutes, a question about the beginning, or a question about a topic
all override that default — and a topic search is never silently replaced by the
most recent minutes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..schemas import Scope

DEFAULT_WINDOW_MINUTES = 5
MINUTE_MS = 60_000

#: Spelled-out minute counts we accept in questions (ru + en).
WORD_NUMBERS: dict[str, int] = {
    "одну": 1,
    "одна": 1,
    "две": 2,
    "два": 2,
    "три": 3,
    "четыре": 4,
    "пять": 5,
    "шесть": 6,
    "семь": 7,
    "восемь": 8,
    "девять": 9,
    "десять": 10,
    "пятнадцать": 15,
    "двадцать": 20,
    "тридцать": 30,
    "полчаса": 30,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "ten": 10,
    "fifteen": 15,
    "twenty": 20,
}
_MINUTE_WORD = r"(?:минут\w*|мин\b|minutes?\b|mins?\b)"
_DIGIT_MINUTES = re.compile(rf"(\d{{1,3}})\s*{_MINUTE_WORD}", re.IGNORECASE)
_WORD_MINUTES = re.compile(rf"\b({'|'.join(WORD_NUMBERS)})\s*{_MINUTE_WORD}", re.IGNORECASE)
_HALF_HOUR = re.compile(r"\bполчаса\b|\bhalf an hour\b", re.IGNORECASE)

BEGINNING_PATTERNS = (
    r"\bс\s+начала\b",
    r"\bв\s+начале\b",
    r"\bсамом\s+начале\b",
    r"\bначал[ое]\s+(?:записи|лекции|встречи)",
    r"\bbeginning\b",
    r"\bat\s+the\s+start\b",
    r"\bstart\s+of\s+the\s+(?:recording|lecture|meeting)\b",
    r"\bfirst\s+minutes\b",
    r"\bпервые\s+минуты\b",
    r"\bпервые\b.{0,20}\bминут",
    r"\bfirst\b.{0,20}\bminutes?\b",
)

RECENT_PATTERNS = (
    r"\bсейчас\s+обсужда",
    r"\bчто\s+сейчас\b",
    r"\bтекущ(?:ая|ую|ей|ий|его)\s+тем",
    r"\bcurrently\s+(?:discuss|talk)",
    r"\bwhat(?:'s|\s+is)\s+being\s+discussed\s+now\b",
)

SEARCH_PATTERNS = (
    r"\bкогда\b",
    r"\bгде\b",
    r"\bупомина",
    r"\bговорил",
    r"\bобсужда",
    r"\bзвучал",
    r"\bчто\s+так(?:ое|ой)\b",
    r"\bкто\s+сказал\b",
    r"\bбыло\s+ли\b",
    r"\bнайд[иу]\b",
    r"\bпоищи\b",
    r"\bwhen\s+did\b",
    r"\bmention",
    r"\bdid\s+we\s+(?:talk|discuss|say)\b",
    r"\bwho\s+said\b",
    r"\bwhat\s+is\b",
    r"\bsearch\b",
    r"\bfind\b",
    r"\bwas\s+there\b",
)

WHOLE_SESSION_PATTERNS = (
    r"\bвс[юя]\s+(?:запись|лекци|встреч)",
    r"\bза\s+всё\s+время\b",
    r"\bза\s+все\s+время\b",
    r"\bwhole\s+(?:recording|session|lecture)\b",
    r"\bentire\s+(?:recording|session)\b",
)

#: Words that carry no topic meaning and would only pollute a full-text query.
STOPWORDS = frozenset(
    [
        "а",
        "бы",
        "был",
        "была",
        "было",
        "были",
        "в",
        "вот",
        "все",
        "всё",
        "для",
        "до",
        "же",
        "за",
        "и",
        "из",
        "как",
        "ко",
        "когда",
        "кто",
        "ли",
        "мне",
        "меня",
        "мы",
        "на",
        "нам",
        "не",
        "него",
        "нет",
        "ним",
        "о",
        "об",
        "он",
        "она",
        "они",
        "по",
        "при",
        "про",
        "с",
        "со",
        "так",
        "такое",
        "там",
        "то",
        "тот",
        "ты",
        "у",
        "что",
        "чём",
        "чем",
        "это",
        "эта",
        "я",
        "about",
        "and",
        "are",
        "at",
        "be",
        "but",
        "by",
        "did",
        "do",
        "does",
        "for",
        "from",
        "had",
        "has",
        "have",
        "how",
        "in",
        "is",
        "it",
        "its",
        "me",
        "my",
        "not",
        "of",
        "on",
        "or",
        "that",
        "the",
        "there",
        "they",
        "this",
        "to",
        "us",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "with",
        "you",
        "your",
    ]
)


@dataclass(frozen=True)
class ResolvedScope:
    kind: Scope
    start_ms: int
    end_ms: int
    query: str | None = None
    #: Human-readable reason, surfaced in the prompt so the model knows what it was given.
    reason: str = ""


def resolve(
    question: str,
    requested: Scope,
    window_minutes: int,
    *,
    watermark_ms: int,
) -> ResolvedScope:
    """Pick the transcript window for a question. ``watermark_ms`` is the last transcribed moment."""
    window = max(1, window_minutes)
    if requested == "recent":
        return _recent(window, watermark_ms, f"explicit request for the last {window} minutes")
    if requested == "beginning":
        return _beginning(window, watermark_ms, "explicit request for the beginning")
    if requested == "all":
        return ResolvedScope("all", 0, watermark_ms, None, "explicit request for the whole recording")
    if requested == "search":
        return ResolvedScope("search", 0, watermark_ms, keywords(question), "explicit topic search")

    named_minutes = explicit_minutes(question)
    if _matches(question, BEGINNING_PATTERNS):
        minutes = named_minutes or window
        return _beginning(minutes, watermark_ms, f"the question asks for the first {minutes} minutes")
    if named_minutes is not None:
        return _recent(named_minutes, watermark_ms, f"the question names {named_minutes} minutes")
    if _matches(question, WHOLE_SESSION_PATTERNS):
        return ResolvedScope("all", 0, watermark_ms, None, "the question asks about the whole recording")
    if _matches(question, RECENT_PATTERNS):
        return _recent(window, watermark_ms, "the question asks about the current discussion")
    if _matches(question, SEARCH_PATTERNS):
        return ResolvedScope("search", 0, watermark_ms, keywords(question), "the question refers to a topic")
    return _recent(window, watermark_ms, f"default window of the last {window} minutes")


def explicit_minutes(question: str) -> int | None:
    match = _DIGIT_MINUTES.search(question)
    if match:
        return max(1, int(match.group(1)))
    match = _WORD_MINUTES.search(question)
    if match:
        return WORD_NUMBERS[match.group(1).lower()]
    if _HALF_HOUR.search(question):
        return 30
    return None


def keywords(question: str) -> str:
    """FTS5 query built from the content words of the question.

    Words are matched by prefix with the inflected tail removed, so a Russian
    question about "энтропию" still finds "энтропии" in the transcript.
    """
    words = [word for word in re.findall(r"\w{3,}", question.lower()) if word not in STOPWORDS]
    unique: list[str] = []
    for word in words:
        stem = word[:-2] if len(word) >= 6 else word
        if stem not in unique:
            unique.append(stem)
    return " OR ".join(f'"{stem}"*' for stem in unique[:8])


def _recent(minutes: int, watermark_ms: int, reason: str) -> ResolvedScope:
    end = watermark_ms
    return ResolvedScope("recent", max(0, end - minutes * MINUTE_MS), end, None, reason)


def _beginning(minutes: int, watermark_ms: int, reason: str) -> ResolvedScope:
    return ResolvedScope("beginning", 0, min(watermark_ms, minutes * MINUTE_MS), None, reason)


def _matches(question: str, patterns: tuple[str, ...]) -> bool:
    return any(re.search(pattern, question, re.IGNORECASE) for pattern in patterns)
