"""``POST /kb/mcp`` over ASGI: dual-era MCP, per-run tokens, read-only bounded tools."""
from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.prompting import UNTRUSTED_HEADER
from skaz.knowledge.agents.tools import TOOL_NAMES
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.mcp import McpRunScope, McpServer, McpTokens
from skaz.knowledge.wiring import McpGrants
from tests.conftest import TOKEN

from .a1_library import Seeded, seed

MODERN = "2026-07-28"
LEGACY = "2025-11-25"


@pytest.fixture
def mcp(kb_app: Any) -> McpServer:
    server: McpServer = kb_app.state.runtime.kb_mcp
    return server


@pytest.fixture
def seeded(kb_app: Any) -> Seeded:
    kb = kb_app.state.runtime.kb
    assert kb.connect(None).state == "ready"
    return seed(kb)


@pytest.fixture
async def http(kb_app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=kb_app),
                                 base_url="http://127.0.0.1:8765") as client:
        yield client


def full_token(mcp: McpServer, run_id: str = "run-1", tools: tuple[str, ...] = TOOL_NAMES) -> str:
    return mcp.issue_mcp_token(McpRunScope(run_id, frozenset(tools)))


def rpc(method: str, params: dict[str, Any] | None = None, identity: int | str = 1) -> dict[str, Any]:
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": identity, "method": method}
    if params is not None:
        message["params"] = params
    return message


def legacy_headers(token: str, version: str | None = LEGACY) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json, text/event-stream"}
    if version is not None:
        headers["MCP-Protocol-Version"] = version
    return headers


def modern(method: str, params: dict[str, Any] | None = None, *, token: str, name: str | None = None,
           identity: int = 1) -> tuple[dict[str, Any], dict[str, str]]:
    body = rpc(method, {**(params or {}), "_meta": {
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientInfo": {"name": "test", "version": "1"},
        "io.modelcontextprotocol/clientCapabilities": {},
    }}, identity)
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json, text/event-stream",
               "MCP-Protocol-Version": MODERN, "Mcp-Method": method}
    if name is not None:
        headers["Mcp-Name"] = name
    return body, headers


def tool_text(response: httpx.Response) -> str:
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["isError"] is False, result
    text: str = result["content"][0]["text"]
    return text


