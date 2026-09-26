"""Codex discovery from a GUI-launched process, auto-check and one-click re-login.

Authored fixtures only: fake executables in a temp dir, no real Codex, login or model.
"""
from __future__ import annotations

import asyncio
import json
import os
import stat
from pathlib import Path
from typing import Any

import pytest

from audiohelper.agent.codex_dispatcher import CodexDispatcher
from audiohelper.agent.codex_runtime import CodexRuntime
from audiohelper.agent.snapshot_queue import SnapshotTask
from audiohelper.db import Database
from audiohelper.gateways import codex_connection
from audiohelper.gateways.codex_connection import CodexConnection
from audiohelper.gateways.codex_locate import USER_PATH_ENV, locate_codex


def _exe(path: Path, body: str = "#!/bin/sh\nexit 0\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


GUI_ENV = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}


def test_launchd_path_alone_does_not_find_a_user_install(tmp_path: Path) -> None:
    _exe(tmp_path / "elsewhere" / "codex")
    assert locate_codex(GUI_ENV, home=tmp_path) is None


def test_login_shell_path_finds_codex_and_its_node(tmp_path: Path) -> None:
    bindir = tmp_path / "tools"
    codex = _exe(bindir / "codex")
    _exe(bindir / "node")
    found = locate_codex({**GUI_ENV, USER_PATH_ENV: str(bindir)}, home=tmp_path)
    assert found is not None
    assert found.binary == str(codex)
    assert found.node_dir == str(bindir)
    assert found.child_path().split(os.pathsep)[:1] == [str(bindir)]


def test_standard_folders_are_the_fallback(tmp_path: Path) -> None:
    codex = _exe(tmp_path / ".local" / "bin" / "codex")
    _exe(tmp_path / ".nvm" / "versions" / "node" / "v22.0.0" / "bin" / "node")
    found = locate_codex(GUI_ENV, home=tmp_path)
    assert found is not None
    assert found.binary == str(codex)
    # Some standard folder supplies Node (Homebrew on a real Mac may come first).
    assert found.node_dir is not None and (Path(found.node_dir) / "node").exists()


def test_node_beside_a_symlinked_npm_script_wins(tmp_path: Path) -> None:
    prefix = tmp_path / "prefix"
    script = _exe(prefix / "lib" / "codex.js")
    _exe(prefix / "lib" / "node")
    link = tmp_path / ".local" / "bin" / "codex"
    link.parent.mkdir(parents=True)
    link.symlink_to(script)
    found = locate_codex(GUI_ENV, home=tmp_path)
    assert found is not None and found.node_dir == str(prefix / "lib")


@pytest.mark.asyncio
async def test_check_uses_discovered_binary_with_child_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    bindir = tmp_path / "tools"
    seen = tmp_path / "seen-path"
    _exe(bindir / "node")
    _exe(bindir / "codex", f'#!/bin/sh\necho "$PATH" > "{seen}"\necho "codex-cli 0.0.1"\n')
    monkeypatch.setenv("PATH", GUI_ENV["PATH"])
    monkeypatch.setenv(USER_PATH_ENV, str(bindir))
    connection = CodexConnection(tmp_path / "account")
    view = await connection.check()
    # The fake binary reports another version: found, run with Node on PATH, rejected honestly.
    assert view["status"] == "incompatible"
    assert view["path"] == str(bindir / "codex")
    assert seen.read_text().strip().split(os.pathsep)[0] == str(bindir)


@pytest.mark.asyncio
async def test_missing_codex_reports_missing_not_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PATH", GUI_ENV["PATH"])
    monkeypatch.delenv(USER_PATH_ENV, raising=False)
    monkeypatch.setattr(codex_connection, "locate_codex", lambda: None)
    view = await CodexConnection(tmp_path / "account").check()
    assert view["status"] == "missing" and view["path"] is None


# --- consent and one-click re-login -------------------------------------------------


class _Rpc:
    def __init__(self) -> None:
        self.requests: list[str] = []

    async def __aenter__(self) -> _Rpc:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.requests.append(method)
        return {"authUrl": "https://auth.openai.com/oauth/authorize?fixture=1"}

    async def next_event(self) -> dict[str, Any]:
        await asyncio.Event().wait()
        raise AssertionError

    async def close(self) -> None:
        pass


@pytest.mark.asyncio
async def test_relogin_needs_no_checkbox_after_a_connected_account(tmp_path: Path) -> None:
    connection = CodexConnection(tmp_path / "account")
    rpc = _Rpc()
    connection.rpc = lambda: rpc  # type: ignore[assignment,method-assign,return-value]
    connection.view.update(status="signed_out")
    with pytest.raises(ValueError, match="consent"):
        await connection.login(False)
    connection._record_consent(True)
    assert connection.view["relogin_available"] is True
    # Survives a restart: a fresh connection object reads the marker.
    assert CodexConnection(tmp_path / "account").view["relogin_available"] is True
    await connection.login(False)
    await connection.close()


