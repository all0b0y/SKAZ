"""Inference against a running ``llama-server`` (localhost): System One answers from a GGUF model.

Two modes, chosen by the pinned model (``local.py``):

* ``native`` — the model is a trained decision model and ``llama-server``
  serves TypeSafe's ``/v1/systemone`` itself; the wire format is the cloud one
  (``systemone.py``).
* ``labels`` — a plain instruct model: SKAZ renders the chat prompt with the
  model's own template (``/apply-template``), asks ``/completion`` for one token
  with ``n_probs`` and renormalises over the allowed single-token labels
  (``labels.py``).

Returns raw answers; thresholds are applied by the caller. Any transport or
format problem becomes ``Undecided`` with a plain reason.
"""
from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any, Literal

import httpx

from .labels import (
    LabelError,
    choice_confidence,
    label_distribution,
    prompt_for,
)
from .protocol import (
    Answer,
    ChoiceAnswer,
    ChoiceQuestion,
    Question,
    ScoreAnswer,
    ScoreQuestion,
    Undecided,
    YesNoAnswer,
)
from .systemone import UNREADABLE, build_request, group_by_state, parse_response

LocalMode = Literal["native", "labels"]
#: How many next-token candidates to read; labels outside the top list count as 0.
N_PROBS = 20
NO_LABEL = "The local model did not answer with one of the options."
SERVER_GONE = "The local decision model stopped responding."


class LlamaClient:
    def __init__(self, http: httpx.AsyncClient, *, timeout_s: float = 60.0) -> None:
        self._http = http
        self.timeout_s = timeout_s

    async def answer(self, base_url: str, questions: Sequence[Question], *, mode: LocalMode,
                     api_key: str | None = None) -> list[Answer]:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        if mode == "native":
            answers: list[Answer] = [Undecided(UNREADABLE)] * len(questions)
            for group in group_by_state(questions):
                batch = await self._native(base_url, [questions[i] for i in group], headers)
                for index, answer in zip(group, batch, strict=True):
                    answers[index] = answer
            return answers
        return [await self._labels(base_url, question, headers) for question in questions]

    async def _post(self, url: str, body: dict[str, Any], headers: dict[str, str]) -> Any:
        response = await self._http.post(url, json=body, headers=headers, timeout=self.timeout_s)
        if response.status_code != 200:
            raise _Failure(f"The local decision model refused the request (HTTP {response.status_code}).")
        try:
            return response.json()
        except ValueError as error:
            raise _Failure(UNREADABLE) from error

    async def _native(self, base_url: str, questions: list[Question],
                      headers: dict[str, str]) -> list[Answer]:
        try:
            request = build_request(questions, model=None)
        except ValueError as error:
            return [Undecided(str(error)) for _ in questions]
        try:
            body = await self._post(f"{base_url}/v1/systemone", request.body, headers)
        except _Failure as failure:
            return [Undecided(failure.reason) for _ in questions]
        except httpx.TimeoutException:
            return [Undecided("The local decision model did not answer in time.") for _ in questions]
        except httpx.HTTPError:
            return [Undecided(SERVER_GONE) for _ in questions]
        return parse_response(request, body)

    async def _labels(self, base_url: str, question: Question, headers: dict[str, str]) -> Answer:
        try:
            prompt = prompt_for(question)
        except LabelError as error:
            return Undecided(str(error))
        try:
            rendered = await self._post(f"{base_url}/apply-template", {
                "messages": list(prompt.messages),
                "chat_template_kwargs": {"enable_thinking": False},
            }, headers)
            text = rendered.get("prompt") if isinstance(rendered, dict) else None
            if not isinstance(text, str):
                return Undecided(UNREADABLE)
            body = await self._post(f"{base_url}/completion", {
                "prompt": text, "n_predict": 1, "n_probs": N_PROBS, "temperature": 0,
                "cache_prompt": True,
            }, headers)
        except _Failure as failure:
            return Undecided(failure.reason)
        except httpx.TimeoutException:
            return Undecided("The local decision model did not answer in time.")
        except httpx.HTTPError:
            return Undecided(SERVER_GONE)
        top = next_token_probabilities(body)
        if top is None:
            return Undecided(UNREADABLE)
        distribution = label_distribution(top, prompt.labels)
        if distribution is None:
            return Undecided(NO_LABEL)
        return labels_to_answer(question, prompt.labels, distribution.probabilities)


class _Failure(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def next_token_probabilities(body: Any) -> list[tuple[str, float]] | None:
    """``(token, probability)`` of the first generated token from a ``/completion`` response.

    Accepts both shapes the server documents: ``top_logprobs`` with ``logprob``
    and, with ``post_sampling_probs``, ``top_probs`` with ``prob``.
    """
    if not isinstance(body, dict):
        return None
    probs = body.get("completion_probabilities")
    if not isinstance(probs, list) or not probs or not isinstance(probs[0], dict):
        return None
    first = probs[0]
    pairs: list[tuple[str, float]] = []
    if isinstance(first.get("top_logprobs"), list):
        for item in first["top_logprobs"]:
            if isinstance(item, dict) and isinstance(item.get("token"), str):
                logprob = item.get("logprob")
                if isinstance(logprob, int | float) and math.isfinite(logprob):
                    pairs.append((item["token"], math.exp(logprob)))
    elif isinstance(first.get("top_probs"), list):
        for item in first["top_probs"]:
            if isinstance(item, dict) and isinstance(item.get("token"), str):
                prob = item.get("prob")
                if isinstance(prob, int | float) and math.isfinite(prob):
                    pairs.append((item["token"], float(prob)))
    else:
        return None
    return pairs


def labels_to_answer(question: Question, labels: Sequence[str], probabilities: Mapping[str, float]) -> Answer:
    if isinstance(question, ChoiceQuestion):
        by_option = {option: probabilities[label]
                     for label, option in zip(labels, question.options, strict=True)}
        option = max(by_option, key=lambda key: by_option[key])
        return ChoiceAnswer(option=option, probabilities=by_option,
                            confidence=choice_confidence(list(by_option.values())))
    if isinstance(question, ScoreQuestion):
        low, _high = question.scale
        distribution = {low + int(label): probabilities[label] for label in labels}
        value = sum(level * p for level, p in distribution.items())
        return ScoreAnswer(value=value, distribution=distribution)
    return YesNoAnswer(p_yes=probabilities["yes"])
