"""Install/update tasks: started only by an explicit request, one per agent at a time, cancellable.

Each task runs the recipe's steps in order, keeps the merged output as a
numbered log (the UI polls with ``after=<seq>``), stops on the first failing
step with a plain reason, and finally checks the installed version against the
agent's minimum. Nothing runs with administrator rights: commands are checked,
stdin is closed and a ``sudo`` stand-in that always refuses comes first on PATH.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from ...gateways.codex_locate import search_path
from ..agents.engine import EngineId, EngineStatus
from ..errors import KnowledgeError, NotFound
from .errors import StepRefused, StepWatch, failure_reason
from .recipes import RECIPES, Action, Recipe, Step
from .runner import Executor, RunningStep, SubprocessExecutor, clean_line
from .system import ElevationRefused, base_env, refuse_sudo

TaskState = Literal["running", "succeeded", "failed", "cancelled"]
DEFAULT_TIMEOUT_S = 20 * 60
MAX_LINES = 5000
SUDO_SHIM = "#!/bin/sh\necho 'SKAZ never runs commands with administrator rights.' >&2\nexit 1\n"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@dataclass(frozen=True)
class LogLine:
    seq: int
    text: str
    at: str


@dataclass
class InstallTask:
    id: str
    engine: EngineId
    action: Action
    recipe: Recipe
    state: TaskState = "running"
    lines: list[LogLine] = field(default_factory=list)
    reason: str | None = None
    version: str | None = None
    started_at: str = field(default_factory=_now)
    finished_at: str | None = None
    dropped: int = 0
    _seq: int = 0
    _changed: asyncio.Event = field(default_factory=asyncio.Event)

    def log(self, text: str) -> None:
        self._seq += 1
        self.lines.append(LogLine(self._seq, text, _now()))
        if len(self.lines) > MAX_LINES:
            del self.lines[0]
            self.dropped += 1
        self._signal()

    def finish(self, state: TaskState, reason: str | None = None) -> None:
        self.state, self.reason, self.finished_at = state, reason, _now()
        self._signal()

    def _signal(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()

    def after(self, seq: int) -> list[LogLine]:
        return [line for line in self.lines if line.seq > seq]

    async def wait_change(self, seq: int, timeout: float) -> None:
        """Long-poll: return when there are lines after ``seq``, the task ended, or the timeout passed."""
        if self.state != "running" or self._seq > seq or timeout <= 0:
            return
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._changed.wait(), timeout)


class InstallBusy(KnowledgeError):
    status_code = 409


Verify = Callable[[EngineId], Awaitable[EngineStatus]]
Resolve = Callable[[EngineId], Awaitable[Mapping[str, str]]]
#: Called after every step of a task succeeded, before the result check (e.g. "Hermes is prepared").
AfterSteps = Callable[[EngineId, Action], None]
#: Watch around one step given its extra environment (Hermes' launchers, review C1); ``None``: no watch.
WatchStep = Callable[[EngineId, Mapping[str, str]], StepWatch | None]


class InstallManager:
    def __init__(self, work_dir: Path, *, verify: Verify, resolve: Resolve,
                 executor: Executor | None = None, recipes: Mapping[EngineId, Recipe] | None = None,
                 timeout_s: float = DEFAULT_TIMEOUT_S, env: Mapping[str, str] | None = None,
                 after_steps: AfterSteps | None = None, watch_step: WatchStep | None = None) -> None:
        self.work_dir = work_dir
        self._watch_step = watch_step
        self._verify = verify
        self._resolve = resolve
        self._after_steps = after_steps
        self._executor: Executor = executor or SubprocessExecutor()
        self.recipes: Mapping[EngineId, Recipe] = recipes or RECIPES
        self._timeout = timeout_s
        self._env = env
        self._tasks: dict[str, InstallTask] = {}
        self._running: dict[str, asyncio.Task[None]] = {}

    def environment(self) -> dict[str, str]:
        """Home-folder install environment: sudo stand-in first, then the user's PATH."""
        shim = self.work_dir / "no-sudo"
        shim.mkdir(mode=0o700, parents=True, exist_ok=True)
        for name in ("sudo", "doas"):
            target = shim / name
            if not target.exists():
                target.write_text(SUDO_SHIM, encoding="utf-8")
                os.chmod(target, 0o700)
        source = dict(self._env) if self._env is not None else None
        env = base_env(os.pathsep.join([str(shim), search_path(source)]))
        env.update({"NONINTERACTIVE": "1", "HOMEBREW_NO_AUTO_UPDATE": "1"})
        return env

    def start(self, engine: EngineId, action: Action) -> InstallTask:
        for task in self._tasks.values():
            if task.engine == engine and task.state == "running":
                if task.action != action:
                    raise InstallBusy(f"{task.recipe.name} is already being installed or updated.")
                return task
        recipe = self.recipes[engine]
        if action == "first_check" and not recipe.first_check:
            raise InstallBusy(f"{recipe.name} has nothing to check first.")
        if action == "repair" and not recipe.repair:
            raise InstallBusy(f"{recipe.name} has no repair of its own. Reinstall it instead.")
        task = InstallTask(uuid.uuid4().hex, engine, action, recipe)
        self._tasks[task.id] = task
        self._running[task.id] = asyncio.create_task(self._run(task))
        return task

    def get(self, task_id: str) -> InstallTask:
        task = self._tasks.get(task_id)
        if task is None:
            raise NotFound("Installation not found.")
        return task

    def running_for(self, engine: EngineId) -> InstallTask | None:
        return next((t for t in self._tasks.values() if t.engine == engine and t.state == "running"), None)

    async def cancel(self, task_id: str) -> InstallTask:
        task = self.get(task_id)
        runner = self._running.get(task_id)
        if runner is not None and not runner.done():
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)
        return task

    async def aclose(self) -> None:
        for task_id in list(self._running):
            await self.cancel(task_id)

    async def _run(self, task: InstallTask) -> None:
        step_handle: list[RunningStep] = []
        try:
            async with asyncio.timeout(self._timeout):
                if await self._steps(task, step_handle):
                    if self._after_steps is not None:
                        self._after_steps(task.engine, task.action)
                    await self._check_result(task)
        except asyncio.CancelledError:
            await self._stop(step_handle)
            task.log("Cancelled.")
            task.finish("cancelled", "The installation was cancelled. Nothing else will run.")
        except TimeoutError:
            await self._stop(step_handle)
            minutes = round(self._timeout / 60)
            task.finish("failed", f"The installation took longer than {minutes} minutes and was stopped.")
        except (ElevationRefused, StepRefused) as error:
            task.finish("failed", str(error))
        except OSError as error:
            task.finish("failed", f"SKAZ couldn't run the installer: {error.strerror or error}.")
        finally:
            self._running.pop(task.id, None)

    @staticmethod
    async def _stop(step_handle: list[RunningStep]) -> None:
        if step_handle:
            with contextlib.suppress(Exception):
                await asyncio.shield(step_handle[-1].terminate())

    async def _steps(self, task: InstallTask, step_handle: list[RunningStep]) -> bool:
        env = self.environment()
        for step in task.recipe.plan(task.action):
            argv, cwd, extra = await self._fill(task.engine, step)
            refuse_sudo(argv)
            task.log(f"$ {' '.join(argv)}")
            watch = self._watch_step(task.engine, extra) if self._watch_step is not None else None
            handle = await self._executor.start(argv, cwd=Path(cwd) if cwd else None, env={**env, **extra})
            step_handle.append(handle)
            seen: list[str] = []
            try:
                async for raw in handle.lines():
                    text = clean_line(raw)
                    if text:
                        seen.append(text)
                        task.log(text)
                code = await handle.wait()
            except BaseException:
                if watch is not None:  # cancelled or timed out: still put back what points into SKAZ
                    with contextlib.suppress(StepRefused):
                        watch.check()
                raise
            if watch is not None:
                watch.check()  # StepRefused: the step's result must not count (the task fails)
            if code != 0:
                task.finish("failed", f"{step.label} failed. {failure_reason(seen, code)}")
                return False
        return True

    async def _fill(self, engine: EngineId, step: Step) -> tuple[list[str], str | None, dict[str, str]]:
        needs = any("{" in part for part in (*step.argv, step.cwd or "", *(value for _, value in step.env)))
        values = dict(await self._resolve(engine)) if needs else {}
        try:
            argv = [part.format(**values) for part in step.argv]
            cwd = step.cwd.format(**values) if step.cwd else None
            extra = {name: value.format(**values) for name, value in step.env}
        except KeyError as missing:
            raise OSError(f"the {task_name(engine)} folder ({missing}) was not found") from missing
        return argv, cwd, extra

    async def _check_result(self, task: InstallTask) -> None:
        status = await self._verify(task.engine)
        name = task.recipe.name
        task.version = status.version
        if not status.installed:
            task.finish("failed", f"The installer finished, but SKAZ can't find {name}. Open a new Terminal "
                                  "window to check it, or install manually.")
        elif status.repairable or (task.action == "repair" and status.version is None):
            # The repair has to make the agent answer again; otherwise it didn't help.
            task.finish("failed", status.reason or f"The repair finished, but {name} still doesn't start.")
        elif status.incompatible:
            task.finish("failed", status.reason or f"The installed {name} can't be used by SKAZ.")
        elif task.action == "first_check":
            task.log(f"{name} runs with SKAZ's own Hermes folder.")
            task.finish("succeeded")
        else:
            task.log(f"{name} {status.version or ''} is ready.".replace("  ", " "))
            task.finish("succeeded")


def task_name(engine: EngineId) -> str:
    return RECIPES[engine].name