@pytest.mark.asyncio
async def test_explicit_sign_out_asks_for_consent_again(tmp_path: Path) -> None:
    connection = CodexConnection(tmp_path / "account")
    rpc = _Rpc()
    connection.rpc = lambda: rpc  # type: ignore[assignment,method-assign,return-value]
    connection._record_consent(True)
    await connection.logout()
    assert rpc.requests == ["account/logout"]
    assert connection.view["relogin_available"] is False
    connection.view.update(status="signed_out")
    with pytest.raises(ValueError, match="consent"):
        await connection.login(False)


# --- automatic checks -----------------------------------------------------------------


def _runtime(tmp_path: Path) -> tuple[Database, CodexRuntime, list[str]]:
    db = Database(tmp_path / "app.sqlite")
    service = CodexRuntime(db, tmp_path / "codex")
    checks: list[str] = []

    async def check() -> dict[str, Any]:
        checks.append("check")
        service.connection.view.update(status="connected")
        return dict(service.connection.view)

    service.connection.check = check  # type: ignore[method-assign]
    return db, service, checks


@pytest.mark.asyncio
async def test_start_checks_when_codex_is_chosen(tmp_path: Path) -> None:
    db, service, checks = _runtime(tmp_path)
    with db.write() as c:
        c.execute("INSERT OR REPLACE INTO codex_settings VALUES(1,?)",
                  (json.dumps({"assistant_enabled": True}),))
    try:
        service.start()
        await asyncio.wait_for(asyncio.shield(service._connection_check), 2)  # type: ignore[arg-type]
        assert checks == ["check"]
        assert service.connection.view["status"] == "connected"
    finally:
        await service.close()
        db.close()


@pytest.mark.asyncio
async def test_start_checks_a_saved_sign_in_even_if_not_chosen(tmp_path: Path) -> None:
    db, service, checks = _runtime(tmp_path)
    auth = tmp_path / "codex" / "account" / "profile" / "auth.json"
    auth.parent.mkdir(parents=True)
    auth.write_text("{}")
    try:
        service.start()
        await asyncio.wait_for(asyncio.shield(service._connection_check), 2)  # type: ignore[arg-type]
        assert checks == ["check"]
    finally:
        await service.close()
        db.close()


@pytest.mark.asyncio
async def test_start_does_not_touch_codex_when_unused(tmp_path: Path) -> None:
    db, service, checks = _runtime(tmp_path)
    try:
        service.start()
        await asyncio.sleep(0)
        assert checks == [] and service._connection_check is None
        assert service.connection.view["status"] == "unchecked"
    finally:
        await service.close()
        db.close()


@pytest.mark.asyncio
async def test_recheck_is_single_flight(tmp_path: Path) -> None:
    db, service, checks = _runtime(tmp_path)
    gate = asyncio.Event()

    async def slow() -> dict[str, Any]:
        checks.append("check")
        await gate.wait()
        return {}

    service.connection.check = slow  # type: ignore[method-assign]
    try:
        service.recheck_connection()
        service.recheck_connection()
        await asyncio.sleep(0)
        assert checks == ["check"]
        gate.set()
        await asyncio.wait_for(asyncio.shield(service._connection_check), 2)  # type: ignore[arg-type]
    finally:
        await service.close()
        db.close()


class _Queue:
    def __init__(self) -> None:
        self.status = "running"
        self.paused = 0

    def checkpoint(self, *_: Any) -> None: ...
    def get(self, _task_id: str) -> SnapshotTask:
        return SnapshotTask("t", "c", ("s",), "q", "m", self.status, None, "", None)

    def pause(self, _task_id: str) -> None:
        self.paused += 1
        self.status = "paused"


class _FailingRunner:
    async def __aenter__(self) -> None:
        raise RuntimeError("401 from provider")

    async def __aexit__(self, *exc: object) -> None:
        return None


@pytest.mark.asyncio
async def test_failed_run_triggers_a_connection_recheck() -> None:
    queue = _Queue()
    calls: list[str] = []
    dispatcher = CodexDispatcher(queue, lambda _task: _FailingRunner(),  # type: ignore[arg-type,return-value]
                                 on_interrupted=lambda: calls.append("recheck"))
    await dispatcher._execute(queue.get("t"))
    assert queue.paused == 1
    assert calls == ["recheck"]
