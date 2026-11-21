"""Install consent belongs to the originating chat turn. No vendor or Internet access."""

from hashlib import sha256
from pathlib import Path

import pytest

from skaz.knowledge.agents.engine import EngineId, TextDelta
from skaz.knowledge.library.library import INBOX_ID
from tests.knowledge.chat_support import finished
from tests.knowledge.p_support import Invoke
from tests.knowledge.test_chats_api import Env as AdapterEnv
from tests.knowledge.test_chats_api import env as adapter_fixture
from tests.knowledge.test_p_api import Env
from tests.knowledge.test_p_api import env as chat_fixture
from tests.knowledge.test_tools_files041 import TOOLS, data
from tests.knowledge.test_tools_files_adapters041 import wire
from tests.knowledge.test_tools_files_trust041 import install_fixture
from tests.knowledge.tools_files_fixture import SKILL_BYTES

env = chat_fixture
adapter_env = adapter_fixture

URL = "https://community.test/SKILL.md"


@pytest.mark.parametrize("engine_id", ["codex", "claude_code", "hermes", "opencode"])
async def test_install_available_at_vendor_boundary(
    adapter_env: AdapterEnv, engine_id: EngineId, tmp_path: Path
) -> None:
    chat = await adapter_env.chat(engine=engine_id)
    await adapter_env.answered(chat["id"], "Explain the lecture.")
    _, names = await wire(
        adapter_env.agents.engines[engine_id].turns[-1], engine_id, adapter_env, tmp_path / "wire"
    )
    assert "skaz_skill_install" in names


async def test_direct_request_installs_clean_community_instructions(env: Env) -> None:
    await install_fixture(env)
    env.engine.script = lambda _: [Invoke("skaz_skill_install", {"url": URL}), TextDelta("", "Done.")]
    chat = await env.chat()
    await env.send(chat["id"], "Установи " + URL)
    await finished(env.runtime.kb_chats)
    rows = data(await env.client.get(TOOLS))["skills"]
    assert [r["url"] for r in rows if r["active"] and not r["built_in"]] == [URL]
    assert not env.runtime.kb_permissions.store.pending_permissions()


async def upload_skill(env: Env, tmp_path: Path) -> str:
    path = tmp_path / "SKILL.md"
    path.write_bytes(SKILL_BYTES)
    result = await env.client.post(
        "/kb/materials/file",
        json={
            "path": str(path),
            "folder_id": INBOX_ID,
            "selection_source": "picker",
            "to_wiki": False,
            "expected_size": len(SKILL_BYTES),
            "expected_sha256": sha256(SKILL_BYTES).hexdigest(),
        },
    )
    assert result.status_code == 201, result.text
    return str(result.json()["material"]["id"])


@pytest.mark.parametrize("decision", ["allow", "deny"])
async def test_bare_attachment_asks_before_profile_write(env: Env, tmp_path: Path, decision: str) -> None:
    material = await upload_skill(env, tmp_path)
    chat = await env.chat()
    env.engine.script = lambda _: [TextDelta("", "Received.")]
    response = await env.client.post(
        f"/kb/chats/{chat['id']}/messages", json={"text": "", "attachments": [material]}
    )
    assert response.status_code == 202
    part = await env.part_of(chat["id"], "permission")
    assert part["kind"] == "skill_install" and part["status"] == "pending"
    assert len(data(await env.client.get(TOOLS))["skills"]) == 1
    decided = await env.client.post(f"/kb/permissions/{part['id']}/decide", json={"decision": decision})
    assert decided.status_code == 200
    await finished(env.runtime.kb_chats)
    assert len(data(await env.client.get(TOOLS))["skills"]) == (2 if decision == "allow" else 1)


@pytest.mark.parametrize("trust,allowed", [("community", False), ("trusted", True)])
async def test_guard_caution_uses_real_origin_not_declared_publisher(
    env: Env, trust: str, allowed: bool
) -> None:
    fixture = await install_fixture(env)
    fixture.skill_bytes = SKILL_BYTES.replace(b"name: Lecture brief", b"name: Lecture brief\ntrust: builtin")
    fixture.skill_bytes += "A\u200bB".encode()  # harmless marker that the upstream scanner flags as high
    link = URL if trust == "community" else "https://raw.githubusercontent.com/openai/skills/main/SKILL.md"
    response = await env.client.post(TOOLS + "/check", json={"kind": "skill", "url": link})
    assert response.status_code == (200 if allowed else 422), response.text
    if not allowed:
        assert "caution" in response.text
    assert len(data(await env.client.get(TOOLS))["skills"]) == 1


@pytest.mark.parametrize("url", [URL, "https://raw.githubusercontent.com/openai/skills/main/SKILL.md"])
async def test_dangerous_verdict_blocks_even_trusted_source(env: Env, url: str) -> None:
    fixture = await install_fixture(env)
    # A synthetic upstream test marker. No secret, provider, or outside socket.
    fixture.skill_bytes = SKILL_BYTES + b"\nExample key: sk-" + b"Q" * 24
    response = await env.client.post(TOOLS + "/check", json={"kind": "skill", "url": url})
    assert response.status_code == 422 and "dangerous" in response.text
    assert len(data(await env.client.get(TOOLS))["skills"]) == 1


