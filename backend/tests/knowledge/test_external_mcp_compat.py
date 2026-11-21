"""Regression coverage for deployed databases and HTTP servers that leave SSE responses open."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from collections.abc import AsyncIterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from skaz.knowledge.extensions.transport import response_body
from skaz.knowledge.store.database import KnowledgeDatabase
from skaz.knowledge.store.schema import MODULES, chats
from tests.knowledge.p_support import Invoke
from tests.knowledge.test_p_api import Env
from tests.knowledge.test_p_api import env as chat_fixture
from tests.knowledge.test_tools_files041 import add, call

env = chat_fixture


@pytest.mark.parametrize(("version", "interrupted"), [(2, False), (2, True), (3, False)])
def test_upgrade_keeps_old_decisions_and_grants(tmp_path: Path, version: int, interrupted: bool) -> None:
    old_sql = chats.PERMISSIONS_SQL.replace(", 'skill_install'", "")
    if version == 2:
        old_sql = old_sql.replace(", 'mcp_call', 'mcp_connect'", "").replace(", 'mcp_call'", "")
    if interrupted:
        # A previous launch already migrated requests; the grants table and version row are still v2.
        old_sql = chats.PERMISSIONS_SQL.split("CREATE TABLE IF NOT EXISTS permission_grants")[0] + (
            "CREATE TABLE IF NOT EXISTS permission_grants"
            + old_sql.split("CREATE TABLE IF NOT EXISTS permission_grants")[1]
        )
    path = tmp_path / "old.sqlite3"
    previous = SimpleNamespace(NAME="chats", VERSION=version, SQL=chats._CHATS_V1 + old_sql)
    old = KnowledgeDatabase(path, modules=tuple(previous if mod is chats else mod for mod in MODULES))
    with old.write() as db:
        db.execute(
            "INSERT INTO chat_threads(id,title,engine,created_at,updated_at) VALUES('c','T','codex','t','t')"
        )
        db.execute("INSERT INTO permission_grants VALUES('c','edit','old-grant')")
        db.execute(
            "INSERT INTO permission_requests(id,chat_id,message_id,run_id,engine,kind,status,created_at,"
            "undo,applied) VALUES('p','c','m','r','codex','edit','allowed','t','old-undo',1)"
        )
    old.close()
    for _ in range(2):
        current = KnowledgeDatabase(path)
        try:
            with current.write() as db:
                assert tuple(
                    db.execute("SELECT undo,applied,status FROM permission_requests").fetchone()
                ) == (
                    "old-undo",
                    1,
                    "allowed",
                )
                assert (
                    db.execute("SELECT granted_at FROM permission_grants WHERE kind='edit'").fetchone()[0]
                    == "old-grant"
                )
                db.execute("INSERT OR IGNORE INTO permission_grants VALUES('c','mcp_call','new')")
                with pytest.raises(sqlite3.IntegrityError):
                    db.execute("INSERT INTO permission_grants VALUES('c','mcp_connect','blocked')")
                db.execute("UPDATE permission_requests SET kind='skill_install' WHERE id='p'")
                with pytest.raises(sqlite3.IntegrityError):
                    db.execute("INSERT INTO permission_grants VALUES('c','skill_install','blocked')")
                assert not db.execute("PRAGMA foreign_key_check").fetchall()
        finally:
            current.close()


class PersistentReply(httpx.AsyncByteStream):
    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield b': keepalive\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n'
        yield b'data: {"jsonrpc":"2.0",'
        yield b'"id":2,"result":{"content":[]}}\r\n'
        yield b"\r\n"
        raise AssertionError("The connection is still open after the complete reply")


async def test_sse_reply_completes_without_waiting_for_eof() -> None:
    response = httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=PersistentReply())
    async with asyncio.timeout(1):
        assert await response_body(response, 4096, 2) == b'{"jsonrpc":"2.0","id":2,"result":{"content":[]}}'


async def test_large_catalog_can_be_read_in_chat_and_sessions_are_released(env: Env) -> None:
    closed = []
    schema = {"type": "object", "properties": {"body": {"type": "string", "description": "é" * 8000}}}

    def handle(req: httpx.Request) -> httpx.Response:
        if req.method == "DELETE":
            closed.append(req.headers["Mcp-Session-Id"])
            return httpx.Response(204)
        packet = json.loads(req.content)
        if "id" not in packet:
            return httpx.Response(202)
        if packet["method"] == "initialize":
            reply = {"protocolVersion": packet["params"]["protocolVersion"], "serverInfo": {"name": "Notes"}}
        else:
            reply = {
                "tools": [
                    {"name": "read", "inputSchema": schema},
                    {"name": "publish", "description": "Publish after approval", "inputSchema": schema},
                ]
            }
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": packet["id"], "result": reply},
            headers={"Mcp-Session-Id": "test-session"},
        )

    env.runtime.kb_extensions.transport.http_transport = httpx.MockTransport(handle)
    item = await add(env.client, "http://127.0.0.1:45678/mcp")
    assert closed == ["test-session"]
    chat = await env.chat()

    async def listing(arguments: dict[str, Any]) -> dict[str, Any]:
        await call(env, chat["id"], Invoke("skaz_mcp_list", arguments), None)
        return dict(json.loads(env.engine.outcomes[-1].split("\n")[-2]))

    assert (await listing({}))["connections"][0]["id"] == item["id"]
    records = await listing({"connection_id": item["id"]})
    assert [t["name"] for t in records["tools"]] == ["read", "publish"]
    offset = 0
    chunks = []
    while True:
        page = await listing({"connection_id": item["id"], "tool": "publish", "offset": offset})
        chunks.append(page["schema_json"])
        if page["next_offset"] is None:
            break
        assert page["next_offset"] > offset
        offset = page["next_offset"]
    assert json.loads("".join(chunks)) == schema
