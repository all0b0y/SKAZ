"""N6: live chat sessions of the ACP agents (Hermes, OpenCode) — N6-CONTRACT §2, §8.

The fakes answer ``session/load`` / ``session/resume`` as the installed sources do (Hermes
v0.22.1+179.gb51e8b8 ``acp_adapter/gateway_server.py`` ``_resume``; OpenCode 1.17.18
``ACP.resumeSession``/``ACP.loadSession``): history replayed before a load's reply, an unknown id is
an error (Hermes 0.21: ``null``). They prove the SKAZ side of the seam only — what is opened, prompted,
kept and deleted — never an agent's memory (the live check is the user's).
"""
from __future__ import annotations

import json
import stat
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge.agents.engine import (
    AgentEvent,
    AgentTurn,
    Compacted,
    Completed,
    Failed,
    SessionBound,
    SessionPlan,
    TextDelta,
    TurnMessage,
    Usage,
    session_support,
)
from skaz.knowledge.agents.hermes import (
    HERMES_SESSIONS,
    HermesEngine,
    hermes_prompt,
    turn_usage_delta,
)
from skaz.knowledge.agents.history import seed_prompt
from skaz.knowledge.agents.opencode import OPENCODE_SESSIONS, opencode_prompt
from tests.knowledge import test_agent_hermes as h
from tests.knowledge import test_agent_opencode as o
from tests.knowledge.agent_fakes import RecordingMcp

HERMES_ID = h.PROBE["session_new_configured"]["sessionId"]
OPENCODE_ID = o.PROBE["session_new"]["sessionId"]
START = SessionPlan("start")
REPLAYED = {"sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": "OLD ANSWER REPLAYED"}}


def chat_turn(plan: SessionPlan | None, run_id: str = "run-1", *, instructions: str = "Answer from SKAZ.",
              **extra: Any) -> AgentTurn:
    return AgentTurn(
        run_id=run_id,
        messages=(TurnMessage("user", "Что такое энтропия?"),
                  TurnMessage("assistant", "Earlier answer.", engine="hermes"),
                  TurnMessage("user", "А в лекции 3?")),
        instructions=instructions, tools=h.TOOLS, session=plan, **extra)


def prompts(received: list[dict[str, Any]]) -> list[str]:
    """Texts SKAZ prompted (Hermes' local ``/tools`` check excluded)."""
    return [item["params"]["prompt"][0]["text"] for item in received
            if item["params"]["prompt"][0]["text"] != "/tools"]


def bound(events: list[AgentEvent]) -> SessionBound:
    (event,) = [event for event in events if isinstance(event, SessionBound)]
    return event


# -- both engines say what they can -----------------------------------------------------------------


def test_both_acp_engines_keep_live_sessions_without_revert(tmp_path: Path) -> None:
    engine, _fake = h.engine_for(tmp_path, h.scenario())
    assert session_support(engine) == HERMES_SESSIONS
    assert HERMES_SESSIONS.live and not HERMES_SESSIONS.revert
    opencode, _ = o.engine_for(tmp_path / "oc", o.scenario())
    assert session_support(opencode) == OPENCODE_SESSIONS
    assert OPENCODE_SESSIONS.live and not OPENCODE_SESSIONS.revert


def test_a_new_session_is_seeded_with_the_one_seed_serializer_and_a_continue_sends_only_the_message() -> None:
    start = chat_turn(START, history_summary="older talk")
    assert hermes_prompt(start) == ("Instructions from SKAZ:\nAnswer from SKAZ.\n\n"
                                    + seed_prompt(start.messages, "older talk"))
    assert opencode_prompt(start) == seed_prompt(start.messages, "older talk")  # instructions: agent prompt
    going_on = chat_turn(SessionPlan("continue", "s-1"), history_summary="ignored")
    assert hermes_prompt(going_on) == "А в лекции 3?"
    assert opencode_prompt(going_on) == "А в лекции 3?"
    slash = AgentTurn("r", (TurnMessage("user", "/reset please"),), "", None,
                      session=SessionPlan("continue", "s"))
    assert hermes_prompt(slash) == "Current request:\n/reset please"  # never a Hermes command
    assert opencode_prompt(slash) == "Current request:\n/reset please"
    first = AgentTurn("r", (TurnMessage("user", "Hi"),), "Be brief.", None, session=START)
    assert hermes_prompt(first) == "Instructions from SKAZ:\nBe brief.\n\nCurrent user message:\nHi"


