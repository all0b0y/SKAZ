"""Hermes providers in SKAZ's own Hermes folder (0.3.1 K1/K3; decisions 2026-10-18 Q2/Q3/Q13).

The ``hermes auth list`` text is built with the same format strings as Hermes' own
``auth_list_command`` / ``_format_exhausted_status`` (hermes_cli/auth_commands.py at v0.22.2 and main
a2ad0d5); the fake ``hermes`` answers from it. These tests prove the SKAZ side only: that SKAZ reads
what Hermes prints, runs only secret-free commands itself, and sends every key or sign-in to Hermes in
Terminal with SKAZ's folder — never the user's ``~/.hermes``.
"""

from __future__ import annotations

import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.hermes import HermesEngine
from skaz.knowledge.agents.hermes_accounts import AccountsError, HermesAccounts
from skaz.knowledge.agents.hermes_providers import (
    CATALOG,
    parse_auth_list,
    provider_order,
)
from skaz.knowledge.errors import NotFound
from skaz.knowledge.install.terminal import TerminalLauncher, read_done, write_steps
from tests.knowledge.agent_fakes import FakeCli, RecordingOpener

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)


def row(
    idx: int,
    label: str,
    auth_type: str,
    cid: str,
    priority: int,
    source: str,
    status: str = "",
    current: bool = False,
) -> str:
    marker = "← " if current else "  "
    return (
        f"  #{idx}  {label:<20} {auth_type:<7} id={cid} priority={priority} {source}{status} {marker}"
    ).rstrip()


LISTING = "\n".join(
    [
        "anthropic (1 credentials):",
        row(1, "work key", "api_key", "a1b2c3", 0, "manual", current=True),
        "",
        "nous: Free tier · Hermes-4-70B",
        "  Sign in with a Nous account to keep your connectors: hermes auth upgrade",
        "",
        "openai-codex (3 credentials):",
        row(
            1,
            "me@example.com",
            "oauth",
            "c0dex1",
            0,
            "device_code",
            " rate-limited usage_limit (429) (1h 5m left)",
            current=False,
        ),
        row(2, "second account", "oauth", "c0dex2", 1, "device_code", current=True),
        row(
            3,
            "old",
            "oauth",
            "c0dex3",
            2,
            "device_code",
            " auth failed invalid_grant (401) (re-auth may be required)",
        ),
        "",
        "openrouter (1 credentials):",
        row(
            1,
            "api-key-1",
            "api_key",
            "0r0r0r",
            0,
            "manual",
            " rate-limited (429) (ready to retry)",
            current=True,
        ),
        "",
        "External CLI logins (Codex CLI, Claude Code) are not adopted: auth.adopt_external_logins is false. "
        "Hermes uses only its own logins; run `hermes auth add <provider>` to add one.",
        "note: merged two forked anthropic grants",
        "",
    ]
)


def test_auth_list_is_read_as_hermes_prints_it() -> None:
    pools = {pool.id: pool for pool in parse_auth_list(LISTING, now=NOW)}
    assert list(pools) == ["anthropic", "nous", "openai-codex", "openrouter"]
    (key,) = pools["anthropic"].credentials
    assert (key.label, key.auth_type, key.id, key.priority, key.source, key.state, key.current) == (
        "work key",
        "api_key",
        "a1b2c3",
        0,
        "manual",
        "ready",
        True,
    )
    assert pools["nous"].credentials == () and pools["nous"].free_tier == "Free tier · Hermes-4-70B"
    limited, second, dead = pools["openai-codex"].credentials
    assert limited.state == "limited" and limited.until == "2026-10-18T13:05:00+00:00"
    assert (
        limited.label == "me@example.com" and limited.detail == "rate-limited usage_limit (429) (1h 5m left)"
    )
    assert second.state == "ready" and second.current and second.label == "second account"
    assert dead.state == "signed_out" and dead.index == 3 and dead.until is None
    (retry,) = pools["openrouter"].credentials
    assert retry.state == "ready" and retry.source == "manual"
    assert pools["openai-codex"].name == "ChatGPT"  # a short name for its chip (Accounts & keys v3)


def test_provider_order_is_main_then_fallback_chain() -> None:
    order = provider_order(
        '"openai-codex"\n',
        '[{"provider": "anthropic", "model": "claude-x"}, {"provider": "openai-codex", "model": "y"}]',
        '{"provider": "openrouter", "model": "z"}',
    )
    assert order == ["openai-codex", "anthropic", "openrouter"]
    assert provider_order(None, None) == []
    assert provider_order("not json", "[1, 2]") == []