async def test_legacy_handshake_list_call_and_ping(http: httpx.AsyncClient, mcp: McpServer,
                                                   seeded: Seeded) -> None:
    token = full_token(mcp)
    init = await http.post("/kb/mcp", headers=legacy_headers(token, None), json=rpc("initialize", {
        "protocolVersion": LEGACY, "capabilities": {}, "clientInfo": {"name": "test", "version": "1"},
    }))
    assert init.status_code == 200 and "mcp-session-id" not in init.headers
    result = init.json()["result"]
    assert result["protocolVersion"] == LEGACY
    assert result["capabilities"] == {"tools": {"listChanged": False}}
    assert result["serverInfo"]["name"] == "skaz" and "untrusted" in result["instructions"]

    initialized = await http.post("/kb/mcp", headers=legacy_headers(token),
                                  json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert initialized.status_code == 202 and initialized.content == b""

    listed = (await http.post("/kb/mcp", headers=legacy_headers(token), json=rpc("tools/list", {}, 2))).json()
    tools = listed["result"]["tools"]
    assert [tool["name"] for tool in tools] == list(TOOL_NAMES)
    assert all(tool["annotations"]["readOnlyHint"] is True for tool in tools)
    assert "resultType" not in listed["result"]

    pong = await http.post("/kb/mcp", headers=legacy_headers(token), json=rpc("ping", None, 3))
    assert pong.json() == {"jsonrpc": "2.0", "id": 3, "result": {}}

    called = await http.post("/kb/mcp", headers=legacy_headers(token), json=rpc("tools/call", {
        "name": "skaz_get_fragment", "arguments": {"material_id": seeded.lecture_id, "seg": 1},
    }, 4))
    text = tool_text(called)
    assert text.startswith(UNTRUSTED_HEADER) and "Энтропия — мера беспорядка системы." in text

    other = await http.post("/kb/mcp", headers=legacy_headers(token), json=rpc("resources/list", {}, 5))
    assert other.status_code == 200 and other.json()["error"]["code"] == -32601

    headerless = await http.post("/kb/mcp", headers=legacy_headers(token, None),
                                 json=rpc("tools/list", {}, 6))
    assert headerless.status_code == 200 and len(headerless.json()["result"]["tools"]) == len(TOOL_NAMES)

    older = await http.post("/kb/mcp", headers=legacy_headers(token, None), json=rpc("initialize", {
        "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "old", "version": "1"},
    }, 7))
    assert older.json()["result"]["protocolVersion"] == LEGACY


async def test_modern_requests_are_stateless_and_header_checked(http: httpx.AsyncClient, mcp: McpServer,
                                                                seeded: Seeded) -> None:
    token = full_token(mcp)
    body, headers = modern("server/discover", token=token)
    discovered = (await http.post("/kb/mcp", headers=headers, json=body)).json()["result"]
    assert discovered["resultType"] == "complete"
    assert discovered["supportedVersions"][0] == MODERN and LEGACY in discovered["supportedVersions"]
    assert discovered["_meta"]["io.modelcontextprotocol/serverInfo"]["name"] == "skaz"
    assert discovered["cacheScope"] == "private" and discovered["ttlMs"] >= 0

    body, headers = modern("tools/list", token=token)
    listed = (await http.post("/kb/mcp", headers=headers, json=body)).json()["result"]
    assert listed["resultType"] == "complete" and listed["cacheScope"] == "private"
    assert [tool["name"] for tool in listed["tools"]] == list(TOOL_NAMES)

    arguments = {"name": "skaz_search", "arguments": {"query": "энтропия"}}
    body, headers = modern("tools/call", arguments, token=token, name="skaz_search")
    called = await http.post("/kb/mcp", headers=headers, json=body)
    assert called.json()["result"]["resultType"] == "complete"
    assert "**" in tool_text(called)
    encoded = "=?base64?" + base64.b64encode(b"skaz_search").decode() + "?="
    body, headers = modern("tools/call", arguments, token=token, name=encoded)
    assert (await http.post("/kb/mcp", headers=headers, json=body)).status_code == 200

    body, headers = modern("tools/call", arguments, token=token, name="skaz_list_folders")
    mismatch = await http.post("/kb/mcp", headers=headers, json=body)
    assert mismatch.status_code == 400 and mismatch.json()["error"]["code"] == -32020
    body, headers = modern("tools/list", token=token)
    headers["Mcp-Method"] = "tools/call"
    assert (await http.post("/kb/mcp", headers=headers, json=body)).json()["error"]["code"] == -32020
    body, headers = modern("tools/list", token=token)
    body["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] = LEGACY
    assert (await http.post("/kb/mcp", headers=headers, json=body)).status_code == 400

    for method in ("ping", "resources/list"):
        body, headers = modern(method, token=token)
        missing = await http.post("/kb/mcp", headers=headers, json=body)
        assert missing.status_code == 404 and missing.json()["error"]["code"] == -32601

    body, headers = modern("tools/list", token=token)
    headers["MCP-Protocol-Version"] = "2099-01-01"
    unsupported = await http.post("/kb/mcp", headers=headers, json=body)
    assert unsupported.status_code == 400
    error = unsupported.json()["error"]
    assert error["code"] == -32022 and error["data"]["requested"] == "2099-01-01"
    assert MODERN in error["data"]["supported"] and LEGACY in error["data"]["supported"]


async def test_wrong_app_revoked_or_expired_tokens_get_401(kb_app: Any, http: httpx.AsyncClient,
                                                           mcp: McpServer) -> None:
    request = rpc("tools/list", {})
    assert (await http.post("/kb/mcp", json=request)).status_code == 401
    # The SKAZ app token is not an MCP token: agents never get it.
    app_token = await http.post("/kb/mcp", headers=legacy_headers(TOKEN), json=request)
    assert app_token.status_code == 401 and app_token.headers["www-authenticate"] == "Bearer"
    forged = await http.post("/kb/mcp", headers=legacy_headers("skaz-mcp-forged"), json=request)
    assert forged.status_code == 401

    # The live path: engines get access per run through ``McpGrants`` and lose it when the run ends.
    grants = McpGrants(mcp)
    specs = tuple(spec for spec in kb_app.state.runtime.kb_tools.specs() if spec.name == "skaz_list_folders")
    access = grants.grant("run-ctx", specs)
    assert access.url.endswith("/kb/mcp") and access.token not in repr(access)
    inside = await http.post("/kb/mcp", headers=legacy_headers(access.token), json=request)
    assert inside.status_code == 200
    other = grants.grant("run-other", specs)
    grants.revoke("run-ctx")
    assert (await http.post("/kb/mcp", headers=legacy_headers(access.token), json=request)).status_code == 401
    assert (await http.post("/kb/mcp", headers=legacy_headers(other.token), json=request)).status_code == 200
    grants.revoke("run-ctx")  # idempotent

    second = full_token(mcp, "run-2")
    mcp.revoke_run("run-2")
    assert (await http.post("/kb/mcp", headers=legacy_headers(second), json=request)).status_code == 401

    now = [0.0]
    tokens = McpTokens(ttl_s=10, clock=lambda: now[0])
    expiring = tokens.issue(McpRunScope("run-3", frozenset({"skaz_list_folders"})))
    assert tokens.resolve(expiring) is not None
    now[0] = 11
    assert tokens.resolve(expiring) is None


async def test_token_tool_set_narrows_list_and_call(http: httpx.AsyncClient, mcp: McpServer,
                                                    seeded: Seeded) -> None:
    token = full_token(mcp, tools=("skaz_list_folders", "skaz_search"))
    listed = (await http.post("/kb/mcp", headers=legacy_headers(token), json=rpc("tools/list", {}))).json()
    assert [tool["name"] for tool in listed["result"]["tools"]] == ["skaz_search", "skaz_list_folders"]
    outside = await http.post("/kb/mcp", headers=legacy_headers(token), json=rpc("tools/call", {
        "name": "skaz_read_material", "arguments": {"material_id": seeded.lecture_id},
    }))
    assert outside.status_code == 200
    assert outside.json()["error"] == {"code": -32602,
                                       "message": "Tool not available for this run: skaz_read_material"}
    body, headers = modern("tools/call", {"name": "skaz_get_fragment", "arguments": {}}, token=token,
                           name="skaz_get_fragment")
    assert (await http.post("/kb/mcp", headers=headers, json=body)).json()["error"]["code"] == -32602

    invalid = await http.post("/kb/mcp", headers=legacy_headers(token), json=rpc("tools/call", {
        "name": "skaz_search", "arguments": {"query": ""},
    }))
    result = invalid.json()["result"]
    assert result["isError"] is True and result["content"][0]["text"].startswith("Invalid arguments: query:")

    with pytest.raises(ValueError, match="ingest runs get none"):
        mcp.issue_mcp_token(McpRunScope("ingest-1", frozenset()))
    with pytest.raises(ValueError, match="Unknown SKAZ tools"):
        mcp.issue_mcp_token(McpRunScope("run-x", frozenset({"skaz_write_page"})))


async def test_tool_output_stays_within_limits_and_untrusted(kb_app: Any, http: httpx.AsyncClient,
                                                             mcp: McpServer, seeded: Seeded) -> None:
    kb = kb_app.state.runtime.kb
    long = kb.create_material(seeded.folder_id, "Длинная", "audio", [
        FragmentInput(text="Очень длинный абзац о теплоте. " * 60, start_ms=n * 1000, end_ms=(n + 1) * 1000)
        for n in range(80)
    ])
    token = full_token(mcp)
    called = await http.post("/kb/mcp", headers=legacy_headers(token), json=rpc("tools/call", {
        "name": "skaz_read_material", "arguments": {"material_id": long.manifest.id},
    }))
    text = tool_text(called)
    assert len(text.encode()) <= mcp.registry.get("skaz_read_material").max_output_bytes  # type: ignore[union-attr]
    data = json.loads(text.split("\n")[2])
    assert data["has_more"] is True and data["next_from_seg"] > 1

    injected = tool_text(await http.post("/kb/mcp", headers=legacy_headers(token), json=rpc("tools/call", {
        "name": "skaz_get_fragment", "arguments": {"material_id": seeded.lecture_id, "seg": 3},
    })))
    assert injected.startswith(UNTRUSTED_HEADER) and injected.count("</untrusted-data>") == 1


async def test_call_budget_per_run(kb_app: Any, http: httpx.AsyncClient, seeded: Seeded) -> None:
    runtime = kb_app.state.runtime
    runtime.kb_mcp = McpServer(runtime.kb_tools, McpTokens(max_calls=1), url="http://127.0.0.1:1/kb/mcp")
    token = full_token(runtime.kb_mcp)
    call = rpc("tools/call", {"name": "skaz_list_folders", "arguments": {}})
    first = (await http.post("/kb/mcp", headers=legacy_headers(token), json=call)).json()
    assert first["result"]["isError"] is False
    spent = (await http.post("/kb/mcp", headers=legacy_headers(token), json=call)).json()["result"]
    assert spent == {"content": [{"type": "text", "text": "Too many tool calls in this run."}],
                     "isError": True}


async def test_transport_edges_and_local_only(kb_app: Any, http: httpx.AsyncClient, mcp: McpServer) -> None:
    token = full_token(mcp)
    headers = legacy_headers(token)
    assert (await http.get("/kb/mcp", headers=headers)).status_code == 405
    assert (await http.delete("/kb/mcp", headers=headers)).status_code == 405
    batch = await http.post("/kb/mcp", headers=headers, json=[rpc("ping"), rpc("ping", None, 2)])
    assert batch.status_code == 400 and batch.json()["error"]["code"] == -32600
    broken = await http.post("/kb/mcp", headers={**headers, "Content-Type": "application/json"},
                             content=b"{nope")
    assert broken.status_code == 400 and broken.json()["error"]["code"] == -32700
    huge = await http.post("/kb/mcp", headers=headers, content=b"x" * (256 * 1024 + 1))
    assert huge.status_code == 413
    no_id = await http.post("/kb/mcp", headers=headers, json={"jsonrpc": "2.0", "id": None, "method": "ping"})
    assert no_id.status_code == 400

    evil = await http.post("/kb/mcp", headers={**headers, "Origin": "https://evil.example"}, json=rpc("ping"))
    assert evil.status_code == 403
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=kb_app),
                                 base_url="http://attacker.example") as remote:
        assert (await remote.post("/kb/mcp", headers=headers, json=rpc("ping"))).status_code == 403

    assert not any(path.startswith("/kb/mcp") for path in kb_app.openapi()["paths"])


