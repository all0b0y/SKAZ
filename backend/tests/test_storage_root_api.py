"""Root selection via authenticated HTTP; no personal directories or model calls."""
from __future__ import annotations

import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest
from starlette.testclient import TestClient

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.secrets import MemorySecretStore

AUTH = {"Authorization": "Bearer test-token"}


def test_root_is_explicit_persisted_and_used_by_projection(tmp_path: Path) -> None:
    config = AppConfig(token="test-token", data_dir=tmp_path / "data")
    root = tmp_path / "chosen"
    with TestClient(create_app(config, secret_store=MemorySecretStore()),
                    base_url="http://127.0.0.1", headers=AUTH) as client:
        response = client.get("/storage/root")
        assert response.status_code == 200, response.text
        assert response.json()["root"] is None
        assert response.json()["suggested_root"].endswith("/Documents/SKAZ")
        assert response.json()["change_locked"] is False
        saved = client.put("/storage/root", json={"root": str(root), "expected_root": None})
        assert saved.status_code == 200, saved.text
        assert saved.json()["root"] == str(root)
        assert not root.exists()  # Selection alone publishes nothing.
    with TestClient(create_app(config, secret_store=MemorySecretStore()),
                    base_url="http://127.0.0.1", headers=AUTH) as client:
        assert client.get("/storage/root").json()["root"] == str(root)
        sid = client.post("/sessions", json={"title": "Root fixture"}).json()["id"]
        assert client.post(f"/sessions/{sid}/files").json()["state"] == "ready"
        assert "Root fixture" in (root / "Ungrouped" / sid / "Transcript.md").read_text()
        assert client.get("/storage/root").json()["change_locked"] is True
        refused = client.put("/storage/root", json={"root": str(tmp_path / "other"),
                                                    "expected_root": str(root)})
        assert refused.status_code == 409
        assert client.put("/storage/root", json={
            "root": None, "expected_root": str(root),
        }).status_code == 409
        assert client.get("/storage/root").json()["root"] == str(root)
        assert not (tmp_path / "other").exists()


@pytest.mark.parametrize("raw", ["", "relative", "/", "/tmp/../folder", "/tmp/./folder",
                                  "/tmp//folder", "/tmp/folder/", "/tmp/secret\n", "~/Documents"])
async def test_invalid_paths_are_not_repaired_or_disclosed(client: httpx.AsyncClient, raw: str) -> None:
    response = await client.put("/storage/root", json={"root": raw, "expected_root": None})
    assert response.status_code == 422
    assert (await client.get("/storage/root")).json()["root"] is None
    assert response.json()["detail"] == (
        "Choose an absolute non-linked folder outside private app storage."
    )


@pytest.mark.parametrize("kind", ["link", "parent-link", "broken-link", "file", "private", "ancestor"])
async def test_unsafe_roots_leave_external_bytes_intact(
    client: httpx.AsyncClient, tmp_path: Path, config: AppConfig, kind: str,
) -> None:
    external = tmp_path / "external"
    external.mkdir()
    evidence = external / "personal.txt"
    evidence.write_text("untouched")
    chosen = tmp_path / "chosen"
    if kind == "file":
        chosen.write_text("not a directory")
    elif kind == "private":
        chosen = config.data_dir / "nested"
    elif kind == "ancestor":
        chosen = tmp_path
    else:
        chosen.symlink_to(external if kind != "broken-link" else tmp_path / "absent")
        if kind == "parent-link":
            chosen /= "child"
    result = await client.put("/storage/root", json={"root": str(chosen), "expected_root": None})
    assert result.status_code == 422
    assert evidence.read_text() == "untouched"
    assert (await client.get("/storage/root")).json()["root"] is None
    assert list(external.iterdir()) == [evidence]


async def test_stale_selection_and_disable_before_output(
    client: httpx.AsyncClient, tmp_path: Path,
) -> None:
    first = str(tmp_path / "first")
    second = str(tmp_path / "second")
    assert (await client.put("/storage/root", json={"root": first, "expected_root": None})).status_code == 200
    assert (await client.put("/storage/root", json={
        "root": second, "expected_root": None,
    })).status_code == 409
    assert (await client.put("/storage/root", json={
        "root": second, "expected_root": first,
    })).status_code == 200
    assert (await client.put("/storage/root", json={
        "root": None, "expected_root": second,
    })).status_code == 200
    assert (await client.get("/storage/root")).json()["root"] is None
    assert not Path(first).exists() and not Path(second).exists()


async def test_database_failure_does_not_change_effective_root(
    client: httpx.AsyncClient, app: Any, tmp_path: Path,
) -> None:
    with app.state.runtime.db.read() as connection:
        connection.execute("PRAGMA query_only = ON")
    try:
        result = await client.put("/storage/root", json={
            "root": str(tmp_path / "new"), "expected_root": None,
        })
        assert result.status_code == 503
        assert (await client.get("/storage/root")).json()["root"] is None
        assert not (tmp_path / "new").exists()
    finally:
        with app.state.runtime.db.read() as connection:
            connection.execute("PRAGMA query_only = OFF")


