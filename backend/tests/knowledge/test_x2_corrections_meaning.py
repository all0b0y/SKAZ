"""Final review M2: a recognition fix that can flip the meaning is never applied automatically.

Negations and meaning-changing particles added, removed or replaced, and numbers (digits or words),
stay "doubtful" whatever the decision layer says. Reviewer's examples first. ``FakeDecisions`` says
"yes, 0.99" to everything here: this proves the screen, not a model's judgement.
"""

from __future__ import annotations

import pytest

from skaz.knowledge.corrections.check import _Proposal, flips_meaning, screen
from skaz.knowledge.decisions.protocol import Answer, Question, YesNoAnswer
from skaz.knowledge.markdown.source import Fragment, FragmentInput
from skaz.knowledge.service import KnowledgeService

from .ingest_support import ScriptedWiki, add_material, block, cite, notes
from .wiki_support import RECOGNITION, correction, corrections, ingest_done, settle_wiki, wired

REVIEW_TEXT = "Энтропия закрытой системы не убывает, это не верно только для открытых систем."


@pytest.mark.parametrize(
    ("before", "after"),
    [
        ("не убывает", "убывает"),  # the reviewer's probe (rv/scr.py)
        ("закрытой системы не", "закрытой системы"),
        ("не верно", "верно"),
        ("только", "тоже"),
    ],
)
def test_the_reviewers_meaning_flips_are_forced_doubtful(before: str, after: str) -> None:
    fragments = {1: Fragment(1, REVIEW_TEXT)}
    plain = REVIEW_TEXT.replace(",", " ").replace(".", " ")
    transcript = {word.casefold() for word in plain.split()} | {"тоже"}
    result = screen(_Proposal(seg=1, before=before, after=after), fragments, transcript, None)
    assert not isinstance(result, str), result
    assert result.force_doubtful, (before, after)


@pytest.mark.parametrize(
    ("before", "after", "flips"),
    [
        ("неверно", "верно", True),
        ("never stops", "ever stops", True),
        ("is not", "is", True),
        ("isn't stable", "is stable", True),
        ("unable", "able", True),
        ("no energy", "the energy", True),
        ("лишь раз", "раз", True),
        ("ни разу", "разу", True),
        ("пятнадцать метров", "пятьдесят метров", True),
        ("fifteen", "fifty", True),
        ("15", "50", True),
        ("энтропея", "энтропия", False),
        ("the sis", "thesis", False),
        ("в следствии", "вследствие", False),
        ("кинетическую", "кинетичную", False),
        ("Больцмона", "Больцмана", False),
    ],
)
def test_flips_meaning(before: str, after: str, flips: bool) -> None:
    assert flips_meaning(before, after) is flips


SPEECH = [
    FragmentInput(text="Энтропия закрытой системы не убывает со временем.", start_ms=0, end_ms=5_000,
                  speaker="1"),
    FragmentInput(text="Энтропея растёт при нагреве.", start_ms=5_000, end_ms=9_000, speaker="1"),
]


def always_yes(_question: Question) -> Answer:
    return YesNoAnswer(0.99)


async def test_a_confident_layer_still_cannot_apply_a_removed_negation(ready: KnowledgeService) -> None:
    material_id = add_material(ready, "Физика", "Лекция 9", SPEECH)
    check = corrections(
        correction(1, "не убывает", "убывает", "misheard particle"),
        correction(2, "Энтропея", "Энтропия"),
    )
    plain = notes(("Энтропия", [block("from_source", "Растёт при нагреве.", cite(2, "растёт при нагреве"))]))
    wiki = ScriptedWiki(notes=[plain], answers={RECOGNITION: [check]})
    ingest, service = wired(ready, wiki, always_yes)
    await ingest_done(ingest, material_id)
    await settle_wiki(service, ingest)
    states = {entry.before: (entry.state, entry.auto)
              for entry in service.store.read_or_empty(material_id).corrections}
    assert states == {"не убывает": ("doubtful", False), "Энтропея": ("applied", True)}