def test_catalog_offers_each_way_once_and_cloud_platforms_through_setup() -> None:
    pairs = [(item.id, item.group) for item in CATALOG]
    assert len(pairs) == len(set(pairs))
    groups: dict[str, list[str]] = {item.id: [] for item in CATALOG}
    for item in CATALOG:
        groups[item.id].append(item.group)
    assert groups["anthropic"] == ["subscription", "api_key"]  # decision Q2: Hermes offers both
    assert groups["openai-codex"] == ["subscription"]
    assert {item.id for item in CATALOG if item.group == "cloud"} == {"bedrock", "vertex", "azure-foundry"}


def test_step_script_runs_the_second_command_only_after_the_first_and_leaves_its_code(tmp_path: Path) -> None:
    good = tmp_path / "ok.sh"
    good.write_text('#!/bin/sh\necho ran >> "$LOG"\n')
    bad = tmp_path / "bad.sh"
    bad.write_text("#!/bin/sh\nexit 3\n")
    for script in (good, bad):
        script.chmod(0o755)
    log = tmp_path / "log"
    env = {"LOG": str(log), "PATH": "/usr/bin:/bin", "TERM": "dumb"}
    path = write_steps(tmp_path / "launch", "two", "Title", [[str(bad)], [str(good)]], env)
    assert read_done(tmp_path / "launch", "two") is None
    subprocess.run(["/bin/bash", str(path)], check=False, capture_output=True, env=env,
                   stdin=subprocess.DEVNULL)
    assert read_done(tmp_path / "launch", "two") == 3 and not log.exists()
    path = write_steps(tmp_path / "launch", "two", "Title", [[str(good)], [str(good)]], env)
    subprocess.run(["/bin/bash", str(path)], check=False, capture_output=True, env=env,
                   stdin=subprocess.DEVNULL)
    assert read_done(tmp_path / "launch", "two") == 0 and log.read_text() == "ran\nran\n"
    assert oct(path.stat().st_mode & 0o777) == "0o700"


