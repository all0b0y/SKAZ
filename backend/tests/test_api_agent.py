"""API providers as tool-driven agents (issue #11).

Real temporary SQLite, the real snapshot queue, dispatcher and runtime tools. The
provider is an injected ``httpx`` transport speaking the provider's own wire format;
its replies are an authored reading policy, not model evaluation. Real-model runs
live in ``scripts/api_agent_acceptance.py``.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz import note_store
from skaz import repository as repo
from skaz.agent.api_agent import ApiAgentEngine
from skaz.agent.api_session import AgentBudget, ApiAgentSession, BudgetExceeded
from skaz.agent.codex_runtime import CodexRuntime
from skaz.catalog import CatalogEntry, ProviderCatalogs
from skaz.codex_schemas import CodexSettings
from skaz.db import Database
from skaz.gateways import ProviderError
from skaz.gateways.codex_session import ToolDefinition
from skaz.gateways.tool_chat import (
    AgentReply,
    AnthropicToolChat,
    AssistantTurn,
    Item,
    ToolCall,
    ToolResult,
    ToolSpec,
    UserTurn,
    read_anthropic,
    read_openai,
    tool_support_problem,
)
from skaz.schemas import Segment
from skaz.secrets import MemorySecretStore
from skaz.settings_store import DEFAULT_SETTINGS, StoredProfile, StoredSettings

REFUSED = "Tool unavailable or request refused"
LECTURE = [
    Segment(id="a1", start_ms=0, end_ms=4000, text="Entropy is first defined as a measure of disorder."),
    Segment(id="a2", start_ms=60_000, end_ms=64_000, text="The second law says entropy never decreases."),
    Segment(id="a3", start_ms=120_000, end_ms=124_000, text="Finally we applied it to heat engines."),
]
SECRET = Segment(id="b1", start_ms=0, end_ms=4000, text="Private salary figures from another meeting.")

# -- An authored reading policy: read every session page by page, then answer. --------

History = list[tuple[dict[str, Any], str]]
Policy = Callable[[History, int], tuple[str, Any]]


def reader(
    sessions: list[str], *, answer: str = "Summary [{labels}]", limit: int = 1,
    first: list[dict[str, Any]] | None = None,
) -> Policy:
    """Call ``first`` tool arguments, then read each session to its end, then answer."""

    def plan(history: History, _step: int) -> tuple[str, Any]:
        if len(history) < len(first or []):
            return "call", (first or [])[len(history)]
        progress: dict[str, int | None] = {}
        labels: list[str] = []
        for args, result in history:
            try:
                page = json.loads(result)
            except ValueError:
                continue
            progress[args["session_id"]] = page["next_after"]
            labels += [block["citation_label"] for block in page["blocks"]]
        for sid in sessions:
            if sid not in progress:
                return "call", {"session_id": sid, "after": 0, "limit": limit}
            if progress[sid] is not None:
                return "call", {"session_id": sid, "after": progress[sid], "limit": limit}
        return "answer", answer.format(labels="][".join(labels) or "P1")

    return plan


def openai_provider(plan: Policy, log: list[dict[str, Any]]) -> Callable[[httpx.Request], httpx.Response]:
    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        log.append(body)
        calls = {
            call["id"]: json.loads(call["function"]["arguments"])
            for message in body["messages"] if message["role"] == "assistant"
            for call in message.get("tool_calls") or []
        }
        history = [
            (calls[message["tool_call_id"]], message["content"])
            for message in body["messages"] if message["role"] == "tool"
        ]
        kind, value = plan(history, len(log))
        if kind == "answer":
            message: dict[str, Any] = {"role": "assistant", "content": value}
            finish = "stop"
        else:
            message = {"role": "assistant", "content": "Reading.", "tool_calls": [{
                "id": f"call_{len(log)}", "type": "function",
                "function": {"name": "skaz_read_transcript", "arguments": json.dumps(value)},
            }]}
            finish = "tool_calls"
        return httpx.Response(200, json={
            "choices": [{"message": message, "finish_reason": finish}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
        })

    return handle


def anthropic_provider(plan: Policy, log: list[dict[str, Any]]) -> Callable[[httpx.Request], httpx.Response]:
    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        log.append(body)
        uses: dict[str, Any] = {}
        history: History = []
        for message in body["messages"]:
            for block in message["content"]:
                if block["type"] == "tool_use":
                    uses[block["id"]] = block["input"]
                elif block["type"] == "tool_result":
                    history.append((uses[block["tool_use_id"]], block["content"]))
        kind, value = plan(history, len(log))
        if kind == "answer":
            content: list[dict[str, Any]] = [{"type": "text", "text": value}]
            stop = "end_turn"
        else:
            content = [
                {"type": "text", "text": "Reading."},
                {
                    "type": "tool_use", "id": f"toolu_{len(log)}",
                    "name": "skaz_read_transcript", "input": value,
                },
            ]
            stop = "tool_use"
        return httpx.Response(200, json={
            "content": content, "stop_reason": stop, "usage": {"input_tokens": 100, "output_tokens": 20},
        })

    return handle


# -- Runtime wiring -----------------------------------------------------------------------


class Harness:
    def __init__(
        self, tmp_path: Path, handler: Callable[[httpx.Request], Any] | None = None, *,
        provider: str = "openai", model: str = "gpt-4.1", budget: AgentBudget | None = None,
        catalog: list[dict[str, Any]] | None = None,
    ) -> None:
        self.db = Database(tmp_path / "app.sqlite")
        self.lecture = repo.create_session(self.db, "Lecture").id
        repo.replace_chunk_segments(self.db, self.lecture, 0, LECTURE)
        self.other = repo.create_session(self.db, "Other").id
        repo.replace_chunk_segments(self.db, self.other, 0, [SECRET])
        self.requests: list[httpx.Request] = []
        self.handler = handler or (lambda _request: httpx.Response(500))

        async def route(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            if request.method == "GET" and request.url.path.endswith("/models"):
                return httpx.Response(200, json={"data": catalog or []})
            result = self.handler(request)
            return await result if asyncio.iscoroutine(result) else result

        self.http = httpx.AsyncClient(transport=httpx.MockTransport(route))
        self.settings = DEFAULT_SETTINGS.model_copy(update={
            "cloud_consent": True,
            "agent": StoredProfile(provider=provider, model=model),  # type: ignore[arg-type]
            "notes": StoredProfile(provider=provider, model=model),  # type: ignore[arg-type]
        })
        self.secrets = MemorySecretStore({"openai": "k", "anthropic": "k", "openrouter": "k"})
        self.service = CodexRuntime(self.db, tmp_path / "codex")
        self.service.api_agents = ApiAgentEngine(
            settings=lambda: self.settings, api_key=self.secrets.get, http=self.http,
            catalogs=ProviderCatalogs(self.http, self.secrets, tmp_path / "catalogs"),
            timeout=5, budget=budget,
        )
        self.service._save_settings(CodexSettings(assistant_api_agent=True, notes_api_agent=True))

    def use(self, **update: Any) -> None:
        self.settings = StoredSettings.model_validate({**self.settings.model_dump(), **update})

    async def ask(self, question: str, scope: str = "session") -> dict[str, Any]:
        chat = self.service.chats.create(self.lecture, scope)
        task = await self.service.submit(chat["id"], question, confirmed=True)
        await self.service.dispatcher.idle()
        return self.settle(task["id"])

    def settle(self, task_id: str) -> dict[str, Any]:
        self.service._finalize(self.service.queue.get(task_id))
        return self.service.task_view(self.service.queue.get(task_id))

    async def close(self) -> None:
        await self.service.close()
        await self.http.aclose()
        self.db.close()


# -- The agent loop over real runtime tools ------------------------------------------------


async def test_full_review_reads_the_whole_scope_in_order_with_openai_tools(tmp_path: Path) -> None:
    log: list[dict[str, Any]] = []
    h = Harness(tmp_path)
    h.handler = openai_provider(reader([h.lecture]), log)
    try:
        view = await h.ask("Summarise the whole lecture")
        assert view["status"] == "completed" and view["engine"] == "api" and view["provider"] == "openai"
        reads = [
            json.loads(call["function"]["arguments"])
            for message in log[-1]["messages"] if message["role"] == "assistant"
            for call in message.get("tool_calls") or []
        ]
        # Every page, in order, from the start: not a ranked top-k.
        afters = [read["after"] for read in reads]
        assert afters[0] == 0 and afters == sorted(afters) and len(reads) >= 2
        meta = h.service._meta(view["id"])
        assert meta["coverage"] == {h.lecture: "complete"} and meta["full_review"] is True
        # Same tools as Codex, declared natively; the full-review rule is in the request.
        tools = [t["function"]["name"] for t in log[0]["tools"]]
        assert tools == [t.name for t in h.service._tools(h.service.queue.get(view["id"]))]
        assert log[0]["tool_choice"] == "auto" and "max_completion_tokens" in log[0]
        assert "needs a full review" in log[0]["messages"][1]["content"]
        assert "untrusted data" in log[0]["messages"][0]["content"]
        assert {c["text"] for c in view["citations"]} == {s.text for s in LECTURE}
        [_user, answer] = h.service.chats.messages(view["chat_id"])
        assert answer["role"] == "assistant" and answer["content"].startswith("Summary [P1]")
        assert any("Model step" in entry for entry in view["activity"])
    finally:
        await h.close()


async def test_a_tool_never_returns_a_source_outside_the_chat_scope(tmp_path: Path) -> None:
    log: list[dict[str, Any]] = []
    h = Harness(tmp_path, provider="anthropic", model="claude-sonnet-4-5")
    h.handler = anthropic_provider(reader([h.lecture], first=[
        {"session_id": h.other, "after": 0},
        {"session_id": h.other, "query": "salary"},
    ]), log)
    try:
        view = await h.ask("What was said about entropy?")
        assert view["status"] == "completed"
        results = [
            block["content"] for message in log[-1]["messages"] for block in message["content"]
            if block["type"] == "tool_result"
        ]
        assert results[:2] == [REFUSED, REFUSED]
        # Nothing from the other session reached the provider in any request.
        assert all("salary" not in json.dumps(body).replace('"query": "salary"', "") for body in log)
        assert all(SECRET.text not in json.dumps(body) for body in log)
        # Anthropic wire shape: tool results first in the user turn, flagged as errors.
        refused = next(
            block for message in log[-1]["messages"] for block in message["content"]
            if block["type"] == "tool_result"
        )
        assert refused["is_error"] is True
    finally:
        await h.close()


async def test_notes_run_on_the_same_agent_path(tmp_path: Path) -> None:
    log: list[dict[str, Any]] = []
    h = Harness(tmp_path, provider="anthropic", model="claude-opus-4-1")
    h.handler = anthropic_provider(reader([h.lecture], answer="# Lecture notes\n\nEntropy [{labels}]."), log)
    try:
        task = await h.service.notes(h.lecture, "English", "normal")
        await h.service.dispatcher.idle()
        view = h.settle(task["id"])
        assert view["status"] == "completed" and view["note_id"] == task["id"]
        [note] = note_store.list_notes(h.db, h.lecture)
        assert note.content.startswith("# Lecture notes") and "[P" not in note.content
        assert {c.text for c in note.citations} == {s.text for s in LECTURE}
        # Ordinary Notes get the transcript reader only, exactly as on Codex.
        assert [t["name"] for t in log[0]["tools"]] == ["skaz_read_transcript"]
    finally:
        await h.close()


async def test_a_note_that_did_not_read_everything_is_not_created(tmp_path: Path) -> None:
    def plan(_history: History, _step: int) -> tuple[str, Any]:
        return "answer", "# Notes\n\nInvented [P1]"

    h = Harness(tmp_path, openai_provider(plan, []))
    try:
        task = await h.service.notes(h.lecture, "English", "normal")
        await h.service.dispatcher.idle()
        view = h.settle(task["id"])
        assert view["status"] in {"paused", "failed"}
        assert note_store.list_notes(h.db, h.lecture) == []
    finally:
        await h.close()


async def test_a_full_review_answer_without_reading_is_corrected_once_then_refused(tmp_path: Path) -> None:
    log: list[dict[str, Any]] = []

    def plan(_history: History, _step: int) -> tuple[str, Any]:
        return "answer", "It was about entropy."

    h = Harness(tmp_path, openai_provider(plan, log))
    try:
        view = await h.ask("Give me a summary of the whole lecture")
        assert (view["status"], view["error"], view["answer"]) == ("failed", "answer_rejected", "")
        assert len(log) == 2 and "were not read to the end" in log[1]["messages"][-1]["content"]
        assert h.service.chats.messages(view["chat_id"])[-1]["role"] == "user"
    finally:
        await h.close()


async def test_a_spent_budget_ends_the_request_honestly(tmp_path: Path) -> None:
    def plan(history: History, _step: int) -> tuple[str, Any]:
        return "call", {"session_id": "loop", "after": len(history)}

    h = Harness(tmp_path, openai_provider(plan, []), budget=AgentBudget(max_tool_calls=3))
    try:
        view = await h.ask("What did the lecturer say?")
        assert view["status"] == "failed"
        assert "all 3 tool calls" in view["error"] and "Nothing was saved" in view["error"]
        assert h.service.chats.messages(view["chat_id"])[-1]["role"] == "user"
    finally:
        await h.close()


async def test_provider_error_pauses_with_its_reason_and_resume_never_switches_model(tmp_path: Path) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "sk-leaked key echoed"}})

    h = Harness(tmp_path, refuse)
    try:
        view = await h.ask("What was defined first?")
        assert view["status"] == "paused"
        assert "API key" in view["error"] and "sk-leaked" not in view["error"]
        # 401 is not replayed and no other provider or model is tried.
        assert [r.url.host for r in h.requests] == ["api.openai.com"]
        assert {json.loads(r.content)["model"] for r in h.requests} == {"gpt-4.1"}
        h.use(agent={"provider": "openai", "model": "gpt-4o"})
        with pytest.raises(ValueError, match="no silent fallback"):
            await h.service.resume(view["id"])
        h.use(agent={"provider": "openai", "model": "gpt-4.1"})
        await h.service.resume(view["id"])
        await h.service.dispatcher.idle()
        assert h.service.queue.get(view["id"]).status == "paused"
    finally:
        await h.close()


async def test_stop_cancels_a_request_in_flight(tmp_path: Path) -> None:
    started = asyncio.Event()

    async def hang(_request: httpx.Request) -> httpx.Response:
        started.set()
        await asyncio.sleep(60)
        raise AssertionError("not cancelled")

    h = Harness(tmp_path, hang)
    try:
        chat = h.service.chats.create(h.lecture, "session")
        task = await h.service.submit(chat["id"], "Anything?")
        await asyncio.wait_for(started.wait(), 5)
        await asyncio.wait_for(h.service.dispatcher.stop(task["id"]), 5)
        assert h.service.queue.get(task["id"]).status == "cancelled"
    finally:
        await h.close()


async def test_models_without_tool_calling_are_unavailable_and_nothing_is_sent(tmp_path: Path) -> None:
    h = Harness(
        tmp_path, lambda _r: httpx.Response(500), provider="openrouter", model="vendor/plain",
        catalog=[
            {"id": "vendor/plain", "supported_parameters": ["temperature"]},
            {"id": "vendor/tools", "supported_parameters": ["tools", "tool_choice"]},
        ],
    )
    try:
        chat = h.service.chats.create(h.lecture, "session")
        with pytest.raises(ValueError, match="does not list tool calling"):
            await h.service.submit(chat["id"], "Question")
        assert h.service.queue.list() == []
        view = h.service.agent_view()["assistant"]
        assert view["engine"] == "api_agent"
        assert view["api_agent"]["available"] is False
        assert "tool calling" in view["api_agent"]["reason"]
        assert all(r.method == "GET" for r in h.requests)
        h.use(agent={"provider": "openrouter", "model": "vendor/tools"})
        assert h.service.agent_view()["assistant"]["api_agent"]["available"] is True
        h.use(agent={"provider": "openai", "model": "gpt-3.5-turbo-instruct"}, cloud_consent=True)
        assert "cannot confirm" in h.service.agent_view()["assistant"]["api_agent"]["reason"]
        h.use(agent={"provider": "openai", "model": "gpt-4.1"}, cloud_consent=False)
        assert "cloud consent" in h.service.agent_view()["assistant"]["api_agent"]["reason"]
    finally:
        await h.close()


# -- The session loop itself ---------------------------------------------------------------


class ScriptedGateway:
    provider = "openai"
    model = "gpt-4.1"

    def __init__(self, replies: list[AgentReply]) -> None:
        self.replies = replies
        self.seen: list[list[Item]] = []

    async def step(
        self, system: str, items: list[Item], tools: list[ToolSpec], *, max_tokens: int
    ) -> AgentReply:
        self.seen.append(list(items))
        await asyncio.sleep(0)
        return self.replies.pop(0)


def echo_tool(log: list[dict[str, Any]]) -> ToolDefinition:
    async def handler(arguments: dict[str, Any]) -> str:
        log.append(arguments)
        return json.dumps({"ok": True})

    return ToolDefinition("skaz_echo", "Echo", {"type": "object"}, handler)


async def test_commentary_is_never_published_and_bad_arguments_are_refused() -> None:
    calls: list[dict[str, Any]] = []
    published: list[str] = []
    gateway = ScriptedGateway([
        AgentReply("Let me look.", (ToolCall("c1", "skaz_echo", None, "{not json"),), tokens=10),
        AgentReply("Still looking.", (ToolCall("c2", "skaz_echo", {"x": 1}, '{"x": 1}'),), tokens=10),
        AgentReply("Final", truncated=True, tokens=10),
        AgentReply(" answer.", tokens=10),
    ])
    session = ApiAgentSession(gateway, tools=[echo_tool(calls)], input_prefix="PREFIX ")

    async def on_answer(text: str) -> None:
        published.append(text)

    result = await session.ask("Q", on_answer=on_answer)
    assert (result.status, result.text) == ("completed", "Final answer.")
    assert published == ["Final", "Final answer."]
    assert calls == [{"x": 1}]
    first, second = gateway.seen[1][-1], gateway.seen[2][-1]
    assert isinstance(first, ToolResult) and first.is_error and first.content == REFUSED
    assert isinstance(second, ToolResult) and not second.is_error
    assert isinstance(gateway.seen[0][0], UserTurn) and gateway.seen[0][0].text == "PREFIX Q"
    assert isinstance(gateway.seen[3][-1], UserTurn) and "Continue exactly" in gateway.seen[3][-1].text
    assert (session.steps, session.tokens, session.calls) == (4, 40, 2)


async def test_budgets_refuse_instead_of_answering_from_part() -> None:
    looping = [AgentReply("", (ToolCall(f"c{i}", "skaz_echo", {}, "{}"),), tokens=10) for i in range(5)]
    session = ApiAgentSession(
        ScriptedGateway(looping), tools=[echo_tool([])], budget=AgentBudget(max_steps=2),
    )
    with pytest.raises(BudgetExceeded, match="model steps"):
        await session.ask("Q")
    heavy = ApiAgentSession(
        ScriptedGateway([AgentReply("x", tokens=500)]), tools=[], budget=AgentBudget(max_tokens=100),
    )
    with pytest.raises(BudgetExceeded, match="tokens"):
        await heavy.ask("Q")
    cut = ApiAgentSession(
        ScriptedGateway([AgentReply("", (ToolCall("c", "skaz_echo", {}, "{"),), truncated=True)]),
        tools=[echo_tool([])],
    )
    with pytest.raises(ProviderError, match="output limit"):
        await cut.ask("Q")


async def test_steering_and_interrupt() -> None:
    release = asyncio.Event()

    class Slow(ScriptedGateway):
        async def step(
            self, system: str, items: list[Item], tools: list[ToolSpec], *, max_tokens: int
        ) -> AgentReply:
            self.seen.append(list(items))
            if len(self.seen) == 1:
                await release.wait()
            return self.replies.pop(0)

    gateway = Slow([AgentReply("", (ToolCall("c", "skaz_echo", {}, "{}"),)), AgentReply("Done")])
    session = ApiAgentSession(gateway, tools=[echo_tool([])])
    running = asyncio.create_task(session.ask("Q"))
    await asyncio.sleep(0.01)
    await session.steer("Answer in French")
    release.set()
    assert (await running).status == "completed"
    last = gateway.seen[1][-1]
    assert isinstance(last, UserTurn) and "Answer in French" in last.text
    with pytest.raises(ValueError):
        await session.steer("late")

    blocked = Slow([AgentReply("never")])
    release.clear()
    stoppable = ApiAgentSession(blocked, tools=[])
    running = asyncio.create_task(stoppable.ask("Q"))
    await asyncio.sleep(0.01)
    await stoppable.interrupt()
    assert (await running).status == "interrupted"


# -- Wire formats and capability -----------------------------------------------------------


def test_wire_readers_check_shape_and_keep_raw_arguments() -> None:
    reply = read_openai("openai", {
        "choices": [{"finish_reason": "tool_calls", "message": {"content": None, "tool_calls": [
            {"id": "a", "type": "function", "function": {"name": "skaz_x", "arguments": '{"q": 1}'}},
            {"id": "b", "type": "function", "function": {"name": "skaz_x", "arguments": "[1]"}},
        ]}}],
        "usage": {"prompt_tokens": 7, "completion_tokens": 3},
    })
    assert [c.arguments for c in reply.tool_calls] == [{"q": 1}, None]
    assert reply.tool_calls[1].raw_arguments == "[1]" and reply.tokens == 10
    with pytest.raises(ProviderError):
        read_openai("openai", {"choices": [{"message": {"content": ""}}]})
    with pytest.raises(ProviderError):
        read_openai("openai", {"choices": [{"message": {"tool_calls": [{"function": {}}]}}]})
    reply = read_anthropic({"content": [
        {"type": "text", "text": "Hm"}, {"type": "tool_use", "id": "t", "name": "skaz_x", "input": {"a": 1}},
    ], "stop_reason": "tool_use"})
    assert reply.text == "Hm" and reply.tool_calls[0].arguments == {"a": 1}
    assert read_anthropic({"content": [{"type": "text", "text": "x"}], "stop_reason": "max_tokens"}).truncated


def test_anthropic_turns_alternate_with_tool_results_first() -> None:
    gateway = AnthropicToolChat(httpx.AsyncClient(), model="claude-sonnet-4-5", api_key="k", timeout=1)
    call = ToolCall("t1", "skaz_x", {"a": 1}, '{"a": 1}')
    body = json.loads(gateway.request("SYS", [
        UserTurn("Q"), AssistantTurn(AgentReply("Hm", (call,))),
        ToolResult("t1", "skaz_x", "page"), UserTurn("Also this"),
    ], [ToolSpec("skaz_x", "X", {"type": "object"})], max_tokens=10))
    assert [m["role"] for m in body["messages"]] == ["user", "assistant", "user"]
    assert [b["type"] for b in body["messages"][2]["content"]] == ["tool_result", "text"]
    assert body["system"] == "SYS" and body["tools"][0]["input_schema"] == {"type": "object"}


@pytest.mark.parametrize(("provider", "model", "ok"), [
    ("openai", "gpt-4.1", True), ("openai", "gpt-4o-mini", True), ("openai", "o3", True),
    ("openai", "gpt-5", True), ("openai", "o1-mini", False), ("openai", "gpt-4o-audio-preview", False),
    ("openai", "gpt-4o-search-preview", False), ("openai", "whisper-1", False),
    ("openai", "gpt-3.5-turbo-instruct", False), ("openai", "my-finetune", False),
    ("anthropic", "claude-sonnet-4-5", True), ("anthropic", "claude-3-haiku-20240307", True),
    ("anthropic", "claude-2.1", False), ("anthropic", "gpt-4.1", False),
    ("local-whisper", "small", False), ("openai", "", False),
])
def test_tool_support_needs_positive_evidence(provider: str, model: str, ok: bool) -> None:
    assert (tool_support_problem(provider, model) is None) is ok


def test_openrouter_tool_support_comes_from_the_catalog() -> None:
    def entry(*parameters: str) -> CatalogEntry:
        return CatalogEntry("m", "m", (), (), supported_parameters=parameters)

    assert tool_support_problem("openrouter", "m", None) is not None
    assert tool_support_problem("openrouter", "m", entry("temperature")) is not None
    assert tool_support_problem("openrouter", "m", entry("tools")) is None


# -- HTTP boundary --------------------------------------------------------------------------


async def test_state_reports_agent_mode_and_one_pass_routes_refuse_it(client: httpx.AsyncClient) -> None:
    sid = (await client.post("/sessions", json={"title": "A"})).json()["id"]
    state = (await client.get("/codex/state", params={"session_id": sid})).json()
    assert state["agent"]["assistant"]["engine"] == "api"
    assert state["settings"]["assistant_api_agent"] is False
    settings = {**state["settings"], "assistant_api_agent": True, "notes_api_agent": True}
    assert (await client.put("/codex/settings", json=settings)).status_code == 200
    state = (await client.get("/codex/state")).json()
    assert state["agent"]["assistant"]["engine"] == "api_agent"
    assert state["agent"]["assistant"]["api_agent"]["available"] is False
    ask = await client.post(f"/sessions/{sid}/ask", json={"question": "What?"})
    assert ask.status_code == 409 and "agent mode" in ask.json()["detail"]
    notes = await client.post(f"/sessions/{sid}/notes", json={})
    assert notes.status_code == 409
    chat = (await client.post("/codex/chats", json={"session_id": sid})).json()
    sent = await client.post(f"/codex/chats/{chat['id']}/messages", json={"question": "What?"})
    assert sent.status_code == 409 and "no other model" in sent.json()["detail"]
