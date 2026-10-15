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


async def test_the_sweep_never_starts_hermes_before_it_was_prepared(tmp_path: Path) -> None:
    fake = FakeCli(tmp_path / "bin", "hermes", scenario())
    engine = HermesEngine(tmp_path / "data", locate_cli=fake.locate, user_home=tmp_path / "home",
                          first_run_gate=True)
    await engine.sweep_history()
    assert fake.records() == []
