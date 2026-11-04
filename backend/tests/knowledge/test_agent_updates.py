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

from skaz.knowledge.agents.engine import (
    AgentEngine,
    AgentTurn,
    EngineId,
    EngineStatus,
    Failed,
    TextDelta,
    TurnMessage,
)
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
                 now: datetime = T0, retry_delay: timedelta | None = None, store: Any = None) -> None:
        versions = versions if versions is not None else {"codex": "0.160.0", "claude_code": None,
                                                          "hermes": None, "opencode": "1.17.18"}
        self.engines = {engine: FakeEngine(engine, status=status(engine, version, version is not None),
                                           script=[TextDelta("", "answer")])
                        for engine, version in versions.items()}
        self.settings = store if store is not None else Settings(settings)
        self.registry = EngineRegistry(self.engines, self.settings)
        self.executor = Executor()
        self.home = tmp_path
        self.bins = self._binaries(tmp_path)

        async def verify(engine: EngineId) -> EngineStatus:
            return (await self.registry.view(engine, refresh=True)).status

        async def resolve(engine: EngineId) -> dict[str, str]:
            folder = str(tmp_path / "hermes-folders")  # Hermes' later steps (ACP extra, check) need them
            return {"binary": str(self.bins[engine]), "install_dir": folder, "hermes_home": folder,
                    "hermes_policy": folder, "hermes_runtime": folder}

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
        #: Engines whose update/rollback command succeeded, as told to the hub (SKAZ's Hermes gateway stop).
        self.after: list[str] = []
        extra: dict[str, Any] = {"retry_delay": retry_delay} if retry_delay is not None else {}
        self.updates = AgentUpdates(self.registry, self.installs, self.gate, home=tmp_path,
                                    locate=self.locate, fetch=self.fetch, hermes_check=self.hermes,
                                    now=lambda: self.clock, start_delay=timedelta(seconds=0.05),
                                    interval=timedelta(hours=24), after_update=self.after_update, **extra)

    async def after_update(self, engine: EngineId) -> None:
        self.after.append(engine)

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


