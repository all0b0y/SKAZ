"""Token accounting across all four agents: protocol reports → one ``Usage`` meaning, then storage.

Protocol shapes are the ones the installed builds emit (see ``agents/usage.py``); the fakes only
replay them, they say nothing about a real model's numbers.
"""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

from skaz.knowledge.agents.claude_code import ClaudeCodeEngine
from skaz.knowledge.agents.engine import AgentTurn, Completed, TurnMessage, Usage
from skaz.knowledge.agents.usage import claude_usage, codex_usage, hermes_usage, opencode_usage
from skaz.knowledge.install.terminal import TerminalLauncher
from tests.knowledge.agent_fakes import FakeCli, RecordingOpener
from tests.knowledge.test_agent_claude_code import SUCCESS

# -- protocol → Usage ------------------------------------------------------------------------


def test_codex_breakdown_is_already_total_counting() -> None:
    total = {"totalTokens": 20_600, "inputTokens": 20_000, "cachedInputTokens": 15_000,
             "cacheWriteInputTokens": 0, "outputTokens": 600, "reasoningOutputTokens": 200}
    assert codex_usage(total) == Usage(20_000, 600, cached_input_tokens=15_000, cache_write_tokens=0,
                                       reasoning_tokens=200)


def test_claude_input_gets_the_cache_reads_and_writes_back() -> None:
    usage = {"input_tokens": 12, "cache_creation_input_tokens": 3_000, "cache_read_input_tokens": 9_000,
             "output_tokens": 450, "service_tier": "standard"}
    assert claude_usage(usage) == Usage(12_012, 450, cached_input_tokens=9_000, cache_write_tokens=3_000)


def test_claude_without_cache_counts_keeps_only_what_was_said() -> None:
    assert claude_usage({"input_tokens": 120, "output_tokens": 30}) == Usage(120, 30)
    assert claude_usage({}) == Usage()


def test_hermes_prompt_tokens_already_include_the_cache() -> None:
    usage = {"inputTokens": 9_000, "outputTokens": 300, "totalTokens": 9_300, "thoughtTokens": 120,
             "cachedReadTokens": 8_000}
    assert hermes_usage(usage) == Usage(9_000, 300, cached_input_tokens=8_000, reasoning_tokens=120)
    assert hermes_usage({"inputTokens": 10, "outputTokens": 4}) == Usage(10, 4)


def test_opencode_input_and_output_are_parts_and_missing_parts_are_zero() -> None:
    usage = {"inputTokens": 1_000, "outputTokens": 200, "totalTokens": 7_300, "thoughtTokens": 100,
             "cachedReadTokens": 5_000, "cachedWriteTokens": 1_000}
    assert opencode_usage(usage) == Usage(7_000, 300, cached_input_tokens=5_000, cache_write_tokens=1_000,
                                          reasoning_tokens=100)
    assert opencode_usage({"inputTokens": 12, "outputTokens": 5, "totalTokens": 17}) == Usage(
        12, 5, cached_input_tokens=0, cache_write_tokens=0, reasoning_tokens=0)
    assert opencode_usage({}) == Usage()


def test_negative_or_non_numbers_are_unknown_not_zero() -> None:
    assert codex_usage({"inputTokens": -1, "outputTokens": "5", "cachedInputTokens": True}) == Usage()


# -- the adapters report it ------------------------------------------------------------------


async def test_claude_code_run_reports_the_cache(tmp_path: Path) -> None:
    stream = copy.deepcopy(SUCCESS)
    stream[-1]["usage"] = {"input_tokens": 20, "cache_creation_input_tokens": 100,
                           "cache_read_input_tokens": 4_000, "output_tokens": 30}
    fake = FakeCli(tmp_path / "bin", "claude", {"stream": stream})
    engine = ClaudeCodeEngine(tmp_path / "data" / "claude-code", locate_cli=fake.locate,
                              launcher=TerminalLauncher(tmp_path / "launch", opener=RecordingOpener()),
                              interrupt_grace_s=2.0)
    turn = AgentTurn(run_id="run-1", messages=(TurnMessage("user", "What is entropy?"),),
                     instructions="Answer.", tools=None)
    events: list[Any] = [event async for event in engine.run(turn)]
    assert events[-1] == Completed("run-1", Usage(4_120, 30, cached_input_tokens=4_000,
                                                  cache_write_tokens=100))


async def test_hermes_run_reports_the_cache_and_reasoning(tmp_path: Path) -> None:
    from tests.knowledge import test_agent_hermes as hermes

    usage = {"inputTokens": 9_000, "outputTokens": 300, "totalTokens": 9_300, "thoughtTokens": 120,
             "cachedReadTokens": 8_000}
    plan = hermes.scenario(tools_listing=hermes.PROBE["tools_listing_with_skaz_policy"],
                           updates=hermes.UPDATES[1:2],
                           prompt_result={"stopReason": "end_turn", "usage": usage})
    engine, _fake = hermes.engine_for(tmp_path, plan)
    events = await hermes.drain(engine, hermes.turn(tools=None))
    assert events[-1] == Completed("run-1", Usage(9_000, 300, cached_input_tokens=8_000,
                                                  reasoning_tokens=120))


# -- storage: wiki pipeline -------------------------------------------------------------------