# -- Hermes -----------------------------------------------------------------------------------------


async def test_hermes_start_keeps_the_session_for_the_chat_instead_of_deleting_it(tmp_path: Path) -> None:
    engine, fake = h.engine_for(tmp_path, h.scenario(), mcp=RecordingMcp())
    events = await h.drain(engine, chat_turn(START))
    await engine.settle_history()
    session = bound(events)
    assert session.session_id == HERMES_ID and session.turn_id.startswith("turn-")
    first_text = next(i for i, event in enumerate(events) if isinstance(event, TextDelta))
    assert events.index(session) < first_text
    assert isinstance(events[-1], Completed)
    assert len(h.received(fake, "session/new")) == 1 and not h.received(fake, "session/load")
    assert prompts(h.received(fake, "session/prompt")) == [hermes_prompt(chat_turn(START))]
    assert fake.records("sessions") == []  # no post-run delete of a chat's session
    assert engine.pending_history() == [] and engine.chat_sessions() == [HERMES_ID]
    new = h.received(fake, "session/new")[0]["params"]
    assert new["cwd"] == str(engine.runs_dir / "chat") and Path(new["cwd"]).is_dir()  # stable, kept


async def test_hermes_continue_loads_the_session_and_sends_only_the_new_message(tmp_path: Path) -> None:
    mcp = RecordingMcp()
    engine, fake = h.engine_for(tmp_path, h.scenario(load_replay=[REPLAYED]), mcp=mcp)
    events = await h.drain(engine, chat_turn(SessionPlan("continue", "sess-chat")))
    await engine.settle_history()
    assert not h.received(fake, "session/new")
    (load,) = h.received(fake, "session/load")
    assert load["params"]["sessionId"] == "sess-chat"
    assert load["params"]["cwd"] == str(engine.runs_dir / "chat")
    assert [server["name"] for server in load["params"]["mcpServers"]] == ["skaz"]  # this answer's grant
    assert prompts(h.received(fake, "session/prompt")) == ["А в лекции 3?"]
    assert all(item["params"]["sessionId"] == "sess-chat" for item in h.received(fake, "session/prompt"))
    assert bound(events).session_id == "sess-chat"
    texts = "".join(event.text for event in events if isinstance(event, TextDelta))
    assert "OLD ANSWER REPLAYED" not in texts  # the history Hermes replays on load is not an answer
    assert texts == "Энтропия растёт."
    assert fake.records("sessions") == [] and engine.chat_sessions() == ["sess-chat"]


@pytest.mark.parametrize("failure", [
    {"session_load_error": {"code": -32603, "message": "Internal error", "data": {"details": "not_found"}}},
    {"session_load_null": True},  # Hermes 0.21's in-process load of an unknown id
])
async def test_hermes_session_that_cant_be_loaded_is_lost_before_anything_is_sent(
        tmp_path: Path, failure: dict[str, Any]) -> None:
    engine, fake = h.engine_for(tmp_path, h.scenario(**failure), mcp=RecordingMcp())
    events = await h.drain(engine, chat_turn(SessionPlan("continue", "sess-gone")))
    await engine.settle_history()
    (terminal,) = events
    assert isinstance(terminal, Failed) and terminal.session_lost and terminal.unsent
    assert not h.received(fake, "session/prompt")
    assert fake.records("sessions") == []  # SKAZ's chat store drops (and deletes) it, not the run


async def test_hermes_failure_before_the_handover_still_deletes_the_new_session(tmp_path: Path) -> None:
    engine, fake = h.engine_for(tmp_path, h.scenario(tools_listing="Available tools (1):\n  terminal: run"),
                                mcp=RecordingMcp())
    events = await h.drain(engine, chat_turn(START))
    await engine.settle_history()
    assert not any(isinstance(event, SessionBound) for event in events)
    assert isinstance(events[-1], Failed) and not events[-1].session_lost
    assert [call["args"] for call in fake.records("sessions")] == [["delete", HERMES_ID, "--yes"]]
    assert engine.chat_sessions() == []


