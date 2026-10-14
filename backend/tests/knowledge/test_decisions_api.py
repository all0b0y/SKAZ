"""``/kb/decisions`` over ASGI: provider choice and consent, «Check», journal counts, local actions.

OpenRouter is a ``MockTransport`` (no key, no network): request handling only.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.knowledge.decisions.protocol import ChoiceQuestion, Undecided, YesNoQuestion
from skaz.knowledge.decisions.service import CONSENT_REQUIRED, LAYER_OFF
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN

OPENROUTER = "https://openrouter.ai/api/v1/systemone"


class Jev:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if str(request.url) != OPENROUTER:
            return httpx.Response(599)
        body = json.loads(request.content)
        self.calls.append(body)
        answers: dict[str, Any] = {}
        for qid, question in body["questions"].items():
            if question["type"] == "choice":
                keys = list(question["criteria"])
                answers[qid] = {"type": "choice", "choice": keys[0], "confidence": 0.95,
                                "probabilities": {key: (0.97 if i == 0 else 0.03 / (len(keys) - 1))
                                                  for i, key in enumerate(keys)}}
            else:
                answers[qid] = {"type": "noul", "noul": 0.55}
        return httpx.Response(200, json={"model": "typesafe/jev-1.13", "answers": answers, "usage": {}})


@pytest.fixture
def jev() -> Jev:
    return Jev()


@pytest.fixture
def app(tmp_path: Path, jev: Jev) -> Iterator[Any]:
    documents = tmp_path / "Documents"
    documents.mkdir()
    config = AppConfig(token=TOKEN, data_dir=tmp_path / "data", documents_dir=documents,
                       documents_sandbox=documents)
    application = create_app(config, secret_store=MemorySecretStore({"openrouter": "sk-or-test"}),
                             http_client=httpx.AsyncClient(transport=httpx.MockTransport(jev)))
    yield application
    application.state.runtime.close()


@pytest.fixture
async def client(app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765",
                                 headers={"Authorization": f"Bearer {TOKEN}"}) as http:
        yield http


async def test_routes_require_the_token(app: Any) -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as anon:
        assert (await anon.get("/kb/decisions")).status_code == 401
        assert (await anon.post("/kb/decisions/test")).status_code == 401


async def test_defaults_off_with_local_not_downloaded(client: httpx.AsyncClient) -> None:
    view = (await client.get("/kb/decisions")).json()
    assert view["provider"] == "off" and view["cloud_consent"] is False and view["openrouter_key"] is True
    assert view["cloud_model"] == "typesafe/jev-1.13"
    local = view["local"]
    assert local["state"] == "not_downloaded" and local["progress"] is None and local["reason"] is None
    assert local["server_build"] == "b11624" and local["server_license"] == "MIT"
    assert local["total_bytes"] > 0 and local["required_bytes"] > 0
    assert view["stats"] == {"decided": 0, "undecided": 0}
    checked = await client.post("/kb/decisions/test")
    assert checked.status_code == 409 and checked.json() == {"detail": LAYER_OFF}


async def test_cloud_requires_consent_and_check_calls_jev(client: httpx.AsyncClient, jev: Jev) -> None:
    refused = await client.put("/kb/decisions/provider", json={"provider": "openrouter_jev"})
    assert refused.status_code == 409 and refused.json() == {"detail": CONSENT_REQUIRED}
    assert jev.calls == []
    chosen = await client.put("/kb/decisions/provider",
                              json={"provider": "openrouter_jev", "cloud_consent": True})
    assert chosen.status_code == 200
    assert chosen.json()["provider"] == "openrouter_jev" and chosen.json()["cloud_consent"] is True
    # Withdrawing consent while staying on the cloud is refused; switching away is fine.
    withdrawn = await client.put("/kb/decisions/provider",
                                 json={"provider": "openrouter_jev", "cloud_consent": False})
    assert withdrawn.status_code == 409

    checked = (await client.post("/kb/decisions/test")).json()
    assert checked["provider"] == "openrouter_jev" and checked["decided"] is True
    assert checked["answer"].startswith("Electrical resistance")
    assert checked["probability"] == pytest.approx(0.97)
    assert len(jev.calls) == 1 and jev.calls[0]["model"] == "typesafe/jev-1.13"
    assert (await client.get("/kb/decisions")).json()["stats"] == {"decided": 0, "undecided": 0}

    off = await client.put("/kb/decisions/provider", json={"provider": "off", "cloud_consent": False})
    assert off.json()["provider"] == "off" and off.json()["cloud_consent"] is False
    assert (await client.put("/kb/decisions/provider", json={"provider": "cloud"})).status_code == 422


async def test_layer_journal_counts_decided_and_handed_to_writer(app: Any, client: httpx.AsyncClient,
                                                                 jev: Jev) -> None:
    service = app.state.runtime.kb_decisions
    assert service.layer() is None
    await client.put("/kb/decisions/provider", json={"provider": "openrouter_jev", "cloud_consent": True})
    layer = service.layer()
    assert layer is not None and layer.id == "openrouter_jev"
    state = "<untrusted-data>The concept.</untrusted-data>"
    choice, noul = await layer.ask_many([ChoiceQuestion(state, "Which?", ("a", "b")),
                                         YesNoQuestion(state, "Merge?")])
    assert not isinstance(choice, Undecided)
    assert isinstance(noul, Undecided)  # 55% is below the cloud cut: the writing model decides
    assert (await client.get("/kb/decisions")).json()["stats"] == {"decided": 1, "undecided": 1}
    activity = app.state.runtime.activity_log.snapshot(10)["entries"]
    assert [entry["outcome"] for entry in activity[:2]] == ["handed_to_writer", "ok"]
    assert all("The concept" not in json.dumps(entry) for entry in activity)
    with service.journal.db.read() as connection:
        rows = [dict(row) for row in connection.execute("SELECT * FROM decision_events")]
    assert {row["decider"] for row in rows} == {"openrouter_jev"}
    assert all("The concept" not in json.dumps(row) for row in rows)


async def test_local_provider_without_download_is_undecided_and_never_cloud(client: httpx.AsyncClient,
                                                                             jev: Jev) -> None:
    await client.put("/kb/decisions/provider", json={"provider": "local", "cloud_consent": True})
    checked = (await client.post("/kb/decisions/test")).json()
    assert checked["provider"] == "local" and checked["decided"] is False
    assert checked["reason"] == "The local decision model isn't downloaded. Download it in Settings."
    assert jev.calls == []
    assert (await client.post("/kb/decisions/local/cancel")).json()["local"]["state"] == "not_downloaded"
    assert (await client.delete("/kb/decisions/local")).json()["local"]["state"] == "not_downloaded"
