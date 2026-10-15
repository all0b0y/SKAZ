"""Hermes' first check (decision B10, X5): one explicit check before SKAZ starts Hermes itself.

With ``HERMES_RUNTIME_DIR`` (review C1) Hermes runs on the user's own tool store, so
the first start in SKAZ's folder downloads nothing — the old "~1.5 GB preparation"
is gone. What stays is a gate: SKAZ never starts ``hermes acp`` on its own until the
user pressed Check, which runs ``hermes acp --check`` once with SKAZ's isolated
``HERMES_HOME`` under the launcher watch, with the same log as an installation.

Hermes is the fake CLI from ``agent_fakes`` (a script in ``tmp_path``) and the
check step runs through a fake executor: no real ``hermes``, no network.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.hermes import (
    CHECKED_FILE,
    CHECKING_NOTE,
    FIRST_CHECK,
    LEGACY_PREPARED_FILE,
    HermesEngine,
)
from skaz.knowledge.agents.hub import AgentsHub, build_agents_hub
from skaz.knowledge.api.agents import agent_view
from skaz.knowledge.install.recipes import RECIPES
from skaz.knowledge.install.tasks import InstallBusy
from skaz.knowledge.install.terminal import TerminalLauncher
from skaz.knowledge.settings.health import SettingsHealth
from tests.knowledge.agent_fakes import FakeCli, RecordingOpener
from tests.knowledge.test_agent_hermes import scenario, turn
from tests.knowledge.test_agent_install import HANG, FakeExecutor

#: Nothing the user reads about this step may promise a download or a size.
DOWNLOAD_WORDING = re.compile(r"GB|MB|download|prepar", re.IGNORECASE)


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
    raise AssertionError("the first check never finished")


async def test_until_checked_hermes_acp_is_never_started(tmp_path: Path) -> None:
    hub, engine, fake = hub_for(tmp_path, FakeExecutor([]))
    view = await hub.registry.view("hermes", refresh=True)
    assert (view.state, view.action) == ("unavailable", "first_check")
    assert view.status.reason == FIRST_CHECK
    assert view.first_run is not None
    assert (view.first_run.checked, view.first_run.needed) == (False, True)
    assert await engine.models() == ()
    events = [event async for event in engine.run(turn(tools=None))]
    assert len(events) == 1 and getattr(events[0], "message", None) == FIRST_CHECK
    with pytest.raises(Exception, match="checks once"):
        await hub.registry.require("hermes")
    assert acp_starts(fake) == []  # status, models, run and require: no ``hermes acp`` at all

    api = agent_view(hub, view)
    assert api.first_run is not None
    assert (api.state, api.action, api.first_run.checked) == ("unavailable", "first_check", False)
    assert "required_bytes" not in api.first_run.model_dump()


async def test_the_card_and_the_problem_never_promise_a_download(tmp_path: Path) -> None:
    """X2 Q1: the user's store is used, nothing is downloaded — no "~1.5 GB", no "Prepare"."""
    hub, _engine, _fake = hub_for(tmp_path, FakeExecutor([]))
    api = agent_view(hub, await hub.registry.view("hermes", refresh=True))
    assert api.first_run is not None
    for text in (api.reason or "", api.first_run.note, FIRST_CHECK, CHECKING_NOTE):
        assert not DOWNLOAD_WORDING.search(text), text
    assert "SKAZ" in api.first_run.note  # says what is checked: Hermes with SKAZ's own folder

    health = SettingsHealth(SimpleNamespace(kb_agents=hub), keys=None)  # type: ignore[arg-type]
    (problem,) = [item for item in await health._agents() if item.id == "agent-hermes"]
    assert [(action.id, action.label) for action in problem.actions] == [("first_check", "Check")]
    for text in (problem.title, problem.reason):
        assert not DOWNLOAD_WORDING.search(text), text


