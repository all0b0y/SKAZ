"""Exercise the actual subprocess boundary, not an internal mocked RPC object."""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

from skaz.gateways.codex_rpc import CodexRpc, CodexRpcError

FIXTURE = Path(__file__).parent / "fixtures" / "codex_rpc_server.py"


@pytest.mark.asyncio
async def test_handshake_and_interleaved_notification(tmp_path: Path) -> None:
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as client:
        result = await client.request("account/read", {"refreshToken": False})
        assert result == {"account": None}
        assert await client.next_event() == {
            "method": "fixture/progress", "params": {"stage": "reading"},
        }
    assert client.closed


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["eof", "malformed", "oversized", "flood", "boolean-id", "bad-params"])
async def test_invalid_peer_terminates_connection(tmp_path: Path, kind: str) -> None:
    async with CodexRpc(
        (sys.executable, str(FIXTURE)), cwd=tmp_path, env={},
        timeout=1, max_message_bytes=2048, max_events=2,
    ) as client:
        with pytest.raises(CodexRpcError) as error:
            await client.request("fixture/failure", {"kind": kind})
        assert "PRIVATE" not in str(error.value)
        assert "timed out" not in str(error.value)
        assert client.closed


@pytest.mark.asyncio
async def test_rpc_error_is_sanitized_without_closing_connection(tmp_path: Path) -> None:
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as client:
        with pytest.raises(CodexRpcError, match=r"^Codex request rejected$"):
            await client.request("fixture/failure", {"kind": "rpc"})
        assert await client.request("account/read", {"refreshToken": False}) == {"account": None}


@pytest.mark.asyncio
async def test_close_reaps_process_and_reentry_is_refused(tmp_path: Path) -> None:
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as client:
        pid = await client.request("fixture/pid", {})
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    with pytest.raises(CodexRpcError, match="cannot be reused"):
        async with client:
            pytest.fail("Must not relaunch a used connection")


@pytest.mark.asyncio
async def test_launch_failure_does_not_expose_command(tmp_path: Path) -> None:
    client = CodexRpc((str(tmp_path / "PRIVATE_BINARY"),), cwd=tmp_path, env={})
    with pytest.raises(CodexRpcError, match=r"^Codex process could not start$"):
        async with client:
            pytest.fail("Missing executable must fail")
    assert client.closed


@pytest.mark.parametrize("timeout", [float("nan"), float("inf"), 0, -1])
def test_nonfinite_or_nonpositive_timeout_is_rejected(tmp_path: Path, timeout: float) -> None:
    with pytest.raises(ValueError):
        CodexRpc((sys.executable,), cwd=tmp_path, env={}, timeout=timeout)



@pytest.mark.asyncio
async def test_concurrent_requests_match_reversed_responses(tmp_path: Path) -> None:
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as client:
        results = await asyncio.gather(
            client.request("fixture/reverse", {}), client.request("fixture/reverse", {}),
        )
        first, second = results
        assert first == 2
        assert second == 3


@pytest.mark.asyncio
async def test_server_action_is_denied_not_confused_with_response(tmp_path: Path) -> None:
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as client:
        assert await client.request("fixture/action", {}) == {
            "code": -32601, "message": "Action not permitted",
        }


@pytest.mark.asyncio
async def test_parent_environment_and_stderr_are_not_exposed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("SKAZ_TEST_PARENT_SECRET", "PRIVATE PARENT VALUE")
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as client:
        assert await client.request("fixture/env", {}) is None
        assert await client.request("fixture/stderr", {}) == "ok"
    captured = capfd.readouterr()
    assert "PRIVATE" not in captured.out + captured.err


@pytest.mark.asyncio
async def test_timeout_closes_and_does_not_retry(tmp_path: Path) -> None:
    async with CodexRpc(
        (sys.executable, str(FIXTURE)), cwd=tmp_path, env={}, timeout=0.2,
    ) as client:
        with pytest.raises(CodexRpcError, match="timed out; not retried"):
            await client.request("fixture/silent", {})
        assert client.closed
        with pytest.raises(CodexRpcError):
            await client.request("account/read", {})


@pytest.mark.asyncio
async def test_closing_wakes_event_waiter_and_is_idempotent(tmp_path: Path) -> None:
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as client:
        waiter = asyncio.create_task(client.next_event())
        await client.close()
        with pytest.raises(CodexRpcError):
            await asyncio.wait_for(waiter, 1)
        await client.close()


@pytest.mark.asyncio
async def test_cancellation_closes_connection(tmp_path: Path) -> None:
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as client:
        request = asyncio.create_task(client.request("fixture/silent", {}))
        await asyncio.sleep(0)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert client.closed

