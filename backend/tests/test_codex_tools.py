"""Dynamic tools across the subprocess boundary; no provider/model calls."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import pytest

from skaz.gateways.codex_rpc import CodexRpc
from skaz.gateways.codex_tools import CodexTools

FIXTURE = Path(__file__).parent / "fixtures" / "codex_rpc_server.py"


def call(**changes: Any) -> dict[str, Any]:
    return {
        "threadId": "thread-a", "turnId": "turn-a", "callId": "call-a",
        "tool": "skaz_read_range", "arguments": {"start_ms": 0, "end_ms": 1000},
        **changes,
    }


async def test_registered_tool_round_trip(tmp_path: Path) -> None:
    received: list[dict[str, Any]] = []

    async def read_range(arguments: dict[str, Any]) -> str:
        received.append(arguments)
        return "[session-a:0-1000] Authored source fixture"

    tools = CodexTools("thread-a", "turn-a", {"skaz_read_range": read_range})
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}, tools=tools) as rpc:
        response = await rpc.request("fixture/tool", call())
    assert received == [{"start_ms": 0, "end_ms": 1000}]
    assert response == {
        "success": True,
        "contentItems": [{"type": "inputText", "text": "[session-a:0-1000] Authored source fixture"}],
    }


@pytest.mark.parametrize("changes", [
    {"threadId": "another-chat"}, {"turnId": "previous-turn"},
    {"tool": "shell"}, {"tool": "skaz_unknown"}, {"namespace": "other"},
    {"arguments": "{}"}, {"callId": ""}, {"callId": None},
])
async def test_wrong_scope_unknown_or_invalid_call_never_invokes_handler(
    tmp_path: Path, changes: dict[str, Any],
) -> None:
    async def forbidden(arguments: dict[str, Any]) -> str:
        pytest.fail("Untrusted call reached handler")

    tools = CodexTools("thread-a", "turn-a", {"skaz_read_range": forbidden})
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}, tools=tools) as rpc:
        assert (await rpc.request("fixture/tool", call(**changes)))["success"] is False


async def test_replayed_call_and_exhausted_budget_do_not_repeat_effect(tmp_path: Path) -> None:
    count = 0

    async def once(arguments: dict[str, Any]) -> str:
        nonlocal count
        count += 1
        return "ok"

    tools = CodexTools("thread-a", "turn-a", {"skaz_read_range": once}, max_calls=1)
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}, tools=tools) as rpc:
        assert (await rpc.request("fixture/tool", call()))["success"] is True
        assert (await rpc.request("fixture/tool", call()))["success"] is False
        assert (await rpc.request("fixture/tool", call(callId="new-call")))["success"] is False
    assert count == 1


@pytest.mark.parametrize("mode", ["exception", "timeout", "oversized"])
async def test_handler_failure_is_bounded_sanitized_and_not_retried(tmp_path: Path, mode: str) -> None:
    count = 0

    async def broken(arguments: dict[str, Any]) -> str:
        nonlocal count
        count += 1
        if mode == "exception":
            raise RuntimeError("PRIVATE HANDLER FAILURE")
        if mode == "timeout":
            await asyncio.Event().wait()
        return "PRIVATE OUTPUT" * 100

    tools = CodexTools(
        "thread-a", "turn-a", {"skaz_read_range": broken}, timeout=0.05, max_output_bytes=100,
    )
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}, tools=tools) as rpc:
        result = await rpc.request("fixture/tool", call())
        assert result["success"] is False
        assert "PRIVATE" not in str(result)
        assert (await rpc.request("fixture/tool", call()))["success"] is False
    assert count == 1


async def test_handler_can_await_rpc_without_blocking_reader(tmp_path: Path) -> None:
    async def read(arguments: dict[str, Any]) -> str:
        result = await rpc.request("account/read", {"refreshToken": False})
        assert result == {"account": None}
        return "ok"

    tools = CodexTools("thread-a", "turn-a", {"skaz_read_range": read})
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}, tools=tools) as rpc:
        result = await asyncio.wait_for(rpc.request("fixture/tool", call()), 1)
        assert result["success"] is True
        assert (await rpc.next_event())["method"] == "fixture/progress"


async def test_revoked_scope_never_dispatches(tmp_path: Path) -> None:
    async def forbidden(arguments: dict[str, Any]) -> str:
        pytest.fail("Revoked scope reached handler")

    tools = CodexTools("thread-a", "turn-a", {"skaz_read_range": forbidden})
    tools.revoke()
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}, tools=tools) as rpc:
        assert (await rpc.request("fixture/tool", call()))["success"] is False


async def test_one_tool_at_a_time_and_close_cancels_handler(tmp_path: Path) -> None:
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def blocked(arguments: dict[str, Any]) -> str:
        started.set()
        try:
            await asyncio.Event().wait()
            return "unreachable"
        finally:
            cancelled.set()

    tools = CodexTools("thread-a", "turn-a", {"skaz_read_range": blocked})
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}, tools=tools) as rpc:
        active = asyncio.create_task(rpc.request("fixture/tool", call()))
        try:
            await asyncio.wait_for(started.wait(), 1)
            result = await rpc.request("fixture/tool", call(callId="parallel"))
            assert result["success"] is False
            await rpc.close()
            assert cancelled.is_set()
        finally:
            await rpc.close()
            await asyncio.gather(active, return_exceptions=True)


async def test_close_cancels_handler_waiting_on_nested_rpc(tmp_path: Path) -> None:
    started = asyncio.Event()

    async def blocked(arguments: dict[str, Any]) -> str:
        started.set()
        await rpc.request("fixture/silent", {})
        return "unreachable"

    tools = CodexTools("thread-a", "turn-a", {"skaz_read_range": blocked})
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}, tools=tools) as rpc:
        active = asyncio.create_task(rpc.request("fixture/tool", call()))
        await asyncio.wait_for(started.wait(), 1)
        await asyncio.wait_for(rpc.close(), 1)
        await asyncio.gather(active, return_exceptions=True)
        assert rpc.closed


@pytest.mark.parametrize("method", [
    "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
])
async def test_registering_tools_does_not_enable_builtin_approvals(tmp_path: Path, method: str) -> None:
    tools = CodexTools("thread-a", "turn-a", {})
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}, tools=tools) as rpc:
        assert await rpc.request("fixture/action", {"method": method}) == {
            "code": -32601, "message": "Action not permitted",
        }


async def test_revocation_during_read_discards_result(tmp_path: Path) -> None:
    started, release = asyncio.Event(), asyncio.Event()

    async def read(arguments: dict[str, Any]) -> str:
        started.set()
        await release.wait()
        return "PRIVATE SOURCE AFTER REVOCATION"

    tools = CodexTools("thread-a", "turn-a", {"skaz_read_range": read})
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}, tools=tools) as rpc:
        active = asyncio.create_task(rpc.request("fixture/tool", call()))
        try:
            await asyncio.wait_for(started.wait(), 1)
            tools.revoke()
            release.set()
            result = await active
            assert result["success"] is False
            assert "PRIVATE" not in str(result)
        finally:
            release.set()
            await asyncio.gather(active, return_exceptions=True)



