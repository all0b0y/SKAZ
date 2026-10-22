"""Restored capabilities of the old interface on ``/kb`` (F2): Codex sign-out, local speech model deletion.

Fakes stand only at the external edge: a fake Codex connection (no codex process is started) and a
fake local-model manager (nothing is downloaded or removed from a real cache). The real
``delete_local_model_cache`` is exercised on a temporary cache folder.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz import asr_providers
from skaz.gateways.asr import LocalModelBusy
from skaz.knowledge.agents.codex import CodexEngine
from skaz.knowledge.agents.engine import EngineId
from skaz.knowledge.agents.registry import CodexStatusEngine, EngineUnavailable
from skaz.knowledge.service import KnowledgeService
from skaz.local_models import LOCAL_MODEL_SIZES, CacheSafetyError, DeleteResult, delete_local_model_cache
from tests.knowledge.test_agent_registry_api import FakeCodexConnection, hub_for, statuses


class SignOutConnection(FakeCodexConnection):
    """Codex's own app-server answers ``account/logout``; SKAZ never reads or writes its auth file."""

    binary: str | None = "/usr/local/bin/codex"

    def __init__(self, view: dict[str, Any]) -> None:
        super().__init__(view)
        self.logouts = 0

    async def logout(self) -> dict[str, Any]:
        self.logouts += 1
        self.view = {**self.view, "status": "signed_out", "models": []}
        return dict(self.view)


CONNECTED = {"status": "connected", "version": "codex-cli 0.150.0", "models": []}


async def test_codex_sign_out_goes_through_the_connection_and_the_view_follows(
    service: KnowledgeService, tmp_path: Path,
) -> None:
    makers: list[Any] = [CodexStatusEngine, lambda c: CodexEngine(c, None)]
    for make in makers:
        connection = SignOutConnection(dict(CONNECTED))
        engines: dict[EngineId, Any] = {**statuses(), "codex": make(connection)}
        registry = hub_for(service, tmp_path / str(id(make)), engines=engines).registry
        assert (await registry.view("codex")).state == "ready"
        view = await registry.logout("codex")
        assert connection.logouts == 1
        # Read again after signing out, never the cached "connected".
        assert view.state == "signed_out" and view.action == "login" and not view.status.signed_in


async def test_claude_code_is_never_signed_out_from_skaz(service: KnowledgeService, tmp_path: Path) -> None:
    registry = hub_for(service, tmp_path).registry
    with pytest.raises(EngineUnavailable) as refused:
        await registry.logout("claude_code")
    # SKAZ's Claude Code uses this Mac's own sign-in: signing it out would reach the user's other apps.
    assert refused.value.status_code == 409 and "this Mac" in refused.value.message


async def test_codex_logout_route(kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path) -> None:
    connection = SignOutConnection(dict(CONNECTED))
    engines: dict[EngineId, Any] = {**statuses(), "codex": CodexStatusEngine(connection)}  # type: ignore[arg-type]
    kb_app.state.runtime.kb_agents = hub_for(kb_app.state.runtime.kb, tmp_path, engines=engines)
    response = await kb_client.post("/kb/agents/codex/logout")
    assert response.status_code == 200, response.text
    assert response.json()["id"] == "codex" and response.json()["state"] == "signed_out"
    assert response.json()["signed_in"] is False and connection.logouts == 1
    # Claude Code keeps this Mac's own sign-in: the route refuses with the reason (Accounts & keys v3).
    assert (await kb_client.post("/kb/agents/claude_code/logout")).status_code == 409


async def test_codex_logout_failure_is_said_plainly(
    kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path,
) -> None:
    class Broken(SignOutConnection):
        async def logout(self) -> dict[str, Any]:
            raise ValueError("Check the Codex connection first")

    broken = CodexStatusEngine(Broken(dict(CONNECTED)))  # type: ignore[arg-type]
    engines: dict[EngineId, Any] = {**statuses(), "codex": broken}
    kb_app.state.runtime.kb_agents = hub_for(kb_app.state.runtime.kb, tmp_path, engines=engines)
    response = await kb_client.post("/kb/agents/codex/logout")
    assert response.status_code == 409
    assert response.json()["detail"] == "SKAZ couldn't sign out of Codex: Check the Codex connection first"


