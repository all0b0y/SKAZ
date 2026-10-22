"""Security review 0.3.1, S-08: Codex app-server processes (chat, wiki, and the W-3b search run) are
registered with the backend's child registry, so quitting SKAZ (``_Server.handle_exit`` →
``CHILDREN.signal_all``) stops them too — not only their stdin closing. Codex keeps its own process
group (no ``start_new_session``): it is signalled as a single process.

Real subprocess boundary (the fixture server of ``tests/test_codex_rpc.py``), no Codex CLI.
"""
from __future__ import annotations

import asyncio
import signal
import sys
from pathlib import Path

import pytest

from skaz.gateways import codex_rpc
from skaz.gateways.codex_rpc import CodexRpc, CodexRpcError
from skaz.knowledge.processes import ChildProcesses

FIXTURE = Path(__file__).parents[1] / "fixtures" / "codex_rpc_server.py"


async def test_a_running_codex_process_is_registered_until_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    children = ChildProcesses()
    monkeypatch.setattr(codex_rpc, "CHILDREN", children)
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as client:
        pid = await client.request("fixture/pid", {})
        assert children.running() == [pid]
    assert children.running() == []


async def test_quitting_skaz_terminates_a_running_codex_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    children = ChildProcesses()
    monkeypatch.setattr(codex_rpc, "CHILDREN", children)
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as client:
        await client.request("fixture/pid", {})
        assert children.signal_all(signal.SIGTERM) == 1  # what _Server.handle_exit does
        with pytest.raises(CodexRpcError):
            async with asyncio.timeout(5):
                while True:
                    await client.request("fixture/pid", {})
                    await asyncio.sleep(0.05)
    assert children.running() == []
