"""Review C1: SKAZ's Hermes never repoints the user's own ``hermes`` nor builds a tool store in SKAZ's folder.

The fake ``hermes`` (``agent_fakes``) boots like Hermes' source does: it uses
``HERMES_RUNTIME_DIR`` as its tool store, otherwise ``<HERMES_HOME>/tools`` (a
home outside ``~/.hermes`` is Hermes' root), builds a missing store and re-mints
the install's launcher onto that store's Python. A "rogue" fake ignores the
override. No real Hermes runs; this proves the SKAZ side only.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from skaz.knowledge.agents.engine import Completed, Failed
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.hermes import HermesEngine
from skaz.knowledge.agents.hermes_launchers import (
    STORE_CREATED,
    TAINTED,
    TAMPERED,
    LauncherWatch,
    install_root,
    user_store,
)
from skaz.knowledge.agents.hub import build_agents_hub
from skaz.knowledge.install.terminal import TerminalLauncher
from tests.knowledge.agent_fakes import (
    FakeCli,
    RecordingMcp,
    RecordingOpener,
    UserHermesInstall,
    hermes_launcher_text,
)
from tests.knowledge.test_agent_hermes import scenario, turn
from tests.knowledge.test_agent_install import FakeExecutor, FakeStep
from tests.knowledge.test_s3_hermes_first_run import MemorySettings


def engine_with_install(tmp_path: Path, *, rogue: tuple[str, ...] = (),
                        gate: bool = False) -> tuple[HermesEngine, FakeCli, UserHermesInstall]:
    user = UserHermesInstall(tmp_path / "home")
    fake = FakeCli(tmp_path / "bin", "hermes", {**scenario(), **user.scenario(rogue=rogue)})
    engine = HermesEngine(tmp_path / "data", mcp=RecordingMcp(), locate_cli=fake.locate, user_home=user.home,
                          launcher=TerminalLauncher(tmp_path / "launch", opener=RecordingOpener()),
                          start_timeout_s=20, first_run_gate=gate)
    engine.home.mkdir(parents=True, exist_ok=True)
    (engine.home / "config.yaml").write_text("model:\n  provider: custom\n")
    return engine, fake, user


async def test_every_hermes_invocation_uses_the_users_store_and_keeps_its_launchers(tmp_path: Path) -> None:
    engine, fake, user = engine_with_install(tmp_path)
    status = await engine.status()
    assert status.signed_in, status.reason
    events = [event async for event in engine.run(turn(tools=None))]
    assert isinstance(events[-1], Completed)
    await engine.settle_history()  # ``hermes sessions delete`` ran too

    starts = fake.records("start")
    assert {tuple(item["argv"][:1]) for item in starts} >= {("--version",), ("acp",), ("sessions",)}
    for item in starts:
        assert item["env"]["HERMES_RUNTIME_DIR"] == str(user.store), item["argv"]
        assert item["env"]["HERMES_HOME"] == str(engine.home)
    assert fake.records("launcher_minted") == []
    assert user.snapshot() == user.original
    assert not (engine.home / "tools").exists()


async def test_a_hermes_ignoring_the_override_is_stopped_and_the_launcher_put_back(tmp_path: Path) -> None:
    engine, fake, user = engine_with_install(tmp_path, rogue=("acp",))
    events = [event async for event in engine.run(turn(tools=None))]
    assert len(events) == 1 and isinstance(events[0], Failed)
    assert (events[0].kind, events[0].message) == ("incompatible", TAMPERED)
    assert fake.records("launcher_minted")  # it really tried
    assert user.snapshot() == user.original
    assert not (engine.home / "tools").exists()
    methods = [item["message"].get("method") for item in fake.records("received")]
    assert "session/prompt" not in methods

    engine, fake, user = engine_with_install(tmp_path / "version", rogue=("--version",))
    status = await engine.status()
    assert (status.incompatible, status.reason) == (True, TAMPERED)
    assert user.snapshot() == user.original
    assert [item["argv"] for item in fake.records("start")] == [["--version"]]  # never got to ``acp``


async def test_a_launcher_already_pointing_into_skaz_is_refused_before_hermes_starts(tmp_path: Path) -> None:
    engine, fake, user = engine_with_install(tmp_path)
    broken = hermes_launcher_text(engine.home / "tools" / "python-3.14" / "bin" / "python3", user.root)
    user.launcher.write_text(broken, encoding="utf-8")
    status = await engine.status()
    assert (status.incompatible, status.reason) == (True, TAINTED)
    events = [event async for event in engine.run(turn(tools=None))]
    assert isinstance(events[0], Failed) and events[0].message == TAINTED
    await engine.sweep_history()
    assert fake.records("start") == []
    assert user.launcher.read_text(encoding="utf-8") == broken  # repairing is the installer's job


class LauncherRewritingExecutor(FakeExecutor):
    """``acp --check`` in SKAZ's folder re-mints the launcher like Hermes without the override."""

    def __init__(self, user: UserHermesInstall, *, honour_override: bool) -> None:
        super().__init__([])
        self.user, self.honour = user, honour_override

    async def start(self, argv: Sequence[str], *, cwd: Path | None, env: Mapping[str, str]) -> FakeStep:
        step = await super().start(argv, cwd=cwd, env=env)
        if list(argv[1:]) == ["acp", "--check"]:
            store = Path(env["HERMES_RUNTIME_DIR"]) if self.honour and "HERMES_RUNTIME_DIR" in env \
                else Path(env["HERMES_HOME"]) / "tools"
            (store / "python-3.14" / "bin").mkdir(parents=True, exist_ok=True)
            self.user.launcher.write_text(hermes_launcher_text(store / "python-3.14" / "bin" / "python3",
                                                               self.user.root), encoding="utf-8")
        return step


