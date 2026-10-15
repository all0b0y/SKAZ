"""``/kb/settings/{health,keys,speech,privacy,about}`` over the existing stores (area S3).

Provider key checks and agents are fakes at the external edge (FakeHttp,
fake engines with a fake installer): no network, no real CLI, no download.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz import asr_providers
from skaz.app import create_app
from skaz.config import AppConfig
from skaz.knowledge.agents.engine import EngineStatus
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.hub import build_agents_hub
from skaz.local_models import DownloadProgress
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp
from tests.knowledge.test_agent_install import FakeExecutor

SECRET = "sk-or-fixture-never-shown"


@pytest.fixture
def cloud() -> FakeHttp:
    return FakeHttp()


@pytest.fixture
def secrets() -> MemorySecretStore:
    return MemorySecretStore()


@pytest.fixture
def local_whisper(monkeypatch: pytest.MonkeyPatch) -> dict[str, bool]:
    state = {"installed": True, "cached": False}
    monkeypatch.setattr(asr_providers, "local_asr_available", lambda: state["installed"])
    monkeypatch.setattr(asr_providers, "local_model_cache_present", lambda *a, **k: state["cached"])
    return state


@pytest.fixture
def app(
    kb_config: AppConfig,
    cloud: FakeHttp,
    secrets: MemorySecretStore,
    tmp_path: Path,
    local_whisper: dict[str, bool],
) -> Iterator[Any]:
    application = create_app(kb_config, secret_store=secrets, http_client=cloud.client())
    runtime = application.state.runtime
    # Agents are fakes: no real codex/claude/hermes process is ever started here.
    runtime.kb_agents = build_agents_hub(
        tmp_path / "agents-data",
        settings=runtime.kb.settings,
        codex=None,  # type: ignore[arg-type]
        engines={
            "codex": FakeEngine(
                "codex", status=EngineStatus("codex", installed=False, reason="Codex is not installed.")
            ),
            "claude_code": FakeEngine("claude_code"),
            "hermes": FakeEngine("hermes"),
        },
        executor=FakeExecutor([([], 0)]),
    )
    yield application
    runtime.close()


@pytest.fixture
async def api(app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        yield client


async def health(api: httpx.AsyncClient) -> dict[str, dict[str, Any]]:
    response = await api.get("/kb/settings/health")
    assert response.status_code == 200, response.text
    return {section["id"]: section for section in response.json()["sections"]}


def problem(sections: dict[str, dict[str, Any]], section: str, problem_id: str) -> dict[str, Any] | None:
    return next((item for item in sections[section]["problems"] if item["id"] == problem_id), None)


async def test_keys_are_stored_in_the_secret_store_checked_and_never_returned(
    api: httpx.AsyncClient,
    cloud: FakeHttp,
    secrets: MemorySecretStore,
) -> None:
    listed = (await api.get("/kb/settings/keys")).json()
    assert listed == {
        "providers": [
            {"id": provider, "configured": False, "checked_at": None, "valid": None}
            for provider in ("openrouter", "soniox", "openai")
        ]
    }
    saved = await api.put("/kb/settings/keys/openrouter", json={"key": f"  {SECRET}  "})
    assert saved.status_code == 200, saved.text
    assert saved.json() == {"id": "openrouter", "configured": True, "checked_at": None, "valid": None}
    assert secrets.get("openrouter") == SECRET
    assert SECRET not in (await api.get("/kb/settings/keys")).text
    assert (await api.get("/settings")).json()["provider_has_api_key"]["openrouter"] is True

    cloud.json_route("GET", "openrouter.ai/api/v1/key", {"data": {"label": "x"}}, status=401)
    refused = (await api.post("/kb/settings/keys/openrouter/check")).json()
    assert refused["valid"] is False and refused["checked_at"]
    request = cloud.requests[-1]
    assert request.headers["Authorization"] == f"Bearer {SECRET}" and request.content == b""
    sections = await health(api)
    found = problem(sections, "accounts", "key-openrouter")
    assert found is not None and found["severity"] == "error" and sections["accounts"]["state"] == "error"
    assert [action["id"] for action in found["actions"]] == ["check"]

    cloud.json_route("GET", "openrouter.ai/api/v1/key", {"data": {}})
    fixed = await api.post("/kb/settings/health/key-openrouter/check")
    assert (
        fixed.status_code == 200
        and problem({s["id"]: s for s in fixed.json()["sections"]}, "accounts", "key-openrouter") is None
    )

    # A new key is never shown as checked; the provider being down is not "invalid".
    await api.put("/kb/settings/keys/openrouter", json={"key": "sk-or-another-fixture"})
    assert (await api.get("/kb/settings/keys")).json()["providers"][0]["valid"] is None
    cloud.json_route("GET", "openrouter.ai/api/v1/key", {}, status=503)
    down = await api.post("/kb/settings/keys/openrouter/check")
    assert (
        down.status_code == 502
        and (await api.get("/kb/settings/keys")).json()["providers"][0]["valid"] is None
    )

    deleted = await api.put("/kb/settings/keys/openrouter", json={"key": ""})
    assert deleted.json()["configured"] is False and secrets.get("openrouter") is None
    missing = await api.post("/kb/settings/keys/openrouter/check")
    assert missing.status_code == 409
    assert (await api.put("/kb/settings/keys/anthropic", json={"key": "x"})).status_code == 422


async def test_speech_settings_read_and_write_the_existing_settings(
    api: httpx.AsyncClient,
    local_whisper: dict[str, bool],
) -> None:
    speech = (await api.get("/kb/settings/speech")).json()
    assert speech == {
        "provider": "soniox",
        "languages": [],
        "translate_by_default": False,
        "translation_language": "ru",
        "local_model": {
            "model": "small", "state": "missing", "progress": None, "reason": None, "size_bytes": 484_000_000,
        },
        "cloud_consent": False,
    }
    changed = await api.put(
        "/kb/settings/speech",
        json={
            "provider": "local_whisper",
            "languages": ["en", "ru"],
            "translate_by_default": True,
            "translation_language": "en",
        },
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["provider"] == "local_whisper"
    legacy = (await api.get("/settings")).json()
    assert (
        legacy["transcription_provider"],
        legacy["used_languages"],
        legacy["native_recording_mode"],
        legacy["translation_target_language"],
    ) == ("local-whisper", ["en", "ru"], "translation", "en")
    local_whisper["cached"] = True
    assert (await api.get("/kb/settings/speech")).json()["local_model"]["state"] == "ready"
    local_whisper["installed"] = False
    failed = (await api.get("/kb/settings/speech")).json()["local_model"]
    assert failed["state"] == "failed" and "faster-whisper" in failed["reason"]
    assert (await api.put("/kb/settings/speech", json={"languages": ["xx"]})).status_code in (400, 422)
    assert (await api.put("/kb/settings/speech", json={"provider": "openai"})).status_code == 422


async def test_speech_problems_offer_explicit_fixes_only(
    app: Any,
    api: httpx.AsyncClient,
    secrets: MemorySecretStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sections = await health(api)
    no_key = problem(sections, "speech", "speech-soniox-key")
    assert no_key is not None and no_key["severity"] == "error"
    assert "still_works" in no_key and no_key["stopped"].startswith("New recordings")
    assert [action["id"] for action in no_key["actions"]] == ["use_local"]
    # Nothing switches by itself: the provider is still Soniox until the user clicks.
    assert (await api.get("/settings")).json()["transcription_provider"] == "soniox"

    switched = await api.post("/kb/settings/health/speech-soniox-key/use_local")
    assert switched.status_code == 200, switched.text
    assert (await api.get("/settings")).json()["transcription_provider"] == "local-whisper"
    missing = problem({s["id"]: s for s in switched.json()["sections"]}, "speech", "speech-local-model")
    assert missing is not None and missing["severity"] == "warning"
    assert [action["id"] for action in missing["actions"]] == ["download", "use_soniox"]

    started: list[tuple[str, str]] = []
    preparations = app.state.runtime.local_models

    async def start(model: str, provider: str = "local-whisper") -> tuple[str, None]:
        started.append((provider, model))
        preparations._progress[f"{provider}:{model}"] = DownloadProgress(downloaded_bytes=25, total_bytes=100)
        return "installing", None

    monkeypatch.setattr(preparations, "start", start)
    downloading = await api.post("/kb/settings/health/speech-local-model/download")
    assert started == [("local-whisper", "small")]
    progress = problem({s["id"]: s for s in downloading.json()["sections"]}, "speech", "speech-local-model")
    assert progress is not None and (progress["severity"], progress["progress"]) == ("progress", 0.25)
    assert {s["id"]: s for s in downloading.json()["sections"]}["speech"]["state"] == "progress"

    preparations._progress.clear()
    preparations._reports["local-whisper:small"] = ("error", "No space left for the model.")
    failed = problem(await health(api), "speech", "speech-local-model")
    assert (
        failed is not None
        and failed["severity"] == "error"
        and failed["reason"] == "No space left for the model."
    )
    back = await api.post("/kb/settings/health/speech-local-model/use_soniox")
    assert (
        back.status_code == 200 and (await api.get("/settings")).json()["transcription_provider"] == "soniox"
    )

    assert (await api.post("/kb/settings/health/speech-local-model/download")).status_code == 404
    assert (await api.post("/kb/settings/health/speech-soniox-key/download")).status_code == 409
    assert (await api.post("/kb/settings/health/no-such/thing")).status_code == 404


async def test_sending_audio_to_soniox_is_allowed_and_revoked_only_by_the_user(
    api: httpx.AsyncClient,
) -> None:
    """Review B2 #6: the consent lives in the existing settings (``cloud_consent``), never implied."""
    assert (await api.put("/kb/settings/keys/soniox", json={"key": "soniox-test-key"})).status_code == 200
    consent = problem(await health(api), "speech", "speech-soniox-consent")
    assert consent is not None and consent["severity"] == "error"
    assert [(action["id"], action["label"], action["primary"]) for action in consent["actions"]] == [
        ("allow_soniox", "Allow sending audio to Soniox", True),
        ("use_local", "Recognise on this Mac", False),
    ]
    # Choosing Soniox (again) is not consent.
    await api.put("/kb/settings/speech", json={"provider": "local_whisper"})
    chosen = await api.put("/kb/settings/speech", json={"provider": "soniox"})
    assert chosen.json()["cloud_consent"] is False
    assert (await api.get("/settings")).json()["cloud_consent"] is False

    allowed = await api.post("/kb/settings/health/speech-soniox-consent/allow_soniox")
    assert allowed.status_code == 200, allowed.text
    after = {section["id"]: section for section in allowed.json()["sections"]}
    assert problem(after, "speech", "speech-soniox-consent") is None
    assert (await api.get("/settings")).json()["cloud_consent"] is True
    assert (await api.get("/kb/settings/speech")).json()["cloud_consent"] is True
    flows = (await api.get("/kb/settings/privacy")).json()["flows"]
    assert next(flow for flow in flows if flow["where"].startswith("Soniox"))["enabled"]

    revoked = await api.put("/kb/settings/speech", json={"cloud_consent": False})
    assert revoked.status_code == 200 and revoked.json()["cloud_consent"] is False
    assert (await api.get("/settings")).json()["cloud_consent"] is False
    assert problem(await health(api), "speech", "speech-soniox-consent") is not None
    regranted = await api.put("/kb/settings/speech", json={"cloud_consent": True})
    assert regranted.json()["cloud_consent"] is True
    # The action is gone once there is nothing to fix.
    assert (await api.post("/kb/settings/health/speech-soniox-consent/allow_soniox")).status_code == 404