async def test_wiki_accounting_keeps_cache_and_reasoning_per_stage(kb_app: Any, kb_client: Any) -> None:
    import json

    from tests.knowledge.ingest_support import PatternDetector, ScriptedWiki, add_material, settle
    from tests.knowledge.test_ingest_pipeline import CONCEPTS_OK, NOTES_OK

    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    usage = Usage(5_000, 200, cached_input_tokens=4_000, cache_write_tokens=500, reasoning_tokens=50)
    wiki = ScriptedWiki(notes=[NOTES_OK], concepts=[CONCEPTS_OK], usage=usage)
    runtime.kb_ingest.engines = lambda _engine: wiki.engine
    runtime.kb_ingest.detector = PatternDetector()
    material_id = add_material(runtime.kb, "Physics", "Cache test", kind="pdf")
    job_id = (await kb_client.post(f"/kb/materials/{material_id}/ingest")).json()["id"]
    await settle(lambda: not runtime.kb_ingest.active_jobs())
    with runtime.kb.db.read() as connection:
        data = json.loads(connection.execute("SELECT data FROM wiki_execution WHERE job_id = ?",
                                             (job_id,)).fetchone()["data"])
    totals = data["totals"]
    assert (totals["calls"], totals["input_tokens"], totals["output_tokens"]) == (2, 10_000, 400)
    assert (totals["cached_input_tokens"], totals["cache_write_tokens"], totals["reasoning_tokens"]) == (
        8_000, 1_000, 100)
    assert totals["known_cached_inputs"] == totals["known_cache_writes"] == totals["known_reasoning"] == 2
    for stage in data["stages"].values():
        assert stage["cached_input_tokens"] == 4_000


async def test_wiki_accounting_marks_unreported_cache_as_unknown(kb_app: Any, kb_client: Any) -> None:
    import json

    from tests.knowledge.ingest_support import PatternDetector, ScriptedWiki, add_material, settle
    from tests.knowledge.test_ingest_pipeline import CONCEPTS_OK, NOTES_OK

    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    wiki = ScriptedWiki(notes=[NOTES_OK], concepts=[CONCEPTS_OK], usage=Usage(10, 5))
    runtime.kb_ingest.engines = lambda _engine: wiki.engine
    runtime.kb_ingest.detector = PatternDetector()
    material_id = add_material(runtime.kb, "Physics", "No cache test", kind="pdf")
    job_id = (await kb_client.post(f"/kb/materials/{material_id}/ingest")).json()["id"]
    await settle(lambda: not runtime.kb_ingest.active_jobs())
    with runtime.kb.db.read() as connection:
        totals = json.loads(connection.execute("SELECT data FROM wiki_execution WHERE job_id = ?",
                                               (job_id,)).fetchone()["data"])["totals"]
    assert totals.get("known_cached_inputs", 0) == 0 and "cached_input_tokens" not in totals


# -- storage: chat answers --------------------------------------------------------------------


async def _chat_env(kb_app: Any, kb_client: Any) -> Any:
    from tests.knowledge.chat_support import Agents, connect, install

    runtime = kb_app.state.runtime
    agents = Agents()
    install(runtime, agents)
    await connect(kb_client, runtime)
    return runtime, agents


def _usage_rows(runtime: Any) -> list[dict[str, Any]]:
    with runtime.kb.db.read() as connection:
        return [dict(row) for row in connection.execute("SELECT * FROM agent_usage ORDER BY id")]


async def test_chat_answer_usage_is_stored_as_counters_only(kb_app: Any, kb_client: Any) -> None:
    from skaz.knowledge.agents.engine import ToolCall
    from tests.knowledge.chat_support import finished, text

    runtime, agents = await _chat_env(kb_app, kb_client)
    usage = Usage(30_000, 800, cached_input_tokens=25_000, cache_write_tokens=0, reasoning_tokens=300)
    agents.scripts["codex"] = lambda _turn: [ToolCall("", "c1", "skaz_list_folders", {}),
                                             *text("Энтропия растёт."), Completed("", usage)]
    chat = (await kb_client.post("/kb/chats", json={})).json()
    sent = (await kb_client.post(f"/kb/chats/{chat['id']}/messages",
                                 json={"text": "Секретный вопрос про энтропию"})).json()
    await finished(runtime.kb_chats)
    try:
        rows = _usage_rows(runtime)
        assert len(rows) == 1
        row = rows[0]
        assert (row["kind"], row["chat_id"], row["message_id"], row["engine"], row["outcome"]) == (
            "chat", chat["id"], sent["assistant"]["id"], "codex", "done")
        assert (row["input_tokens"], row["cached_input_tokens"], row["cache_write_tokens"],
                row["output_tokens"], row["reasoning_tokens"]) == (30_000, 25_000, 0, 800, 300)
        assert row["tool_calls"] == 1
        assert row["prompt_characters"] > len("Секретный вопрос про энтропию")
        assert row["duration_ms"] >= 0
        # Counters only: neither the question nor the answer is kept here.
        assert not any(isinstance(value, str) and ("Секретный" in value or "Энтропия" in value)
                       for value in row.values())
    finally:
        await runtime.kb_chats.close()


async def test_failed_chat_answer_is_logged_with_unknown_tokens(kb_app: Any, kb_client: Any) -> None:
    from tests.knowledge.chat_support import finished, limit_failure

    runtime, agents = await _chat_env(kb_app, kb_client)
    agents.scripts["claude_code"] = lambda _turn: [limit_failure()]
    chat = (await kb_client.post("/kb/chats", json={"engine": "claude_code"})).json()
    await kb_client.post(f"/kb/chats/{chat['id']}/messages", json={"text": "Вопрос"})
    await finished(runtime.kb_chats)
    try:
        rows = _usage_rows(runtime)
        # A limit leaves the answer resumable: its state is "interrupted".
        assert [(row["engine"], row["outcome"], row["input_tokens"], row["output_tokens"])
                for row in rows] == [("claude_code", "interrupted", None, None)]
    finally:
        await runtime.kb_chats.close()