def test_step_script_refuses_sudo(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        write_steps(tmp_path, "x", "t", [["/usr/bin/sudo", "rm"]], {})


# -- the service against a fake ``hermes`` ----------------------------------------------------------


def scenario(**cli: Any) -> dict[str, Any]:
    answers = {
        "auth list": {"stdout": LISTING},
        "config get model.provider --json": {"stdout": '"openai-codex"\n'},
        "config get fallback_providers --json": {"stdout": '[{"provider": "anthropic", "model": "c"}]\n'},
    }
    answers.update(cli)
    return {"version_output": "Hermes Agent v0.22.2 (2026.10.16)", "cli": answers}


def accounts_for(tmp_path: Path, plan: dict[str, Any]) -> tuple[HermesAccounts, FakeCli, RecordingOpener]:
    fake = FakeCli(tmp_path / "bin", "hermes", plan)
    opener = RecordingOpener()
    engine = HermesEngine(
        tmp_path / "data",
        locate_cli=fake.locate,
        user_home=tmp_path / "home",
        launcher=TerminalLauncher(tmp_path / "launch", opener=opener),
        status_timeout_s=20,
    )
    return HermesAccounts(engine), fake, opener


async def test_view_lists_providers_in_hermes_order_from_skaz_folder(tmp_path: Path) -> None:
    accounts, fake, _opener = accounts_for(tmp_path, scenario())
    view = await accounts.view()
    assert view.state == "ready"
    assert [(pool.id, pool.order) for pool in view.providers] == [
        ("openai-codex", 0),
        ("anthropic", 1),
        ("nous", None),
        ("openrouter", None),
    ]
    calls = fake.records("cli")
    assert {" ".join(call["args"]) for call in calls} == {
        "auth list",
        "config get model.provider --json",
        "config get fallback_providers --json",
        "config get fallback_model --json",
    }
    home = str(accounts.engine.home)
    assert all(call["home"] == home and call["cwd"] == home for call in calls)
    assert not (tmp_path / "home" / ".hermes").exists()  # the user's own Hermes folder is never touched


async def test_view_says_why_when_hermes_is_missing_or_refuses(tmp_path: Path) -> None:
    engine = HermesEngine(tmp_path / "data", locate_cli=lambda name: None, user_home=tmp_path / "home")
    missing = await HermesAccounts(engine).view()
    assert missing.state == "not_installed" and missing.providers == () and missing.catalog == CATALOG
    accounts, _fake, _opener = accounts_for(tmp_path / "x", scenario(**{"auth list": {"exit": 2}}))
    failed = await accounts.view()
    assert failed.state == "unavailable" and failed.reason and "didn't list" in failed.reason


async def test_add_opens_hermes_own_command_in_terminal_and_never_takes_a_key(tmp_path: Path) -> None:
    accounts, fake, opener = accounts_for(tmp_path, scenario())
    view = await accounts.add("openai-codex", "subscription")
    (call,) = opener.calls
    assert call[:3] == ["/usr/bin/open", "-a", "Terminal"]
    script = Path(call[3]).read_text(encoding="utf-8")
    assert f"{fake.binary} auth add openai-codex --type oauth" in script
    assert f"export HERMES_HOME={accounts.engine.home}" in script
    assert view.terminal is not None and view.terminal.state == "running"
    assert view.terminal.provider == "openai-codex"
    # The window ends: SKAZ sees only its exit code.
    (tmp_path / "launch" / "hermes-provider-add-openai-codex.done").write_text("0\n")
    after = await accounts.view()
    assert after.terminal is not None and after.terminal.state == "done"

    await accounts.add("anthropic", "api_key")
    script = Path(opener.calls[-1][3]).read_text(encoding="utf-8")
    assert f"{fake.binary} auth add anthropic --type api-key" in script and "--api-key" not in script

    await accounts.add("vertex", "cloud")
    assert f"{fake.binary} model" in Path(opener.calls[-1][3]).read_text(encoding="utf-8")
    with pytest.raises(NotFound):
        await accounts.add("openai-codex", "api_key")  # not a way Hermes offers for it
    with pytest.raises(NotFound):
        await accounts.add("evil; rm -rf ~", "api_key")


async def test_sign_in_again_adds_at_the_old_place_then_removes_the_old_one(tmp_path: Path) -> None:
    accounts, fake, opener = accounts_for(tmp_path, scenario())
    await accounts.sign_in_again("openai-codex", "c0dex3")
    script = Path(opener.calls[-1][3]).read_text(encoding="utf-8")
    assert (
        f"{fake.binary} auth add openai-codex --type oauth --priority 2 --label old && "
        f"{fake.binary} auth remove openai-codex c0dex3"
    ) in script
    with pytest.raises(NotFound):
        await accounts.sign_in_again("openai-codex", "nope")


async def test_remove_and_move_run_hermes_commands_without_terminal(tmp_path: Path) -> None:
    accounts, fake, opener = accounts_for(
        tmp_path,
        scenario(
            **{
                "auth remove openai-codex c0dex2": {
                    "stdout": "Removed openai-codex credential #2 (second account)\n"
                },
                "auth priority openai-codex c0dex3 2": {
                    "stdout": 'Set openai-codex credential "old" to priority 2\n'
                },
            }
        ),
    )
    await accounts.remove("openai-codex", "c0dex2")
    await accounts.move("openai-codex", "c0dex3", 9)  # clamped to the pool's last place
    asked = [
        " ".join(call["args"])
        for call in fake.records("cli")
        if call["args"][0] == "auth" and call["args"][1] in ("remove", "priority")
    ]
    assert asked[0] == "auth remove openai-codex c0dex2"
    assert asked[1] == "auth priority openai-codex c0dex3 2"
    assert opener.calls == []
    with pytest.raises(AccountsError, match="Hermes didn't do it"):
        await accounts.move("openai-codex", "c0dex3", 1)  # the fake has no answer: Hermes refused
    with pytest.raises(NotFound):
        await accounts.remove("openai-codex", "../../x")
    assert all(
        call["args"][1] != "remove" or call["args"][3] == "c0dex2"
        for call in fake.records("cli")
        if call["args"][0] == "auth"
    )


async def test_api_routes(kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path) -> None:
    accounts, _fake, opener = accounts_for(tmp_path, scenario())
    kb_app.state.runtime.kb_agents.hermes_accounts = accounts
    listed = await kb_client.get("/kb/agents/hermes/providers")
    assert listed.status_code == 200
    body = listed.json()
    assert body["state"] == "ready" and body["providers"][0]["id"] == "openai-codex"
    assert body["providers"][0]["credentials"][0]["state"] == "limited"
    assert {item["group"] for item in body["catalog"]} == {"subscription", "api_key", "cloud"}
    added = await kb_client.post(
        "/kb/agents/hermes/providers/add", json={"provider": "nous", "group": "subscription"}
    )
    assert added.status_code == 200 and added.json()["terminal"]["provider"] == "nous"
    assert len(opener.calls) == 1
    bad = await kb_client.post("/kb/agents/hermes/providers/add", json={"provider": "nous", "group": "x"})
    assert bad.status_code == 422
    unknown = await kb_client.delete("/kb/agents/hermes/providers/nous/credentials/zzz")
    assert unknown.status_code == 404
    order = await kb_client.post("/kb/agents/hermes/providers/order")
    assert order.status_code == 200 and "fallback" in Path(opener.calls[-1][3]).read_text(encoding="utf-8")
    assert os.environ.get("HERMES_HOME") is None or os.environ["HERMES_HOME"] != str(accounts.engine.home)