def test_codex_sign_in_lives_only_in_skaz_own_codex_home(kb_app: Any) -> None:
    runtime = kb_app.state.runtime
    connection = runtime.codex_connection
    data = runtime.config.data_dir.resolve()
    assert connection.root.resolve().is_relative_to(data)
    env = connection.environment()
    # account/logout runs with these: SKAZ's own HOME and CODEX_HOME, never ~/.codex.
    assert Path(env["CODEX_HOME"]).resolve().is_relative_to(data)
    assert Path(env["HOME"]).resolve().is_relative_to(data)
    assert Path(env["CODEX_HOME"]).resolve() != (Path.home() / ".codex").resolve()


class FakePreparations:
    """The local model manager at its edge: records deletions, can be busy or refuse an unsafe cache."""

    def __init__(self, result: DeleteResult | Exception, cache: dict[str, bool] | None = None) -> None:
        self.result = result
        self.cache = cache if cache is not None else {"present": False}
        self.deleted: list[tuple[str, str]] = []
        self._reports: dict[str, Any] = {}

    def close(self) -> None:
        return None

    def progress(self, provider: str, model: str) -> None:
        return None

    async def delete(self, provider: str, model: str) -> DeleteResult:
        self.deleted.append((provider, model))
        if isinstance(self.result, Exception):
            raise self.result
        self.cache["present"] = False
        return self.result


async def test_speech_settings_show_the_model_size(kb_client: httpx.AsyncClient) -> None:
    model = (await kb_client.get("/kb/settings/speech")).json()["local_model"]
    assert model["model"] == "small" and model["size_bytes"] == LOCAL_MODEL_SIZES["small"]


async def test_deleting_the_local_speech_model(
    kb_app: Any, kb_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = {"present": True}
    # The readiness check reads the cache folder; here it reads the fake's, never this Mac's.
    monkeypatch.setattr(asr_providers, "local_asr_available", lambda: True)
    monkeypatch.setattr(asr_providers, "local_model_cache_present", lambda *a, **k: cache["present"])
    fake = FakePreparations(DeleteResult(deleted=True, deleted_bytes=483_100_000, deleted_files=7), cache)
    kb_app.state.runtime.local_models = fake
    assert (await kb_client.get("/kb/settings/speech")).json()["local_model"]["state"] == "ready"
    response = await kb_client.delete("/kb/settings/speech/local-model")
    assert response.status_code == 200, response.text
    body = response.json()
    assert fake.deleted == [("local-whisper", "small")]
    assert (body["deleted"], body["deleted_bytes"]) == (True, 483_100_000)
    assert body["speech"]["local_model"]["model"] == "small"
    assert body["speech"]["local_model"]["state"] == "missing"


@pytest.mark.parametrize(("error", "status", "detail"), [
    (LocalModelBusy("local-whisper:small"), 409, "in use or still downloading"),
    (CacheSafetyError("Refusing to remove a symlink at the cache boundary."), 409, "isn't safe to remove"),
])
async def test_local_model_deletion_refusals(
    kb_app: Any, kb_client: httpx.AsyncClient, error: Exception, status: int, detail: str,
) -> None:
    kb_app.state.runtime.local_models = FakePreparations(error)
    response = await kb_client.delete("/kb/settings/speech/local-model")
    assert response.status_code == status and detail in response.json()["detail"]


def test_the_real_cache_deletion_removes_only_that_model(tmp_path: Path) -> None:
    cache = tmp_path / "hf"
    model = cache / "models--Systran--faster-whisper-small" / "blobs"
    other = cache / "models--Systran--faster-whisper-base" / "blobs"
    for folder in (model, other):
        folder.mkdir(parents=True)
        (folder / "weights.bin").write_bytes(b"x" * 1000)
    result = delete_local_model_cache("local-whisper", "small", cache_dir=tmp_path / "hf")
    assert (result.deleted, result.deleted_bytes, result.deleted_files) == (True, 1000, 1)
    assert not model.exists() and (other / "weights.bin").exists()


async def test_new_routes_require_the_token(kb_app: Any) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=kb_app), base_url="http://127.0.0.1:8765",
    ) as anonymous:
        assert (await anonymous.post("/kb/agents/codex/logout")).status_code == 401
        assert (await anonymous.delete("/kb/settings/speech/local-model")).status_code == 401