def test_no_token_carrying_dataclass_shows_its_token() -> None:
    """A token kept in a dataclass never appears in its repr (logs, tracebacks)."""
    import dataclasses

    from skaz.knowledge.agents import mcp_access
    from skaz.knowledge.mcp import server, tokens

    checked = []
    for module in (server, tokens, mcp_access):
        for value in vars(module).values():
            if not isinstance(value, type) or value.__module__ != module.__name__:
                continue
            name = value.__name__
            if dataclasses.is_dataclass(value):
                for item in dataclasses.fields(value):
                    if "token" in item.name:
                        checked.append(f"{name}.{item.name}")
                        assert item.repr is False, f"{name}.{item.name} is shown in repr"
    assert "McpAccess.token" in checked


class _CountingBody:
    """A chunked request body (no Content-Length) that counts how much of it the server read."""

    def __init__(self, chunks: int, size: int = 64 * 1024) -> None:
        self.chunks, self.size, self.read = chunks, size, 0

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for _ in range(self.chunks):
            self.read += 1
            yield b"x" * self.size


async def test_a_body_without_a_valid_token_is_never_read(http: httpx.AsyncClient) -> None:
    body = _CountingBody(64)  # 4 MB, chunked
    response = await http.post("/kb/mcp", headers=legacy_headers("not-a-token"), content=body)
    assert response.status_code == 401
    assert body.read <= 1  # the transport may hand over the first chunk; the router reads none


async def test_a_chunked_body_is_cut_at_the_limit(http: httpx.AsyncClient, mcp: McpServer) -> None:
    body = _CountingBody(64)  # 4 MB, no Content-Length to refuse it by
    response = await http.post("/kb/mcp", headers=legacy_headers(full_token(mcp)), content=body)
    assert response.status_code == 413
    assert body.read <= 256 // 64 + 2  # read until just past the 256 KB limit, not the 4 MB
