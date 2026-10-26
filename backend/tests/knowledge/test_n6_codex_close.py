"""N6 S1 (decision 19): closing a Codex connection leaves no process holding a live thread.

Live threads are resumed by the next answer's app-server; a native ``codex`` left running after its npm
shim died keeps the thread ("already has an active writer", measured on codex 0.160). So closing first
ends the pipe (Codex exits cleanly and releases the thread) and only a stubborn process gets signals —
to its whole group, so the shim's native child goes too.

Real subprocess boundary (``tests/fixtures/codex_rpc_server.py``), no Codex CLI.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

from skaz.gateways import codex_rpc
from skaz.gateways.codex_rpc import CodexRpc
from skaz.knowledge.processes import ChildProcesses

FIXTURE = Path(__file__).parents[1] / "fixtures" / "codex_rpc_server.py"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def test_closing_lets_codex_exit_cleanly_on_its_own(tmp_path: Path) -> None:
    marker = tmp_path / "clean-exit"
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path,
                        env={"SKAZ_TEST_CLEAN_EXIT": str(marker)}) as client:
        await client.request("fixture/pid", {})
    assert marker.read_text() == "clean"  # stdin closed first: no SIGTERM cut the exit short


async def test_closing_a_stubborn_codex_also_stops_its_native_child(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    children = ChildProcesses()
    monkeypatch.setattr(codex_rpc, "CHILDREN", children)
    monkeypatch.setattr(codex_rpc, "CLOSE_GRACE_S", 0.3)
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as client:
        native = await client.request("fixture/stubborn", {})
        assert _alive(native)
    async with asyncio.timeout(5):
        while _alive(native):
            await asyncio.sleep(0.05)
    assert children.running() == []
