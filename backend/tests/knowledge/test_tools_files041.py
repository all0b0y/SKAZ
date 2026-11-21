"""Public profile, chat decision and file boundaries. Only the external app and vendor CLI are fixtures."""

from __future__ import annotations

import base64
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.knowledge.agents.engine import TextDelta
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN
from tests.knowledge.chat_support import finished
from tests.knowledge.p_support import Invoke
from tests.knowledge.test_p_api import Env
from tests.knowledge.test_p_api import env as chat_fixture
from tests.knowledge.tools_files_fixture import FILE_BYTES, FILE_NAME, External
from tests.knowledge.tools_files_fixture import external as external_fixture

env = chat_fixture
external = external_fixture


TOOLS = "/kb/settings/tools"


def data(reply: httpx.Response, status: int = 200) -> Any:
    assert reply.status_code == status, f"{reply.request.method} {reply.request.url.path}: {reply.text}"
    return reply.json()


async def checked(client: httpx.AsyncClient, url: str, kind: str = "mcp") -> dict[str, Any]:
    return dict(data(await client.post(TOOLS + "/check", json={"url": url, "kind": kind})))


async def add(client: httpx.AsyncClient, url: str) -> dict[str, Any]:
    ticket = await checked(client, url)
    return dict(data(await client.post(TOOLS, json={"url": url, "check_id": ticket["check_id"]}), 201))


@asynccontextmanager
async def profile(config: AppConfig) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(config, secret_store=MemorySecretStore())
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as client:
            assert (await client.post("/kb/library", json={})).status_code in (200, 201)
            yield client
    finally:
        app.state.runtime.close()


async def test_b1_checked_source_toggle_restart_and_isolation(
    kb_config: AppConfig, tmp_path: Path, external: External
) -> None:
    url = external.url + "/redirect"
    async with profile(kb_config) as client:
        initial = data(await client.get(TOOLS))
        assert initial["mcp"] == [] and [s["id"] for s in initial["skills"]] == ["humanizer"]
        denied = await client.post(TOOLS + "/check", json={"kind": "mcp", "url": external.url + "/blocked"})
        assert denied.status_code == 422 and denied.json()["detail"]
        assert data(await client.get(TOOLS))["mcp"] == []
        ticket = await checked(client, url)
        assert ticket["recipient"] == external.url + "/mcp"
        changed = await client.post(
            TOOLS, json={"url": external.url + "/mcp", "check_id": ticket["check_id"]}
        )
        assert changed.status_code in (409, 422)
        assert data(await client.get(TOOLS))["mcp"] == []
        item = await add(client, url)
        assert item["active"] and "save_note" in [tool["name"] for tool in item["tools"]]
        data(await client.patch(TOOLS + "/" + item["id"], json={"active": False}))
    async with profile(kb_config) as client:
        assert [(x["id"], x["active"]) for x in data(await client.get(TOOLS))["mcp"]] == [(item["id"], False)]
        assert data(await client.patch(TOOLS + "/" + item["id"], json={"active": True}))["active"]
    docs = tmp_path / "second-documents"
    docs.mkdir()
    async with profile(
        replace(kb_config, data_dir=tmp_path / "second", documents_dir=docs, documents_sandbox=docs)
    ) as other:
        assert data(await other.get(TOOLS))["mcp"] == []
    assert external.calls == []


async def call(env: Env, chat_id: str, invoke: Invoke, decision: str | None) -> dict[str, Any]:
    env.engine.script = lambda _turn: [invoke, TextDelta("", "Done.")]
    sent = await env.send(chat_id, "Create the single requested note.")
    assistant = sent["assistant"]["id"]
    if decision is not None:
        from tests.knowledge.ingest_support import settle

        await settle(lambda: bool(env.runtime.kb_permissions.store.pending_permissions()))
        before = await env.chat_view(chat_id)
        message = next(m for m in before["messages"] if m["id"] == assistant)
        part = next(p for p in message["parts"] if p["type"] == "permission" and p["status"] == "pending")
        data(await env.client.post(f"/kb/permissions/{part['id']}/decide", json={"decision": decision}))
    await finished(env.runtime.kb_chats)
    return next(m for m in (await env.chat_view(chat_id))["messages"] if m["id"] == assistant)


