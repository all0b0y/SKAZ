"""Run source policy with deterministic DNS and HTTPS at the socket boundary. No external connections."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import httpx
import pytest

from skaz.knowledge.agents.engine import EngineId
from tests.knowledge.test_chats_api import Env
from tests.knowledge.test_chats_api import env as chat_fixture
from tests.knowledge.test_p_api import Env as ToolEnv
from tests.knowledge.test_tools_files041 import TOOLS, checked, data
from tests.knowledge.test_tools_files_adapters041 import wire
from tests.knowledge.tools_files_fixture import SKILL_BYTES, External

env = chat_fixture


TRUSTED = "https://publisher.test/SKILL.md"
REMOTE = "https://notes.test/mcp"


class Sources:
    def __init__(self) -> None:
        self.skill_bytes = SKILL_BYTES
        self.requests: list[tuple[str, str]] = []
        self.app = External()

    def handle(self, req: httpx.Request) -> httpx.Response:
        host = req.headers["host"]
        self.requests.append((host, req.url.path))
        if req.url.path == "/elsewhere":
            return httpx.Response(307, headers={"Location": "https://different.test/mcp"})
        if req.url.path == "/local":
            return httpx.Response(307, headers={"Location": "http://127.0.0.1:4150/mcp"})
        if req.url.path == "/direct":
            return httpx.Response(307, headers={"Location": "/mcp"})
        if req.url.path.endswith("/SKILL.md"):
            return httpx.Response(200, content=self.skill_bytes, headers={"Content-Type": "text/markdown"})
        body = json.loads(req.content)
        if "id" not in body:
            return httpx.Response(202)
        return httpx.Response(200, json={"id": body["id"], "jsonrpc": "2.0", "result": self.app.result(body)})


async def install_fixture(env: Env | ToolEnv) -> Sources:
    # First exercise the public contract so an absent feature has a behavioral RED on the baseline.
    data(await env.client.get(TOOLS))
    service = env.runtime.kb_extensions
    fixture = Sources()

    async def resolve(_: str) -> list[str]:
        return ["93.184.216.34"]

    service.transport.resolve = resolve
    service.transport.http_transport = httpx.MockTransport(fixture.handle)
    service.skill_sources = {
        TRUSTED: {
            "publisher": "Fixture publisher",
            "name": "Lecture brief",
            "version": "1",
            "sha256": hashlib.sha256(SKILL_BYTES).hexdigest(),
        }
    }
    service.mcp_sources = {REMOTE}
    return fixture


async def test_b1_unverified_remote_requires_warning_trusted_redirect_rechecked(env: Env) -> None:
    fixture = await install_fixture(env)
    url = "https://third.test/mcp"
    ticket = await checked(env.client, url)
    assert ticket["trust"] == "unverified" and ticket["warning"]
    create = {"url": url, "check_id": ticket["check_id"]}
    assert (await env.client.post(TOOLS, json=create)).status_code in (409, 422)
    ticket = await checked(env.client, url)
    item = data(
        await env.client.post(
            TOOLS, json={**create, "check_id": ticket["check_id"], "acknowledge_unverified": True}
        ),
        201,
    )
    assert item["trust"] == "unverified"
    assert (await checked(env.client, REMOTE))["trust"] == "verified"
    # A redirection that changes destination to a new, unapproved recipient needs a direct URL.
    for hop in ("elsewhere", "local"):
        result = await env.client.post(
            TOOLS + "/check", json={"url": "https://notes.test/" + hop, "kind": "mcp"}
        )
        assert result.status_code == 422 and result.json()["detail"]
    assert all(host not in ("different.test", "127.0.0.1:4150") for host, _ in fixture.requests)
    assert (await checked(env.client, "https://notes.test/direct"))["recipient"] == REMOTE
    assert fixture.app.calls == []


@pytest.mark.parametrize("engine_id", ["codex", "claude_code", "hermes", "opencode"])
async def test_b2_verified_skill_download_then_disable_at_every_vendor_wire(
    env: Env, engine_id: EngineId, tmp_path: Path
) -> None:
    fixture = await install_fixture(env)
    unknown = await env.client.post(
        TOOLS + "/check", json={"kind": "skill", "url": "https://third.test/SKILL.md"}
    )
    assert unknown.status_code == 200 and unknown.json()["trust"] == "unverified"
    assert ("third.test", "/SKILL.md") in fixture.requests
    fixture.skill_bytes = b"modified"
    wrong = await env.client.post(TOOLS + "/check", json={"kind": "skill", "url": TRUSTED})
    assert wrong.status_code == 422
    assert [s["id"] for s in data(await env.client.get(TOOLS))["skills"]] == ["humanizer"]
    fixture.skill_bytes = SKILL_BYTES
    ticket = await checked(env.client, TRUSTED, "skill")
    installed = data(await env.client.post(TOOLS, json={"url": TRUSTED, "check_id": ticket["check_id"]}), 201)
    chat = await env.chat(engine=engine_id)
    await env.answered(chat["id"], "Make a lecture brief.")
    on, tools_on = await wire(env.agents.engines[engine_id].turns[-1], engine_id, env, tmp_path / "on")
    assert "ZEPHYR-704" in on
    data(await env.client.patch(TOOLS + "/" + installed["id"], json={"active": False}))
    await env.answered(chat["id"], "Make another lecture brief.")
    off, tools_off = await wire(env.agents.engines[engine_id].turns[-1], engine_id, env, tmp_path / "off")
    assert "ZEPHYR-704" not in off and tools_off == tools_on
    assert all(not path.startswith("/scripts/") for _, path in fixture.requests)
    assert fixture.app.calls == []