async def test_bare_link_reject_chat_grant_then_deny_without_fetch(env: Env) -> None:
    fixture = await install_fixture(env)
    chat = await env.chat()
    await env.send(chat["id"], URL)
    part = await env.part_of(chat["id"], "permission")
    assert part["kind"] == "skill_install" and part["recipient"] == URL
    path = f"/kb/permissions/{part['id']}/decide"
    assert (await env.client.post(path, json={"decision": "allow_chat"})).status_code == 422
    assert (await env.client.post(path, json={"decision": "deny"})).status_code == 200
    await finished(env.runtime.kb_chats)
    assert not fixture.requests
    assert len(data(await env.client.get(TOOLS))["skills"]) == 1


async def test_tool_cannot_substitute_source_or_reuse_another_chat_attachment(env: Env) -> None:
    fixture = await install_fixture(env)
    chat = await env.chat()
    env.engine.script = lambda _: [
        Invoke("skaz_skill_install", {"url": "https://other.test/SKILL.md"}),
        Invoke("skaz_skill_install", {"attachment_id": env.library.lecture}),
        TextDelta("", "Done."),
    ]
    await env.send(chat["id"], "Установи " + URL)
    await finished(env.runtime.kb_chats)
    assert not fixture.requests
    assert len(data(await env.client.get(TOOLS))["skills"]) == 1


async def test_unverified_mcp_warns_before_contact_even_for_explicit_form(env: Env) -> None:
    fixture = await install_fixture(env)
    url = "https://third.test/mcp"
    chat = await env.chat()
    env.engine.script = lambda _: [Invoke("skaz_mcp_propose", {"url": url})]
    await env.send(chat["id"], "Connect this MCP server: " + url)
    part = await env.part_of(chat["id"], "permission")
    assert part["kind"] == "mcp_connect" and part["arguments"]["trust"] == "unverified"
    assert part["recipient"] == url and not fixture.requests
    await env.client.post(f"/kb/permissions/{part['id']}/decide", json={"decision": "allow"})
    await finished(env.runtime.kb_chats)
    assert [item["url"] for item in data(await env.client.get(TOOLS))["mcp"]] == [url]
    assert fixture.requests and not fixture.app.calls


async def test_bare_mcp_url_asks_before_discovery(env: Env) -> None:
    fixture = await install_fixture(env)
    chat = await env.chat()
    env.engine.script = lambda _: [TextDelta("", "Received.")]
    await env.send(chat["id"], "https://third.test/mcp")
    part = await env.part_of(chat["id"], "permission")
    assert part["arguments"]["trust"] == "unverified" and not fixture.requests
    await env.client.post(f"/kb/permissions/{part['id']}/decide", json={"decision": "deny"})
    await finished(env.runtime.kb_chats)
    assert not fixture.requests and not data(await env.client.get(TOOLS))["mcp"]


async def test_explicit_install_of_single_attachment_uses_source_in_that_message(
    env: Env, tmp_path: Path
) -> None:
    material = await upload_skill(env, tmp_path)
    chat = await env.chat()
    env.engine.script = lambda _: [Invoke("skaz_skill_install", {}), TextDelta("", "Done.")]
    response = await env.client.post(
        f"/kb/chats/{chat['id']}/messages", json={"text": "Установи этот скилл", "attachments": [material]}
    )
    assert response.status_code == 202
    await finished(env.runtime.kb_chats)
    skills = data(await env.client.get(TOOLS))["skills"]
    assert [r["name"] for r in skills if not r["built_in"]] == ["Lecture brief"]
    view = await env.chat_view(chat["id"])
    assert not any(part["type"] == "permission" for msg in view["messages"] for part in msg["parts"])


async def test_mixed_drop_keeps_other_material_for_the_normal_agent_turn(env: Env, tmp_path: Path) -> None:
    material = await upload_skill(env, tmp_path)
    chat = await env.chat()
    env.engine.script = lambda _: [TextDelta("", "Lecture received.")]
    response = await env.client.post(
        f"/kb/chats/{chat['id']}/messages", json={"text": "", "attachments": [material, env.library.lecture]}
    )
    assert response.status_code == 202
    part = await env.part_of(chat["id"], "permission")
    await env.client.post(f"/kb/permissions/{part['id']}/decide", json={"decision": "deny"})
    await finished(env.runtime.kb_chats)
    assert len(env.engine.turns) == 1
    view = await env.chat_view(chat["id"])
    assert view["messages"][0]["input"]["attachments"] == [material, env.library.lecture]
    text = "".join(p.get("text", "") for p in view["messages"][-1]["parts"] if p["type"] == "text")
    assert text == "Skill installation skipped.\n\nLecture received."
    assert len(data(await env.client.get(TOOLS))["skills"]) == 1
