"""Deck and test pages in the wiki (decisions S2, S3, S6; Q7).

``Wiki/Decks/<Title>.md`` (kind ``deck``) and ``Wiki/Tests/<Title>.md`` (kind ``test``) are ordinary
SKAZ pages: frontmatter plus marked blocks, readable and editable in Obsidian, part of Export.

* A card is a ``from_source`` block ``Question::Answer [[link]] ^c-…`` whose citations were checked
  mechanically (the quote is verbatim in the fragment, layer 4).
* The agent's explanation of a card is an ``explanation`` block right after it, marked
  ``for=c-<card>``; its text starts with "Agent explanation:" (in the wiki language).
* A test question is a ``from_source`` block marked ``q=choice|multi|short|open``. Choice and multi:
  the question, then ``- [x] <right answer>`` lines (each cited); short and open: ``Question::reference
  answer``. A short answer's accepted spellings ride in ``accept=`` (base64url JSON). The agent's
  made-up wrong options are an ``explanation`` block ``for=c-<q> role=wrong`` starting with
  "Made up by the agent:" and listing ``- [ ] <option>``.

FSRS progress and test attempts are service data in the database, never in the file (S2, S6).
"""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Literal

from ..markdown.page import Block, Cite, Heading, PageDocument, Part

QuestionType = Literal["choice", "multi", "short", "open"]
QUESTION_TYPES: tuple[QuestionType, ...] = ("choice", "multi", "short", "open")
SEPARATOR = "::"

LABELS: dict[str, dict[str, str]] = {
    "en": {
        "cards": "Cards",
        "questions": "Questions",
        "explanation": "Agent explanation",
        "wrong": "Made up by the agent",
    },
    "ru": {
        "cards": "Карточки",
        "questions": "Вопросы",
        "explanation": "Пояснение агента",
        "wrong": "Придумано агентом",
    },
}
_PREFIX = {key: tuple(labels[key] for labels in LABELS.values()) for key in ("explanation", "wrong")}
_LINK = re.compile(r"\s*\[\[[^\]\n]+\]\]")
_RIGHT = re.compile(r"^- \[[xX]\] (.+)$")
_WRONG = re.compile(r"^- \[ \] (.+)$")


def label(key: str, language: str) -> str:
    return LABELS.get(language, LABELS["en"])[key]


def _strip_links(text: str) -> str:
    return _LINK.sub("", text).strip()


def _unprefix(text: str, key: str) -> str:
    stripped = text.strip()
    for prefix in _PREFIX[key]:
        if stripped.lower().startswith(prefix.lower() + ":"):
            return stripped[len(prefix) + 1 :].strip()
    return stripped


