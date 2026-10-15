"""SKAZ's conversations do not stay in Hermes' session store (review B2 #4).

Hermes ACP persists every prompted session to ``HERMES_HOME/state.db`` and has
no switch to turn that off (installed source ``acp_adapter/session.py``, docs
user-guide/features/acp "Session behavior"); the documented way to remove one
is ``hermes sessions delete <id>``. SKAZ deletes each run's session from its
own Hermes folder when the run ends, keeps a list of the ones not deleted yet
and sweeps them (plus ended ACP sessions) on the next start. The fake Hermes
records what it was asked; it proves the SKAZ side only.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from skaz.knowledge.agents.engine import Completed, Failed
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.hermes import HermesEngine
from tests.knowledge.agent_fakes import FakeCli
from tests.knowledge.test_agent_hermes import PROBE, UPDATES, drain, engine_for, scenario, turn

SESSION_ID = PROBE["session_new_configured"]["sessionId"]


def _sessions_calls(fake: FakeCli) -> list[dict[str, Any]]:
    return fake.records("sessions")


async def test_a_finished_run_deletes_its_session_from_skazs_hermes_folder(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, scenario())
    events = await drain(engine, turn(tools=None))
    assert isinstance(events[-1], Completed)
    await engine.settle_history()
    calls = _sessions_calls(fake)
    assert [call["args"] for call in calls] == [["delete", SESSION_ID, "--yes"]]
    assert calls[0]["home"] == str(engine.home)  # SKAZ's own folder, never ~/.hermes
    assert not str(engine.home).startswith(str(tmp_path / "home" / ".hermes"))
    assert engine.pending_history() == []


async def test_a_stopped_run_is_deleted_too(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, scenario(updates=UPDATES[1:2], hang=True))
    stream = engine.run(turn(tools=None))
    await stream.__anext__()
    await engine.interrupt("run-1")
    rest = [event async for event in stream]
    assert isinstance(rest[-1], Failed) and rest[-1].kind == "cancelled"
    await engine.settle_history()
    assert [call["args"] for call in _sessions_calls(fake)] == [["delete", SESSION_ID, "--yes"]]


async def test_a_session_hermes_could_not_delete_is_swept_on_the_next_start(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, scenario(sessions_exit=1))
    await drain(engine, turn(tools=None))
    await engine.settle_history()
    assert engine.pending_history() == [SESSION_ID]  # remembered beside SKAZ's Hermes folder
    fake.scenario_path.write_text(json.dumps(scenario()), encoding="utf-8")

    restarted = HermesEngine(tmp_path / "data", locate_cli=fake.locate, user_home=tmp_path / "home")
    await restarted.sweep_history()
    args = [call["args"] for call in _sessions_calls(fake)]
    assert args[-2:] == [["delete", SESSION_ID, "--yes"], ["prune", "--source", "acp", "--yes"]]
    assert restarted.pending_history() == []


async def test_the_sweep_never_starts_hermes_before_its_first_check(tmp_path: Path) -> None:
    fake = FakeCli(tmp_path / "bin", "hermes", scenario())
    engine = HermesEngine(tmp_path / "data", locate_cli=fake.locate, user_home=tmp_path / "home",
                          first_run_gate=True)
    await engine.sweep_history()
    assert fake.records() == []


async def test_app_start_sweeps_in_the_background_once_hermes_was_checked(tmp_path: Path) -> None:
    """G7: the leftovers of an earlier run go at app start, not only at the first use of Hermes."""
    from skaz.knowledge.agents.hub import build_agents_hub
    from skaz.knowledge.agents.registry import CodexStatusEngine

    engine, fake = engine_for(tmp_path, scenario(sessions_exit=1))
    await drain(engine, turn(tools=None))
    await engine.settle_history()
    assert engine.pending_history() == [SESSION_ID]
    fake.scenario_path.write_text(json.dumps(scenario()), encoding="utf-8")

    restarted = HermesEngine(tmp_path / "data", locate_cli=fake.locate, user_home=tmp_path / "home")
    settings: dict[str, Any] = {}
    hub = build_agents_hub(tmp_path / "data", settings=_Settings(settings), codex=None,  # type: ignore[arg-type]
                           engines={"codex": CodexStatusEngine(None),  # type: ignore[arg-type]
                                    "claude_code": FakeEngine("claude_code"), "hermes": restarted})
    before = len(_sessions_calls(fake))
    hub.start()  # returns at once: the sweep runs in the background
    await restarted.settle_history()
    args = [call["args"] for call in _sessions_calls(fake)][before:]
    assert args == [["delete", SESSION_ID, "--yes"], ["prune", "--source", "acp", "--yes"]]
    assert restarted.pending_history() == []
    # Once per app run: the first use of Hermes later doesn't sweep again.
    await drain(restarted, turn(tools=None))
    await restarted.settle_history()
    later = [call["args"] for call in _sessions_calls(fake)][before + 2:]
    assert ["prune", "--source", "acp", "--yes"] not in later


async def test_app_start_never_touches_an_unchecked_hermes(tmp_path: Path) -> None:
    from skaz.knowledge.agents.hub import build_agents_hub
    from skaz.knowledge.agents.registry import CodexStatusEngine

    fake = FakeCli(tmp_path / "bin", "hermes", scenario())
    engine = HermesEngine(tmp_path / "data", locate_cli=fake.locate, user_home=tmp_path / "home",
                          first_run_gate=True)
    hub = build_agents_hub(tmp_path / "data", settings=_Settings({}), codex=None,  # type: ignore[arg-type]
                           engines={"codex": CodexStatusEngine(None),  # type: ignore[arg-type]
                                    "claude_code": FakeEngine("claude_code"), "hermes": engine})
    hub.start()
    await engine.settle_history()
    assert fake.records() == []


class _Settings:
    def __init__(self, values: dict[str, Any]) -> None:
        self.values = values

    def get(self, key: str, default: Any = None) -> Any:
        return self.values.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self.values[key] = value


async def test_the_app_lifespan_starts_the_sweep_after_the_library_opened(kb_app: Any,
                                                                          monkeypatch: Any) -> None:
    runtime = kb_app.state.runtime
    order: list[str] = []
    real_open = runtime.kb.open_connected

    def open_library() -> bool:
        opened: bool = real_open()
        order.append("library")
        return opened

    monkeypatch.setattr(runtime.kb, "open_connected", open_library)
    monkeypatch.setattr(type(runtime.kb_agents), "start", lambda _self: order.append("agents"))
    async with kb_app.router.lifespan_context(kb_app):
        assert order == ["library", "agents"]


async def test_an_id_hermes_keeps_refusing_to_delete_is_given_up_after_a_few_starts(tmp_path: Path) -> None:
    """Review Low: a session Hermes never deletes is not retried on every start forever."""
    from skaz.knowledge.agents.hermes import MAX_DELETE_ATTEMPTS

    engine, fake = engine_for(tmp_path, scenario(sessions_exit=1))
    await drain(engine, turn(tools=None))
    await engine.settle_history()
    assert engine.pending_history() == [SESSION_ID]
    tries = 1
    while engine.pending_history():
        restarted = HermesEngine(tmp_path / "data", locate_cli=fake.locate, user_home=tmp_path / "home")
        await restarted.sweep_history()
        tries += 1
        assert tries <= MAX_DELETE_ATTEMPTS, "never given up"
    assert tries == MAX_DELETE_ATTEMPTS
    deletes = [call for call in _sessions_calls(fake) if call["args"][0] == "delete"]
    assert len(deletes) == MAX_DELETE_ATTEMPTS


async def test_an_id_older_than_the_ttl_is_dropped_without_asking_hermes(tmp_path: Path) -> None:
    from skaz.knowledge.agents.hermes import HISTORY_TTL_S

    engine, fake = engine_for(tmp_path, scenario(sessions_exit=1))
    old = "2020-01-01T00:00:00+00:00"
    engine.history_file.parent.mkdir(parents=True, exist_ok=True)
    engine.history_file.write_text(json.dumps({"sessions": ["sess-old"], "first_seen": {"sess-old": old}}))
    assert HISTORY_TTL_S < 10 * 365 * 24 * 3600
    await engine.sweep_history()
    assert engine.pending_history() == []
    assert not [call for call in _sessions_calls(fake) if "sess-old" in call["args"]]


def test_an_old_history_file_without_counters_still_reads(tmp_path: Path) -> None:
    engine, _fake = engine_for(tmp_path, scenario())
    engine.history_file.parent.mkdir(parents=True, exist_ok=True)
    engine.history_file.write_text(json.dumps({"sessions": ["a", "b"]}))
    assert engine.pending_history() == ["a", "b"]


async def test_the_model_list_session_is_deleted_too(tmp_path: Path) -> None:
    """Hermes 0.22 stores a session when it is created (``gateway/session_local.py`` mints the row
    with its policy at ``session.create``), not only once prompted: the one SKAZ opens to read the
    model list is removed like a run's."""
    engine, fake = engine_for(tmp_path, scenario())
    assert await engine.models() != ()
    await engine.settle_history()
    assert [call["args"] for call in _sessions_calls(fake)] == [["delete", SESSION_ID, "--yes"]]
    assert engine.pending_history() == []
