"""The SKAZ agent loop for API providers: Codex's tool contract over native tool calling.

This is the API-provider counterpart of :class:`~skaz.gateways.codex_session.CodexSession`
and exposes the same three operations (``ask``, ``steer``, ``interrupt``), so the
dispatcher, the queue and the runtime drive either one unchanged. It deliberately
is not an agent framework: one conversation, the tools the runtime registered, and
fixed per-request budgets.

The tools are the runtime's own :class:`ToolDefinition` handlers — the very ones
Codex gets — and every call goes through :class:`CodexTools`, so the schemas, the
scope checks, the per-call timeouts, the one-use call identities and the result
size limit are identical. Text the model writes next to a tool call is
commentary and is never published as the answer, as with Codex.

Budgets end a request honestly (:class:`BudgetExceeded`) instead of cutting the
reading short and answering from what happened to fit.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from uuid import uuid4

from ..gateways import ProviderError
from ..gateways.codex_session import BASE_INSTRUCTIONS, ToolDefinition, TurnResult
from ..gateways.codex_tools import CodexTools
from ..gateways.tool_chat import AssistantTurn, Item, ToolChatGateway, ToolResult, ToolSpec, UserTurn

#: The thread identity of an API-provider turn; tool scopes are bound to it and a turn id.
API_THREAD = "api"

CONTINUE_EXACT = (
    "Your previous response stopped at the output limit. Continue exactly where it ended. "
    "Return only the missing continuation; never repeat what you already wrote."
)


@dataclass(frozen=True)
class AgentBudget:
    """Per-request limits: one task execution, including its correction or continuation."""

    #: Model requests (each one is a provider call).
    max_steps: int = 48
    #: Tool calls, the same ceiling Codex gets per turn.
    max_tool_calls: int = 128
    #: Input plus output tokens across every step, as reported by the provider.
    max_tokens: int = 1_500_000
    #: Wall-clock limit of one turn, the same as a Codex turn.
    turn_timeout: float = 600
    max_answer_bytes: int = 1024 * 1024

    def __post_init__(self) -> None:
        if (
            self.max_steps < 1 or self.max_tool_calls < 1 or self.max_tokens < 1
            or not math.isfinite(self.turn_timeout) or self.turn_timeout <= 0 or self.max_answer_bytes < 1
        ):
            raise ValueError("Invalid agent budget")


class BudgetExceeded(ProviderError):
    """The request spent its budget before finishing: a refusal, never retried as is."""


#: Told after each model step: steps, tokens and tool calls used so far.
Progress = Callable[[int, int, int], Awaitable[None]]


class ApiAgentSession:
    def __init__(
        self,
        gateway: ToolChatGateway,
        *,
        tools: list[ToolDefinition],
        input_prefix: str = "",
        budget: AgentBudget | None = None,
        step_tokens: int = 8192,
        on_progress: Progress | None = None,
    ) -> None:
        names = [tool.name for tool in tools]
        if (
            len(set(names)) != len(names) or any(not name.startswith("skaz_") for name in names)
            or step_tokens < 1
        ):
            raise ValueError("Invalid agent session configuration")
        self._gateway = gateway
        self._specs = [ToolSpec(tool.name, tool.description, tool.input_schema) for tool in tools]
        self._handlers = {tool.name: tool.handler for tool in tools}
        self._timeouts = {tool.name: tool.timeout for tool in tools}
        self._prefix = input_prefix
        self._budget = budget or AgentBudget()
        self._step_tokens = step_tokens
        self._on_progress = on_progress
        #: The whole conversation of this execution; a correction continues it.
        self._items: list[Item] = []
        self._steering: list[str] = []
        self.steps = self.tokens = self.calls = 0
        self._active = False
        self._interrupted = False
        self._work: asyncio.Task[None] | None = None

    async def steer(self, text: str) -> None:
        if not text.strip() or len(text.encode()) > 65536:
            raise ValueError("Invalid steering message")
        if not self._active:
            raise ValueError("No active turn")
        self._steering.append(text)

    async def interrupt(self) -> None:
        if self._work is not None and not self._work.done():
            self._interrupted = True
            self._work.cancel()

    async def ask(
        self, question: str, *, on_answer: Callable[[str], Awaitable[None]] | None = None,
    ) -> TurnResult:
        """Run one turn to its final answer; the callback gets cumulative text, never deltas."""
        if self._active:
            raise ProviderError("An agent turn is already active")
        if not question.strip():
            raise ValueError("Question cannot be empty")
        self._active = True
        self._interrupted = False
        turn_id = uuid4().hex
        scope = CodexTools(
            API_THREAD, turn_id, self._handlers, tool_timeouts=self._timeouts,
            max_calls=max(1, self._budget.max_tool_calls - self.calls),
        )
        answer = ""

        async def publish(text: str) -> None:
            nonlocal answer
            answer = text
            if on_answer is not None:
                await on_answer(text)

        text = question if self._items else self._prefix + question
        self._work = asyncio.create_task(self._loop(scope, turn_id, text, publish))
        try:
            async with asyncio.timeout(self._budget.turn_timeout):
                await self._work
            return TurnResult(API_THREAD, turn_id, "completed", answer)
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if self._interrupted and (current is None or current.cancelling() == 0):
                return TurnResult(API_THREAD, turn_id, "interrupted", answer)
            raise
        except TimeoutError:
            raise ProviderError(
                f"The request did not finish within {self._budget.turn_timeout:.0f} s; not retried."
            ) from None
        finally:
            scope.revoke()
            self._work = None
            self._active = False

    async def _loop(
        self, scope: CodexTools, turn_id: str, text: str, publish: Callable[[str], Awaitable[None]],
    ) -> None:
        budget = self._budget
        self._items.append(UserTurn(text))
        parts: list[str] = []
        while True:
            if self._steering:
                self._items.append(UserTurn(
                    "Additional instructions from the user:\n" + "\n".join(self._steering)
                ))
                self._steering.clear()
            if self.steps >= budget.max_steps:
                raise BudgetExceeded(
                    f"The request used all {budget.max_steps} model steps before finishing. "
                    "Nothing was saved; narrow the question or the scope."
                )
            self.steps += 1
            reply = await self._gateway.step(
                BASE_INSTRUCTIONS, self._items, self._specs, max_tokens=self._step_tokens
            )
            self.tokens += reply.tokens
            self._items.append(AssistantTurn(reply))
            if self.tokens > budget.max_tokens:
                raise BudgetExceeded(
                    f"The request used {self.tokens:,} tokens, over its budget of {budget.max_tokens:,}. "
                    "Nothing was saved; narrow the question or the scope."
                )
            if reply.tool_calls:
                if reply.truncated:
                    raise ProviderError(
                        "The model reached its output limit in the middle of a tool call; nothing was saved."
                    )
                for call in reply.tool_calls:
                    if self.calls >= budget.max_tool_calls:
                        raise BudgetExceeded(
                            f"The request used all {budget.max_tool_calls} tool calls before finishing. "
                            "Nothing was saved; narrow the question or the scope."
                        )
                    self.calls += 1
                    result = await scope.invoke({
                        "threadId": API_THREAD, "turnId": turn_id, "callId": call.id,
                        "tool": call.name, "arguments": call.arguments,
                    })
                    content = "".join(str(item.get("text", "")) for item in result["contentItems"])
                    self._items.append(ToolResult(call.id, call.name, content, not result["success"]))
                await self._report()
                continue
            await self._report()
            if reply.truncated and not reply.text.strip():
                raise ProviderError(
                    "The model spent its whole output allowance without writing an answer. "
                    "Try again or pick another model."
                )
            parts.append(reply.text)
            answer = "".join(parts)
            if len(answer.encode()) > budget.max_answer_bytes:
                raise ProviderError("The answer exceeds the size limit; nothing was saved.")
            await publish(answer)
            if not reply.truncated:
                if not answer.strip():
                    raise ProviderError(
                        "The model returned an empty answer. Try again or pick another model."
                    )
                return
            self._items.append(UserTurn(CONTINUE_EXACT))

    async def _report(self) -> None:
        if self._on_progress is not None:
            await self._on_progress(self.steps, self.tokens, self.calls)
