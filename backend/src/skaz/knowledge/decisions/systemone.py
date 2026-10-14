"""TypeSafe System One wire format and the OpenRouter + Jev decider.

Request (docs.typesafe.ai «Choice», «Noul», «Score»; OpenRouter «Jev SDK»)::

    POST https://openrouter.ai/api/v1/systemone
    {"model": "...", "state": "...", "questions": {"<id>": {"type": "choice"|"noul"|"score",
      "instructions": "...", "criteria": {...} | [...]}}}

Response: ``{"model": ..., "answers": {"<id>": {"type": "choice", "choice", "probabilities",
"confidence"} | {"type": "noul", "noul"} | {"type": "score", "score", "probabilities",
"confidence", "legend"}}, "usage": {...}}``. The same shape is served by
``llama-server`` ``/v1/systemone`` for decision models (used by ``local.py``).

One request carries one ``state``: questions of a batch are grouped by state.
Every failure becomes ``Undecided`` with a plain reason — no retries, no
fallback to another decider (spec B8). The cloud path is never called without
the user's consent to send wiki text to OpenRouter.
"""
from __future__ import annotations

import math
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from .policy import Thresholds, apply_thresholds
from .protocol import (
    Answer,
    ChoiceAnswer,
    ChoiceQuestion,
    DeciderId,
    Question,
    ScoreAnswer,
    ScoreQuestion,
    Undecided,
    YesNoAnswer,
    YesNoQuestion,
)

OPENROUTER_SYSTEMONE_URL = "https://openrouter.ai/api/v1/systemone"
#: Pinned, not ``jev-latest``: a new release must not silently change decisions.
JEV_MODEL = "typesafe/jev-1.13"
OPENROUTER_SECRET = "openrouter"
DEFAULT_TIMEOUT_S = 20.0

UNREADABLE = "The decision service sent an answer SKAZ could not read."


class WireError(ValueError):
    """A System One response that does not match the questions asked."""


@dataclass(frozen=True)
class WireRequest:
    body: dict[str, Any]
    #: Question id → the protocol question, in request order.
    questions: Mapping[str, Question]
    #: For choice questions: criteria key → option text.
    option_keys: Mapping[str, Mapping[str, str]]


def _option_key(index: int) -> str:
    return f"option_{index + 1}"


def _level_legend(scale: tuple[int, int]) -> list[str]:
    low, high = scale
    return [f"{value} on a scale from {low} (lowest) to {high} (highest)" for value in range(low, high + 1)]


def build_request(questions: Sequence[Question], *, model: str | None) -> WireRequest:
    """One System One request for questions that share the same ``state``."""
    if not questions:
        raise ValueError("At least one question is required.")
    state = questions[0].state
    if any(question.state != state for question in questions):
        raise ValueError("Questions of one System One request must share the state.")
    wire: dict[str, Any] = {}
    asked: dict[str, Question] = {}
    keys: dict[str, dict[str, str]] = {}
    for index, question in enumerate(questions):
        qid = f"q{index + 1}"
        asked[qid] = question
        if isinstance(question, ChoiceQuestion):
            options = {_option_key(i): option for i, option in enumerate(question.options)}
            if len(options) < 2:
                raise ValueError("A choice needs at least two options.")
            keys[qid] = options
            wire[qid] = {"type": "choice", "instructions": question.question, "criteria": options}
        elif isinstance(question, YesNoQuestion):
            wire[qid] = {"type": "noul", "instructions": question.question}
        else:
            low, high = question.scale
            if high - low < 1 or high - low > 9:
                raise ValueError("A score needs between 2 and 10 levels.")
            wire[qid] = {"type": "score", "instructions": question.question,
                         "criteria": _level_legend(question.scale)}
    body: dict[str, Any] = {"state": state, "questions": wire}
    if model is not None:
        body["model"] = model
    return WireRequest(body, asked, keys)


