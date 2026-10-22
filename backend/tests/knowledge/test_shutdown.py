"""Quitting SKAZ leaves no agent or ``llama-server`` process behind, within Electron's grace (review B2 #5).

Real child processes, fake programs: the Claude Code and Hermes fakes
(``agent_fakes``) and a stand-in ``llama-server`` that ignore SIGINT/SIGTERM and
have a child of their own — the worst case of an agent busy in a long answer
or a server still loading its model. The app's own lifespan shutdown runs.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import re
import signal
import subprocess
import sys
import time
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any

from skaz.knowledge import shutdown as shutdown_module
from skaz.knowledge.agents.claude_code import ClaudeCodeEngine
from skaz.knowledge.agents.engine import AgentEvent, AgentTurn, TurnMessage
from skaz.knowledge.agents.hermes import HermesEngine
from tests.knowledge.agent_fakes import FakeCli
from tests.knowledge.test_agent_hermes import scenario as hermes_scenario

ROOT = Path(__file__).resolve().parents[3]
#: Electron SIGKILLs the backend this long after SIGTERM (electron/backend.ts).
ELECTRON_GRACE_S = 4.0
STUBBORN = ("import signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "signal.signal(signal.SIGINT, signal.SIG_IGN); time.sleep(600)")


def _turn(run_id: str) -> AgentTurn:
    return AgentTurn(run_id=run_id, messages=(TurnMessage("user", "What is entropy?"),),
                     instructions="Answer from the SKAZ wiki only.", tools=None)


async def _drain(events: AsyncIterator[AgentEvent]) -> list[AgentEvent]:
    return [event async for event in events]


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True,
                           text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")  # a zombie has exited; only its exit status is left


async def _wait_for(check: Any, timeout: float = 15.0) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = check()
        if found:
            return found
        await asyncio.sleep(0.05)
    raise AssertionError("the fake process did not start")


async def _survivors(pids: Sequence[int], timeout: float = 1.0) -> list[int]:
    deadline = time.monotonic() + timeout
    while True:
        alive = [pid for pid in pids if _alive(pid)]
        if not alive or time.monotonic() > deadline:
            return alive
        await asyncio.sleep(0.05)


async def test_quitting_stops_every_agent_and_llama_server_process_within_the_grace(
    kb_app: Any, tmp_path: Path,
) -> None:
    runtime = kb_app.state.runtime
    pids: list[int] = []
    tasks: list[asyncio.Task[Any]] = []
    loop = asyncio.get_running_loop()
    try:
        async with kb_app.router.lifespan_context(kb_app):
            # Claude Code busy in an answer (the app's own engine, a fake CLI).
            claude = runtime.kb_agents.registry.engine("claude_code")
            assert isinstance(claude, ClaudeCodeEngine)
            claude_cli = FakeCli(tmp_path / "bin", "claude", {"stubborn": True, "hang": True, "stream": []})
            claude._locate = claude_cli.locate
            tasks.append(asyncio.create_task(_drain(claude.run(_turn("run-claude")))))
            # Hermes over ACP, checked and busy.
            hermes = runtime.kb_agents.registry.engine("hermes")
            assert isinstance(hermes, HermesEngine)
            hermes_cli = FakeCli(tmp_path / "bin", "hermes", hermes_scenario(stubborn=True, hang=True))
            hermes._locate = hermes_cli.locate
            hermes.prepare()
            hermes.mark_checked()
            tasks.append(asyncio.create_task(_drain(hermes.run(_turn("run-hermes")))))
            # llama-server launched and still loading its model (not healthy yet).
            server: list[asyncio.subprocess.Process] = []

            async def launch(_argv: Sequence[str], env: dict[str, str],
                             _log: Path) -> asyncio.subprocess.Process:
                process = await asyncio.create_subprocess_exec(sys.executable, "-c", STUBBORN, env=env)
                server.append(process)
                return process

            manager = runtime.kb_decisions.manager
            manager._launch = launch
            manager.start_timeout_s = 600
            tasks.append(asyncio.create_task(manager._start()))

            for cli in (claude_cli, hermes_cli):
                found = await _wait_for(lambda cli=cli: cli.records("stubborn"))
                pids += [found[0]["pid"], found[0]["child"]]
            await _wait_for(lambda: server)
            pids.append(server[0].pid)
            assert all(_alive(pid) for pid in pids)
            quitting = loop.time()
        took = loop.time() - quitting

        survivors = await _survivors(pids)
        assert survivors == [], f"orphaned after quit: {survivors}"
        assert took < ELECTRON_GRACE_S - 0.5, f"shutdown took {took:.1f} s; Electron kills the backend at 4 s"
    finally:
        for pid in pids:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_a_service_that_hangs_while_closing_does_not_hold_the_quit(kb_app: Any) -> None:
    runtime = kb_app.state.runtime
    closed: list[str] = []

    async def hangs() -> None:
        await asyncio.sleep(30)

    async def ingest_close() -> None:
        closed.append("ingest")

    runtime.kb_chats.close = hangs
    runtime.kb_ingest.close = ingest_close
    started = time.monotonic()
    await shutdown_module.close_knowledge(runtime, deadline_s=0.5)
    assert time.monotonic() - started < 1.5
    assert closed == ["ingest"]  # the others still closed, in parallel


def test_the_backend_deadline_fits_inside_the_electron_grace() -> None:
    source = (ROOT / "electron" / "backend.ts").read_text(encoding="utf-8")
    match = re.search(r"const SHUTDOWN_GRACE_MS = ([\d_]+);", source)
    assert match is not None
    grace_s = int(match.group(1).replace("_", "")) / 1000
    assert grace_s == ELECTRON_GRACE_S
    # The knowledge part plus a margin for the rest of the shutdown (recordings, imports, the database).
    assert grace_s >= shutdown_module.DEADLINE_S + 1.0
    # Uvicorn first waits for requests still in flight (bounded since decision 11), then the lifespan.
    from skaz.__main__ import REQUESTS_GRACE_S
    assert grace_s >= REQUESTS_GRACE_S + shutdown_module.DEADLINE_S + 0.5


async def test_codex_stops_its_running_answers_together(kb_app: Any) -> None:
    """Each app-server gets up to 2 s to exit; four answers must not cost 8 s of the grace."""
    from skaz.knowledge.agents.codex import CodexEngine, _Run

    class SlowRpc:
        closed = False

        async def close(self) -> None:
            await asyncio.sleep(0.5)
            self.closed = True

    engine = CodexEngine(kb_app.state.runtime.codex_connection, None)
    rpcs = [SlowRpc() for _ in range(4)]
    for index, rpc in enumerate(rpcs):
        engine._runs[f"run-{index}"] = _Run(f"run-{index}", rpc=rpc)  # type: ignore[arg-type]
    started = time.monotonic()
    await engine.close()
    assert all(rpc.closed for rpc in rpcs)
    assert time.monotonic() - started < 1.2
