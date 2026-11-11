"""One claim comparison of "Check older materials" (N3 decision 3g): only the decision model is asked.

Cost path, traced before building (see the B7 report): N2 found repeats while the *writing agent* compared
the new statements of a concept page with the page's other statements, and the decision layer confirmed each
pair. A material added before N2 has no such marks, and re-running the writing agent would be a chat-model
call per page — more than the decision model, which decision 3g forbids without asking. Instead:

* the candidates are code, not a model: the other sources' statements on the SAME concept page (N2 already
  puts one concept in one page, across languages), at most ``MAX_OPTIONS``, the ones sharing most words first;
* one **claim comparison** = one statement of the material put to the decision layer: a choice of the page
  statement that only repeats it ("None of these" included), and — only when one was picked — the same
  confirming yes/no N2 asks (``wiki.repeats.QUESTION``, threshold ``CONFIDENT``). At most two cheap calls;
* nothing about the wiki changes: the verdict is stored as evidence (ids only), a paragraph is never merged
  or removed here.

An unsure or failed answer is a verdict of "unsure", never a repeat: only a confident yes counts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..agents.prompting import untrusted_block
from ..decisions.policy import LOW_CONFIDENCE
from ..decisions.protocol import (
    Answer,
    ChoiceAnswer,
    ChoiceQuestion,
    DecisionLayer,
    Undecided,
    YesNoAnswer,
    YesNoQuestion,
)
from ..wiki.context import CONFIDENT
from ..wiki.repeats import QUESTION as CONFIRM_QUESTION
from ..wiki.statements import Statement
from .reader import text_hash
from .store import Judged, StatementRef

MAX_OPTIONS = 8
MAX_OPTION_CHARS = 320
NONE_OPTION = "None of these"
PICK_QUESTION = (
    "Which one of the numbered statements only repeats statement B — the same claim, perhaps in other words "
    "or another language — without adding a detail, number, condition or example that B lacks?"
)
_WORD = re.compile(r"\w+", re.UNICODE)
#: An ``Undecided`` that says the layer answered but was not sure — a verdict of "unsure", not an outage.
NOT_CONFIDENT = LOW_CONFIDENCE.split(" (")[0]


@dataclass(frozen=True)
class Unanswered:
    """The decision layer gave no answer at all (down, failing, below its own threshold)."""

    reason: str


Outcome = Judged | Unanswered


def _words(text: str) -> frozenset[str]:
    return frozenset(word for word in _WORD.findall(text.casefold()) if len(word) > 2)


def shortlist(statement: Statement, others: list[Statement]) -> list[Statement]:
    """Up to ``MAX_OPTIONS`` statements of other sources: the ones sharing most words, in page order."""
    mine = _words(statement.text)
    ranked = sorted(range(len(others)), key=lambda index: (-len(mine & _words(others[index].text)), index))
    return [others[index] for index in sorted(ranked[:MAX_OPTIONS])]


def _unsure(own: Judged) -> Judged:
    return Judged(own.page_id, own.block_id, own.text_hash, "unsure")


async def _ask(layer: DecisionLayer, question: ChoiceQuestion | YesNoQuestion) -> Answer:
    try:
        return await layer.ask(question)
    except Exception:  # an adapter failure is "undecided", never a guess; its text may carry material
        return Undecided("the decision layer failed")


async def compare(layer: DecisionLayer, statement: Statement, others: list[Statement]) -> Outcome:
    """The verdict for one statement of the material against the other sources' statements on its page."""
    options = shortlist(statement, others)
    own = Judged(statement.page_id, statement.block_id, text_hash(statement.text), "new")
    if not options:
        return own
    state = untrusted_block("statement B", statement.line("B"))
    numbered = [f"{number}. {item.text[:MAX_OPTION_CHARS]}" for number, item in enumerate(options, start=1)]
    picked = await _ask(layer, ChoiceQuestion(state=state, question=PICK_QUESTION,
                                              options=[*numbered, NONE_OPTION]))
    if isinstance(picked, Undecided):
        return _unsure(own) if picked.reason.startswith(NOT_CONFIDENT) else Unanswered(picked.reason)
    if not isinstance(picked, ChoiceAnswer) or picked.option not in numbered:
        return own if isinstance(picked, ChoiceAnswer) and picked.option == NONE_OPTION else Unanswered(
            "the decision layer gave no usable answer")
    match = options[numbered.index(picked.option)]
    confirmed = await _ask(layer, YesNoQuestion(
        state="\n".join([untrusted_block("statement A", match.line("A")), state]), question=CONFIRM_QUESTION))
    if isinstance(confirmed, Undecided):
        return _unsure(own) if confirmed.reason.startswith(NOT_CONFIDENT) else Unanswered(confirmed.reason)
    if not isinstance(confirmed, YesNoAnswer):
        return Unanswered("the decision layer gave no usable answer")
    if confirmed.p_yes >= CONFIDENT:
        found = StatementRef(match.page_id, match.block_id, text_hash(match.text))
        return Judged(own.page_id, own.block_id, own.text_hash, "repeat", found)
    if confirmed.p_yes <= 1 - CONFIDENT:
        return own
    return _unsure(own)
