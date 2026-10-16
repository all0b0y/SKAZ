"""Native function/tool calling for the API providers (OpenAI, OpenRouter, Anthropic).

One call is one model step: the application sends the conversation and the tool
declarations, the provider answers with text or with tool calls. The loop that
runs the tools lives in ``agent/api_session.py``; nothing here executes a tool,
reads a source or retries on its own beyond the shared request policy of
:func:`~skaz.gateways.chat._post_completion`.

A conversation is kept provider-neutral (:data:`Item`) and encoded per request,
so the same loop drives every provider. Tool arguments that are not a JSON object
are passed on as ``None``: the dispatcher refuses them instead of guessing.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from . import ProviderError, ProviderNotConfigured
from .chat import (
    _ANTHROPIC_TOKEN_FIELDS,
    _OPENAI_TOKEN_FIELDS,
    ANTHROPIC_MESSAGES_URL,
    ANTHROPIC_VERSION,
    OPENAI_BASE_URL,
    OPENROUTER_BASE_URL,
    _joined_text,
    _post_completion,
    _token_counts,
)

TOOL_PROVIDERS = ("openai", "openrouter", "anthropic")

#: Characters per token when a provider reports no usage: a deliberately high count.
_CHARS_PER_TOKEN = 3


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    #: ``None`` when the model sent something other than a JSON object.
    arguments: dict[str, Any] | None
    #: Exactly what the model sent, replayed unchanged in the next request.
    raw_arguments: str = ""


@dataclass(frozen=True)
class AgentReply:
    text: str
    tool_calls: tuple[ToolCall, ...] = ()
    #: The provider stopped at the output limit, not at the end of its answer.
    truncated: bool = False
    #: Input plus output tokens for this step, reported or (without a report) estimated.
    tokens: int = 0


@dataclass(frozen=True)
class UserTurn:
    text: str


@dataclass(frozen=True)
class AssistantTurn:
    reply: AgentReply


@dataclass(frozen=True)
class ToolResult:
    call_id: str
    name: str
    content: str
    is_error: bool = False


Item = UserTurn | AssistantTurn | ToolResult


class ToolChatGateway(Protocol):
    provider: str
    model: str

    async def step(
        self, system: str, items: list[Item], tools: list[ToolSpec], *, max_tokens: int
    ) -> AgentReply: ...


def _encoded(body: dict[str, Any]) -> bytes:
    return json.dumps(body, ensure_ascii=False).encode("utf-8")


def _estimate(body: bytes, reply_chars: int) -> int:
    return (len(body) + reply_chars) // _CHARS_PER_TOKEN + 1


def _spent(usage: dict[str, int], body: bytes, reply_chars: int) -> int:
    if "input_tokens" in usage or "output_tokens" in usage:
        return usage.get("input_tokens", 0) + usage.get("output_tokens", 0)
    return usage.get("total_tokens") or _estimate(body, reply_chars)


def _parsed(raw: str) -> dict[str, Any] | None:
    try:
        value = json.loads(raw) if raw.strip() else {}
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


class OpenAICompatibleToolChat:
    """/chat/completions with ``tools`` — OpenAI and OpenRouter."""

    def __init__(
        self, http: httpx.AsyncClient, *, provider: str, model: str, api_key: str, base_url: str,
        timeout: float,
    ) -> None:
        self._http = http
        self.provider = provider
        self.model = model
        self._api_key = api_key
        self._base = base_url.rstrip("/")
        self._timeout = timeout

    def request(self, system: str, items: list[Item], tools: list[ToolSpec], *, max_tokens: int) -> bytes:
        messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
        for item in items:
            if isinstance(item, UserTurn):
                messages.append({"role": "user", "content": item.text})
            elif isinstance(item, ToolResult):
                messages.append({"role": "tool", "tool_call_id": item.call_id, "content": item.content})
            else:
                # ``null`` content is only valid beside tool calls.
                message: dict[str, Any] = {
                    "role": "assistant",
                    "content": item.reply.text or (None if item.reply.tool_calls else ""),
                }
                if item.reply.tool_calls:
                    message["tool_calls"] = [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {"name": call.name, "arguments": call.raw_arguments or "{}"},
                        }
                        for call in item.reply.tool_calls
                    ]
                messages.append(message)
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name, "description": tool.description, "parameters": tool.input_schema,
                    },
                }
                for tool in tools
            ],
            "tool_choice": "auto",
        }
        # OpenAI's reasoning models refuse ``max_tokens`` and a non-default temperature.
        body["max_completion_tokens" if self.provider == "openai" else "max_tokens"] = max_tokens
        return _encoded(body)

    async def step(
        self, system: str, items: list[Item], tools: list[ToolSpec], *, max_tokens: int
    ) -> AgentReply:
        body = self.request(system, items, tools, max_tokens=max_tokens)
        return await _post_completion(
            self._http,
            provider=self.provider,
            model=self.model,
            url=f"{self._base}/chat/completions",
            headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"},
            body=body,
            timeout=self._timeout,
            read=lambda payload: read_openai(self.provider, payload, body),
            usage=lambda payload: _token_counts(payload, _OPENAI_TOKEN_FIELDS),
        )


def read_openai(provider: str, payload: dict[str, Any], body: bytes = b"") -> AgentReply:
    """One step of a /chat/completions reply, every level of the shape checked."""
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ProviderError(f"{provider} returned no answer choices. Try again or pick another model.")
    first = choices[0]
    message = first.get("message")
    if not isinstance(message, dict):
        raise ProviderError(f"{provider} returned no message. Try again or pick another model.")
    text = _joined_text(message.get("content"))
    calls: list[ToolCall] = []
    raw_calls = message.get("tool_calls") or []
    if not isinstance(raw_calls, list):
        raise ProviderError(f"{provider} returned malformed tool calls. Pick another model.")
    for index, raw in enumerate(raw_calls):
        function = raw.get("function") if isinstance(raw, dict) else None
        if not isinstance(function, dict) or not isinstance(function.get("name"), str):
            raise ProviderError(f"{provider} returned malformed tool calls. Pick another model.")
        identity = raw.get("id") if isinstance(raw.get("id"), str) and raw.get("id") else f"call_{index}"
        arguments = function.get("arguments")
        raw_arguments = arguments if isinstance(arguments, str) else json.dumps(arguments or {})
        calls.append(ToolCall(str(identity), function["name"], _parsed(raw_arguments), raw_arguments))
    truncated = first.get("finish_reason") == "length"
    if not calls and not truncated and not text.strip():
        raise ProviderError(f"{provider} returned an empty message. Try again or pick another model.")
    usage = _token_counts(payload, _OPENAI_TOKEN_FIELDS)
    return AgentReply(text, tuple(calls), truncated, _spent(usage, body, len(text)))


class AnthropicToolChat:
    """/v1/messages with ``tools``."""

    provider = "anthropic"

    def __init__(self, http: httpx.AsyncClient, *, model: str, api_key: str, timeout: float) -> None:
        self._http = http
        self.model = model
        self._api_key = api_key
        self._timeout = timeout

    def request(self, system: str, items: list[Item], tools: list[ToolSpec], *, max_tokens: int) -> bytes:
        messages: list[dict[str, Any]] = []

        def add(role: str, block: dict[str, Any]) -> None:
            # Roles must alternate: consecutive user material (tool results, then an
            # instruction) is one message, tool results first as the API requires.
            if messages and messages[-1]["role"] == role:
                messages[-1]["content"].append(block)
            else:
                messages.append({"role": role, "content": [block]})

        for item in items:
            if isinstance(item, UserTurn):
                add("user", {"type": "text", "text": item.text})
            elif isinstance(item, ToolResult):
                add("user", {
                    "type": "tool_result", "tool_use_id": item.call_id,
                    "content": item.content, "is_error": item.is_error,
                })
            else:
                if item.reply.text:
                    add("assistant", {"type": "text", "text": item.reply.text})
                for call in item.reply.tool_calls:
                    add("assistant", {
                        "type": "tool_use", "id": call.id, "name": call.name, "input": call.arguments or {},
                    })
        body = {
            "model": self.model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
            "tools": [
                {"name": tool.name, "description": tool.description, "input_schema": tool.input_schema}
                for tool in tools
            ],
        }
        return _encoded(body)

    async def step(
        self, system: str, items: list[Item], tools: list[ToolSpec], *, max_tokens: int
    ) -> AgentReply:
        body = self.request(system, items, tools, max_tokens=max_tokens)
        return await _post_completion(
            self._http,
            provider=self.provider,
            model=self.model,
            url=ANTHROPIC_MESSAGES_URL,
            headers={
                "x-api-key": self._api_key,
                "anthropic-version": ANTHROPIC_VERSION,
                "Content-Type": "application/json",
            },
            body=body,
            timeout=self._timeout,
            read=lambda payload: read_anthropic(payload, body),
            usage=lambda payload: _token_counts(payload, _ANTHROPIC_TOKEN_FIELDS),
        )


def read_anthropic(payload: dict[str, Any], body: bytes = b"") -> AgentReply:
    blocks = payload.get("content")
    if not isinstance(blocks, list):
        raise ProviderError("anthropic returned no content blocks.")
    texts: list[str] = []
    calls: list[ToolCall] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            texts.append(block["text"])
        elif block.get("type") == "tool_use":
            identity, name, arguments = block.get("id"), block.get("name"), block.get("input")
            if not isinstance(identity, str) or not identity or not isinstance(name, str):
                raise ProviderError("anthropic returned a malformed tool call. Pick another model.")
            parsed = arguments if isinstance(arguments, dict) else None
            calls.append(ToolCall(identity, name, parsed, json.dumps(arguments, ensure_ascii=False)))
    text = "".join(texts)
    truncated = payload.get("stop_reason") == "max_tokens"
    if not calls and not truncated and not text.strip():
        raise ProviderError("anthropic returned an empty message. Try again or pick another model.")
    usage = _token_counts(payload, _ANTHROPIC_TOKEN_FIELDS)
    return AgentReply(text, tuple(calls), truncated, _spent(usage, body, len(text)))


def build_tool_chat(
    *, http: httpx.AsyncClient, provider: str, model: str, api_key: str | None, timeout: float,
) -> ToolChatGateway:
    if not model:
        raise ProviderNotConfigured("No model is configured for this task. Pick one in settings.")
    if provider not in TOOL_PROVIDERS:
        raise ProviderNotConfigured(f"Provider '{provider}' has no tool-calling adapter.")
    if not api_key:
        raise ProviderNotConfigured(f"No API key stored for provider '{provider}'.")
    if provider == "anthropic":
        return AnthropicToolChat(http, model=model, api_key=api_key, timeout=timeout)
    base = OPENROUTER_BASE_URL if provider == "openrouter" else OPENAI_BASE_URL
    return OpenAICompatibleToolChat(
        http, provider=provider, model=model, api_key=api_key, base_url=base, timeout=timeout,
    )


#: OpenAI chat families documented with function calling.
_OPENAI_TOOL_FAMILIES = re.compile(r"^(gpt-3\.5-turbo|gpt-4o?|gpt-4\.\d+|gpt-5|o1|o3|o4)(?=$|[-.])")
#: Members of those families that are documented without function calling.
_OPENAI_WITHOUT_TOOLS = re.compile(
    r"instruct|audio|realtime|transcribe|tts|search|image|embedding|^o1-(mini|preview)|^chatgpt-"
)
#: Claude models older than the tool-use API.
_ANTHROPIC_WITHOUT_TOOLS = re.compile(r"^claude-(instant|1|2)(?=$|[-.])")


def tool_support_problem(provider: str, model: str, openrouter_entry: object = None) -> str | None:
    """Why ``provider``/``model`` cannot run the agent loop, or ``None`` when it can.

    Only positive evidence counts: an OpenRouter model must declare ``tools`` in the
    catalog, an OpenAI or Anthropic model must belong to a documented tool-calling
    family. Unknown means unavailable — never a guess that silently degrades.
    ``openrouter_entry`` is the model's :class:`~skaz.catalog.CatalogEntry` or ``None``.
    """
    if provider not in TOOL_PROVIDERS:
        return f"{provider} has no tool-calling adapter in SKAZ."
    if not model:
        return "No model is selected."
    if provider == "anthropic":
        if not model.startswith("claude-") or _ANTHROPIC_WITHOUT_TOOLS.match(model):
            return f"'{model}' is not a Claude model with tool use."
        return None
    if provider == "openai":
        if not _OPENAI_TOOL_FAMILIES.match(model) or _OPENAI_WITHOUT_TOOLS.search(model):
            return f"SKAZ cannot confirm that OpenAI '{model}' supports function calling."
        return None
    if openrouter_entry is None:
        return f"The OpenRouter catalog does not list '{model}', so its tool support cannot be confirmed."
    if not getattr(openrouter_entry, "declares_tools", False):
        return f"OpenRouter does not list tool calling for '{model}'."
    return None


def step_tokens(provider: str, model: str) -> int:
    """Output allowance of one step; longer answers continue in the next step."""
    if provider == "anthropic" and re.match(r"^claude-3-(opus|sonnet|haiku)", model):
        return 4096  # The first Claude 3 models refuse a larger max_tokens.
    return 8192

