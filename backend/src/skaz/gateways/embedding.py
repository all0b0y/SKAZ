"""OpenRouter embeddings: explicit ZDR routing, bounded spend, no retries.

Only metadata is fetched before the caller approves the complete operation's
upper bound. No raw provider error, text, or credential is exposed to callers.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

import httpx

from . import ProviderError, ProviderNotConfigured, describe_http_error

BASE = "https://openrouter.ai/api/v1"
MAX_INPUT_BYTES = 6000
BATCH_SIZE = 8
QUERY_INSTRUCTION = "Instruct: Given a user question, retrieve passages that answer the question\nQuery: "
RESPONSE_ALIASES = {
    ("qwen/qwen3-embedding-8b", "deepinfra"): "Qwen/Qwen3-Embedding-8B",
    ("openai/text-embedding-3-small", "azure"): "text-embedding-3-small",
}


@dataclass(frozen=True)
class Endpoint:
    model: str
    tag: str
    price: Decimal
    context: int

    @property
    def space(self) -> str:
        # Version includes query instruction and document windowing contracts.
        return f"openrouter:{self.model}:{self.tag}:v1"

    def upper_bound(self, count: int) -> Decimal:
        return self.price * self.context * count


def _price(value: Any) -> Decimal:
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        raise ProviderError("Embedding endpoint has invalid pricing.") from None
    if not result.is_finite() or result < 0:
        raise ProviderError("Embedding endpoint has invalid pricing.")
    return result


async def endpoint(http: httpx.AsyncClient, model: str, timeout: float) -> Endpoint:
    reply = await _request(http, "GET", "/endpoints/zdr", timeout=timeout)
    rows = reply.get("data")
    if not isinstance(rows, list):
        raise ProviderError("Embedding ZDR catalog is malformed; no text was sent.")
    choices: list[Endpoint] = []
    for row in rows:
        if not isinstance(row, dict) or row.get("model_id") != model or row.get("status") != 0:
            continue
        tag, context, pricing = row.get("tag"), row.get("context_length"), row.get("pricing")
        if not isinstance(tag, str) or not tag or type(context) is not int or context < 8192:
            continue
        if not isinstance(pricing, dict) or "prompt" not in pricing:
            continue
        if any(_price(value) != 0 for name, value in pricing.items() if name != "prompt"):
            continue
        choices.append(Endpoint(model, tag, _price(pricing["prompt"]), context))
    if not choices:
        raise ProviderNotConfigured(
            "Selected embedding model has no available ZDR endpoint with supported pricing. "
            "No text was sent; choose another embedding model."
        )
    return min(choices, key=lambda item: (item.price, item.tag))


async def _request(
    http: httpx.AsyncClient, method: str, path: str, *, timeout: float,
    key: str | None = None, payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        response = await http.request(
            method, BASE + path, headers={"Authorization": f"Bearer {key}"} if key else {},
            json=payload, timeout=timeout, follow_redirects=False,
        )
    except httpx.HTTPError:
        raise ProviderError(
            "Embedding transport failed. No automatic retry; a sent request may have been billed."
        ) from None
    if response.status_code != 200:
        raise ProviderError(describe_http_error("OpenRouter embedding", response.status_code))
    try:
        result = response.json()
    except ValueError:
        raise ProviderError("Embedding service returned invalid JSON.") from None
    if not isinstance(result, dict):
        raise ProviderError("Embedding service returned an invalid response.")
    return result


def normalized(vector: Any) -> list[float]:
    if not isinstance(vector, list) or not vector or len(vector) > 65536:
        raise ProviderError("Invalid embedding dimensions.")
    try:
        valid = all(type(value) in (int, float) and math.isfinite(value) for value in vector)
        norm = math.hypot(*vector) if valid else 0.0
    except (OverflowError, TypeError):
        raise ProviderError("Embedding contains invalid values.") from None
    if not valid:
        raise ProviderError("Embedding contains invalid values.")
    if not math.isfinite(norm) or norm == 0:
        raise ProviderError("Embedding has invalid norm.")
    return [float(value) / norm for value in vector]


async def embed(
    http: httpx.AsyncClient, route: Endpoint, texts: list[str], role: Literal["document", "query"],
    *, key: str, timeout: float,
) -> list[list[float]]:
    inputs = (
        [QUERY_INSTRUCTION + text for text in texts]
        if role == "query" and route.model.startswith("qwen/") else texts
    )
    if not inputs or len(inputs) > BATCH_SIZE or any(
        not text.strip() or len(text.encode("utf-8")) > MAX_INPUT_BYTES for text in inputs
    ):
        raise ProviderNotConfigured("Embedding input is oversized or empty; nothing was sent.")
    payload: dict[str, Any] = {
        "model": route.model, "input": inputs, "encoding_format": "float",
        "provider": {"only": [route.tag], "allow_fallbacks": False,
                     "data_collection": "deny", "zdr": True,
                     "max_price": {"prompt": float(route.price * 1_000_000), "completion": 0}},
    }
    if route.model.startswith("voyageai/"):
        payload["input_type"] = role
    reply = await _request(http, "POST", "/embeddings", key=key, payload=payload, timeout=timeout)
    accepted = {route.model, RESPONSE_ALIASES.get((route.model, route.tag), route.model)}
    if reply.get("model") not in accepted:
        raise ProviderError("Embedding response model differs from the selected model.")
    rows = reply.get("data")
    if not isinstance(rows, list) or len(rows) != len(inputs) or any(
        not isinstance(row, dict) or type(row.get("index")) is not int for row in rows
    ) or sorted(row["index"] for row in rows) != list(range(len(inputs))):
        raise ProviderError("Embedding response has invalid vector ordering/count.")
    vectors = [normalized(row.get("embedding")) for row in sorted(rows, key=lambda row: row["index"])]
    if len({len(vector) for vector in vectors}) != 1:
        raise ProviderError("Embedding dimensions changed within a batch.")
    usage = reply.get("usage")
    tokens = usage.get("prompt_tokens") if isinstance(usage, dict) else None
    if type(tokens) is not int or not 0 <= tokens <= route.context * len(inputs):
        raise ProviderError("Embedding usage is missing or outside the reserved bound; stopped.")
    if (isinstance(usage, dict) and usage.get("cost") is not None
            and _price(usage["cost"]) > route.upper_bound(len(inputs))):
        raise ProviderError("Embedding reported cost exceeds its reserved bound; stopped.")
    return vectors