async def test_not_set_up_hermes_asks_for_setup_first_not_the_check(tmp_path: Path) -> None:
    hub, _engine, fake = hub_for(tmp_path, FakeExecutor([]), set_up=False)
    view = await hub.registry.view("hermes", refresh=True)
    assert view.action != "first_check" and view.first_run is not None and not view.first_run.needed
    assert acp_starts(fake) == []


async def test_the_check_runs_once_in_skaz_folder_on_the_users_store_then_ready(tmp_path: Path) -> None:
    executor = FakeExecutor([HANG])
    hub, engine, fake = hub_for(tmp_path, executor)
    task = hub.installs.start("hermes", "first_check")
    for _ in range(100):
        if executor.started:
            break
        await asyncio.sleep(0.01)
    # While it runs, the agent says it is being checked and offers no other action.
    view = await hub.registry.view("hermes")
    api = agent_view(hub, view)
    assert (api.state, api.action, api.reason) == ("preparing", None, CHECKING_NOTE)
    health = SettingsHealth(SimpleNamespace(kb_agents=hub), keys=None)  # type: ignore[arg-type]
    (problem,) = [item for item in await health._agents() if item.id == "agent-hermes"]
    assert (problem.severity, problem.reason) == ("progress", CHECKING_NOTE)
    with pytest.raises(InstallBusy):
        hub.installs.start("hermes", "update")
    (started,) = executor.started
    located = fake.locate("hermes")
    assert located is not None
    assert started["argv"] == [str(fake.binary), "acp", "--check"]
    assert started["env"]["HERMES_HOME"] == str(engine.home)
    assert started["env"]["HERMES_MANAGED_DIR"] == str(engine.policy_dir)
    assert started["env"]["HERMES_RUNTIME_DIR"] == str(engine.runtime_dir(located))
    assert not str(engine.home).startswith(str(tmp_path / "home" / ".hermes"))
    await hub.installs.cancel(task.id)
    assert not engine.checked()  # a cancelled check is not a checked Hermes

    executor.plan.append((["ACP check ok.", "Done."], 0))
    second = hub.installs.start("hermes", "first_check")
    assert await wait_task(hub, second.id) == "succeeded"
    assert [line.text for line in second.after(0)][-1] == "Hermes Agent runs with SKAZ's own Hermes folder."
    assert (engine.checked_marker.name, engine.checked()) == (CHECKED_FILE, True)
    view = await hub.registry.view("hermes")
    assert view.state == "ready" and view.first_run is not None and view.first_run.checked
    assert acp_starts(fake)  # only now SKAZ itself talks to ``hermes acp``


async def test_a_failed_check_keeps_the_gate_and_others_have_nothing_to_check(tmp_path: Path) -> None:
    hub, engine, _fake = hub_for(tmp_path, FakeExecutor([(["ModuleNotFoundError: acp"], 1)]))
    task = hub.installs.start("hermes", "first_check")
    assert await wait_task(hub, task.id) == "failed"
    assert not engine.checked()
    assert (await hub.registry.view("hermes", refresh=True)).action == "first_check"
    with pytest.raises(InstallBusy, match="nothing to check"):
        hub.installs.start("claude_code", "first_check")
    assert RECIPES["hermes"].first_check and not RECIPES["codex"].first_check


async def test_a_hermes_prepared_by_an_earlier_version_counts_as_checked(tmp_path: Path) -> None:
    hub, engine, _fake = hub_for(tmp_path, FakeExecutor([]))
    (engine.agents_dir / LEGACY_PREPARED_FILE).write_text('{"prepared": true}\n')
    assert engine.checked()
    view = await hub.registry.view("hermes", refresh=True)
    assert view.state == "ready" and view.action is None


async def test_without_the_gate_an_engine_behaves_as_before(tmp_path: Path) -> None:
    fake = FakeCli(tmp_path / "bin", "hermes", scenario())
    engine = HermesEngine(tmp_path / "data", locate_cli=fake.locate, user_home=tmp_path / "home")
    engine.home.mkdir(parents=True, exist_ok=True)
    (engine.home / "config.yaml").write_text("model:\n  provider: custom\n")
    assert engine.checked() and not engine.first_run().needed
