"""0.3.1 P, step 1: the permission broker, its storage, Stop/restart and the paused answer deadline.

The broker and its tables are SKAZ's own code (no fakes). Codex runs over the authored
stand-in process (``fixtures/codex_kb_server.py``, the app-server shape of
``DynamicToolCallParams`` in ``~/.hermes/cache/scratch/cxs`` generated from codex-cli 0.160.0).
"""
from __future__ import annotations

import asyncio
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import Field

from skaz.gateways.codex_rpc import CodexRpc
from skaz.knowledge.agents.codex import TOO_LONG, CodexEngine
from skaz.knowledge.agents.engine import AgentTurn, Completed, Failed, ToolResult, TurnMessage, collect
from skaz.knowledge.agents.tools import TOOLS, SkazTool, ToolContext, ToolRegistry, _Args
from skaz.knowledge.permissions.broker import (
    ALREADY,
    RESTARTED,
    PermissionBroker,
    PermissionConflict,
    PermissionInvalid,
)
from skaz.knowledge.permissions.store import ControlStore, RunRef
from skaz.knowledge.permissions.waits import RunWaits
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.store.database import KnowledgeDatabase
from skaz.knowledge.store.schema import MODULES, chats

FIXTURE = Path(__file__).parent / "fixtures" / "codex_kb_server.py"


class FakeConnection:
    """``CodexConnection`` stand-in that spawns the authored app-server fixture (as in test_codex_engine)."""

    def __init__(self, root: Path) -> None:
        self.cwd = root
        self.binary: str | None = sys.executable
        self.log = root / "codex-log.jsonl"

    async def check(self) -> dict[str, Any]:
        return {"status": "connected", "version": "codex-cli 0.160.0", "path": "/fixture/codex"}

    def rpc(self, *, max_message_bytes: int = 1024 * 1024) -> CodexRpc:
        return CodexRpc((sys.executable, str(FIXTURE), str(self.log)), cwd=self.cwd, env={},
                        max_message_bytes=max_message_bytes)

RUN = RunRef("msg-run-1", "chat-1", "msg-run-1", "codex")


def _chat(db: KnowledgeDatabase, chat_id: str = "chat-1") -> None:
    with db.write() as connection:
        connection.execute("INSERT INTO chat_threads(id, title, engine, created_at, updated_at) "
                           "VALUES (?, 'T', 'codex', 't', 't')", (chat_id,))


@pytest.fixture
def db(tmp_path: Path) -> Any:
    database = KnowledgeDatabase(tmp_path / "knowledge.sqlite3")
    _chat(database)
    yield database
    database.close()


@pytest.fixture
def broker(db: KnowledgeDatabase) -> PermissionBroker:
    return PermissionBroker(ControlStore(db), RunWaits())


async def _until(predicate: Any, timeout: float = 2.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.01)


# -- storage -------------------------------------------------------------------------------------


