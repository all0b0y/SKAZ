"""Hermes 0.22's gateway daemon of SKAZ's own Hermes folder is stopped when SKAZ quits (decision B18).

Fake daemons only (``agent_fakes.FakeGateway``: real processes that hold ``gateway.lock`` and write
``gateway.pid`` the way ``gateway/status.py`` and ``gateway/runtime_ownership.py`` do) — no Hermes
runs. A daemon of any other ``HERMES_HOME`` (the user's ``~/.hermes`` above all) is never signalled.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

from skaz.knowledge.agents.hermes import HermesEngine
from skaz.knowledge.agents.hermes_gateway import GatewayDaemon, find_gateway, gateway_command
from skaz.knowledge.processes import CHILDREN, ChildProcesses
from skaz.knowledge.shutdown import close_knowledge
from tests.knowledge.agent_fakes import FakeGateway

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX daemons and signals")


@pytest.fixture
def gateways() -> Iterator[list[FakeGateway]]:
    started: list[FakeGateway] = []
    yield started
    for gateway in started:
        gateway.close()


def engine(tmp_path: Path) -> HermesEngine:
    return HermesEngine(tmp_path / "data", user_home=tmp_path / "home")


def start(gateways: list[FakeGateway], tmp_path: Path, home: Path, **kwargs: object) -> FakeGateway:
    gateway = FakeGateway(tmp_path / "fakes", home, **kwargs)  # type: ignore[arg-type]
    gateways.append(gateway)
    return gateway


def users_gateway(gateways: list[FakeGateway], tmp_path: Path) -> FakeGateway:
    return start(gateways, tmp_path, tmp_path / "home" / ".hermes")


def test_the_gateway_of_skaz_folder_is_found_and_stopped_as_a_planned_stop(
    tmp_path: Path, gateways: list[FakeGateway],
) -> None:
    hermes = engine(tmp_path)
    ours = start(gateways, tmp_path, hermes.home)
    found = find_gateway(hermes.home)
    assert found == GatewayDaemon(hermes.home, ours.pid)
    assert found.returncode is None
    assert found.deliver(signal.SIGTERM)
    assert ours.stopped() and ours.notes() == ["ready", "SIGINT"]  # Hermes' planned stop, not a kill
    assert found.returncode == 0
    assert find_gateway(hermes.home) is None


def test_the_users_gateway_is_never_found(tmp_path: Path, gateways: list[FakeGateway]) -> None:
    hermes = engine(tmp_path)
    user = users_gateway(gateways, tmp_path)
    assert find_gateway(hermes.home) is None
    assert find_gateway(tmp_path / "data" / "agents") is None
    assert user.process.poll() is None and user.notes() == ["ready"]


def test_files_in_skaz_folder_pointing_at_the_users_gateway_are_not_trusted(
    tmp_path: Path, gateways: list[FakeGateway],
) -> None:
    hermes = engine(tmp_path)
    user = users_gateway(gateways, tmp_path)
    hermes.home.mkdir(parents=True, exist_ok=True)
    claim = json.loads((user.home / "gateway.pid").read_text())
    # Copied records (a stale or planted file): nothing holds SKAZ's lock.
    for name in ("gateway.pid", "gateway.lock"):
        (hermes.home / name).write_text(json.dumps(claim))
    assert find_gateway(hermes.home) is None
    # The same, claiming SKAZ's folder.
    for name in ("gateway.pid", "gateway.lock"):
        (hermes.home / name).write_text(json.dumps({**claim, "hermes_home": str(hermes.home)}))
    assert find_gateway(hermes.home) is None
    assert user.process.poll() is None and user.notes() == ["ready"]


def test_a_live_gateway_of_skaz_folder_whose_pid_file_names_another_process_is_not_signalled(
    tmp_path: Path, gateways: list[FakeGateway],
) -> None:
    hermes = engine(tmp_path)
    user = users_gateway(gateways, tmp_path)
    ours = start(gateways, tmp_path, hermes.home)
    found = find_gateway(hermes.home)
    assert found is not None
    claim = json.loads((user.home / "gateway.pid").read_text())
    (hermes.home / "gateway.pid").write_text(json.dumps({**claim, "hermes_home": str(hermes.home)}))
    assert find_gateway(hermes.home) is None  # the lock's holder is another pid
    assert not found.deliver(signal.SIGKILL)
    assert user.process.poll() is None and ours.process.poll() is None
    assert user.notes() == ["ready"] and ours.notes() == ["ready"]


@pytest.mark.parametrize(
    "plan",
    [
        {"pid_file": {"hermes_home": "/Users/someone/.hermes"}},  # the record names another folder
        {"lock": {"hermes_home": "/Users/someone/.hermes"}},
        {"pid_file": {"kind": "something-else"}},
        {"start_shift": 360000},  # started an hour off the record: a reused pid
        {"pid_file": {"start_time": "yesterday"}},
    ],
)
def test_a_record_that_does_not_prove_the_process_is_refused(
    tmp_path: Path, gateways: list[FakeGateway], plan: dict[str, object],
) -> None:
    hermes = engine(tmp_path)
    gateway = start(gateways, tmp_path, hermes.home, plan=plan)
    assert find_gateway(hermes.home) is None
    assert gateway.process.poll() is None


@pytest.mark.parametrize(
    "argv",
    [
        ("serve",),  # not a gateway
        ("-m", "hermes_cli.main", "--profile", "work", "gateway", "run"),  # another profile
        ("-m", "hermes_cli.main", "-p", "work", "gateway", "run"),
        ("HERMES_HOME=/Users/someone/.hermes", "-m", "hermes_cli.main", "gateway", "run"),
    ],
)
def test_a_process_that_is_not_this_folders_gateway_run_is_refused(
    tmp_path: Path, gateways: list[FakeGateway], argv: tuple[str, ...],
) -> None:
    hermes = engine(tmp_path)
    start(gateways, tmp_path, hermes.home, argv=argv)
    assert find_gateway(hermes.home) is None


def test_gateway_command_rule(tmp_path: Path) -> None:
    home = tmp_path / "hermes-home"
    assert gateway_command("/py -m hermes_cli.main --profile default gateway run --quiet --idle-exit", home)
    assert gateway_command("/py -m hermes_cli.main --profile=default gateway run", home)
    assert gateway_command(f"/py HERMES_HOME={home} -m hermes_cli.main gateway run", home)
    assert not gateway_command("/py -m hermes_cli.main gateway status", home)
    assert not gateway_command("/py -m hermes_cli.main --profile=ops gateway run", home)
    assert not gateway_command(f"/py HERMES_HOME={home}2 -m hermes_cli.main gateway run", home)


def test_without_a_gateway_nothing_is_found(tmp_path: Path) -> None:
    hermes = engine(tmp_path)
    assert find_gateway(hermes.home) is None
    hermes.home.mkdir(parents=True, exist_ok=True)
    (hermes.home / "gateway.lock").write_text("{}")
    (hermes.home / "gateway.pid").write_text(json.dumps({"pid": os.getpid(), "kind": "hermes-gateway",
                                                         "hermes_home": str(hermes.home)}))
    assert find_gateway(hermes.home) is None  # a free lock: the gateway is gone, the files stale


def test_a_stale_pid_reused_by_another_process_is_not_signalled(
    tmp_path: Path, gateways: list[FakeGateway],
) -> None:
    hermes = engine(tmp_path)
    ours = start(gateways, tmp_path, hermes.home)
    found = find_gateway(hermes.home)
    assert found is not None
    ours.close()  # SIGKILL: gateway.pid and the lock record stay behind, the lock is released
    bystander = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        assert not found.deliver(signal.SIGKILL)
        assert bystander.poll() is None
    finally:
        bystander.kill()
        bystander.wait()


async def test_quitting_skaz_stops_its_gateway_and_never_the_users(
    tmp_path: Path, gateways: list[FakeGateway],
) -> None:
    hermes = engine(tmp_path)
    user = users_gateway(gateways, tmp_path)
    ours = start(gateways, tmp_path, hermes.home)
    try:
        await hermes.aclose()
        assert ours.stopped() and ours.notes() == ["ready", "SIGINT"]
        assert user.process.poll() is None and user.notes() == ["ready"]
    finally:
        if hermes._gateway is not None:
            CHILDREN.discard(hermes._gateway)


async def test_a_seen_gateway_is_registered_with_the_children_and_stopped_by_the_shutdown(
    tmp_path: Path, gateways: list[FakeGateway],
) -> None:
    hermes = engine(tmp_path)
    user = users_gateway(gateways, tmp_path)
    ours = start(gateways, tmp_path, hermes.home)
    daemon = hermes.adopt_gateway()
    try:
        assert daemon is not None and ours.pid in CHILDREN.running()
        assert hermes.adopt_gateway() is daemon  # registered once
        assert user.pid not in CHILDREN.running()

        children = ChildProcesses()  # the shutdown's registry, with this daemon only
        children.add(daemon, group=True)
        runtime = _Runtime()
        await close_knowledge(runtime, deadline_s=0.5, children=children)
        assert ours.stopped() and ours.notes()[:2] == ["ready", "SIGINT"]
        assert user.process.poll() is None and user.notes() == ["ready"]
    finally:
        CHILDREN.discard(daemon)


async def test_a_stubborn_gateway_is_killed_with_its_group(
    tmp_path: Path, gateways: list[FakeGateway],
) -> None:
    hermes = engine(tmp_path)
    ours = start(gateways, tmp_path, hermes.home)
    daemon = find_gateway(hermes.home)
    assert daemon is not None
    os.kill(ours.pid, signal.SIGSTOP)  # cannot handle SIGINT
    try:
        assert daemon.deliver(signal.SIGKILL)
        assert ours.stopped()
        assert ours.process.returncode == -signal.SIGKILL
    finally:
        ours.close()


class _Closes:
    async def close(self) -> None:
        await asyncio.sleep(0)

    async def aclose(self) -> None:
        await asyncio.sleep(0)


class _Runtime:
    kb_wiki = kb_chats = kb_ingest = kb_codex = _Closes()
    kb_decisions = kb_agents = _Closes()