def test_environment_override_is_read_only_and_does_not_replace_preference(tmp_path: Path) -> None:
    config = AppConfig(token="test-token", data_dir=tmp_path / "data")
    chosen, override = str(tmp_path / "chosen"), tmp_path / "override"
    for active in (config, replace(config, session_files_root=override), config):
        with TestClient(create_app(active, secret_store=MemorySecretStore()),
                        base_url="http://127.0.0.1", headers=AUTH) as client:
            view = client.get("/storage/root").json()
            if view["root"] is None:
                client.put("/storage/root", json={"root": chosen, "expected_root": None}).raise_for_status()
            elif active.session_files_root:
                assert view["root"] == str(override) and view["managed"] and view["change_locked"]
                assert client.put("/storage/root", json={
                    "root": None, "expected_root": str(override),
                }).status_code == 409
            else:
                assert view["root"] == chosen and not view["managed"]


async def test_failed_publication_intent_blocks_switch_or_disable(
    client: httpx.AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "chosen"
    (await client.put("/storage/root", json={"root": str(root), "expected_root": None})).raise_for_status()
    sid = (await client.post("/sessions", json={"title": "Fixture"})).json()["id"]
    mkdir = os.mkdir

    def fail(path: Any, *args: Any, **kwargs: Any) -> None:
        if path == "chosen":
            raise OSError("disk fixture failure")
        mkdir(path, *args, **kwargs)

    monkeypatch.setattr(os, "mkdir", fail)
    assert (await client.post(f"/sessions/{sid}/files")).json()["state"] == "error"
    assert not root.exists()
    assert (await client.get("/storage/root")).json()["change_locked"] is True
    for new_root in (None, str(tmp_path / "other")):
        assert (await client.put("/storage/root", json={"root": new_root,
                                                       "expected_root": str(root)})).status_code == 409
    assert (await client.get(f"/sessions/{sid}")).status_code == 200


def test_concurrent_selections_do_not_overwrite_newer_root(tmp_path: Path) -> None:
    config = AppConfig(token="test-token", data_dir=tmp_path / "data")
    with TestClient(create_app(config, secret_store=MemorySecretStore()),
                    base_url="http://127.0.0.1", headers=AUTH) as client, ThreadPoolExecutor(2) as pool:
        def select(name: str) -> tuple[int, str]:
            response = client.put("/storage/root", json={
                "root": str(tmp_path / name), "expected_root": None,
            })
            return response.status_code, str(response.json().get("root", ""))

        responses = list(pool.map(select, ["first", "second"]))
        assert sorted(status for status, _ in responses) == [200, 409]
        winner = next(root for status, root in responses if status == 200)
        assert client.get("/storage/root").json()["root"] == winner


async def test_root_endpoint_requires_auth_and_expected_value(client: httpx.AsyncClient) -> None:
    assert (await client.get("/storage/root", headers={"Authorization": "Bearer wrong"})).status_code == 401
    for body in (
        {"root": None}, {"expected_root": None}, {"root": None, "expected_root": None, "move": True},
    ):
        assert (await client.put("/storage/root", json=body)).status_code == 422


def test_private_storage_alias_does_not_bypass_overlap_guard(tmp_path: Path) -> None:
    actual = tmp_path / "actual"
    actual.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(actual)
    config = AppConfig(token="test-token", data_dir=alias / "data")
    with TestClient(create_app(config, secret_store=MemorySecretStore()),
                    base_url="http://127.0.0.1", headers=AUTH) as client:
        response = client.put("/storage/root", json={
            "root": str(actual / "data" / "nested"), "expected_root": None,
        })
        assert response.status_code == 422
        assert client.get("/storage/root").json()["root"] is None


CRASH_ROOT = r'''
import os, sqlite3, sys
from pathlib import Path
from starlette.testclient import TestClient
from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.secrets import MemorySecretStore
native_connect = sqlite3.connect
class CrashConnection(sqlite3.Connection):
    saving_root = False
    def execute(self, sql, *args, **kwargs):
        if sql.startswith("INSERT OR REPLACE INTO storage_root"):
            self.saving_root = True
        return super().execute(sql, *args, **kwargs)
    def commit(self):
        if self.saving_root and sys.argv[4] == "before":
            os._exit(73)
        super().commit()
        if self.saving_root:
            os._exit(73)
def connect(*args, **kwargs):
    return native_connect(*args, **kwargs, factory=CrashConnection)
sqlite3.connect = connect
app = create_app(AppConfig(token="test-token", data_dir=Path(sys.argv[1])),
                 secret_store=MemorySecretStore())
with TestClient(app, base_url="http://127.0.0.1") as client:
    response = client.put("/storage/root", headers={"Authorization": "Bearer test-token"},
                          json={"root": sys.argv[3], "expected_root": sys.argv[2]})
    raise RuntimeError(f"Crash boundary missed: {response.status_code}")
'''


@pytest.mark.parametrize("phase", ["before", "after"])
def test_process_death_around_preference_commit(tmp_path: Path, phase: str) -> None:
    config = AppConfig(token="test-token", data_dir=tmp_path / "data")
    old, new = str(tmp_path / "old"), str(tmp_path / "new")
    with TestClient(create_app(config, secret_store=MemorySecretStore()),
                    base_url="http://127.0.0.1", headers=AUTH) as client:
        client.put("/storage/root", json={"root": old, "expected_root": None}).raise_for_status()
    child = subprocess.run(
        [sys.executable, "-c", CRASH_ROOT, str(config.data_dir), old, new, phase],
        capture_output=True, text=True, timeout=20, cwd=Path(__file__).resolve().parents[1],
    )
    assert child.returncode == 73, child.stderr
    with TestClient(create_app(config, secret_store=MemorySecretStore()),
                    base_url="http://127.0.0.1", headers=AUTH) as client:
        assert client.get("/storage/root").json()["root"] == (old if phase == "before" else new)
        assert not Path(old).exists() and not Path(new).exists()