async def test_library_agent_and_decision_problems(app: Any, api: httpx.AsyncClient) -> None:
    sections = await health(api)
    library = problem(sections, "storage", "library-not-connected")
    assert library is not None and sections["storage"]["state"] == "warning"
    connected = await api.post("/kb/settings/health/library-not-connected/connect")
    assert connected.status_code == 200
    assert {s["id"]: s for s in connected.json()["sections"]}["storage"]["state"] == "ok"
    assert (await api.get("/kb/library")).json()["state"] == "ready"

    agent = problem(sections, "accounts", "agent-codex")
    assert agent is not None and agent["title"] == "Codex isn't installed"
    assert [action["id"] for action in agent["actions"]] == ["install"]
    installing = await api.post("/kb/settings/health/agent-codex/install")
    assert installing.status_code == 200
    assert app.state.runtime.kb_agents.installs.recipes["codex"].name == "Codex"

    # Only the main agent is a problem: Claude Code / Hermes not ready doesn't raise anything.
    assert all(
        item["id"] == "agent-codex"
        for item in sections["accounts"]["problems"]
        if item["id"].startswith("agent-")
    )

    assert (await api.put("/kb/decisions/provider", json={"provider": "local"})).status_code == 200
    local = problem(await health(api), "models", "decisions-local")
    assert local is not None and local["severity"] == "warning"
    assert [action["id"] for action in local["actions"]] == ["download", "use_cloud"]
    # Back to the cloud only with the consent the user gave for it: here none was given.
    refused = await api.post("/kb/settings/health/decisions-local/use_cloud")
    assert refused.status_code == 409
    assert (await api.get("/kb/decisions")).json()["provider"] == "local"

    assert (
        await api.put("/kb/decisions/provider", json={"provider": "openrouter_jev", "cloud_consent": True})
    ).status_code == 200
    no_key = problem(await health(api), "models", "decisions-openrouter")
    assert no_key is not None and no_key["actions"][0]["id"] == "use_local"
    assert (await api.post("/kb/settings/health/decisions-openrouter/use_local")).status_code == 200
    assert (await api.get("/kb/decisions")).json()["provider"] == "local"


