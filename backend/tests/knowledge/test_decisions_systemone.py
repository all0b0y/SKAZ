"""System One wire format (TypeSafe docs examples) and the OpenRouter + Jev decider on ``MockTransport``.

The transport is fake: these tests prove request/response handling and the
consent/error rules, not Jev's decision quality.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.decisions.policy import Thresholds
from skaz.knowledge.decisions.protocol import (
    Answer,
    ChoiceAnswer,
    ChoiceQuestion,
    Question,
    ScoreAnswer,
    ScoreQuestion,
    Undecided,
    YesNoAnswer,
    YesNoQuestion,
)
from skaz.knowledge.decisions.systemone import (
    JEV_MODEL,
    OPENROUTER_SYSTEMONE_URL,
    UNREADABLE,
    OpenRouterJevDecider,
    WireRequest,
    build_request,
    group_by_state,
    parse_response,
)

EXAMPLES = json.loads((Path(__file__).parent / "fixtures" / "decisions" / "systemone_examples.json")
                      .read_text(encoding="utf-8"))
LOW = Thresholds(choice=0.0, noul=0.0, score=0.0)
STATE = "<untrusted-data>A new concept: Ohm's law.</untrusted-data>"
CHOICE = ChoiceQuestion(STATE, "Which page?", ("Ohm's law", "Photosynthesis", "New page"))
NOUL = YesNoQuestion(STATE, "Is it physics?")
SCORE = ScoreQuestion(STATE, "How central is it?", (1, 3))


def test_build_request_follows_the_documented_shape() -> None:
    request = build_request([CHOICE, NOUL, SCORE], model=JEV_MODEL)
    assert request.body == {
        "model": JEV_MODEL,
        "state": STATE,
        "questions": {
            "q1": {"type": "choice", "instructions": "Which page?",
                   "criteria": {"option_1": "Ohm's law", "option_2": "Photosynthesis",
                                "option_3": "New page"}},
            "q2": {"type": "noul", "instructions": "Is it physics?"},
            "q3": {"type": "score", "instructions": "How central is it?", "criteria": [
                "1 on a scale from 1 (lowest) to 3 (highest)", "2 on a scale from 1 (lowest) to 3 (highest)",
                "3 on a scale from 1 (lowest) to 3 (highest)"]},
        },
    }
    # Same field set as the documented request (criteria map for choice, ordered list for score).
    assert set(request.body["questions"]["q1"]) == set(EXAMPLES["choice"]["request_question"])
    assert set(request.body["questions"]["q3"]) == set(EXAMPLES["score"]["request_question"])
    with pytest.raises(ValueError, match="share the state"):
        build_request([CHOICE, YesNoQuestion("other", "?")], model=None)
    assert "model" not in build_request([NOUL], model=None).body


def test_parse_documented_responses() -> None:
    choice_q = ChoiceQuestion("s", "Which team should handle this?", ("returns", "shipping", "billing"))
    request = WireRequest({}, {"department": choice_q},
                          {"department": {key: key for key in ("returns", "shipping", "billing")}})
    [choice] = parse_response(request, EXAMPLES["choice"]["response"])
    assert choice == ChoiceAnswer("returns", {"shipping": 0.0, "returns": 1.0, "billing": 0.0}, 1.0)

    noul_request = WireRequest({}, {"is_human_escalation": YesNoQuestion("s", "?"),
                                    "is_repeat_contact": YesNoQuestion("s", "?")}, {})
    noul_answers = parse_response(noul_request, EXAMPLES["noul"]["response"])
    assert noul_answers == [YesNoAnswer(0.99), YesNoAnswer(0.93)]

    score_request = WireRequest({}, {"bug_severity": ScoreQuestion("s", "?", (0, 2))}, {})
    [score] = parse_response(score_request, EXAMPLES["score"]["response"])
    assert isinstance(score, ScoreAnswer)
    assert score.value == pytest.approx(1.43)
    assert score.distribution == {0: 0.0, 1: 0.57, 2: 0.43}

    # OpenRouter adds id/provider/usage.cost; they are ignored.
    refund = WireRequest({}, {"refund": YesNoQuestion("s", "?")}, {})
    assert parse_response(refund, EXAMPLES["openrouter"]["response"]) == [YesNoAnswer(0.98)]


@pytest.mark.parametrize("answer", [
    None, "x", {"type": "noul"}, {"type": "choice", "choice": "option_1", "probabilities": {"option_9": 1}},
    {"type": "choice", "choice": "option_9", "probabilities": {"option_1": 1}},
    {"type": "noul", "noul": 1.7}, {"type": "noul", "noul": True},
])
def test_unreadable_answers_become_undecided(answer: Any) -> None:
    request = build_request([CHOICE if isinstance(answer, dict) and answer.get("type") == "choice" else NOUL],
                            model=None)
    assert parse_response(request, {"answers": {"q1": answer}}) == [Undecided(UNREADABLE)]
    assert parse_response(request, ["not", "an", "object"]) == [Undecided(UNREADABLE)]


def test_group_by_state_keeps_first_seen_order() -> None:
    questions: list[Question] = [NOUL, YesNoQuestion("b", "?"), CHOICE, YesNoQuestion("b", "!")]
    assert group_by_state(questions) == [[0, 2], [1, 3]]


class Recorder:
    def __init__(self, handler: Any) -> None:
        self.requests: list[httpx.Request] = []
        self.handler = handler

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        result = self.handler(request)
        assert isinstance(result, httpx.Response)
        return result


def decider(handler: Any, *, key: str | None = "sk-or-test", consent: bool = True,
            thresholds: Thresholds = LOW) -> tuple[OpenRouterJevDecider, Recorder, list[tuple[str, Answer]]]:
    recorder = Recorder(handler)
    events: list[tuple[str, Answer]] = []
    client = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    layer = OpenRouterJevDecider(
        client, api_key=lambda: key, consent=lambda: consent, thresholds=thresholds,
        observer=lambda decider, primitive, answer, ms: events.append((primitive, answer)))
    return layer, recorder, events


def ok_body(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    answers: dict[str, Any] = {}
    for qid, question in body["questions"].items():
        if question["type"] == "choice":
            answers[qid] = {"type": "choice", "choice": "option_1", "confidence": 0.9,
                            "probabilities": {"option_1": 0.93, "option_2": 0.05, "option_3": 0.02}}
        elif question["type"] == "noul":
            answers[qid] = {"type": "noul", "noul": 0.12}
        else:
            answers[qid] = {"type": "score", "score": 1.0, "confidence": 1.0,
                            "probabilities": {"0": 0.0, "1": 1.0, "2": 0.0}}
    return httpx.Response(200, json={"model": "typesafe/jev-1.13-20260917", "answers": answers,
                                     "usage": {"input_tokens": 10, "output_tokens": 0}})


async def test_success_sends_one_request_per_state_with_the_key() -> None:
    other = YesNoQuestion("<untrusted-data>Another state.</untrusted-data>", "Is it biology?")
    layer, recorder, events = decider(ok_body)
    answers = await layer.ask_many([CHOICE, other, NOUL, SCORE])
    assert len(recorder.requests) == 2
    first = recorder.requests[0]
    assert str(first.url) == OPENROUTER_SYSTEMONE_URL
    assert first.headers["Authorization"] == "Bearer sk-or-test"
    sent = json.loads(first.content)
    assert sent["model"] == JEV_MODEL and sent["state"] == STATE
    assert list(sent["questions"]) == ["q1", "q2", "q3"]
    expected = {"Ohm's law": 0.93, "Photosynthesis": 0.05, "New page": 0.02}
    assert answers[0] == ChoiceAnswer("Ohm's law", expected, 0.9)
    assert answers[1] == YesNoAnswer(0.12) and answers[2] == YesNoAnswer(0.12)
    assert answers[3] == ScoreAnswer(2.0, {1: 0.0, 2: 1.0, 3: 0.0})
    # Recorded per request: the first state's three answers, then the second state's one.
    assert [primitive for primitive, _ in events] == ["choice", "noul", "score", "noul"]


async def test_thresholds_turn_unsure_answers_into_undecided() -> None:
    layer, _recorder, events = decider(ok_body, thresholds=Thresholds(choice=0.95, noul=0.8, score=0.5))
    choice, noul = await layer.ask_many([CHOICE, NOUL])
    assert isinstance(choice, Undecided) and "93%" in choice.reason and "writing model" in choice.reason
    assert noul == YesNoAnswer(0.12)  # 88% sure it is "no": above 80%
    assert isinstance(events[0][1], Undecided)


@pytest.mark.parametrize(("status", "reason"), [
    (401, "OpenRouter rejected the API key. Check the key in Settings."),
    (429, "OpenRouter's rate limit was reached. Try again later."),
    (402, "OpenRouter declined the request for this account (payment required)."),
    (503, "OpenRouter or Jev is unavailable right now (HTTP 503)."),
    (400, "OpenRouter rejected the decision request (HTTP 400)."),
])
async def test_http_errors_become_plain_reasons_without_retry(status: int, reason: str) -> None:
    layer, recorder, _events = decider(
        lambda request: httpx.Response(status, json={"error": {"message": "x"}}))
    assert await layer.ask_many([CHOICE, NOUL]) == [Undecided(reason), Undecided(reason)]
    assert len(recorder.requests) == 1


async def test_timeout_and_network_errors() -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    def offline(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    layer, recorder, _ = decider(timeout)
    assert await layer.ask(NOUL) == Undecided("OpenRouter did not answer in time.")
    assert len(recorder.requests) == 1
    layer, _, _ = decider(offline)
    offline_reason = "SKAZ couldn't reach OpenRouter. Check the internet connection."
    assert await layer.ask(NOUL) == Undecided(offline_reason)
    layer, _, _ = decider(lambda request: httpx.Response(200, content=b"<html>"))
    assert await layer.ask(NOUL) == Undecided(UNREADABLE)


async def test_without_consent_or_key_openrouter_is_never_called() -> None:
    layer, recorder, events = decider(ok_body, consent=False)
    [answer] = await layer.ask_many([NOUL])
    assert isinstance(answer, Undecided) and "allow sending wiki text to OpenRouter" in answer.reason
    assert recorder.requests == [] and len(events) == 1
    layer, recorder, _ = decider(ok_body, key=None)
    assert await layer.ask(NOUL) == Undecided("Add an OpenRouter API key to use cloud decisions.")
    assert recorder.requests == []
