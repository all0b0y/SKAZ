"""What the agent sends for cards and test questions, checked before anything is shown (S3, S4).

* A right answer is always "from the source": at least one citation whose quote is verbatim in the
  cited fragment (the wiki's layer 4, ``MaterialReader.checked_quote``). A card or question without
  one is dropped with the reason, the rest are kept (S3).
* The agent's explanation and its made-up wrong options are kept apart from the source and labelled.
* Text that reads like instructions to an AI is refused (layer 5); model text is made inert for the
  page format (no wikilinks, no ``%%``, no ``::`` inside a question).
* Short answers are compared by code after normalisation; open answers are judged by the agent (S4).
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import Field

from ..agents.tools import _Args
from ..chats.resolve import MaterialReader
from ..ingest.checks import MIN_QUOTE_CHARS, clean_text, clean_title
from ..ingest.pages import SourceRef
from ..markdown.page import Cite
from ..sources.guard.detector import detect_instruction
from .format import SEPARATOR, QuestionType

MAX_ITEMS = 60
MAX_TEXT = 1_000
MAX_OPTIONS = 6


class CitationIn(_Args):
    material_id: str = Field(min_length=1, max_length=120, description="Material id (mat-…).")
    seg: int = Field(ge=1, le=10_000_000, description="Fragment number (the N in seg-N).")
    quote: str = Field(
        min_length=1,
        max_length=2_000,
        description="The exact words of that fragment the answer rests on, copied verbatim.",
    )


class CardIn(_Args):
    question: str = Field(min_length=1, max_length=MAX_TEXT, description="The front: a question or a term.")
    answer: str = Field(
        min_length=1,
        max_length=MAX_TEXT,
        description="The back: the answer as the source says it, in your words if needed.",
    )
    citations: list[CitationIn] = Field(
        min_length=1, max_length=4, description="Where the answer is in the sources (verbatim quote)."
    )
    explanation: str | None = Field(
        default=None,
        max_length=MAX_TEXT,
        description="Optional: your own example or mnemonic, shown as 'Agent "
        "explanation', never as the source.",
    )


class QuestionIn(_Args):
    type: Literal["choice", "multi", "short", "open"] = Field(
        description="choice: one right option; multi: several right options; short: a word or number; "
        "open: an answer in the user's own words (you will judge it later)."
    )
    question: str = Field(min_length=1, max_length=MAX_TEXT)
    answers: list[str] = Field(
        min_length=1,
        max_length=MAX_OPTIONS,
        description="choice/multi: the right options; short/open: one reference answer. "
        "Every right answer must be backed by the citations.",
    )
    wrong: list[str] = Field(
        default_factory=list,
        max_length=MAX_OPTIONS,
        description="choice/multi: wrong options you make up (shown as made up by you).",
    )
    accept: list[str] = Field(
        default_factory=list,
        max_length=8,
        description="short: other spellings of the same answer (e.g. '-70', '−70 mV').",
    )
    citations: list[CitationIn] = Field(min_length=1, max_length=4)
    explanation: str | None = Field(default=None, max_length=MAX_TEXT)


@dataclass(frozen=True)
class CheckedCard:
    question: str
    answer: str
    cites: tuple[Cite, ...]
    links: tuple[str, ...]
    explanation: str | None


@dataclass(frozen=True)
class CheckedQuestion:
    type: QuestionType
    question: str
    answers: tuple[str, ...]
    wrong: tuple[str, ...]
    accept: tuple[str, ...]
    cites: tuple[Cite, ...]
    links: tuple[str, ...]
    explanation: str | None


@dataclass(frozen=True)
class Dropped:
    index: int
    reason: str


class Refused(ValueError):
    """One card or question can't be shown; the reason goes to the agent."""


def _inert(text: str, label: str) -> str:
    cleaned = clean_text(text).replace("%%", "%").replace("[[", "[").replace("]]", "]")
    cleaned = " ".join(cleaned.split())
    if not cleaned:
        raise Refused(f"{label} is empty.")
    if detect_instruction(cleaned) is not None:
        raise Refused(f"{label} reads like instructions to an AI.")
    return cleaned


def clean_study_title(title: str) -> str:
    cleaned = clean_title(title)
    if detect_instruction(cleaned) is not None:
        raise Refused("The title reads like instructions to an AI.")
    return cleaned


