"""Installers on a fake executor: official commands, journal, plain failure reasons, cancel, never sudo."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from collections.abc import AsyncIterator, Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge.agents.engine import EngineId, EngineStatus
from skaz.knowledge.install.errors import failure_reason
from skaz.knowledge.install.recipes import RECIPES
from skaz.knowledge.install.runner import SubprocessExecutor, clean_line
from skaz.knowledge.install.system import ElevationRefused, refuse_sudo
from skaz.knowledge.install.tasks import InstallBusy, InstallManager, InstallTask

HANG = object()


class FakeStep:
    def __init__(self, lines: Sequence[str], code: int, hang: bool) -> None:
        self._lines, self._code, self._hang = lines, code, hang
        self.terminated = False
        self._stop = asyncio.Event()

    async def lines(self) -> AsyncIterator[str]:
        for line in self._lines:
            yield line + "\n"
        if self._hang:
            await self._stop.wait()

    async def wait(self) -> int:
        return self._code

    async def terminate(self) -> None:
        self.terminated = True
        self._stop.set()


class FakeExecutor:
    """Plays scripted output per step; records argv/cwd/env of every started step."""

    def __init__(self, plan: Sequence[tuple[Sequence[str], int] | object]) -> None:
        self.plan = list(plan)
        self.started: list[dict[str, Any]] = []
        self.steps: list[FakeStep] = []

    async def start(self, argv: Sequence[str], *, cwd: Path | None, env: Mapping[str, str]) -> FakeStep:
        self.started.append({"argv": list(argv), "cwd": cwd, "env": dict(env)})
        item = self.plan.pop(0) if self.plan else ([], 0)
        if isinstance(item, tuple):
            lines, code = item
            step = FakeStep(lines, code, False)
        else:
            step = FakeStep([], 0, True)  # HANG: runs until terminated
        self.steps.append(step)
        return step


def manager(
    tmp_path: Path, executor: FakeExecutor, status: EngineStatus | None = None, timeout_s: float = 60
) -> tuple[InstallManager, list[EngineId]]:
    verified: list[EngineId] = []

    async def verify(engine: EngineId) -> EngineStatus:
        verified.append(engine)
        return status or EngineStatus(engine, installed=True, version="2.1.300", signed_in=False)

    async def resolve(engine: EngineId) -> dict[str, str]:
        return {
            "binary": f"/Users/me/.local/bin/{RECIPES[engine].binary}",
            "install_dir": "/Users/me/.hermes/hermes-agent",
            "hermes_home": "/skaz/agents/hermes-home",
            "hermes_policy": "/skaz/agents/hermes-policy",
            "hermes_runtime": "/Users/me/.hermes/tools",
        }

    return InstallManager(
        tmp_path / "install",
        verify=verify,
        resolve=resolve,
        executor=executor,
        timeout_s=timeout_s,
        env={"PATH": "/usr/bin:/bin"},
    ), verified


async def finished(task: InstallTask) -> InstallTask:
    for _ in range(200):
        if task.state != "running":
            return task
        await asyncio.sleep(0.01)
    raise AssertionError("task did not finish")


async def test_success_runs_the_official_installer_then_checks_the_version(tmp_path: Path) -> None:
    executor = FakeExecutor([(["Downloading Claude Code...", "\x1b[32m✔\x1b[0m Installed 2.1.300"], 0)])
    installs, verified = manager(tmp_path, executor)
    task = await finished(installs.start("claude_code", "install"))
    assert task.state == "succeeded" and task.reason is None and task.version == "2.1.300"
    assert executor.started[0]["argv"] == [
        "/bin/bash",
        "-c",
        "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash",
    ]
    assert [line.text for line in task.lines] == [
        "$ /bin/bash -c set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash",
        "Downloading Claude Code...",
        "✔ Installed 2.1.300",
        "Claude Code 2.1.300 is ready.",
    ]
    assert [line.seq for line in task.after(2)] == [3, 4]
    assert verified == ["claude_code"]
    env = executor.started[0]["env"]
    assert env["PATH"].split(os.pathsep)[0] == str(tmp_path / "install" / "no-sudo")
    assert env["HOME"] == str(Path.home())


async def test_network_failure_has_a_plain_reason_and_manual_command(tmp_path: Path) -> None:
    executor = FakeExecutor([(["curl: (6) Could not resolve host: claude.ai"], 6)])
    installs, verified = manager(tmp_path, executor)
    task = await finished(installs.start("claude_code", "install"))
    assert task.state == "failed" and verified == []
    assert task.reason == (
        "Run the official Claude Code installer failed. SKAZ couldn't download the installer. "
        "Check the internet connection and try again."
    )
    assert task.recipe.manual_command == "curl -fsSL https://claude.ai/install.sh | bash"
    assert task.recipe.docs_url == "https://code.claude.com/docs/en/setup"


async def test_cancel_stops_the_running_step(tmp_path: Path) -> None:
    executor = FakeExecutor([HANG])
    installs, verified = manager(tmp_path, executor)
    task = installs.start("codex", "install")
    for _ in range(100):
        if executor.steps:
            break
        await asyncio.sleep(0.01)
    assert installs.start("codex", "install") is task  # a second click joins the running task, no queue
    await installs.cancel(task.id)
    assert task.state == "cancelled" and executor.steps[0].terminated and verified == []
    assert task.lines[-1].text == "Cancelled."


async def test_timeout_stops_the_installer(tmp_path: Path) -> None:
    executor = FakeExecutor([HANG])
    installs, _ = manager(tmp_path, executor, timeout_s=0.2)
    task = await finished(installs.start("codex", "install"))
    assert task.state == "failed" and executor.steps[0].terminated
    assert task.reason is not None and task.reason.startswith("The installation took longer than")


async def test_outdated_after_install_is_a_failure_with_update_reason(tmp_path: Path) -> None:
    outdated = EngineStatus(
        "claude_code",
        installed=True,
        version="2.1.100",
        incompatible=True,
        reason="Claude Code 2.1.100 is outdated — version 2.1.259 or newer is required.",
    )
    installs, _ = manager(tmp_path, FakeExecutor([([], 0)]), status=outdated)
    task = await finished(installs.start("claude_code", "update"))
    assert task.state == "failed" and task.reason == outdated.reason
    missing = EngineStatus("claude_code", installed=False)
    installs, _ = manager(tmp_path / "m", FakeExecutor([([], 0)]), status=missing)
    task = await finished(installs.start("claude_code", "install"))
    assert task.state == "failed" and "can't find Claude Code" in (task.reason or "")


async def test_hermes_procedure_adds_the_acp_extra_and_checks_it(tmp_path: Path) -> None:
    executor = FakeExecutor([([], 0), ([], 0), (["Hermes ACP check OK"], 0)])
    installs, _ = manager(tmp_path, executor)
    task = await finished(installs.start("hermes", "update"))
    assert task.state == "succeeded"
    assert [step["argv"] for step in executor.started] == [
        ["/Users/me/.local/bin/hermes", "update"],
        [
            "/Users/me/.hermes/hermes-agent/scripts/run-in-hermes-env",
            "python",
            "-c",
            "import pm; pm.sync_venv(['acp'], explicit=True)",
        ],
        ["/Users/me/.local/bin/hermes", "acp", "--check"],
    ]
    assert executor.started[1]["cwd"] == Path("/Users/me/.hermes/hermes-agent")
    # Review C1: the check runs in SKAZ's Hermes folder on the user's own tool store; the official
    # updater and the ACP extra run as the user's Hermes (no SKAZ folder).
    assert {key: executor.started[2]["env"].get(key) for key in ("HERMES_HOME", "HERMES_MANAGED_DIR",
                                                                "HERMES_RUNTIME_DIR")} == {
        "HERMES_HOME": "/skaz/agents/hermes-home",
        "HERMES_MANAGED_DIR": "/skaz/agents/hermes-policy",
        "HERMES_RUNTIME_DIR": "/Users/me/.hermes/tools",
    }
    assert not any("HERMES_HOME" in step["env"] for step in executor.started[:2])
    install = RECIPES["hermes"].plan("install")[0].argv
    assert install[-1].endswith(
        "https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive"
    )


def test_no_command_of_any_recipe_uses_sudo() -> None:
    for recipe in RECIPES.values():
        for action in ("install", "update"):
            for step in recipe.plan(action):
                refuse_sudo(step.argv)
                assert not any("sudo" in part for part in step.argv), (recipe.engine, step)
        assert "sudo" not in recipe.manual_command
    for bad in (
        ["sudo", "npm", "i", "-g", "x"],
        ["/bin/bash", "-c", "curl x | sudo bash"],
        ["/usr/bin/sudo", "true"],
        ["bash", "-c", "doas make install"],
        ["su", "-c", "x"],
    ):
        with pytest.raises(ElevationRefused):
            refuse_sudo(bad)
    refuse_sudo(["bash", "-c", "pseudo_tool --sudoers-free"])  # words that merely contain it are fine


async def test_installers_cannot_reach_a_real_sudo(tmp_path: Path) -> None:
    installs, _ = manager(tmp_path, FakeExecutor([]))
    env = installs.environment()
    result = subprocess.run(
        ["sudo", "-n", "true"], env=env, capture_output=True, text=True, check=False, stdin=subprocess.DEVNULL
    )
    assert result.returncode == 1 and "never runs commands with administrator rights" in result.stderr


async def test_hermes_repair_runs_its_own_repair_for_skaz_folder_then_checks(tmp_path: Path) -> None:
    executor = FakeExecutor([([], 0), (["Hermes ACP check OK"], 0)])
    installs, _ = manager(tmp_path, executor)
    task = await finished(installs.start("hermes", "repair"))
    assert task.state == "succeeded"
    assert [step["argv"] for step in executor.started] == [
        ["/Users/me/.local/bin/hermes", "pm", "repair"],
        ["/Users/me/.local/bin/hermes", "acp", "--check"],
    ]
    assert executor.started[0]["env"]["HERMES_HOME"] == "/skaz/agents/hermes-home"
    # Agents without a repair of their own are refused, not "repaired" by something else.
    with pytest.raises(InstallBusy):
        installs.start("codex", "repair")


def test_failure_reasons_in_plain_words() -> None:
    # H3: Hermes refusing to "update" a newer canary build is not a broken installer.
    assert "No update is needed" in failure_reason(
        ["Refusing to move: v0.21.5 predates the installed v0.22.1. Downgrading is unsupported."], 1)
    assert "disk space" in failure_reason(["write error: No space left on device"], 1)
    assert "needs Node.js" in failure_reason(["bash: npm: command not found"], 127)
    assert "needs Python" in failure_reason(["python3: command not found"], 127)
    assert "no permission" in failure_reason(["mkdir: /usr/local/lib: Permission denied"], 1)
    assert "internet connection" in failure_reason(["curl: (7) Failed to connect to claude.ai port 443"], 7)
    assert failure_reason(["something odd"], 3) == (
        "The installer stopped with an error (exit code 3). See the log, or install manually."
    )


def test_log_lines_are_cleaned() -> None:
    assert clean_line("\x1b[1;32mOK\x1b[0m\n") == "OK"
    assert clean_line("10%\r50%\r100%\r") == "100%"
    assert len(clean_line("x" * 5000)) == 2000


async def test_subprocess_executor_streams_lines_and_kills_the_group_on_cancel(tmp_path: Path) -> None:
    script = tmp_path / "installer.py"
    script.write_text(
        "import sys, time\nprint('step one', flush=True)\n"
        "print('step two', file=sys.stderr, flush=True)\ntime.sleep(30)\n"
    )
    step = await SubprocessExecutor().start(
        [sys.executable, str(script)], cwd=tmp_path, env={"PATH": "/usr/bin:/bin"}
    )
    seen: list[str] = []
    async for line in step.lines():
        seen.append(line.strip())
        if len(seen) == 2:
            break
    assert sorted(seen) == ["step one", "step two"]
    await step.terminate()
    assert await step.wait() != 0