def _probability(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise WireError("probability is not a number")
    if value < -1e-6 or value > 1 + 1e-6:
        raise WireError("probability out of range")
    return min(1.0, max(0.0, float(value)))


def _parse_one(question: Question, raw: Any, option_keys: Mapping[str, str]) -> Answer:
    if not isinstance(raw, dict):
        raise WireError("answer is not an object")
    kind = raw.get("type")
    if isinstance(question, ChoiceQuestion):
        if kind != "choice":
            raise WireError("wrong answer type")
        probabilities_raw = raw.get("probabilities")
        if not isinstance(probabilities_raw, dict) or set(probabilities_raw) - set(option_keys):
            raise WireError("unknown option in probabilities")
        probabilities = {option_keys[key]: _probability(value) for key, value in probabilities_raw.items()}
        for option in option_keys.values():
            probabilities.setdefault(option, 0.0)
        choice = raw.get("choice")
        if not isinstance(choice, str) or choice not in option_keys:
            raise WireError("unknown choice")
        return ChoiceAnswer(option=option_keys[choice], probabilities=probabilities,
                            confidence=_probability(raw.get("confidence", max(probabilities.values()))))
    if isinstance(question, YesNoQuestion):
        if kind != "noul":
            raise WireError("wrong answer type")
        return YesNoAnswer(p_yes=_probability(raw.get("noul")))
    if kind != "score":
        raise WireError("wrong answer type")
    low, high = question.scale
    probabilities_raw = raw.get("probabilities")
    if not isinstance(probabilities_raw, dict):
        raise WireError("score without probabilities")
    distribution: dict[int, float] = {}
    for key, value in probabilities_raw.items():
        try:
            level = int(key)
        except (TypeError, ValueError) as error:
            raise WireError("score level is not a number") from error
        if not 0 <= level <= high - low:
            raise WireError("score level out of range")
        distribution[low + level] = _probability(value)
    score = raw.get("score")
    if isinstance(score, bool) or not isinstance(score, int | float) or not math.isfinite(score):
        raise WireError("score is not a number")
    return ScoreAnswer(value=low + float(score), distribution=distribution)


def parse_response(request: WireRequest, body: Any) -> list[Answer]:
    """Answers in request order; an answer that doesn't fit its question becomes ``Undecided``."""
    answers = body.get("answers") if isinstance(body, dict) else None
    if not isinstance(answers, dict):
        return [Undecided(UNREADABLE) for _ in request.questions]
    parsed: list[Answer] = []
    for qid, question in request.questions.items():
        try:
            parsed.append(_parse_one(question, answers.get(qid), request.option_keys.get(qid, {})))
        except WireError:
            parsed.append(Undecided(UNREADABLE))
    return parsed


def group_by_state(questions: Sequence[Question]) -> list[list[int]]:
    """Indices of ``questions`` grouped by identical ``state``, first-seen order."""
    groups: dict[str, list[int]] = {}
    for index, question in enumerate(questions):
        groups.setdefault(question.state, []).append(index)
    return list(groups.values())


def _http_reason(status: int) -> str:
    if status in (401, 403):
        return "OpenRouter rejected the API key. Check the key in Settings."
    if status == 402:
        return "OpenRouter declined the request for this account (payment required)."
    if status == 429:
        return "OpenRouter's rate limit was reached. Try again later."
    if status >= 500:
        return f"OpenRouter or Jev is unavailable right now (HTTP {status})."
    return f"OpenRouter rejected the decision request (HTTP {status})."


DecisionObserver = Callable[[DeciderId, str, Answer, int], None]


class OpenRouterJevDecider:
    """``DecisionLayer`` over OpenRouter's System One API with the pinned Jev model."""

    def __init__(
        self,
        http: httpx.AsyncClient,
        *,
        api_key: Callable[[], str | None],
        consent: Callable[[], bool],
        thresholds: Thresholds,
        url: str = OPENROUTER_SYSTEMONE_URL,
        model: str = JEV_MODEL,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        observer: DecisionObserver | None = None,
    ) -> None:
        self._http = http
        self._api_key = api_key
        self._consent = consent
        self.thresholds = thresholds
        self.url = url
        self.model = model
        self.timeout_s = timeout_s
        self._observer = observer

    @property
    def id(self) -> DeciderId:
        return "openrouter_jev"

    async def ask(self, question: Question) -> Answer:
        return (await self.ask_many([question]))[0]

    async def ask_many(self, questions: Sequence[Question]) -> Sequence[Answer]:
        answers: list[Answer] = [Undecided("Not asked.")] * len(questions)
        for group in group_by_state(questions):
            started = time.monotonic()
            batch = await self._ask_group([questions[i] for i in group])
            elapsed = int((time.monotonic() - started) * 1000)
            for index, answer in zip(group, batch, strict=True):
                answers[index] = answer
                if self._observer is not None:
                    self._observer(self.id, _primitive(questions[index]), answer, elapsed)
        return answers

    async def _ask_group(self, questions: list[Question]) -> list[Answer]:
        if not self._consent():
            return [Undecided("Cloud decisions are off: allow sending wiki text to OpenRouter first.")
                    for _ in questions]
        key = self._api_key()
        if not key:
            return [Undecided("Add an OpenRouter API key to use cloud decisions.") for _ in questions]
        try:
            request = build_request(questions, model=self.model)
        except ValueError as error:
            return [Undecided(str(error)) for _ in questions]
        try:
            response = await self._http.post(
                self.url, json=request.body, timeout=self.timeout_s,
                headers={"Authorization": f"Bearer {key}", "X-Title": "SKAZ"},
            )
        except httpx.TimeoutException:
            return [Undecided("OpenRouter did not answer in time.") for _ in questions]
        except httpx.HTTPError:
            return [Undecided("SKAZ couldn't reach OpenRouter. Check the internet connection.")
                    for _ in questions]
        if response.status_code != 200:
            reason = _http_reason(response.status_code)
            return [Undecided(reason) for _ in questions]
        try:
            body = response.json()
        except ValueError:
            return [Undecided(UNREADABLE) for _ in questions]
        return [apply_thresholds(question, answer, self.thresholds)
                for question, answer in zip(questions, parse_response(request, body), strict=True)]


def _primitive(question: Question) -> str:
    if isinstance(question, ChoiceQuestion):
        return "choice"
    if isinstance(question, YesNoQuestion):
        return "noul"
    assert isinstance(question, ScoreQuestion)
    return "score"