async def test_hermes_stateless_runs_keep_the_post_run_delete(tmp_path: Path) -> None:
    engine, fake = h.engine_for(tmp_path, h.scenario(), mcp=RecordingMcp())
    events = await h.drain(engine, chat_turn(None))
    await engine.settle_history()
    assert isinstance(events[-1], Completed)
    assert not any(isinstance(event, SessionBound | Compacted) for event in events)
    assert [call["args"] for call in fake.records("sessions")] == [["delete", HERMES_ID, "--yes"]]
    assert engine.chat_sessions() == []


async def test_hermes_delete_session_removes_it_from_skazs_folder(tmp_path: Path) -> None:
    engine, fake = h.engine_for(tmp_path, h.scenario(missing_sessions=["sess-gone"]), mcp=RecordingMcp())
    await h.drain(engine, chat_turn(START))
    await engine.delete_session(HERMES_ID)
    await engine.delete_session("sess-gone")  # "No session '<id>'": already gone, no error
    calls = fake.records("sessions")
    assert [call["args"] for call in calls] == [["delete", HERMES_ID, "--yes"],
                                                ["delete", "sess-gone", "--yes"]]
    assert {call["home"] for call in calls} == {str(engine.home)}  # SKAZ's folder, never ~/.hermes
    assert engine.chat_sessions() == []


async def test_hermes_delete_session_raises_when_hermes_keeps_it(tmp_path: Path) -> None:
    engine, fake = h.engine_for(tmp_path, h.scenario(), mcp=RecordingMcp())
    await h.drain(engine, chat_turn(START))
    fake.scenario_path.write_text(json.dumps(h.scenario(sessions_exit=1)), encoding="utf-8")
    with pytest.raises(RuntimeError):
        await engine.delete_session(HERMES_ID)
    assert engine.chat_sessions() == [HERMES_ID]  # still SKAZ's: the chat store retries


async def test_the_start_up_prune_never_runs_while_a_chat_session_is_kept(tmp_path: Path) -> None:
    """``prune --source acp`` deletes every ENDED ACP session and a chat's session is ended between
    answers (Hermes 0.22 ``session_acp_lifecycle.end_idle_acp_session``)."""
    engine, fake = h.engine_for(tmp_path, h.scenario(), mcp=RecordingMcp())
    await h.drain(engine, chat_turn(START))
    restarted = HermesEngine(tmp_path / "data", locate_cli=fake.locate, user_home=tmp_path / "home")
    await restarted.sweep_history()
    assert ["prune", "--source", "acp", "--yes"] not in [call["args"] for call in fake.records("sessions")]
    await restarted.delete_session(HERMES_ID)  # the chat was deleted: nothing of SKAZ's is kept
    again = HermesEngine(tmp_path / "data", locate_cli=fake.locate, user_home=tmp_path / "home")
    await again.sweep_history()
    assert [call["args"] for call in fake.records("sessions")][-1] == ["prune", "--source", "acp", "--yes"]


async def test_hermes_tools_changed_notice_is_never_an_answer_or_a_tools_listing(tmp_path: Path) -> None:
    notice = "Editor MCP tools changed (servers: skaz); the new tool list applies from the next turn.\n"
    updates = [{"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": notice}},
               *h.UPDATES]
    engine, _fake = h.engine_for(tmp_path, h.scenario(updates=updates), mcp=RecordingMcp())
    events = await h.drain(engine, chat_turn(SessionPlan("continue", "sess-chat")))
    assert "".join(event.text for event in events if isinstance(event, TextDelta)) == "Энтропия растёт."


def test_session_usage_is_this_answers_share_of_the_cumulative_counters() -> None:
    before = {"inputTokens": 1000, "outputTokens": 100, "cachedReadTokens": 0}
    after = {"inputTokens": 2600, "outputTokens": 160, "cachedReadTokens": 1400}
    assert turn_usage_delta(after, before) == {"inputTokens": 1600, "outputTokens": 60,
                                               "cachedReadTokens": 1400}
    assert turn_usage_delta(after, None) == after
    rebuilt = {"inputTokens": 1200, "outputTokens": 90}  # a counter went down: the agent starts at zero
    assert turn_usage_delta(rebuilt, before) == rebuilt