def encode_list(values: Sequence[str]) -> str:
    raw = json.dumps(list(values), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_list(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode("utf-8")
        items = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return ()
    return tuple(str(item) for item in items if isinstance(item, str)) if isinstance(items, list) else ()


# -- reading ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Card:
    id: str
    question: str
    answer: str
    cites: tuple[Cite, ...]
    explanation: str | None = None
    #: The block was changed outside SKAZ (Obsidian): it stays, shown as the user's text.
    edited: bool = False


@dataclass(frozen=True)
class Question:
    id: str
    type: QuestionType
    question: str
    #: Right answers from the source (choice/multi), or the reference answer (short/open).
    answers: tuple[str, ...]
    cites: tuple[Cite, ...]
    wrong: tuple[str, ...] = ()
    accept: tuple[str, ...] = ()
    explanation: str | None = None


def _explanations(blocks: Sequence[Block]) -> dict[tuple[str, str], str]:
    out: dict[tuple[str, str], str] = {}
    for block in blocks:
        target = block.attr("for")
        if block.kind == "explanation" and target:
            role = block.attr("role") or "explanation"
            out[(target, role)] = block.body
    return out


def split_card(body: str) -> tuple[str, str] | None:
    text = _strip_links(body)
    question, sep, answer = text.partition(SEPARATOR)
    if not sep or not question.strip() or not answer.strip():
        return None
    return question.strip(), answer.strip()


def read_cards(document: PageDocument) -> list[Card]:
    blocks = document.blocks()
    notes = _explanations(blocks)
    cards: list[Card] = []
    for block in blocks:
        if block.kind != "from_source" or block.attr("for"):
            continue
        parts = split_card(block.body)
        if parts is None:
            continue
        explanation = notes.get((block.id, "explanation"))
        cards.append(
            Card(
                block.id,
                parts[0],
                parts[1],
                block.cites,
                _unprefix(explanation, "explanation") if explanation else None,
                edited=block.owner != "agent",
            )
        )
    return cards


def read_questions(document: PageDocument) -> list[Question]:
    blocks = document.blocks()
    notes = _explanations(blocks)
    out: list[Question] = []
    for block in blocks:
        kind = block.attr("q")
        if block.kind != "from_source" or kind not in QUESTION_TYPES:
            continue
        qtype: QuestionType = kind
        if qtype in ("choice", "multi"):
            lines = _strip_links(block.body).splitlines()
            right = [m.group(1).strip() for line in lines if (m := _RIGHT.match(_strip_links(line)))]
            text = " ".join(line.strip() for line in lines if not _RIGHT.match(_strip_links(line))).strip()
            if not text or not right:
                continue
            answers = tuple(right)
        else:
            parts = split_card(block.body)
            if parts is None:
                continue
            text, answers = parts[0], (parts[1],)
        wrong_body = notes.get((block.id, "wrong"))
        wrong = tuple(
            m.group(1).strip()
            for line in (_unprefix(wrong_body, "wrong").splitlines() if wrong_body else [])
            if (m := _WRONG.match(line.strip()))
        )
        explanation = notes.get((block.id, "explanation"))
        out.append(
            Question(
                block.id,
                qtype,
                text,
                answers,
                block.cites,
                wrong,
                decode_list(block.attr("accept")),
                _unprefix(explanation, "explanation") if explanation else None,
            )
        )
    return out


# -- writing -----------------------------------------------------------------------------------


@dataclass
class DraftCard:
    question: str
    answer: str
    cites: tuple[Cite, ...]
    #: Human-readable links to the cited fragments (``[[…|Title · 08:12]]``), one per cite.
    links: tuple[str, ...] = ()
    explanation: str | None = None


@dataclass
class DraftQuestion:
    type: QuestionType
    question: str
    answers: tuple[str, ...]
    cites: tuple[Cite, ...]
    links: tuple[str, ...] = ()
    wrong: tuple[str, ...] = ()
    accept: tuple[str, ...] = ()
    explanation: str | None = None
    extra: dict[str, str] = field(default_factory=dict)


def card_body(draft: DraftCard) -> str:
    return " ".join([f"{draft.question}{SEPARATOR}{draft.answer}", *draft.links])


def question_body(draft: DraftQuestion) -> str:
    if draft.type in ("choice", "multi"):
        lines = [draft.question, *[f"- [x] {answer}" for answer in draft.answers]]
        if draft.links:
            lines[-1] = " ".join([lines[-1], *draft.links])
        return "\n".join(lines)
    return " ".join([f"{draft.question}{SEPARATOR}{draft.answers[0]}", *draft.links])


def deck_parts(
    cards: Sequence[tuple[str, DraftCard]], language: str, new_id: Callable[[str], str]
) -> list[Part]:
    """``(block id, card)`` pairs → the page body: one heading, each card with its explanation after it."""
    parts: list[Part] = [Heading(2, label("cards", language))]
    for block_id, draft in cards:
        parts.append(Block.create(block_id, "from_source", card_body(draft), cites=draft.cites))
        if draft.explanation:
            parts.append(
                Block.create(
                    new_id("c"),
                    "explanation",
                    f"{label('explanation', language)}: {draft.explanation}",
                    attrs=(("for", block_id),),
                )
            )
    return parts


def test_parts(
    questions: Sequence[tuple[str, DraftQuestion]], language: str, new_id: Callable[[str], str]
) -> list[Part]:
    parts: list[Part] = [Heading(2, label("questions", language))]
    for block_id, draft in questions:
        attrs: list[tuple[str, str]] = [("q", draft.type)]
        if draft.accept:
            attrs.append(("accept", encode_list(draft.accept)))
        parts.append(
            Block.create(block_id, "from_source", question_body(draft), cites=draft.cites, attrs=tuple(attrs))
        )
        if draft.wrong:
            body = "\n".join([f"{label('wrong', language)}:", *[f"- [ ] {option}" for option in draft.wrong]])
            parts.append(
                Block.create(new_id("c"), "explanation", body, attrs=(("for", block_id), ("role", "wrong")))
            )
        if draft.explanation:
            parts.append(
                Block.create(
                    new_id("c"),
                    "explanation",
                    f"{label('explanation', language)}: {draft.explanation}",
                    attrs=(("for", block_id),),
                )
            )
    return parts
