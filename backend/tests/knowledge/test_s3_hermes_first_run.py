"""Hermes' first start (decision B10): ~1.5 GB of its own environment, only on the user's action.

Hermes is the fake CLI from ``agent_fakes`` (a script in ``tmp_path``) and the
``prepare`` step runs through a fake executor: no real ``hermes``, no network,
no download — this proves that SKAZ never starts ``hermes acp`` by itself.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.hermes import PREPARE_FIRST, PREPARED_FILE, PREPARING_NOTE, HermesEngine
from skaz.knowledge.agents.hub import AgentsHub, build_agents_hub
from skaz.knowledge.api.agents import agent_view
from skaz.knowledge.install.recipes import HERMES_PREPARE_BYTES, RECIPES
from skaz.knowledge.install.tasks import InstallBusy
from skaz.knowledge.install.terminal import TerminalLauncher
from tests.knowledge.agent_fakes import FakeCli, RecordingOpener
from tests.knowledge.test_agent_hermes import scenario, turn
from tests.knowledge.test_agent_install import HANG, FakeExecutor


class MemorySettings:
    def __init__(self) -> None:
        self.values: dict[str, Any] = {"agents.default_engine": "hermes"}

    def get(self, key: str, default: Any = None) -> Any:
        return self.values.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self.values[key] = value


def hub_for(
    tmp_path: Path, executor: FakeExecutor, *, set_up: bool = True
) -> tuple[AgentsHub, HermesEngine, FakeCli]:
    fake = FakeCli(tmp_path / "bin", "hermes", scenario())
    engine = HermesEngine(
        tmp_path / "data",
        locate_cli=fake.locate,
        user_home=tmp_path / "home",
        launcher=TerminalLauncher(tmp_path / "launch", opener=RecordingOpener()),
        start_timeout_s=20,
        first_run_gate=True,
    )
    if set_up:
        engine.home.mkdir(parents=True, exist_ok=True)
        (engine.home / "config.yaml").write_text("model:\n  provider: custom\n")
    hub = build_agents_hub(
        tmp_path / "data",
        settings=MemorySettings(),
        codex=None,  # type: ignore[arg-type]
        engines={"codex": FakeEngine("codex"), "claude_code": FakeEngine("claude_code"), "hermes": engine},
        executor=executor,
        locate_cli=fake.locate,
        user_home=tmp_path / "home",
    )
    return hub, engine, fake


def acp_starts(fake: FakeCli) -> list[list[str]]:
    return [item["argv"] for item in fake.records("start") if item["argv"] and item["argv"][0] == "acp"]


async def wait_task(hub: AgentsHub, task_id: str) -> str:
    for _ in range(500):
        task = hub.installs.get(task_id)
        if task.state != "running":
            return task.state
        await asyncio.sleep(0.01)
    raise AssertionError("the prepare task never finished")


async def test_until_prepared_hermes_acp_is_never_started(tmp_path: Path) -> None:
    hub, engine, fake = hub_for(tmp_path, FakeExecutor([]))
    view = await hub.registry.view("hermes", refresh=True)
    assert (view.state, view.action) == ("unavailable", "prepare")
    assert view.status.reason == PREPARE_FIRST
    assert view.first_run is not None
    assert (view.first_run.required_bytes, view.first_run.prepared, view.first_run.needed) == (
        HERMES_PREPARE_BYTES,
        False,
        True,
    )
    assert await engine.models() == ()
    events = [event async for event in engine.run(turn(tools=None))]
    assert len(events) == 1 and getattr(events[0], "message", None) == PREPARE_FIRST
    with pytest.raises(Exception, match="prepares its environment"):
        await hub.registry.require("hermes")
    assert acp_starts(fake) == []  # status, models, run and require: no ``hermes acp`` at all

    api = agent_view(hub, view)
    assert api.first_run is not None and api.first_run.required_bytes == 1_500_000_000
    assert (api.state, api.action, api.first_run.prepared) == ("unavailable", "prepare", False)


async def test_not_set_up_hermes_asks_for_setup_first_not_preparation(tmp_path: Path) -> None:
    hub, _engine, fake = hub_for(tmp_path, FakeExecutor([]), set_up=False)
    view = await hub.registry.view("hermes", refresh=True)
    assert view.action != "prepare" and view.first_run is not None and not view.first_run.needed
    assert acp_starts(fake) == []


async def test_prepare_runs_once_in_skaz_folder_with_a_log_then_hermes_is_ready(tmp_path: Path) -> None:
    executor = FakeExecutor([HANG])
    hub, engine, fake = hub_for(tmp_path, executor)
    task = hub.installs.start("hermes", "prepare")
    for _ in range(100):
        if executor.started:
            break
        await asyncio.sleep(0.01)
    # While it runs, the agent says "preparing" with the plain note and offers no other action.
    view = await hub.registry.view("hermes")
    api = agent_view(hub, view)
    assert (api.state, api.action, api.reason) == ("preparing", None, PREPARING_NOTE)
    with pytest.raises(InstallBusy):
        hub.installs.start("hermes", "update")
    (started,) = executor.started
    assert started["argv"] == [str(fake.binary), "acp", "--check"]
    assert started["env"]["HERMES_HOME"] == str(engine.home)
    assert started["env"]["HERMES_MANAGED_DIR"] == str(engine.policy_dir)
    assert not str(engine.home).startswith(str(tmp_path / "home" / ".hermes"))
    await hub.installs.cancel(task.id)
    assert not engine.prepared()  # a cancelled preparation is not a prepared Hermes

    executor.plan.append((["Preparing environment…", "Done."], 0))
    second = hub.installs.start("hermes", "prepare")
    assert await wait_task(hub, second.id) == "succeeded"
    assert [line.text for line in second.after(0)][-1] == "Hermes Agent's environment for SKAZ is ready."
    assert (engine.prepared_marker.name, engine.prepared()) == (PREPARED_FILE, True)
    view = await hub.registry.view("hermes")
    assert view.state == "ready" and view.first_run is not None and view.first_run.prepared
    assert acp_starts(fake)  # only now SKAZ itself talks to ``hermes acp``


async def test_failed_preparation_keeps_the_gate_and_others_have_nothing_to_prepare(tmp_path: Path) -> None:
    hub, engine, _fake = hub_for(tmp_path, FakeExecutor([(["No space left on device"], 1)]))
    task = hub.installs.start("hermes", "prepare")
    assert await wait_task(hub, task.id) == "failed"
    assert not engine.prepared()
    assert (await hub.registry.view("hermes", refresh=True)).action == "prepare"
    with pytest.raises(InstallBusy, match="nothing to prepare"):
        hub.installs.start("claude_code", "prepare")
    assert RECIPES["hermes"].can_prepare and not RECIPES["codex"].can_prepare


async def test_without_the_gate_an_engine_behaves_as_before(tmp_path: Path) -> None:
    fake = FakeCli(tmp_path / "bin", "hermes", scenario())
    engine = HermesEngine(tmp_path / "data", locate_cli=fake.locate, user_home=tmp_path / "home")
    engine.home.mkdir(parents=True, exist_ok=True)
    (engine.home / "config.yaml").write_text("model:\n  provider: custom\n")
    assert engine.prepared() and not engine.first_run().needed