def _cites(
    reader: MaterialReader, citations: Sequence[CitationIn]
) -> tuple[tuple[Cite, ...], tuple[str, ...]]:
    cites: list[Cite] = []
    links: list[str] = []
    for citation in citations:
        ref = f"{citation.material_id}:seg-{citation.seg}"
        source = reader.source(citation.material_id)
        if source is None or reader.fragment(citation.material_id, citation.seg) is None:
            raise Refused(f"{ref} is not a fragment SKAZ can cite (unknown or excluded).")
        checked = reader.checked_quote(citation.material_id, citation.seg, citation.quote)
        if checked is None:
            raise Refused(
                f"the quote for {ref} is not verbatim in that fragment (or is shorter than "
                f"{MIN_QUOTE_CHARS} characters)"
            )
        cite = Cite(citation.material_id, citation.seg, checked)
        if cite in cites:
            continue
        cites.append(cite)
        link = SourceRef(
            material_id=citation.material_id,
            folder_name=source.folder_name,
            title=source.title,
            file_stem=source.files.source_path.stem,
            start_ms={f.seg: f.start_ms for f in source.fragments},
            page={f.seg: f.page for f in source.fragments},
        ).link(citation.seg)
        if link not in links:
            links.append(link)
    return tuple(cites), tuple(links)


def check_card(reader: MaterialReader, card: CardIn) -> CheckedCard:
    question = _inert(card.question, "The question").replace(SEPARATOR, ":")
    answer = _inert(card.answer, "The answer").replace(SEPARATOR, ":")
    cites, links = _cites(reader, card.citations)
    explanation = (
        _inert(card.explanation, "The explanation") if card.explanation and card.explanation.strip() else None
    )
    return CheckedCard(question, answer, cites, links, explanation)


def check_question(reader: MaterialReader, item: QuestionIn) -> CheckedQuestion:
    question = _inert(item.question, "The question").replace(SEPARATOR, ":")
    answers = tuple(dict.fromkeys(_inert(a, "An answer").replace(SEPARATOR, ":") for a in item.answers))
    wrong = tuple(dict.fromkeys(_inert(w, "A wrong option") for w in item.wrong))
    if item.type in ("choice", "multi"):
        if not wrong:
            raise Refused("a choice question needs wrong options to choose from")
        if item.type == "choice" and len(answers) != 1:
            raise Refused("a choice question has exactly one right option (use multi for several)")
        if set(map(normalize_answer, answers)) & set(map(normalize_answer, wrong)):
            raise Refused("a wrong option is the same as a right one")
    else:
        answers = answers[:1]
        wrong = ()
    accept = (
        tuple(dict.fromkeys(_inert(a, "An accepted answer") for a in item.accept))
        if item.type == "short"
        else ()
    )
    cites, links = _cites(reader, item.citations)
    explanation = (
        _inert(item.explanation, "The explanation") if item.explanation and item.explanation.strip() else None
    )
    return CheckedQuestion(item.type, question, answers, wrong, accept, cites, links, explanation)


def check_all(items: Sequence[Any], check: Any) -> tuple[list[Any], list[Dropped]]:
    """Every item checked; refused ones are dropped with their 1-based number and reason."""
    kept: list[Any] = []
    dropped: list[Dropped] = []
    for number, item in enumerate(items, start=1):
        try:
            kept.append(check(item))
        except Refused as error:
            dropped.append(Dropped(number, str(error)))
    return kept, dropped


# -- short answers -----------------------------------------------------------------------------

_DASHES = dict.fromkeys(map(ord, "−‒–—‐‑"), "-")
_NUMBER = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


def normalize_answer(text: str) -> str:
    """Case, width, dashes, spaces and trailing punctuation don't matter (S4)."""
    folded = unicodedata.normalize("NFKC", text).translate(_DASHES).casefold()
    folded = re.sub(r"\s+", " ", folded).strip()
    return folded.strip(" .,;:!?\"'«»“”()[]")


def _numbers(text: str) -> list[float]:
    return [float(match.replace(",", ".")) for match in _NUMBER.findall(text)]


def short_matches(given: str, answers: Sequence[str]) -> bool:
    """The typed answer equals an accepted one; or, for a number, the same number (units may be left out)."""
    typed = normalize_answer(given)
    if not typed:
        return False
    for answer in answers:
        expected = normalize_answer(answer)
        if typed == expected:
            return True
        typed_numbers, expected_numbers = _numbers(typed), _numbers(expected)
        if len(typed_numbers) == 1 and typed_numbers == expected_numbers:
            words = set(_NUMBER.sub(" ", typed).split())
            if words <= set(_NUMBER.sub(" ", expected).split()):
                return True
    return False
