"""U1: agents check for updates by themselves and offer them; updates wait for running work.

Fakes only: a fake executor stands in for every command that would change anything (no real
update/install/rollback runs), the "latest version" answers come from a fake fetch.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge.agents.engine import AgentTurn, EngineId, EngineStatus, Failed, TextDelta, TurnMessage
from skaz.knowledge.agents.fake import FakeEngine, Gate
from skaz.knowledge.agents.registry import EngineRegistry
from skaz.knowledge.agents.update_gate import UpdateGate, guard, holding
from skaz.knowledge.agents.updates import (
    SETTINGS_KEY,
    AgentUpdates,
    UpdateRefused,
    next_check_at,
    terminal_hint,
)
from skaz.knowledge.install.latest import CheckOutput
from skaz.knowledge.install.recipes import RECIPES
from skaz.knowledge.install.system import Located
from skaz.knowledge.install.tasks import InstallManager

T0 = datetime(2026, 10, 26, 9, 0, tzinfo=UTC)
ONLY_HERMES: dict[EngineId, str | None] = {"codex": None, "claude_code": None, "hermes": "0.22.1",
                                           "opencode": None}


class Settings:
    def __init__(self, data: dict[str, Any] | None = None) -> None:
        self.data: dict[str, Any] = dict(data or {})

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self.data[key] = value


class Step:
    def __init__(self, lines: Sequence[str], code: int, on_done: Any = None,
                 hold: asyncio.Event | None = None) -> None:
        self._lines, self._code, self._on_done, self._hold = lines, code, on_done, hold

    async def lines(self) -> AsyncIterator[str]:
        for line in self._lines:
            yield line + "\n"
        if self._hold is not None:
            await self._hold.wait()

    async def wait(self) -> int:
        if self._on_done is not None:
            self._on_done()
        return self._code

    async def terminate(self) -> None:
        if self._hold is not None:
            self._hold.set()


class Executor:
    """Plays one scripted step per started command and records argv; never runs anything."""

    def __init__(self) -> None:
        self.plan: list[Step] = []
        self.started: list[list[str]] = []

    async def start(self, argv: Sequence[str], *, cwd: Path | None, env: Mapping[str, str]) -> Step:
        self.started.append(list(argv))
        return self.plan.pop(0) if self.plan else Step([], 0)


def status(engine: EngineId, version: str | None, installed: bool = True) -> EngineStatus:
    return EngineStatus(engine, installed=installed, version=version, signed_in=installed)


class World:
    def __init__(self, tmp_path: Path, *, versions: dict[EngineId, str | None] | None = None,
                 latest: dict[str, str] | None = None, settings: dict[str, Any] | None = None,
                 now: datetime = T0) -> None:
        versions = versions if versions is not None else {"codex": "0.160.0", "claude_code": None,
                                                          "hermes": None, "opencode": "1.17.18"}
        self.engines = {engine: FakeEngine(engine, status=status(engine, version, version is not None),
                                           script=[TextDelta("", "answer")])
                        for engine, version in versions.items()}
        self.settings = Settings(settings)
        self.registry = EngineRegistry(self.engines, self.settings)
        self.executor = Executor()
        self.home = tmp_path
        self.bins = self._binaries(tmp_path)

        async def verify(engine: EngineId) -> EngineStatus:
            return (await self.registry.view(engine, refresh=True)).status

        async def resolve(engine: EngineId) -> dict[str, str]:
            return {"binary": str(self.bins[engine])}

        self.installs = InstallManager(tmp_path / "install", verify=verify, resolve=resolve,
                                       executor=self.executor, env={"PATH": "/usr/bin:/bin"})
        self.gate = UpdateGate()
        for engine in self.engines.values():
            guard(engine, self.gate)
        self.latest = dict(latest if latest is not None else {
            "https://registry.npmjs.org/@openai/codex/latest": '{"version": "0.164.0"}',
            "https://api.github.com/repos/anomalyco/opencode/releases/latest": '{"tag_name": "v1.19.4"}',
        })
        self.asked: list[str] = []
        self.offline = False
        self.clock = now
        self.hermes_output = CheckOutput(0, "→ Selected release available: stable v0.22.5 (bf0203a794a0)")
        self.updates = AgentUpdates(self.registry, self.installs, self.gate, home=tmp_path,
                                    locate=self.locate, fetch=self.fetch, hermes_check=self.hermes,
                                    now=lambda: self.clock, start_delay=timedelta(seconds=0.05),
                                    interval=timedelta(hours=24))

    @staticmethod
    def _binaries(home: Path) -> dict[EngineId, Path]:
        npm = home / ".local/lib/node_modules/@openai/codex/bin/codex.js"
        npm.parent.mkdir(parents=True)
        npm.write_text("")
        codex = home / ".local/bin/codex"
        codex.parent.mkdir(parents=True)
        codex.symlink_to(npm)
        opencode = home / ".opencode/bin/opencode"
        opencode.parent.mkdir(parents=True)
        opencode.write_text("")
        claude_real = home / ".local/share/claude/versions/2.1.281"
        claude_real.parent.mkdir(parents=True)
        claude_real.write_text("")
        claude = home / ".local/bin/claude"
        claude.symlink_to(claude_real)
        hermes = home / ".local/bin/hermes"
        hermes.write_text("")
        return {"codex": codex, "opencode": opencode, "claude_code": claude, "hermes": hermes}

    def locate(self, engine: EngineId) -> Located | None:
        return Located(self.bins[engine], "/usr/bin:/bin")

    async def fetch(self, url: str) -> str:
        self.asked.append(url)
        if self.offline:
            raise OSError("offline")
        if url not in self.latest:
            raise OSError(f"unexpected {url}")
        return self.latest[url]

    async def hermes(self, located: Located) -> CheckOutput:
        self.asked.append("hermes update --check")
        return self.hermes_output

    def set_version(self, engine: EngineId, version: str | None) -> None:
        self.engines[engine]._status = status(engine, version, version is not None)


def agent(view: Any, engine: str) -> Any:
    return next(a for a in view.agents if a.engine == engine)


def turn(run_id: str) -> AgentTurn:
    return AgentTurn(run_id=run_id, instructions="", messages=(TurnMessage("user", "hi"),), tools=())


async def until(condition: Any, timeout: float = 2.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not condition():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.01)


# -- schedule -----------------------------------------------------------------------------------


def test_first_check_a_minute_after_start_then_every_day_counting_the_saved_time() -> None:
    assert next_check_at(T0, None) == T0 + timedelta(minutes=1)
    # Checked 2 h ago (before a restart): the next check is its 24 h turn, not a new one now.
    assert next_check_at(T0, T0 - timedelta(hours=2)) == T0 + timedelta(hours=22)
    # Checked 3 days ago: ~1 min after this start.
    assert next_check_at(T0, T0 - timedelta(days=3)) == T0 + timedelta(minutes=1)


async def test_background_check_runs_after_the_start_delay_and_is_saved(tmp_path: Path) -> None:
    world = World(tmp_path)
    world.updates.start()
    try:
        await until(lambda: world.settings.get(SETTINGS_KEY, {}).get("checked_at") is not None)
    finally:
        await world.updates.aclose()
    saved = world.settings.get(SETTINGS_KEY)
    assert saved["attempted_at"] == saved["checked_at"] == T0.isoformat(timespec="seconds")
    # Installed agents only: Codex (npm) and OpenCode (curl), not Claude Code or Hermes.
    assert sorted(world.asked) == ["https://api.github.com/repos/anomalyco/opencode/releases/latest",
                                   "https://registry.npmjs.org/@openai/codex/latest"]
    assert saved["agents"]["codex"]["channel"] == "npm" and saved["agents"]["codex"]["latest"] == "0.164.0"


async def test_a_restart_soon_after_a_check_does_not_ask_again(tmp_path: Path) -> None:
    earlier = {"auto": True, "attempted_at": (T0 - timedelta(hours=2)).isoformat(), "checked_at": None,
               "agents": {}}
    world = World(tmp_path, settings={SETTINGS_KEY: earlier})
    world.updates.start()
    await asyncio.sleep(0.2)
    await world.updates.aclose()
    assert world.asked == []
    expected = (T0 + timedelta(hours=22)).isoformat(timespec="seconds")
    assert (await world.updates.view()).next_check_at == expected


async def test_switched_off_means_no_background_requests_but_manual_check_works(tmp_path: Path) -> None:
    world = World(tmp_path)
    await world.updates.set_auto(False)
    world.updates.start()
    await asyncio.sleep(0.2)
    assert world.asked == []
    assert (await world.updates.view()).next_check_at is None
    view = await world.updates.check()
    await world.updates.aclose()
    assert len(world.asked) == 2 and view.auto is False and view.checked_at is not None


# -- check and offer ----------------------------------------------------------------------------


async def test_offer_skip_and_the_next_version(tmp_path: Path) -> None:
    world = World(tmp_path)
    view = await world.updates.check()
    codex = agent(view, "codex")
    assert (codex.available, codex.installed, codex.latest) == (True, "0.160.0", "0.164.0")
    assert codex.unseen
    assert codex.note == "Updates Codex for this whole Mac, including Terminal."
    assert agent(view, "opencode").latest == "1.19.4" and view.unseen
    assert not agent(view, "claude_code").available and not agent(view, "hermes").available
    view = await world.updates.mark_seen()
    assert not view.unseen and agent(view, "codex").available
    view = await world.updates.skip("codex", "0.164.0")
    assert not agent(view, "codex").available and agent(view, "codex").skipped == "0.164.0"
    world.latest["https://registry.npmjs.org/@openai/codex/latest"] = '{"version": "0.165.0"}'
    view = await world.updates.check()
    codex = agent(view, "codex")
    assert codex.available and codex.latest == "0.165.0" and codex.unseen  # the next version is offered


async def test_an_agent_updated_by_hand_has_no_offer(tmp_path: Path) -> None:
    world = World(tmp_path)
    await world.updates.check()
    world.set_version("codex", "0.164.0")
    await world.registry.view("codex", refresh=True)
    assert not agent(await world.updates.view(), "codex").available


async def test_network_errors_are_silent_and_change_nothing(tmp_path: Path) -> None:
    world = World(tmp_path)
    await world.updates.check()
    before = dict(world.settings.get(SETTINGS_KEY)["agents"]["codex"])
    agent_before = await world.registry.view("codex")
    world.offline = True
    world.clock = T0 + timedelta(days=1)
    view = await world.updates.check()
    saved = world.settings.get(SETTINGS_KEY)
    assert saved["agents"]["codex"] == before  # the last result stays
    assert saved["checked_at"] == T0.isoformat(timespec="seconds")  # "Last checked" is the last that worked
    assert saved["attempted_at"] == (T0 + timedelta(days=1)).isoformat(timespec="seconds")
    assert agent(view, "codex").available and agent(view, "codex").failure is None
    after = await world.registry.view("codex")
    assert (after.state, after.status) == (agent_before.state, agent_before.status)


async def test_hermes_is_offered_the_release_its_own_check_names(tmp_path: Path) -> None:
    world = World(tmp_path, versions=ONLY_HERMES)
    view = await world.updates.check()
    hermes = agent(view, "hermes")
    assert (hermes.available, hermes.latest, hermes.channel) == (True, "0.22.5", "git")
    assert hermes.services_note == "Running Hermes services keep the old version until you restart them."
    world.hermes_output = CheckOutput(0, "→ Update channel: main\n"
                                         "⚕ Update available: 3 commits behind origin/main.")
    view = await world.updates.check()
    assert not agent(view, "hermes").available  # commits, not a version: no offer


# -- the update run -----------------------------------------------------------------------------


async def test_update_runs_the_agents_own_command_and_rechecks(tmp_path: Path) -> None:
    world = World(tmp_path)
    await world.updates.check()
    world.executor.plan.append(Step(["changed 1 package"], 0,
                                    on_done=lambda: world.set_version("codex", "0.164.0")))
    view = await world.updates.update("codex")
    assert agent(view, "codex").phase == "updating"
    await until(lambda: "codex" not in world.updates._runs)
    assert world.executor.started == [[str(world.bins["codex"]), "update"]]
    view = await world.updates.view()
    codex = agent(view, "codex")
    assert codex.installed == "0.164.0" and not codex.available and codex.failure is None


async def test_hermes_update_does_not_restart_its_services(tmp_path: Path) -> None:
    world = World(tmp_path, versions=ONLY_HERMES)
    await world.updates.check()
    world.executor.plan.append(Step([], 0, on_done=lambda: world.set_version("hermes", "0.22.5")))
    await world.updates.update("hermes")
    await until(lambda: "hermes" not in world.updates._runs)
    assert world.executor.started[0] == [str(world.bins["hermes"]), "update", "--no-gateway-restart"]


async def test_a_busy_agent_updates_after_current_work_and_new_work_waits(tmp_path: Path) -> None:
    world = World(tmp_path)
    await world.updates.check()
    release = asyncio.Event()
    codex = world.engines["codex"]
    codex._script = [Gate(release), TextDelta("", "done")]
    running = asyncio.create_task(_collect(codex.run(turn("r1"))))
    await until(lambda: world.gate.busy("codex"))
    assert agent(await world.updates.view(), "codex").busy
    world.executor.plan.append(Step([], 0, on_done=lambda: world.set_version("codex", "0.164.0")))
    view = await world.updates.update("codex")
    assert agent(view, "codex").phase == "queued" and world.executor.started == []
    # A new answer to Codex waits; OpenCode keeps working.
    waiting = asyncio.create_task(_collect(codex.run(turn("r2"))))
    other = await _collect(world.engines["opencode"].run(turn("o1")))
    assert any(isinstance(event, TextDelta) for event in other)
    await asyncio.sleep(0.05)
    assert not waiting.done() and world.executor.started == []
    release.set()  # the running answer finishes, then the update runs, then the waiting answer
    assert any(isinstance(event, TextDelta) for event in await running)
    await until(lambda: waiting.done())
    assert world.executor.started == [[str(world.bins["codex"]), "update"]]
    assert agent(await world.updates.view(), "codex").installed == "0.164.0"


async def test_cancel_a_queued_update_lets_waiting_work_go_on(tmp_path: Path) -> None:
    world = World(tmp_path)
    await world.updates.check()
    release = asyncio.Event()
    codex = world.engines["codex"]
    codex._script = [Gate(release), TextDelta("", "done")]
    running = asyncio.create_task(_collect(codex.run(turn("r1"))))
    await until(lambda: world.gate.busy("codex"))
    await world.updates.update("codex")
    waiting = asyncio.create_task(_collect(codex.run(turn("r2"))))
    await asyncio.sleep(0.05)
    assert not waiting.done()
    view = await world.updates.cancel("codex")
    assert agent(view, "codex").phase == "idle" and agent(view, "codex").available
    release.set()
    await running
    await waiting
    assert world.executor.started == []  # nothing was updated


async def test_a_waiting_answer_can_be_stopped(tmp_path: Path) -> None:
    world = World(tmp_path)
    await world.updates.check()
    release = asyncio.Event()
    codex = world.engines["codex"]
    codex._script = [Gate(release)]
    running = asyncio.create_task(_collect(codex.run(turn("r1"))))
    await until(lambda: world.gate.busy("codex"))
    await world.updates.update("codex")
    waiting = asyncio.create_task(_collect(codex.run(turn("r2"))))
    await asyncio.sleep(0.02)
    await codex.interrupt("r2")
    events = await waiting
    assert isinstance(events[-1], Failed) and events[-1].kind == "cancelled" and events[-1].unsent
    await world.updates.cancel("codex")
    release.set()
    await running


async def test_a_wiki_build_holds_the_agent_for_the_whole_build(tmp_path: Path) -> None:
    world = World(tmp_path)
    await world.updates.check()
    codex = world.engines["codex"]
    world.executor.plan.append(Step([], 0, on_done=lambda: world.set_version("codex", "0.164.0")))
    steps: list[str] = []
    async with holding(codex):
        await _collect(codex.run(turn("w1")))
        await world.updates.update("codex")
        await asyncio.sleep(0.05)
        steps.append("between steps")
        assert world.executor.started == []  # not between two steps of the build
        await _collect(codex.run(turn("w2")))  # the build's own next step doesn't wait
    await until(lambda: "codex" not in world.updates._runs)
    assert world.executor.started == [[str(world.bins["codex"]), "update"]]


async def test_a_refusing_command_shows_its_output_and_the_terminal_command(tmp_path: Path) -> None:
    world = World(tmp_path, versions={"codex": None, "claude_code": "2.1.281", "hermes": None,
                                      "opencode": None},
                  latest={"https://downloads.claude.ai/claude-code-releases/latest": "2.1.310\n"})
    await world.updates.check()
    said = ["Claude is managed by Homebrew.", "To update, run: brew upgrade claude-code"]
    world.executor.plan.append(Step(said, 0))
    await world.updates.update("claude_code")
    await until(lambda: "claude_code" not in world.updates._runs)
    failure = agent(await world.updates.view(), "claude_code").failure
    assert failure.reason == "Claude Code wasn't updated: it is still 2.1.281."
    assert failure.command == "brew upgrade claude-code"
    assert failure.output == ("Claude is managed by Homebrew.", "To update, run: brew upgrade claude-code",
                              "Claude Code 2.1.281 is ready.")
    assert failure.rollback == "none"


async def test_a_failed_recheck_offers_roll_back_only_where_the_agent_can(tmp_path: Path) -> None:
    world = World(tmp_path)
    await world.updates.check()
    # OpenCode (curl): the update leaves a version SKAZ can't use → error, log, Roll back to 1.17.18.
    broken = EngineStatus("opencode", installed=True, version="1.19.4", incompatible=True,
                          reason="This OpenCode version can't be used.")
    world.executor.plan.append(Step(["upgraded"], 0,
                                    on_done=lambda: setattr(world.engines["opencode"], "_status", broken)))
    await world.updates.update("opencode")
    await until(lambda: "opencode" not in world.updates._runs)
    failure = agent(await world.updates.view(), "opencode").failure
    assert failure.reason == "This OpenCode version can't be used."
    assert (failure.rollback, failure.previous) == ("skaz", "1.17.18")
    world.executor.plan.append(Step([], 0, on_done=lambda: world.set_version("opencode", "1.17.18")))
    await world.updates.rollback("opencode")
    await until(lambda: "opencode" not in world.updates._runs)
    assert world.executor.started[-1] == [str(world.bins["opencode"]), "upgrade", "1.17.18"]
    assert agent(await world.updates.view(), "opencode").failure is None
    # Codex (npm): honest "roll back manually" with the vendor's page; SKAZ refuses to try.
    broken_codex = EngineStatus("codex", installed=True, version="0.164.0", incompatible=True, reason="Bad.")
    world.executor.plan.append(Step([], 0,
                                    on_done=lambda: setattr(world.engines["codex"], "_status", broken_codex)))
    await world.updates.update("codex")
    await until(lambda: "codex" not in world.updates._runs)
    failure = agent(await world.updates.view(), "codex").failure
    assert failure.rollback == "manual" and failure.docs_url == "https://github.com/openai/codex/releases"
    with pytest.raises(UpdateRefused):
        await world.updates.rollback("codex")


async def test_a_failed_command_keeps_the_previous_version(tmp_path: Path) -> None:
    world = World(tmp_path)
    await world.updates.check()
    world.executor.plan.append(Step(["npm error code EACCES"], 1))
    await world.updates.update("codex")
    await until(lambda: "codex" not in world.updates._runs)
    failure = agent(await world.updates.view(), "codex").failure
    assert failure.reason.endswith("Codex 0.160.0 is still installed.")
    assert failure.rollback == "none" and failure.command == "npm install -g @openai/codex@latest"
    assert agent(await world.updates.view(), "codex").available  # Update can be tried again


async def test_no_update_without_an_offer(tmp_path: Path) -> None:
    world = World(tmp_path)
    with pytest.raises(UpdateRefused):
        await world.updates.update("codex")


def test_terminal_hint_skips_skazs_own_command_echo() -> None:
    assert terminal_hint(["$ /usr/local/bin/codex update", "Done"]) is None
    assert terminal_hint(["Run `npm install -g @openai/codex@latest` to update."]) == \
        "npm install -g @openai/codex@latest"


def test_upgrade_recipes_are_the_agents_own_commands() -> None:
    assert [step.argv for step in RECIPES["codex"].plan("upgrade")] == [("{binary}", "update")]
    assert [step.argv for step in RECIPES["claude_code"].plan("upgrade")] == [("{binary}", "update")]
    assert RECIPES["claude_code"].plan("rollback")[0].argv == ("{binary}", "install", "{version}")
    assert RECIPES["opencode"].plan("rollback")[0].argv == ("{binary}", "upgrade", "{version}")
    assert RECIPES["hermes"].plan("upgrade")[0].argv == ("{binary}", "update", "--no-gateway-restart")


async def _collect(events: AsyncIterator[Any]) -> list[Any]:
    return [event async for event in events]