async def test_a_live_session_run_passes_the_gate_unchanged() -> None:
    """Merge of U1 and N6: the gate wraps only ``run`` / ``interrupt``; a turn with a session plan reaches
    the engine as it is, ``SessionBound`` and the rest come back unchanged, and the engine still declares
    live sessions and deletes them."""
    from skaz.knowledge.agents.engine import (
        Completed,
        LiveSessionEngine,
        SessionBound,
        SessionPlan,
        SessionSupport,
        session_support,
    )
    live = SessionSupport(live=True, revert=True)
    plain, guarded = (FakeEngine("codex", script=[TextDelta("", "ok")], sessions=live) for _ in range(2))
    guard(guarded, UpdateGate())
    for plan in (SessionPlan("start"), SessionPlan("continue", "codex-session-1"),
                 SessionPlan("revert", "codex-session-1", "turn-1")):
        sent = AgentTurn(run_id=f"r-{plan.mode}", instructions="", messages=(TurnMessage("user", "hi"),),
                         tools=(), session=plan)
        expected = await _collect(plain.run(sent))
        got = await _collect(guarded.run(sent))
        assert got == expected
        assert isinstance(got[0], SessionBound) and isinstance(got[-1], Completed)
        assert guarded.turns[-1] is sent
    assert session_support(guarded) == live and isinstance(guarded, LiveSessionEngine)
    await guarded.delete_session("codex-session-1")
    assert guarded.deleted_sessions == ["codex-session-1"]


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
    assert failure.output == ("Update Claude Code…", "Claude is managed by Homebrew.",
                              "To update, run: brew upgrade claude-code", "Check Claude Code…",
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
    # User decision (FIX-1 F3.9): the legacy "Needs an update" leaves Hermes' running services alone too.
    assert RECIPES["hermes"].plan("update")[0].argv == ("{binary}", "update", "--no-gateway-restart")


# -- FIX-1 F3 (audit R3) ---------------------------------------------------------------------------


async def test_a_run_inside_a_counted_run_of_the_same_agent_is_not_blocked_by_a_queued_update(
        tmp_path: Path) -> None:
    """F3.2: work started from inside a running answer (a Codex chat's own web search, a tool's task)
    must not wait for an update that itself waits for that answer."""
    world = World(tmp_path)
    await world.updates.check()
    release = asyncio.Event()
    codex = world.engines["codex"]
    codex._script = lambda t: ([TextDelta("", "a"), Gate(release), TextDelta("", "b")] if t.run_id == "chat-1"
                               else [TextDelta("", "nested")])
    world.executor.plan.append(Step([], 0, on_done=lambda: world.set_version("codex", "0.164.0")))
    seen: dict[str, Any] = {}

    async def outer() -> None:
        stream = codex.run(turn("chat-1"))
        async for event in stream:
            if isinstance(event, TextDelta) and event.text == "a":
                await world.updates.update("codex")
                assert agent(await world.updates.view(), "codex").phase == "queued"
                # Inline (a tool handler on the reader's path) and in a task spawned from here.
                seen["inline"] = await asyncio.wait_for(_collect(codex.run(turn("nested-1"))), 1)
                spawned = asyncio.create_task(_collect(codex.run(turn("nested-2"))))
                seen["spawned"] = await asyncio.wait_for(spawned, 1)
                release.set()

    unrelated: list[Any] = []
    await outer()
    # Work from elsewhere still waits for the update; the update ran after the outer answer.
    await until(lambda: "codex" not in world.updates._runs)
    unrelated = await _collect(codex.run(turn("later")))
    assert any(isinstance(event, TextDelta) for event in seen["inline"])
    assert any(isinstance(event, TextDelta) for event in seen["spawned"])
    assert world.executor.started == [[str(world.bins["codex"]), "update"]]
    assert unrelated


async def test_other_work_still_waits_for_a_queued_update(tmp_path: Path) -> None:
    world = World(tmp_path)
    await world.updates.check()
    release = asyncio.Event()
    codex = world.engines["codex"]
    codex._script = [Gate(release), TextDelta("", "done")]
    running = asyncio.create_task(_collect(codex.run(turn("r1"))))
    await until(lambda: world.gate.busy("codex"))
    world.executor.plan.append(Step([], 0, on_done=lambda: world.set_version("codex", "0.164.0")))
    await world.updates.update("codex")
    other = asyncio.create_task(_collect(codex.run(turn("r2"))))  # its own task: not nested
    await asyncio.sleep(0.05)
    assert not other.done()
    release.set()
    await running
    await other


async def test_a_run_waiting_at_the_gate_is_not_started_in_the_engine_and_is_reported(tmp_path: Path) -> None:
    """F3.6 + F3.11: the engine's ``run`` is called only once the gate lets the run in (a run stopped while
    it waits leaves nothing in the engine); while it waits, the update view names it (the chat label)."""
    world = World(tmp_path)
    await world.updates.check()
    release = asyncio.Event()
    codex = world.engines["codex"]
    codex._script = [Gate(release)]
    running = asyncio.create_task(_collect(codex.run(turn("r1"))))
    await until(lambda: world.gate.busy("codex"))
    await world.updates.update("codex")
    waiting = asyncio.create_task(_collect(codex.run(turn("r2"))))
    await until(lambda: agent_waiting(world) == ("r2",))
    assert "r2" not in codex.active_runs()  # nothing registered in the engine while it waits
    assert [len(t.messages) for t in codex.turns] == [1]  # only r1 reached the engine
    await codex.interrupt("r2")
    events = await waiting
    assert isinstance(events[-1], Failed) and events[-1].kind == "cancelled" and events[-1].unsent
    assert "r2" not in codex.active_runs() and agent_waiting(world) == ()
    await world.updates.cancel("codex")
    release.set()
    await running


async def test_a_run_stopped_before_it_is_read_never_reaches_the_engine(tmp_path: Path) -> None:
    world = World(tmp_path)
    codex = world.engines["codex"]
    stream = codex.run(turn("r1"))
    await codex.interrupt("r1")  # the Stop came before anything read the answer
    events = await _collect(stream)
    assert isinstance(events[-1], Failed) and events[-1].kind == "cancelled"
    assert codex.turns == [] and not world.gate.busy("codex")


def agent_waiting(world: World) -> tuple[str, ...]:
    return tuple(world.gate.waiting("codex"))


async def test_the_update_view_lists_answers_waiting_for_it(tmp_path: Path) -> None:
    world = World(tmp_path)
    await world.updates.check()
    release = asyncio.Event()
    codex = world.engines["codex"]
    codex._script = [Gate(release), TextDelta("", "done")]
    running = asyncio.create_task(_collect(codex.run(turn("r1"))))
    await until(lambda: world.gate.busy("codex"))
    world.executor.plan.append(Step([], 0, on_done=lambda: world.set_version("codex", "0.164.0")))
    await world.updates.update("codex")
    waiting = asyncio.create_task(_collect(codex.run(turn("message-7"))))
    await until(lambda: agent_waiting(world) == ("message-7",))
    view = await world.updates.view()
    assert agent(view, "codex").waiting == ("message-7",) and agent(view, "opencode").waiting == ()
    release.set()
    await running
    await waiting
    assert agent(await world.updates.view(), "codex").waiting == ()


async def test_an_install_already_running_refuses_the_update_and_keeps_the_offer(tmp_path: Path) -> None:
    """F3.4: InstallBusy is no failed update (no pointless Roll back): refused at once, or — when it
    appears while the update waited — the offer simply stays."""
    world = World(tmp_path)
    await world.updates.check()
    hold = asyncio.Event()
    world.executor.plan.append(Step(["installing"], 0, hold=hold))
    legacy = world.installs.start("opencode", "update")  # "Needs an update" running for OpenCode
    with pytest.raises(UpdateRefused):
        await world.updates.update("opencode")
    view = await world.updates.view()
    assert agent(view, "opencode").failure is None and agent(view, "opencode").available
    # Queued behind running work, then an install starts before the update could.
    release = asyncio.Event()
    codex = world.engines["codex"]
    codex._script = [Gate(release)]
    running = asyncio.create_task(_collect(codex.run(turn("r1"))))
    await until(lambda: world.gate.busy("codex"))
    await world.updates.update("codex")
    other = asyncio.Event()
    world.executor.plan.append(Step(["installing codex"], 0, hold=other))
    codex_install = world.installs.start("codex", "update")
    release.set()
    await running
    await until(lambda: "codex" not in world.updates._runs)
    view = await world.updates.view()
    codex_view = agent(view, "codex")
    assert codex_view.failure is None and codex_view.available and codex_view.phase == "idle"
    for task in (legacy, codex_install):
        await world.installs.cancel(task.id)


async def test_a_failed_hermes_check_keeps_the_last_result_and_last_checked(tmp_path: Path) -> None:
    """F3.5: ``hermes update --check`` exiting non-zero (offline: "Could not resolve the stable source
    channel") is a failed check like an HTTP error, not "no update"."""
    world = World(tmp_path, versions=ONLY_HERMES)
    await world.updates.check()
    before = dict(world.settings.get(SETTINGS_KEY)["agents"]["hermes"])
    world.hermes_output = CheckOutput(1, "→ Update channel: stable\n✗ Could not resolve the stable source "
                                         "channel: fatal: unable to access 'https://github.com/…'")
    world.clock = T0 + timedelta(days=1)
    view = await world.updates.check()
    saved = world.settings.get(SETTINGS_KEY)
    assert saved["agents"]["hermes"] == before
    assert saved["checked_at"] == T0.isoformat(timespec="seconds")
    assert agent(view, "hermes").available and agent(view, "hermes").latest == "0.22.5"


class BrokenSettings(Settings):
    """Writes fail (a locked database): every check raises."""

    def __init__(self) -> None:
        super().__init__()
        self.writes = 0

    def set(self, key: str, value: Any) -> None:
        self.writes += 1
        raise OSError("database is locked")


async def test_a_failing_background_check_backs_off(tmp_path: Path) -> None:
    """F3.7: a check that raises (nothing was saved) waits before the next try instead of spinning."""
    store = BrokenSettings()
    world = World(tmp_path, store=store, retry_delay=timedelta(hours=1))
    world.updates.start()
    await asyncio.sleep(0.3)
    await world.updates.aclose()
    assert store.writes == 1


async def test_a_successful_update_or_rollback_is_told_to_the_hub_a_failed_one_is_not(tmp_path: Path) -> None:
    """F3.8: after a Hermes update the hub stops SKAZ's own Hermes gateway (the next answer starts the new
    version); a rollback the same; a failed command changes nothing to restart."""
    world = World(tmp_path, versions=ONLY_HERMES)
    await world.updates.check()
    world.executor.plan.append(Step([], 0, on_done=lambda: world.set_version("hermes", "0.22.5")))
    await world.updates.update("hermes")
    await until(lambda: "hermes" not in world.updates._runs)
    assert world.after == ["hermes"]
    world2 = World(tmp_path / "second")
    await world2.updates.check()
    world2.executor.plan.append(Step(["npm error code EACCES"], 1))
    await world2.updates.update("codex")
    await until(lambda: "codex" not in world2.updates._runs)
    assert world2.after == []
    # OpenCode: the command ran but the recheck failed (no restart), then a rollback that worked.
    broken = EngineStatus("opencode", installed=True, version="1.19.4", incompatible=True, reason="Bad.")
    world2.executor.plan.append(Step([], 0, on_done=lambda: setattr(world2.engines["opencode"], "_status",
                                                                   broken)))
    await world2.updates.update("opencode")
    await until(lambda: "opencode" not in world2.updates._runs)
    assert world2.after == []
    world2.executor.plan.append(Step([], 0, on_done=lambda: world2.set_version("opencode", "1.17.18")))
    await world2.updates.rollback("opencode")
    await until(lambda: "opencode" not in world2.updates._runs)
    assert world2.after == ["opencode"]


async def test_codex_web_search_waits_for_an_update_of_codex() -> None:
    """F3.3: Codex's web search runs its own ``codex app-server``; it passes the gate like any run."""
    from skaz.knowledge.agents.web_runner import CodexSearch

    class Connection:
        cwd = Path("/nonexistent")
        spawned = 0

        def rpc(self, **_: Any) -> Any:
            Connection.spawned += 1
            raise ValueError("no codex in this test")

    gate = UpdateGate()
    codex = FakeEngine("codex", script=[TextDelta("", "x")])
    guard(codex, gate)
    updating = asyncio.Event()
    done = asyncio.Event()

    async def update() -> None:
        async with gate.exclusive("codex"):
            updating.set()
            await done.wait()

    job = asyncio.create_task(update())
    await updating.wait()
    search = asyncio.create_task(CodexSearch(Connection()).search(codex, "entropy"))
    await asyncio.sleep(0.05)
    assert Connection.spawned == 0 and not search.done()
    done.set()
    await job
    outcome = await search
    assert Connection.spawned == 1 and outcome.error


async def test_codex_engine_forgets_its_status_on_reset(tmp_path: Path) -> None:
    """F3.1 (HIGH): after ``codex update`` the registry's refresh must read the new version, not the
    real CodexEngine's 60 s status cache ("Codex wasn't updated" after a good update)."""
    from skaz.knowledge.agents.codex import CodexEngine

    class Connection:
        cwd = tmp_path
        binary: str | None = "/fixture/codex"

        def __init__(self) -> None:
            self.version = "codex-cli 0.160.0"

        async def check(self) -> dict[str, Any]:
            return {"status": "connected", "version": self.version, "path": self.binary}

        def rpc(self, **_: Any) -> Any:
            raise ValueError("not used")

    connection = Connection()
    codex = CodexEngine(connection, None)
    engines: dict[EngineId, AgentEngine] = {
        engine: FakeEngine(engine, status=status(engine, None, False))
        for engine in ("claude_code", "hermes", "opencode")}
    registry = EngineRegistry({"codex": codex, **engines}, Settings())
    assert (await registry.view("codex")).status.version == "0.160.0"
    connection.version = "codex-cli 0.164.0"
    assert (await registry.view("codex", refresh=True)).status.version == "0.164.0"


async def test_hub_exposes_whether_an_agent_is_blocked_by_an_update() -> None:
    """For F1's session deletions: ``update_gate.blocked(engine)`` on the engine object."""
    from skaz.knowledge.agents.update_gate import blocked
    gate = UpdateGate()
    codex = FakeEngine("codex")
    guard(codex, gate)
    assert not blocked(codex) and not blocked(FakeEngine("hermes"))
    async with gate.exclusive("codex"):
        assert blocked(codex)
    assert not blocked(codex)


async def _collect(events: AsyncIterator[Any]) -> list[Any]:
    return [event async for event in events]


async def test_the_hub_stops_skazs_own_hermes_gateway_after_a_hermes_update_only(tmp_path: Path) -> None:
    """F3.8 wiring: the hub's hook calls the existing planned stop of SKAZ's Hermes gateway
    (``HermesEngine.aclose``) for Hermes and nothing for other agents. No agent is started."""
    from skaz.knowledge.agents.hermes import HermesEngine
    from skaz.knowledge.agents.hub import build_agents_hub

    hub = build_agents_hub(tmp_path / "data", settings=Settings(), codex=object(),  # type: ignore[arg-type]
                           locate_cli=lambda _name: None, user_home=tmp_path)
    hermes = hub.registry.engine("hermes")
    assert isinstance(hermes, HermesEngine) and hub.updates is not None and hub.gate is not None
    stops: list[str] = []

    async def stop(**_: Any) -> None:
        stops.append("hermes")

    hermes.aclose = stop  # type: ignore[method-assign]
    hook = hub.updates._after_update
    assert hook is not None
    await hook("codex")
    assert stops == []
    await hook("hermes")
    assert stops == ["hermes"]
    assert not hub.blocked("hermes")
    async with hub.gate.exclusive("hermes"):
        assert hub.blocked("hermes") and not hub.blocked("codex")
