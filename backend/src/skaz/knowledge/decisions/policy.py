"""Confidence thresholds: below them a decider answers ``Undecided`` and the writing agent decides.

The probability of the chosen answer is compared, not TypeSafe's ``confidence``
(which rescales by the number of options): the benchmark measured accuracy and
coverage against this value. Thresholds are per primitive because yes/no and
multi-option questions are calibrated differently.
"""
from __future__ import annotations

from dataclasses import dataclass

from .labels import score_confidence
from .protocol import Answer, ChoiceAnswer, Question, ScoreAnswer, Undecided, YesNoAnswer

LOW_CONFIDENCE = "Not confident enough ({value:.0%} < {threshold:.0%}); the writing model decides."


@dataclass(frozen=True)
class Thresholds:
    #: Minimum probability of the chosen option.
    choice: float
    #: Minimum of ``max(p_yes, 1 - p_yes)``.
    noul: float
    #: Minimum TypeSafe score confidence (spread around the peak level).
    score: float


def top_probability(answer: Answer) -> float | None:
    """The value compared against the threshold; ``None`` for ``Undecided``."""
    if isinstance(answer, ChoiceAnswer):
        return answer.probabilities.get(answer.option, 0.0)
    if isinstance(answer, YesNoAnswer):
        return max(answer.p_yes, 1 - answer.p_yes)
    if isinstance(answer, ScoreAnswer):
        levels = sorted(answer.distribution)
        return score_confidence([answer.distribution[level] for level in levels]) if levels else 0.0
    return None


def threshold_for(answer: Answer, thresholds: Thresholds) -> float:
    if isinstance(answer, ChoiceAnswer):
        return thresholds.choice
    if isinstance(answer, YesNoAnswer):
        return thresholds.noul
    return thresholds.score


def apply_thresholds(question: Question, answer: Answer, thresholds: Thresholds) -> Answer:
    del question  # thresholds depend on the primitive only, which the answer carries
    value = top_probability(answer)
    if value is None:
        return answer
    threshold = threshold_for(answer, thresholds)
    if value + 1e-12 < threshold:
        return Undecided(LOW_CONFIDENCE.format(value=value, threshold=threshold))
    return answer