async def run_task(tmp_path: Path, action: str, *,
                   honour: bool) -> tuple[Any, HermesEngine, UserHermesInstall, LauncherRewritingExecutor]:
    engine, fake, user = engine_with_install(tmp_path, gate=True)
    executor = LauncherRewritingExecutor(user, honour_override=honour)
    hub = build_agents_hub(tmp_path / "data", settings=MemorySettings(), codex=None,  # type: ignore[arg-type]
                           engines={"codex": FakeEngine("codex"), "claude_code": FakeEngine("claude_code"),
                                    "hermes": engine},
                           executor=executor, locate_cli=fake.locate, user_home=user.home)
    task = hub.installs.start("hermes", action)  # type: ignore[arg-type]
    for _ in range(500):
        if task.state != "running":
            break
        await asyncio.sleep(0.01)
    return task, engine, user, executor


async def test_prepare_and_the_acp_check_run_in_skaz_folder_on_the_users_store(tmp_path: Path) -> None:
    for action in ("prepare", "update"):
        task, engine, user, executor = await run_task(tmp_path / action, action, honour=True)
        assert task.state == "succeeded", task.reason
        check = next(step for step in executor.started if step["argv"][1:] == ["acp", "--check"])
        assert check["env"]["HERMES_HOME"] == str(engine.home)
        assert check["env"]["HERMES_MANAGED_DIR"] == str(engine.policy_dir)
        assert check["env"]["HERMES_RUNTIME_DIR"] == str(user.store)
        assert user.snapshot() == user.original


async def test_an_installer_step_that_repoints_the_launcher_fails_and_is_undone(tmp_path: Path) -> None:
    task, engine, user, _executor = await run_task(tmp_path, "prepare", honour=False)
    assert (task.state, task.reason) == ("failed", TAMPERED)
    assert user.snapshot() == user.original
    assert not engine.prepared()


def test_watch_removes_a_store_built_in_skaz_folder(tmp_path: Path) -> None:
    store = tmp_path / "agents" / "hermes-home" / "tools"
    watch = LauncherWatch([], skaz_dirs=[tmp_path / "agents"], stores=[store])
    store.mkdir(parents=True)
    (store / "facts.json").write_text("{}")
    try:
        watch.check()
    except Exception as error:
        assert str(error) == STORE_CREATED
    else:
        raise AssertionError("a store in SKAZ's folder must refuse the action")
    assert not store.exists()


def test_the_users_store_comes_from_the_launcher_then_the_install_stamp(tmp_path: Path) -> None:
    user = UserHermesInstall(tmp_path / "home")
    assert install_root(user.forwarder, user.home) == user.root
    assert user_store(user.forwarder, user.home) == user.store
    # No usable launcher: the stamp's runtimeDir (pm/environments.py:131-139), else ~/.hermes/tools.
    user.launcher.write_text("#!/bin/sh\nexit 1\n")
    (user.root / "install-stamp.json").write_text(json.dumps({"runtimeDir": str(tmp_path / "elsewhere")}))
    assert user_store(user.forwarder, user.home) == tmp_path / "elsewhere"
    (user.root / "install-stamp.json").write_text(json.dumps({"schemaVersion": 2}))
    assert user_store(user.forwarder, user.home) == user.home / ".hermes" / "tools"
    empty = tmp_path / "empty"
    assert user_store(tmp_path / "nowhere" / "hermes", empty) == empty / ".hermes" / "tools"
