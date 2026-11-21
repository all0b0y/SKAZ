"""Count calls to the external loopback app made through each real SKAZ adapter and chat's grant."""

from __future__ import annotations

import asyncio
import json
import socket
from collections.abc import AsyncIterator
from dataclasses import replace
from pathlib import Path
from typing import Any, cast

import httpx
import pytest
import uvicorn

from skaz.knowledge.agents.codex import CodexEngine
from skaz.knowledge.agents.engine import AgentEngine, AgentEvent, AgentTurn, Completed, EngineId, TurnMessage
from skaz.knowledge.agents.registry import EngineRegistry
from skaz.knowledge.wiring import McpGrants
from tests.knowledge import test_agent_claude_code as claude
from tests.knowledge import test_agent_hermes as hermes
from tests.knowledge import test_agent_opencode as opencode
from tests.knowledge.agent_fakes import FakeCli
from tests.knowledge.chat_support import Agents, finished
from tests.knowledge.ingest_support import settle
from tests.knowledge.opencode_fake import FakeOpenCode
from tests.knowledge.p_support import ToolEngine
from tests.knowledge.test_codex_engine import FakeConnection
from tests.knowledge.test_tools_files041 import TOOLS, add, data
from tests.knowledge.tools_files_fixture import FILE_NAME, External
from tests.knowledge.tools_files_fixture import external as external_fixture

external = external_fixture


class OfflineVendor(ToolEngine):
    """Only status/model selection is scripted here. run() delegates to the actual product adapter."""

    def __init__(self, runtime: Any, engine_id: EngineId, root: Path) -> None:
        super().__init__(runtime, engine_id)
        self.root = root
        self.call: dict[str, Any] = {"name": "skaz_list_folders", "arguments": {}}
        self.replies: list[bool] = []

    async def run(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        root = self.root / turn.run_id
        root.mkdir()
        turn = replace(
            turn,
            web=None,
            model=None,
            effort=None,
            session=None,
            messages=(TurnMessage("user", "case:fixture_tool"),),
        )
        grant = McpGrants(self.runtime.kb_mcp)
        if self.id == "codex":
            (root / "selected-tool.json").write_text(json.dumps(self.call))
            connection = FakeConnection(root)
            adapter = CodexEngine(connection, self.runtime.kb_tools, run_timeout_s=15)
            async for event in adapter.run(turn):
                if isinstance(event, Completed):
                    reply = next(
                        item["result"]
                        for item in connection.received()
                        if item.get("id") == "tool-1" and "result" in item
                    )
                    self.replies.append(reply["success"])
                yield event
            return
        adapter_: AgentEngine
        cli: FakeCli | FakeOpenCode
        if self.id == "claude_code":
            adapter_, cli = claude.engine_for(
                root, {"stream": claude.SUCCESS, "fixture_tool": self.call}, mcp=cast(Any, grant)
            )
        elif self.id == "hermes":
            adapter_, cli = hermes.engine_for(
                root,
                hermes.scenario(
                    fixture_tool=self.call,
                    updates=[
                        {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "Finished."},
                        }
                    ],
                ),
                mcp=cast(Any, grant),
            )
        else:
            adapter_, cli = opencode.engine_for(
                root,
                opencode.scenario(
                    fixture_tool=self.call,
                    updates=[
                        {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "Finished."},
                        }
                    ],
                ),
                mcp=cast(Any, grant),
            )
            turn = replace(turn, model=opencode.SONNET)
        async for event in adapter_.run(turn):
            if isinstance(event, Completed):
                recorded = cli.records("fixture_result")
                self.replies.append(
                    bool(
                        recorded
                        and "result" in recorded[0]["reply"]
                        and not recorded[0]["reply"]["result"].get("isError")
                    )
                )
            yield event


@pytest.fixture
async def loopback(kb_app: Any) -> AsyncIterator[None]:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    server = uvicorn.Server(
        uvicorn.Config(kb_app, lifespan="off", log_level="error", access_log=False, ws="none")
    )
    kb_app.state.runtime.kb_mcp.url = f"http://127.0.0.1:{sock.getsockname()[1]}/kb/mcp"
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        await settle(lambda: server.started)
        yield
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 6)
        sock.close()


@pytest.mark.parametrize("engine_id", ["codex", "claude_code", "hermes", "opencode"])
@pytest.mark.parametrize("control", [True, False], ids=["existing-wire", "external-consent"])
async def test_b2_tool_requests_across_adapter(
    engine_id: EngineId,
    control: bool,
    loopback: None,
    kb_app: Any,
    kb_client: httpx.AsyncClient,
    external: External,
    tmp_path: Path,
) -> None:
    runtime = kb_app.state.runtime
    vendor = OfflineVendor(runtime, engine_id, tmp_path)
    engines: dict[EngineId, AgentEngine] = dict(Agents().engines)
    engines[engine_id] = vendor
    runtime.kb_agents.registry = EngineRegistry(engines, runtime.kb.settings, cache_s=0)
    assert (await kb_client.post("/kb/library", json={})).status_code in (200, 201)
    first, second = [
        data(await kb_client.post("/kb/chats", json={"engine": engine_id}), 201)["id"] for _ in range(2)
    ]

    async def send(chat: str, decision: str | None = None) -> dict[str, Any]:
        before = len(external.calls)
        sent = data(await kb_client.post(f"/kb/chats/{chat}/messages", json={"text": "Make my note."}), 202)
        message_id = sent["assistant"]["id"]
        if decision:
            await settle(lambda: bool(runtime.kb_permissions.store.pending_permissions()), timeout=8)
            (part,) = runtime.kb_permissions.store.pending_permissions()
            assert (part.chat_id, part.message_id) == (chat, message_id)
            assert len(external.calls) == before
            data(await kb_client.post(f"/kb/permissions/{part.id}/decide", json={"decision": decision}))
        await finished(runtime.kb_chats, timeout=12)
        msg = next(
            m for m in data(await kb_client.get(f"/kb/chats/{chat}"))["messages"] if m["id"] == message_id
        )
        assert msg["state"] == "done", msg.get("failure")
        return dict(msg)

    try:
        if control:
            await send(first)
            assert vendor.replies == [True]
            assert external.calls == []
            return
        item = await add(kb_client, external.url + "/mcp")
        arguments = {"title": "Only this title"}
        vendor.call = {
            "name": "skaz_mcp_call",
            "arguments": {"connection_id": item["id"], "tool": "save_note", "arguments": arguments},
        }
        await send(first, "deny")
        assert external.calls == []
        answer = await send(first, "allow")
        assert [p["name"] for p in answer["parts"] if p["type"] == "file"] == [FILE_NAME]
        await send(first, "allow_chat")  # Allow once did not persist
        await send(first)  # no second prompt in this chat
        await send(second, "deny")
        assert external.calls == [{"name": "save_note", "arguments": arguments}] * 3
        data(await kb_client.patch(TOOLS + "/" + item["id"], json={"active": False}))
        await send(first)
        assert len(external.calls) == 3
    finally:
        await runtime.kb_chats.close()