async def test_hermes_continue_reports_only_its_own_tokens_under_the_same_gateway(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(HermesEngine, "gateway_pid", lambda _self: 4242)
    cumulative = {"stopReason": "end_turn", "usage": {"inputTokens": 10, "outputTokens": 4}}
    engine, fake = h.engine_for(tmp_path, h.scenario(prompt_result=cumulative), mcp=RecordingMcp())
    first = await h.drain(engine, chat_turn(START))
    assert first[-1] == Completed("run-1", Usage(10, 4))
    cumulative = {"stopReason": "end_turn", "usage": {"inputTokens": 25, "outputTokens": 9}}
    fake.scenario_path.write_text(json.dumps(h.scenario(prompt_result=cumulative)), encoding="utf-8")
    second = await h.drain(engine, chat_turn(SessionPlan("continue", HERMES_ID), "run-2"))
    assert second[-1] == Completed("run-2", Usage(15, 5))
    monkeypatch.setattr(HermesEngine, "gateway_pid", lambda _self: None)  # 0.21: per-process agent
    third = await h.drain(engine, chat_turn(SessionPlan("continue", HERMES_ID), "run-3"))
    assert third[-1] == Completed("run-3", Usage(25, 9))


# -- OpenCode ---------------------------------------------------------------------------------------


async def test_opencode_start_keeps_the_session_and_its_instructions(tmp_path: Path) -> None:
    engine, fake = o.engine_for(tmp_path, o.scenario(), mcp=RecordingMcp())
    events = await o.drain(engine, chat_turn(START, model=o.SONNET, instructions="Start rules {env:HOME}."))
    assert isinstance(events[-1], Completed)
    session = bound(events)
    assert session.session_id == OPENCODE_ID
    assert events.index(session) < next(i for i, e in enumerate(events) if isinstance(e, TextDelta))
    (new,) = fake.received("session/new")
    assert new["params"]["cwd"] == str(engine.chat_dir)
    assert o.acp_start(fake)["cwd"] == str(engine.chat_dir)
    assert prompts(fake.received("session/prompt")) == [seed_prompt(chat_turn(START).messages)]
    assert fake.records("session_delete") == []  # no post-run delete of a chat's session
    assert engine.pending_history() == []
    kept = engine.sessions_dir / f"{OPENCODE_ID}.json"
    assert kept.read_text(encoding="utf-8") == o.acp_start(fake)["run_config"]
    assert stat.S_IMODE(kept.stat().st_mode) == 0o600


async def test_opencode_continue_resumes_with_the_start_instructions_and_only_the_new_message(
        tmp_path: Path) -> None:
    engine, fake = o.engine_for(tmp_path, o.scenario(), mcp=RecordingMcp())
    await o.drain(engine, chat_turn(START, model=o.SONNET, instructions="Start rules."))
    started_with = o.acp_start(fake)["run_config"]
    events = await o.drain(engine, chat_turn(SessionPlan("continue", OPENCODE_ID), "run-2", model=o.SONNET,
                                             instructions="Changed rules."))
    assert isinstance(events[-1], Completed) and bound(events).session_id == OPENCODE_ID
    assert len(fake.received("session/new")) == 1
    (resume,) = fake.received("session/resume")
    assert resume["params"]["sessionId"] == OPENCODE_ID and resume["params"]["cwd"] == str(engine.chat_dir)
    assert [server["name"] for server in resume["params"]["mcpServers"]] == ["skaz"]
    second = [item for item in fake.records("start") if item["argv"] == ["acp"]][-1]
    assert second["run_config"] == started_with and "Changed rules" not in second["run_config"]
    assert prompts(fake.received("session/prompt"))[-1] == "А в лекции 3?"
    assert fake.records("session_delete") == []


async def test_opencode_session_that_cant_be_resumed_is_lost_before_anything_is_sent(tmp_path: Path) -> None:
    engine, fake = o.engine_for(tmp_path, o.scenario(), mcp=RecordingMcp())
    await o.drain(engine, chat_turn(START, model=o.SONNET))
    fake.scenario_path.write_text(json.dumps(o.scenario(
        resume_error={"code": -32603, "message": "Internal error", "data": {"message": "NotFoundError"}})))
    events = await o.drain(engine, chat_turn(SessionPlan("continue", OPENCODE_ID), "run-2", model=o.SONNET))
    (terminal,) = events
    assert isinstance(terminal, Failed) and terminal.session_lost and terminal.unsent
    assert len(fake.received("session/prompt")) == 1  # only the first answer's


async def test_opencode_session_without_its_kept_instructions_is_lost_without_starting_opencode(
        tmp_path: Path) -> None:
    engine, fake = o.engine_for(tmp_path, o.scenario(), mcp=RecordingMcp())
    events = await o.drain(engine, chat_turn(SessionPlan("continue", "ses_unknown"), model=o.SONNET))
    (terminal,) = events
    assert isinstance(terminal, Failed) and terminal.session_lost and terminal.unsent
    assert not [item for item in fake.records("start") if item["argv"] == ["acp"]]


async def test_opencode_without_resume_falls_back_to_load_and_drops_the_replayed_history(
        tmp_path: Path) -> None:
    engine, fake = o.engine_for(tmp_path, o.scenario(), mcp=RecordingMcp())
    await o.drain(engine, chat_turn(START, model=o.SONNET))
    fake.scenario_path.write_text(json.dumps(o.scenario(resume_unknown=True, load_replay=[REPLAYED])))
    events = await o.drain(engine, chat_turn(SessionPlan("continue", OPENCODE_ID), "run-2", model=o.SONNET))
    assert isinstance(events[-1], Completed)
    assert len(fake.received("session/load")) == 1
    texts = "".join(event.text for event in events if isinstance(event, TextDelta))
    assert "OLD ANSWER REPLAYED" not in texts


async def test_opencode_stateless_runs_keep_the_post_run_delete(tmp_path: Path) -> None:
    engine, fake = o.engine_for(tmp_path, o.scenario(), mcp=RecordingMcp())
    events = await o.drain(engine, chat_turn(None, model=o.SONNET))
    assert isinstance(events[-1], Completed)
    assert not any(isinstance(event, SessionBound | Compacted) for event in events)
    assert [item["id"] for item in fake.records("session_delete")] == [OPENCODE_ID]
    assert not engine.sessions_dir.exists() or not list(engine.sessions_dir.iterdir())


async def test_opencode_delete_session_removes_it_and_its_kept_instructions(tmp_path: Path) -> None:
    engine, fake = o.engine_for(tmp_path, o.scenario(missing_sessions=["ses_gone"]), mcp=RecordingMcp())
    await o.drain(engine, chat_turn(START, model=o.SONNET))
    kept = engine.sessions_dir / f"{OPENCODE_ID}.json"
    assert kept.is_file()
    await engine.delete_session(OPENCODE_ID)
    assert not kept.exists()
    await engine.delete_session("ses_gone")  # "Session not found": already gone
    deletes = fake.records("session_delete")
    assert [item["id"] for item in deletes] == [OPENCODE_ID, "ses_gone"]
    assert {item["data"] for item in deletes} == {str(engine.data_home)}  # SKAZ's OpenCode folder
    fake.scenario_path.write_text(json.dumps(o.scenario(delete_exit=1)))
    with pytest.raises(RuntimeError):
        await engine.delete_session("ses_other")


async def test_opencode_failure_before_the_handover_still_deletes_the_new_session(tmp_path: Path) -> None:
    engine, fake = o.engine_for(tmp_path, o.scenario(), mcp=RecordingMcp())
    events = await o.drain(engine, chat_turn(START, model="anthropic/not-a-model"))
    assert isinstance(events[-1], Failed) and not any(isinstance(event, SessionBound) for event in events)
    assert [item["id"] for item in fake.records("session_delete")] == [OPENCODE_ID]
    assert not (engine.sessions_dir / f"{OPENCODE_ID}.json").exists()