def test_a_chats_v1_database_upgrades_to_the_agent_control_tables(tmp_path: Path) -> None:
    """A library from 0.3.0 (chats v1) keeps its chats and gains the P tables (one upgrade step)."""
    path = tmp_path / "knowledge.sqlite3"
    v1 = SimpleNamespace(NAME="chats", VERSION=1, SQL=chats._CHATS_V1)
    old = KnowledgeDatabase(path, modules=tuple(v1 if module is chats else module for module in MODULES))
    _chat(old, "chat-old")
    with old.read() as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "permission_requests" not in tables
    old.close()

    db = KnowledgeDatabase(path)
    try:
        assert db.schema_versions()["chats"] == chats.VERSION == 2
        with db.read() as connection:
            tables = {row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            assert connection.execute("SELECT id FROM chat_threads").fetchone()[0] == "chat-old"
        assert {"permission_requests", "permission_grants", "agent_questions"} <= tables
        with db.write() as connection, pytest.raises(sqlite3.IntegrityError):
            connection.execute("INSERT INTO permission_grants(chat_id, kind, granted_at) "
                               "VALUES ('chat-old', 'delete', 't')")  # deleting can never be granted
    finally:
        db.close()


# -- broker ----------------------------------------------------------------------------------------


async def test_a_request_waits_without_a_timeout_until_the_user_allows(broker: PermissionBroker) -> None:
    seen: list[str] = []
    broker.listeners.append(lambda record: seen.append(record.status))
    task = asyncio.create_task(broker.request(RUN, "edit", page_id="pg-1", title="Entropy",
                                              preview={"summary": {"added": 1}}))
    await _until(lambda: seen == ["pending"])
    await asyncio.sleep(0.2)
    assert not task.done()  # no timeout: it waits for the user
    assert broker.waits.waiting(RUN.run_id)
    pending = broker.store.pending_permissions(run_id=RUN.run_id)
    assert [record.kind for record in pending] == ["edit"] and broker.waiting_chats() == {"chat-1"}

    decided = await broker.decide(pending[0].id, "allow")
    verdict = await task
    assert verdict.status == "allowed" and decided.status == "allowed" and verdict.permission.auto is False
    assert seen == ["pending", "allowed"] and not broker.waits.waiting(RUN.run_id)
    assert broker.waits.paused_s(RUN.run_id) >= 0.2
    with pytest.raises(PermissionConflict) as twice:
        await broker.decide(pending[0].id, "deny")
    assert twice.value.message == ALREADY and twice.value.status_code == 409


async def test_deny_carries_the_users_reason_to_the_agent(broker: PermissionBroker) -> None:
    task = asyncio.create_task(broker.request(RUN, "create", page_id=None, title="New", preview={}))
    await _until(lambda: bool(broker.store.pending_permissions()))
    record = broker.store.pending_permissions()[0]
    await broker.decide(record.id, "deny", "  Not this page, use Entropy  ")
    verdict = await task
    assert (verdict.status, verdict.reason) == ("denied", "Not this page, use Entropy")


async def test_allow_in_this_chat_covers_the_same_kind_never_delete(broker: PermissionBroker) -> None:
    task = asyncio.create_task(broker.request(RUN, "edit", page_id="pg-1", title="A", preview={}))
    await _until(lambda: bool(broker.store.pending_permissions()))
    await broker.decide(broker.store.pending_permissions()[0].id, "allow_chat")
    assert (await task).status == "allowed"

    again = await broker.request(RUN, "edit", page_id="pg-2", title="B", preview={})
    assert again.status == "allowed" and again.permission.auto is True  # no question this time

    other = asyncio.create_task(broker.request(RUN, "create", page_id=None, title="C", preview={}))
    await _until(lambda: bool(broker.store.pending_permissions()))
    assert broker.store.pending_permissions()[0].kind == "create"  # another kind still asks
    await broker.decide(broker.store.pending_permissions()[0].id, "deny")
    await other

    deletion = asyncio.create_task(broker.request(RUN, "delete", page_id="pg-1", title="A", preview={}))
    await _until(lambda: bool(broker.store.pending_permissions()))
    pending = broker.store.pending_permissions()[0]
    with pytest.raises(PermissionInvalid):
        await broker.decide(pending.id, "allow_chat")
    await broker.decide(pending.id, "allow")
    assert (await deletion).permission.auto is False

    other_chat = RunRef("run-x", "chat-2", "run-x", "hermes")
    _chat(broker.store.db, "chat-2")
    elsewhere = asyncio.create_task(broker.request(other_chat, "edit", page_id="pg-1", title="A", preview={}))
    await _until(lambda: bool(broker.store.pending_permissions()))  # the grant was for chat-1 only
    await broker.cancel_run("run-x")
    assert (await elsewhere).status == "cancelled"


async def test_stop_cancels_what_the_run_waits_for(broker: PermissionBroker) -> None:
    task = asyncio.create_task(broker.request(RUN, "rename", page_id="pg-1", title="A", preview={}))
    await _until(lambda: bool(broker.store.pending_permissions()))
    assert await broker.cancel_run(RUN.run_id) == 1
    verdict = await task
    assert verdict.status == "cancelled" and verdict.permission.status == "cancelled"
    assert broker.waiting_chats() == set() and not broker.waits.waiting(RUN.run_id)


async def test_an_abandoned_wait_is_recorded_as_cancelled(broker: PermissionBroker) -> None:
    task = asyncio.create_task(broker.request(RUN, "edit", page_id="pg-1", title="A", preview={}))
    await _until(lambda: bool(broker.store.pending_permissions()))
    record = broker.store.pending_permissions()[0]
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert broker.store.permission(record.id).status == "cancelled"  # type: ignore[union-attr]


def test_requests_left_pending_by_an_earlier_start_become_cancelled(db: KnowledgeDatabase) -> None:
    store = ControlStore(db)
    first = PermissionBroker(store, RunWaits())

    async def leave_pending() -> str:
        task = asyncio.create_task(first.request(RUN, "edit", page_id="pg-1", title="A", preview={}))
        await _until(lambda: bool(store.pending_permissions()))
        record_id = store.pending_permissions()[0].id
        task.cancel()  # the process "dies" without settling it: put the row back to pending
        await asyncio.gather(task, return_exceptions=True)
        store.update_permission(record_id, status="pending")
        return record_id

    record_id = asyncio.run(leave_pending())
    assert PermissionBroker(store, RunWaits()).recover() == 1
    record = store.permission(record_id)
    assert record is not None and (record.status, record.reason) == ("cancelled", RESTARTED)


async def test_an_answer_to_a_request_nobody_waits_for_is_refused(broker: PermissionBroker) -> None:
    task = asyncio.create_task(broker.request(RUN, "edit", page_id="pg-1", title="A", preview={}))
    await _until(lambda: bool(broker.store.pending_permissions()))
    record_id = broker.store.pending_permissions()[0].id
    broker._futures.pop(record_id)  # the waiting call is gone (crashed run)
    with pytest.raises(PermissionConflict) as refused:
        await broker.decide(record_id, "allow")
    assert refused.value.code == "NOT_WAITING"
    assert broker.store.permission(record_id).status == "cancelled"  # type: ignore[union-attr]
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


# -- the answer deadline stands still while the run waits ------------------------------------------


class _NoArgs(_Args):
    note: str | None = Field(default=None, max_length=10)


def _waiting_tool(waits: RunWaits | None, seconds: float) -> SkazTool:
    async def run(context: ToolContext | None, _args: Any) -> dict[str, Any]:
        assert context is not None and context.engine == "codex"
        if waits is not None:
            waits.begin(context.run_id)
        try:
            await asyncio.sleep(seconds)
        finally:
            if waits is not None:
                waits.end(context.run_id)
        return {"status": "applied"}

    return SkazTool("skaz_test_wait", "Waits like a permission request.", _NoArgs, run=run, timeout_s=None)


def _turn(registry: ToolRegistry) -> AgentTurn:
    return AgentTurn(run_id="run-1", messages=(TurnMessage("user", "case:wait_tool"),), instructions="",
                     tools=registry.specs({"skaz_test_wait"}))


async def test_codex_deadline_stands_still_while_the_user_decides(ready: KnowledgeService,
                                                                  tmp_path: Path) -> None:
    waits = RunWaits()
    registry = ToolRegistry(ready, (*TOOLS, _waiting_tool(waits, 1.2)))
    root = tmp_path / "codex"
    root.mkdir()
    engine = CodexEngine(FakeConnection(root), registry, run_timeout_s=0.6, waits=waits)
    result = await collect(engine.run(_turn(registry)))
    assert isinstance(result.terminal, Completed), result.terminal
    outcome = next(event for event in result.events if isinstance(event, ToolResult))
    assert outcome.output == '{"status":"applied"}' and not outcome.is_error


async def test_codex_deadline_still_ends_a_run_that_is_not_waiting(ready: KnowledgeService,
                                                                  tmp_path: Path) -> None:
    waits = RunWaits()
    registry = ToolRegistry(ready, (*TOOLS, _waiting_tool(None, 1.2)))
    root = tmp_path / "codex"
    root.mkdir()
    engine = CodexEngine(FakeConnection(root), registry, run_timeout_s=0.6, waits=waits)
    result = await collect(engine.run(_turn(registry)))
    assert isinstance(result.terminal, Failed) and result.terminal.message == TOO_LONG