async def test_b1_b2_agent_proposal_uses_same_check(env: Env, external: External) -> None:
    chat = await env.chat()

    def proposal(url: str) -> Invoke:
        return Invoke("skaz_mcp_propose", {"url": url})

    await call(env, chat["id"], proposal(external.url + "/blocked"), None)
    assert "/blocked" in external.requests
    assert data(await env.client.get(TOOLS))["mcp"] == []
    await call(env, chat["id"], proposal(external.url + "/mcp"), "deny")
    assert data(await env.client.get(TOOLS))["mcp"] == []
    await call(env, chat["id"], proposal(external.url + "/mcp"), "allow")
    assert len(data(await env.client.get(TOOLS))["mcp"]) == 1
    assert external.calls == []


async def test_b2_b3_consent_delivery_and_file_ownership(
    env: Env, external: External, kb_config: AppConfig, tmp_path: Path
) -> None:
    item = await add(env.client, external.url + "/mcp")
    chat, other = await env.chat(), await env.chat()
    args = {"title": "Lesson"}
    invoke = Invoke("skaz_mcp_call", {"connection_id": item["id"], "tool": "save_note", "arguments": args})
    await call(env, chat["id"], invoke, "deny")
    assert external.calls == []
    message = await call(env, chat["id"], invoke, "allow")
    assert external.calls == [{"name": "save_note", "arguments": args}]
    (part,) = [p for p in message["parts"] if p["type"] == "file"]
    assert (part["name"], part["size"]) == (FILE_NAME, len(FILE_BYTES))
    route = f"/kb/chats/{chat['id']}/messages/{message['id']}/files/{part['id']}"
    file = data(await env.client.get(route))
    assert file["name"] == FILE_NAME and base64.b64decode(file["data"], validate=True) == FILE_BYTES
    for wrong in (
        route.replace(chat["id"], other["id"]),
        route.replace(message["id"], "absent"),
        route.replace(part["id"], "absent"),
    ):
        assert (await env.client.get(wrong)).status_code == 404
    docs = tmp_path / "other-profile-documents"
    docs.mkdir()
    async with profile(
        replace(kb_config, data_dir=tmp_path / "other-profile", documents_dir=docs, documents_sandbox=docs)
    ) as other_profile:
        assert (await other_profile.get(route)).status_code == 404
    await call(env, chat["id"], invoke, "deny")  # allow once expired
    assert len(external.calls) == 1
    await call(env, chat["id"], invoke, "allow_chat")
    external.mode = "link"
    linked = await call(env, chat["id"], invoke, None)
    assert len(external.calls) == 3
    assert all(p["type"] != "file" for p in linked["parts"])
    await call(env, other["id"], invoke, "deny")
    assert len(external.calls) == 3
    data(await env.client.patch(TOOLS + "/" + item["id"], json={"active": False}))
    await call(env, chat["id"], invoke, None)
    assert len(external.calls) == 3


async def test_b2_disabled_during_consent_sends_nothing(env: Env, external: External) -> None:
    from tests.knowledge.ingest_support import settle

    item = await add(env.client, external.url + "/mcp")
    chat = await env.chat()
    args = {"connection_id": item["id"], "tool": "save_note", "arguments": {"title": "Lesson"}}
    env.engine.script = lambda _turn: [Invoke("skaz_mcp_call", args), TextDelta("", "Finished.")]
    await env.send(chat["id"], "Save a note.")
    await settle(lambda: bool(env.runtime.kb_permissions.store.pending_permissions()))
    (part,) = env.runtime.kb_permissions.store.pending_permissions()
    data(await env.client.patch(TOOLS + "/" + item["id"], json={"active": False}))
    await env.client.post(f"/kb/permissions/{part.id}/decide", json={"decision": "allow"})
    await finished(env.runtime.kb_chats)
    assert external.calls == []
