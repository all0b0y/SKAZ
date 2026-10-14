"""The wiki decision layer contract (spec B8, research «Decision-модели / System One»).

Cheap typed decisions — where a concept goes, whether two pages merge, whether
to link, what to read — are asked here; writing text stays with the agent.
Implementations: TypeSafe System One over OpenRouter (Jev) or a local
``llama-server`` (area D1). Callers (ingest W1, links W2) depend only on this
protocol.

``Undecided`` is an explicit answer, never an exception swallowed into a guess:
the caller then asks the writing agent and records that in the activity log.
No silent substitution of one decider for another.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

DeciderId = Literal["openrouter_jev", "local"]


@dataclass(frozen=True)
class ChoiceQuestion:
    """Pick one of ``options`` given ``state`` (untrusted text, already wrapped)."""

    state: str
    question: str
    options: Sequence[str]


@dataclass(frozen=True)
class YesNoQuestion:
    """System One ``noul``: the probability that the answer is yes."""

    state: str
    question: str


@dataclass(frozen=True)
class ScoreQuestion:
    """System One ``score``: a value on ``scale`` (inclusive integer bounds)."""

    state: str
    question: str
    scale: tuple[int, int]


Question = ChoiceQuestion | YesNoQuestion | ScoreQuestion


@dataclass(frozen=True)
class ChoiceAnswer:
    option: str
    probabilities: Mapping[str, float]
    confidence: float


@dataclass(frozen=True)
class YesNoAnswer:
    p_yes: float


@dataclass(frozen=True)
class ScoreAnswer:
    value: float
    distribution: Mapping[int, float] = field(default_factory=dict)


@dataclass(frozen=True)
class Undecided:
    """Below the calibrated threshold, unavailable, or failed — with a plain reason."""

    reason: str


Answer = ChoiceAnswer | YesNoAnswer | ScoreAnswer | Undecided


class DecisionLayer(Protocol):
    @property
    def id(self) -> DeciderId: ...

    async def ask(self, question: Question) -> Answer: ...

    async def ask_many(self, questions: Sequence[Question]) -> Sequence[Answer]: ...
