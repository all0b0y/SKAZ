"""Per-purpose Codex engine choice, legacy migration and observable login outcome.

Authored fixtures only: no Codex binary, login, account or model call.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from pydantic import ValidationError

from skaz.agent.codex_runtime import CodexRuntime
from skaz.agent.snapshot_queue import SnapshotTask
from skaz.codex_schemas import CodexSettings
from skaz.db import Database
from skaz.gateways import codex_connection
from skaz.gateways.codex_connection import CodexConnection

AUTH = {"Authorization": "Bearer test-token"}
CATALOG = [{"id": "m", "label": "M", "efforts": ["low", "high"]}]


def test_defaults_choose_nothing() -> None:
    settings = CodexSettings().model_dump()
    assert settings["assistant_enabled"] is False
    assert settings["notes_enabled"] is False
    assert "enabled" not in settings


@pytest.mark.parametrize("legacy", [True, False])
def test_legacy_enabled_applies_to_both_purposes_when_absent(legacy: bool) -> None:
    settings = CodexSettings.model_validate({"enabled": legacy, "assistant_model": "m"})
    assert (settings.assistant_enabled, settings.notes_enabled) == (legacy, legacy)
    assert "enabled" not in settings.model_dump()
    # The existing keyword fixture shape stays accepted.
    assert CodexSettings(enabled=legacy).notes_enabled is legacy  # type: ignore[call-arg]


def test_per_purpose_fields_win_over_legacy() -> None:
    settings = CodexSettings.model_validate({"enabled": True, "notes_enabled": False})
    assert settings.assistant_enabled is True
    assert settings.notes_enabled is False
    both = CodexSettings.model_validate({"enabled": False, "assistant_enabled": True, "notes_enabled": True})
    assert (both.assistant_enabled, both.notes_enabled) == (True, True)


def test_legacy_json_document_is_read() -> None:
    settings = CodexSettings.model_validate_json('{"enabled": true, "notes_model": "m"}')
    assert (settings.assistant_enabled, settings.notes_enabled) == (True, True)


@pytest.mark.parametrize("bad", ["yes", 1, None])
def test_legacy_enabled_must_be_a_boolean(bad: Any) -> None:
    with pytest.raises(ValidationError):
        CodexSettings.model_validate({"enabled": bad})


def test_unknown_fields_still_forbidden() -> None:
    with pytest.raises(ValidationError):
        CodexSettings.model_validate({"assistant_enabled": True, "command": "sh"})


def _raw_doc(db: Database) -> dict[str, Any]:
    with db.read() as c:
        return dict(json.loads(c.execute("SELECT doc FROM codex_settings WHERE id=1").fetchone()[0]))


@pytest.mark.asyncio
async def test_stored_legacy_preference_is_migrated_on_start(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.sqlite")
    first = CodexRuntime(db, tmp_path / "codex")
    legacy = {"enabled": True, "assistant_model": "m", "assistant_effort": "high",
              "notes_model": "m", "notes_effort": "low", "ask_before_large": False}
    with db.write() as c:
        c.execute("INSERT OR REPLACE INTO codex_settings VALUES(1,?)", (json.dumps(legacy),))
    await first.close()
    restarted = CodexRuntime(db, tmp_path / "codex")
    try:
        doc = _raw_doc(db)
        assert "enabled" not in doc
        assert doc["assistant_enabled"] is True and doc["notes_enabled"] is True
        assert doc["assistant_model"] == "m" and doc["notes_effort"] == "low"
        assert doc["ask_before_large"] is False
        assert restarted.settings()["notes_enabled"] is True
    finally:
        await restarted.close()
        db.close()


@pytest.mark.asyncio
async def test_disabled_legacy_preference_stays_disabled(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.sqlite")
    first = CodexRuntime(db, tmp_path / "codex")
    with db.write() as c:
        c.execute("INSERT OR REPLACE INTO codex_settings VALUES(1,?)", ('{"enabled": false}',))
    await first.close()
    restarted = CodexRuntime(db, tmp_path / "codex")
    try:
        doc = _raw_doc(db)
        assert (doc["assistant_enabled"], doc["notes_enabled"]) == (False, False)
    finally:
        await restarted.close()
        db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(("assistant", "notes"), [(True, False), (False, True)])
async def test_each_purpose_is_routed_independently_and_survives_restart(
    tmp_path: Path, assistant: bool, notes: bool,
) -> None:
    db = Database(tmp_path / "app.sqlite")
    service = CodexRuntime(db, tmp_path / "codex")
    await service.configure(CodexSettings(
        assistant_enabled=assistant, notes_enabled=notes,
        assistant_model="m", assistant_effort="high", notes_model="m", notes_effort="low",
    ))
    await service.close()
    service = CodexRuntime(db, tmp_path / "codex")
    try:
        service.connection.view.update(status="connected", models=CATALOG)
        for kind, enabled, effort in (("assistant", assistant, "high"), ("notes", notes, "low")):
            if enabled:
                assert service._ready(kind) == ("m", effort)
            else:
                with pytest.raises(ValueError, match="no fallback"):
                    service._ready(kind)
    finally:
        await service.close()
        db.close()


@pytest.mark.asyncio
async def test_codex_purpose_without_catalog_model_never_runs(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.sqlite")
    service = CodexRuntime(db, tmp_path / "codex")
    try:
        service.connection.view.update(status="connected", models=CATALOG)
        await service.configure(
            CodexSettings(assistant_enabled=True, assistant_model="gone", assistant_effort="high")
        )
        with pytest.raises(ValueError, match="current catalog"):
            service._ready("assistant")
        service.connection.view.update(status="signed_out", models=[])
        with pytest.raises(ValueError, match="no fallback"):
            service._ready("assistant")
    finally:
        await service.close()
        db.close()


class _Queue:
    def __init__(self, tasks: list[SnapshotTask]) -> None:
        self.tasks = tasks

    def list(self) -> list[SnapshotTask]:
        return list(self.tasks)

    def close(self) -> None:
        pass


class _Dispatcher:
    def __init__(self) -> None:
        self.stopped: list[str] = []

    async def stop(self, task_id: str) -> None:
        self.stopped.append(task_id)

    async def close(self) -> None:
        pass


def _task(task_id: str, status: str) -> SnapshotTask:
    return SnapshotTask(task_id, "c", ("s",), "q", "m", status, None, "", None)


@pytest.mark.asyncio
async def test_disabling_one_purpose_stops_only_its_active_tasks(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.sqlite")
    service = CodexRuntime(db, tmp_path / "codex")
    queue = _Queue([_task("a-run", "running"), _task("a-paused", "paused"),
                    _task("n-run", "queued"), _task("a-done", "completed")])
    dispatcher = _Dispatcher()
    service._queue = queue  # type: ignore[assignment]
    service._dispatcher = dispatcher  # type: ignore[assignment]
    for task_id, kind in (("a-run", "assistant"), ("a-paused", "assistant"),
                          ("n-run", "notes"), ("a-done", "assistant")):
        service._save_meta(task_id, {"kind": kind})
    try:
        await service.configure(CodexSettings(assistant_enabled=True, notes_enabled=True))
        assert dispatcher.stopped == []
        await service.configure(CodexSettings(assistant_enabled=False, notes_enabled=True))
        # Paused work stays resumable once Codex is chosen again; nothing else is touched.
        assert dispatcher.stopped == ["a-run"]
        await service.configure(CodexSettings(assistant_enabled=False, notes_enabled=False))
        assert dispatcher.stopped == ["a-run", "a-run", "n-run"]
    finally:
        await service.close()
        db.close()


@pytest.mark.asyncio
async def test_settings_api_accepts_both_shapes_without_starting_anything(client: AsyncClient) -> None:
    initial = (await client.get("/codex/settings", headers=AUTH)).json()
    assert (initial["assistant_enabled"], initial["notes_enabled"]) == (False, False)
    legacy = await client.put("/codex/settings", headers=AUTH, json={
        "enabled": True, "assistant_model": "", "assistant_effort": "",
        "notes_model": "", "notes_effort": "", "ask_before_large": True,
    })
    assert legacy.status_code == 200
    assert (legacy.json()["assistant_enabled"], legacy.json()["notes_enabled"]) == (True, True)
    mixed = await client.put("/codex/settings", headers=AUTH, json={
        "assistant_enabled": True, "notes_enabled": False, "assistant_model": "m",
        "assistant_effort": "high", "notes_model": "", "notes_effort": "", "ask_before_large": True,
    })
    assert mixed.status_code == 200
    stored = (await client.get("/codex/settings", headers=AUTH)).json()
    assert stored == mixed.json()
    assert "enabled" not in stored
    state = (await client.get("/codex/state", headers=AUTH)).json()
    assert state["tasks"] == []
    assert state["connection"]["status"] == "unchecked"
    assert state["connection"]["login"] == "idle"


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
    connection.rpc = lambda: rpc  # type: ignore[assignment,method-assign,return-value]
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
    connection.rpc = lambda: second  # type: ignore[assignment,method-assign,return-value]
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
    connection.rpc = lambda: retry  # type: ignore[assignment,method-assign,return-value]
    await connection.login(True)
    await _settle(connection)
    assert (connection.view["status"], connection.view["login"]) == ("connected", "idle")
