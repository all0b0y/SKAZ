"""The agent's check of an open answer (S4, Q6): the chat's agent and model, no tools, a JSON verdict.

It is a separate run, not a message of the chat: the block shows the verdict as "Agent's opinion · not
a fact". Source text enters only as untrusted data (layer 6); chat-only writing skills stay out.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Callable, Mapping
from typing import Any

from ...native_io import disk_call
from ..agents.engine import AgentTurn, Failed, TurnMessage, collect
from ..agents.prompting import untrusted_block
from ..agents.registry import EngineRegistry
from ..chats.store import ChatRepository
from ..errors import KnowledgeError
from ..service import KnowledgeService
from .format import Question
from .service import JUDGE_RULES, JUDGE_SCHEMA, judge_prompt
from .store import StudyBlock

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")


def parse_verdict(text: str) -> dict[str, Any]:
    raw = _FENCE.sub("", text.strip())
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in the answer")
    value = json.loads(raw[start : end + 1])
    if not isinstance(value, dict) or value.get("verdict") not in ("right", "partly", "wrong"):
        raise ValueError("not a verdict")
    return value


def make_judge(kb: KnowledgeService, registry: Callable[[], EngineRegistry]) -> Callable[..., Any]:
    repo = ChatRepository(kb.db)

    async def judge(block: StudyBlock, question: Question, text: str) -> Mapping[str, Any]:
        # A test opened from the wiki carries the agent fixed when it was opened (bug 1); one made in a
        # chat is checked by that chat's agent, model and effort.
        fixed = block.payload.get("agent")
        if isinstance(fixed, Mapping) and fixed.get("engine"):
            engine_id, model, effort = fixed["engine"], fixed.get("model"), fixed.get("effort")
        else:
            chat = await disk_call(repo.get, block.chat_id)
            if chat is None:
                raise KnowledgeError("The chat of this test is gone.")
            engine_id, model, effort = chat.engine, chat.model, chat.effort
        engine = await registry().require_known(engine_id)
        quotes = [cite.quote for cite in question.cites if cite.quote]
        turn = AgentTurn(
            run_id=f"judge-{uuid.uuid4().hex[:12]}",
            messages=(
                TurnMessage(
                    "user",
                    untrusted_block("question, source and answer", judge_prompt(question, text, quotes)),
                ),
            ),
            instructions=JUDGE_RULES,
            tools=None,
            model=model,
            effort=effort,
            response_schema=JUDGE_SCHEMA,
        )
        result = await collect(engine.run(turn))
        if isinstance(result.terminal, Failed):
            raise KnowledgeError(result.terminal.message)
        verdict = parse_verdict(result.text)
        # Who checked it (bug 1, R5): the verdict says it — «Codex · gpt-…» — as the agent's opinion.
        verdict["checked_by"] = await _who(registry(), engine_id, model)
        return verdict

    return judge


async def _who(registry: EngineRegistry, engine: str, model: str | None) -> str:
    from ..agents.registry import ENGINE_NAMES

    name = ENGINE_NAMES.get(engine, engine)  # type: ignore[call-overload]
    view = registry.last_view(engine)  # type: ignore[arg-type]
    chosen = model or (view.current_model if view is not None else None)
    if view is not None and chosen is None and view.models:
        chosen = view.models[0].id
    label = next((option.label for option in (view.models if view else ()) if option.id == chosen), chosen)
    return f"{name} · {label}" if label else name