async def test_privacy_follows_the_current_choices(api: httpx.AsyncClient) -> None:
    flows = (await api.get("/kb/settings/privacy")).json()["flows"]
    enabled = {(flow["where"], flow["what"][:20]) for flow in flows if flow["enabled"]}
    assert ("Soniox (cloud speech recognition)", "Audio of recordings") not in enabled  # no consent yet
    assert any(where.startswith("Codex") for where, _ in enabled)
    assert not any(where.startswith("Claude Code") for where, _ in enabled)
    assert (await api.put("/settings", json={"cloud_consent": True})).status_code == 200
    flows = (await api.get("/kb/settings/privacy")).json()["flows"]
    soniox = next(flow for flow in flows if flow["where"].startswith("Soniox"))
    assert soniox["enabled"] and soniox["when"]
    await api.put("/kb/agents/default", json={"engine": "claude_code"})
    flows = (await api.get("/kb/settings/privacy")).json()["flows"]
    chat = [flow for flow in flows if flow["when"] == "When you ask in a chat" and flow["enabled"]]
    assert [flow["where"].split(" ·")[0] for flow in chat] == ["Claude Code"]


async def test_about_has_version_build_and_licenses(
    api: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SKAZ_APP_VERSION", "0.3.0")
    monkeypatch.setenv("SKAZ_BUILD", "2026-10-15 abc1234")
    about = (await api.get("/kb/settings/about")).json()
    assert about["version"] == "0.3.0" and about["build"] == "2026-10-15 abc1234"
    names = {item["name"]: item["license"] for item in about["licenses"]}
    assert names["yt-dlp"] == "Unlicense" and names["FFmpeg"].startswith("LGPL")
    assert names["Qwen3.5 4B (Q4_K_M)"] == "Apache-2.0" and all(
        item["url"].startswith("https://") for item in about["licenses"]
    )
    monkeypatch.delenv("SKAZ_BUILD")
    assert (await api.get("/kb/settings/about")).json()["build"] == "development"


async def test_settings_routes_require_the_token(app: Any) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765"
    ) as anonymous:
        for path in (
            "/kb/settings/health",
            "/kb/settings/keys",
            "/kb/settings/speech",
            "/kb/settings/privacy",
            "/kb/settings/about",
        ):
            assert (await anonymous.get(path)).status_code == 401, path
