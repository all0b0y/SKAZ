"""Codex sign-in through ``CodexConnection``: the observable login outcome.

Kept from the Codex settings tests when the per-purpose Codex runtime (assistant /
notes) was removed; the connection is what the knowledge agents run on.

Authored fixtures only: no Codex binary, login, account or model call."""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from skaz.gateways import codex_connection
from skaz.gateways.codex_connection import CodexConnection

CATALOG = [{"id": "m", "label": "M", "efforts": ["low", "high"]}]

def _returning(rpc: Any) -> Callable[[], Any]:
    """Stand in for ``CodexConnection.rpc``: hand out the scripted RPC fake."""
    return lambda: rpc


class _LoginRpc:
    """Authored stand-in for the app-server login conversation."""

    def __init__(
        self, events: list[dict[str, Any] | BaseException] | None = None, *, hang: bool = False,
    ) -> None:
        self.events = list(events or [])
        self.hang = hang
        self.closed = False
        self.requests: list[str] = []

    async def __aenter__(self) -> _LoginRpc:
        return self

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.requests.append(method)
        return {"authUrl": "https://auth.openai.com/oauth/authorize?fixture=1"}

    async def next_event(self) -> dict[str, Any]:
        if self.hang or not self.events:
            await asyncio.Event().wait()
        event = self.events.pop(0)
        if isinstance(event, BaseException):
            raise event
        return event

    async def close(self) -> None:
        self.closed = True


def _connection(tmp_path: Path, rpc: _LoginRpc) -> tuple[CodexConnection, list[str]]:
    connection = CodexConnection(tmp_path / "account")
    connection.binary = "/fixture/codex"
    connection.view.update(status="signed_out")
    connection.rpc = _returning(rpc)  # type: ignore[assignment,method-assign]
    checks: list[str] = []

    async def check() -> dict[str, Any]:
        checks.append("check")
        connection.view.update(status="connected", models=CATALOG, error=None)
        return dict(connection.view)

    connection.check = check  # type: ignore[method-assign]
    return connection, checks


async def _settle(connection: CodexConnection) -> None:
    waiter = connection._login_waiter
    assert waiter is not None
    await asyncio.wait_for(asyncio.shield(waiter), 2)


@pytest.mark.asyncio
async def test_login_success_refreshes_the_account_and_catalog(tmp_path: Path) -> None:
    rpc = _LoginRpc([{"method": "account/updated", "params": {}},
                     {"method": "account/login/completed", "params": {"success": True, "error": None}}])
    connection, checks = _connection(tmp_path, rpc)
    assert connection.view["login"] == "idle"
    url = await connection.login(True)
    assert url.startswith("https://auth.openai.com/")
    await _settle(connection)
    assert checks == ["check"]
    assert connection.view["status"] == "connected"
    assert connection.view["login"] == "idle"
    assert rpc.closed and connection._login is None


@pytest.mark.asyncio
async def test_login_pending_is_observable(tmp_path: Path) -> None:
    rpc = _LoginRpc(hang=True)
    connection, checks = _connection(tmp_path, rpc)
    await connection.login(True)
    assert connection.view["login"] == "pending"
    assert connection.view["status"] == "signed_out"
    await connection.close()
    assert connection.view["login"] == "cancelled"
    assert checks == [] and rpc.closed


@pytest.mark.asyncio
async def test_failed_login_is_reported_without_a_check(tmp_path: Path) -> None:
    rpc = _LoginRpc([{"method": "account/login/completed",
                      "params": {"success": False, "error": "raw provider text"}}])
    connection, checks = _connection(tmp_path, rpc)
    await connection.login(True)
    await _settle(connection)
    assert checks == []
    assert connection.view["status"] == "signed_out"
    assert connection.view["login"] == "failed"
    assert connection.view["error"] == "Login did not complete"


@pytest.mark.asyncio
async def test_login_that_never_completes_times_out(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(codex_connection, "LOGIN_TIMEOUT_S", 0.05)
    rpc = _LoginRpc(hang=True)
    connection, checks = _connection(tmp_path, rpc)
    await connection.login(True)
    await _settle(connection)
    assert (connection.view["status"], connection.view["login"]) == ("signed_out", "timed_out")
    assert checks == [] and rpc.closed and connection._login is None


@pytest.mark.asyncio
async def test_login_process_failure_is_reported(tmp_path: Path) -> None:
    rpc = _LoginRpc([RuntimeError("disconnected")])
    connection, _checks = _connection(tmp_path, rpc)
    await connection.login(True)
    await _settle(connection)
    assert connection.view["login"] == "failed"


@pytest.mark.asyncio
async def test_second_login_replaces_an_abandoned_browser_page(tmp_path: Path) -> None:
    first = _LoginRpc(hang=True)
    connection, _checks = _connection(tmp_path, first)
    await connection.login(True)
    second = _LoginRpc([{"method": "account/login/completed", "params": {"success": True}}])
    connection.rpc = _returning(second)  # type: ignore[assignment,method-assign]
    await connection.login(True)
    assert first.closed
    await _settle(connection)
    assert (connection.view["status"], connection.view["login"]) == ("connected", "idle")


@pytest.mark.asyncio
async def test_login_can_be_retried_after_failure(tmp_path: Path) -> None:
    rpc = _LoginRpc([{"method": "account/login/completed", "params": {"success": False}}])
    connection, _checks = _connection(tmp_path, rpc)
    await connection.login(True)
    await _settle(connection)
    retry = _LoginRpc([{"method": "account/login/completed", "params": {"success": True}}])
    connection.rpc = _returning(retry)  # type: ignore[assignment,method-assign]
    await connection.login(True)
    await _settle(connection)
    assert (connection.view["status"], connection.view["login"]) == ("connected", "idle")
