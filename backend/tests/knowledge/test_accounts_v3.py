"""Accounts & keys v3 (confirmed 2026-10-21): sign-in that checks itself, sign out per agent, named keys.

Fakes stand only at the edges: fake ``claude`` / ``opencode`` / ``hermes`` executables, a recording
Terminal opener (no Terminal window is opened) and a fake Codex connection. The step scripts are run
for real with ``bash`` and stdin from ``/dev/null`` (not a Terminal tab), so they never try to close a
window; the window-closing AppleScript is checked as text only.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.claude_code import ClaudeCodeEngine
from skaz.knowledge.agents.engine import EngineId
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.hermes import HermesEngine
from skaz.knowledge.agents.hermes_accounts import AccountsError
from skaz.knowledge.agents.hermes_providers import order_command, other_command
from skaz.knowledge.agents.hub import build_agents_hub
from skaz.knowledge.agents.opencode import OpenCodeEngine
from skaz.knowledge.agents.registry import CodexStatusEngine, EngineUnavailable
from skaz.knowledge.errors import NotFound
from skaz.knowledge.install.terminal import (
    CLOSER_FILE,
    SIGNED_IN_NOTE,
    TerminalLauncher,
    read_done,
    stopped_note,
    write_steps,
)
from skaz.knowledge.service import KnowledgeService
from tests.knowledge.agent_fakes import FakeCli, RecordingOpener
from tests.knowledge.opencode_fake import FakeOpenCode, opencode_probe
from tests.knowledge.test_agent_registry_api import FakeCodexConnection, hub_for, statuses
from tests.knowledge.test_k_hermes_providers import accounts_for, scenario

PATH_ENV = {"PATH": "/usr/bin:/bin", "TERM": "dumb"}


def run_script(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["/bin/bash", str(path)], check=False, capture_output=True, text=True,
                          stdin=subprocess.DEVNULL, env=PATH_ENV, timeout=30)


# -- the Terminal window: English lines, the exit code, closing itself ------------------------------


def test_successful_window_says_so_in_english_and_closes_itself(tmp_path: Path) -> None:
    launch = tmp_path / "launch"
    path = write_steps(launch, "claude-code-sign-in", "SKAZ opened the Claude Code sign-in.",
                       [["/usr/bin/true"]], {}, agent="Claude Code")
    out = run_script(path)
    assert read_done(launch, "claude-code-sign-in") == 0
    assert SIGNED_IN_NOTE == "Sign-in finished. SKAZ is checking it now."
    assert SIGNED_IN_NOTE in out.stdout and "Press Return" not in out.stdout
    text = path.read_text(encoding="utf-8")
    # Only a real Terminal tab closes itself (stdin a terminal, Apple's Terminal); never the user's prefs.
    assert '[ -t 0 ] && [ "${TERM_PROGRAM:-}" = "Apple_Terminal" ]' in text
    assert "defaults write" not in text and "com.apple.Terminal" not in text
    closer = (launch / CLOSER_FILE).read_text(encoding="utf-8")
    # The closer only shuts a one-tab window whose shell has ended, found by this tab's tty.
    assert "tty of" in closer and "busy of" in closer and "count of" in closer and "close" in closer


def test_failed_window_stays_open_with_the_agents_name(tmp_path: Path) -> None:
    launch = tmp_path / "launch"
    path = write_steps(launch, "opencode-sign-in", "Title", [["/usr/bin/false"]], {}, agent="OpenCode")
    out = run_script(path)
    assert read_done(launch, "opencode-sign-in") == 1
    assert stopped_note("OpenCode") == (
        "OpenCode stopped before it finished. Press Return to close this window.")
    assert stopped_note("OpenCode") in out.stdout and SIGNED_IN_NOTE not in out.stdout
    assert "read -r" in path.read_text(encoding="utf-8")  # waits for Return before it closes


def test_a_window_that_shows_something_waits_for_return_even_after_success(tmp_path: Path) -> None:
    launch = tmp_path / "launch"
    path = write_steps(launch, "hermes-provider-order", "Title", [["/usr/bin/true"]], {}, agent="Hermes",
                       close_on_success=False)
    out = run_script(path)
    assert read_done(launch, "hermes-provider-order") == 0
    assert "Press Return to close this window." in out.stdout and SIGNED_IN_NOTE not in out.stdout


def test_closing_the_window_midway_still_leaves_a_code(tmp_path: Path) -> None:
    launch = tmp_path / "launch"
    path = write_steps(launch, "x", "Title", [["/bin/sleep", "20"]], {}, agent="Hermes")
    process = subprocess.Popen(["/bin/bash", str(path)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, env=PATH_ENV, start_new_session=True)
    try:
        time.sleep(0.5)
        os.killpg(process.pid, signal.SIGHUP)  # what closing a Terminal window sends
        process.wait(timeout=10)
    finally:
        if process.poll() is None:
            process.kill()
    assert read_done(launch, "x") == 129


# -- every agent's sign-in leaves a code SKAZ watches --------------------------------------------


async def test_claude_sign_in_is_followed_until_terminal_ends(tmp_path: Path) -> None:
    opener = RecordingOpener()
    fake = FakeCli(tmp_path / "bin", "claude", {})
    engine = ClaudeCodeEngine(tmp_path / "data" / "claude-code", locate_cli=fake.locate,
                              launcher=TerminalLauncher(tmp_path / "launch", opener=opener))
    assert engine.login_progress() is None
    await engine.login()
    text = Path(opener.calls[0][3]).read_text(encoding="utf-8")
    assert f"{fake.binary} auth login" in text and "claude-code-sign-in.done" in text
    assert stopped_note("Claude Code") in text
    assert engine.login_progress() == "waiting"
    (tmp_path / "launch" / "claude-code-sign-in.done").write_text("0\n")
    assert engine.login_progress() == "done"
    (tmp_path / "launch" / "claude-code-sign-in.done").write_text("1\n")
    assert engine.login_progress() == "failed"


async def test_opencode_and_hermes_setup_are_followed_too(tmp_path: Path) -> None:
    opener = RecordingOpener()
    fake = FakeOpenCode(tmp_path / "oc", {**opencode_scenario()})
    opencode = OpenCodeEngine(tmp_path / "data", locate_cli=fake.locate, user_home=tmp_path / "home",
                              launcher=TerminalLauncher(tmp_path / "launch", opener=opener))
    await opencode.login()
    assert "opencode-sign-in.done" in Path(opener.calls[-1][3]).read_text(encoding="utf-8")
    assert opencode.login_progress() == "waiting"
    hermes_fake = FakeCli(tmp_path / "hb", "hermes", {"version_output": "Hermes Agent v0.22.2 (2026.10.16)"})
    hermes = HermesEngine(tmp_path / "hdata", locate_cli=hermes_fake.locate, user_home=tmp_path / "home",
                          launcher=TerminalLauncher(tmp_path / "launch", opener=opener))
    await hermes.login()
    text = Path(opener.calls[-1][3]).read_text(encoding="utf-8")
    assert "hermes-setup.done" in text and stopped_note("Hermes") in text
    assert hermes.login_progress() == "waiting"


async def test_registry_reports_sign_in_progress_and_api_waits_for_it(
    service: KnowledgeService, tmp_path: Path, kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    connection = FakeCodexConnection({"status": "signed_out", "login": "idle"})
    codex = CodexStatusEngine(connection)  # type: ignore[arg-type]
    engines: dict[EngineId, Any] = {**statuses(), "codex": codex}
    hub = hub_for(service, tmp_path, engines=engines)
    registry = hub.registry
    assert registry.sign_in("codex").state == "idle"  # nothing started in this SKAZ
    outcome = await registry.login("codex", consent=True)
    assert outcome.method == "browser"
    connection.view["login"] = "pending"
    assert registry.sign_in("codex").state == "waiting"
    connection.view.update(login="idle", status="connected")  # account/login/completed arrived
    done = registry.sign_in("codex")
    assert (done.state, done.method) == ("done", "browser")
    connection.view["login"] = "timed_out"
    assert registry.sign_in("codex").state == "failed"

    kb_app.state.runtime.kb_agents = hub
    connection.view["login"] = "idle"
    answer = await kb_client.get("/kb/agents/codex/sign-in", params={"wait": 0})
    assert answer.status_code == 200
    assert answer.json() == {"engine": "codex", "method": "browser", "state": "done"}
    idle = await kb_client.get("/kb/agents/claude_code/sign-in")
    assert idle.json()["state"] == "idle"
    assert (await kb_client.get("/kb/agents/codex/sign-in", params={"wait": 99})).status_code == 422


# -- signing out --------------------------------------------------------------------------------


def opencode_scenario() -> dict[str, Any]:
    probe = opencode_probe()
    two = ("┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  Anthropic api\n│\n●  DeepSeek api\n│\n"
           "└  2 credentials\n")  # the shape `opencode auth list` printed in the 1.17.18 probe
    return {"version_output": probe["version_output"], "debug_agent": probe["debug_agent_skaz"],
            "auth_list": two, "models_verbose": probe["models_verbose"]}


async def test_opencode_signs_out_every_provider_of_skaz_folder_only(tmp_path: Path) -> None:
    fake = FakeOpenCode(tmp_path / "bin", opencode_scenario())
    engine = OpenCodeEngine(tmp_path / "data", locate_cli=fake.locate, user_home=tmp_path / "home",
                            launcher=TerminalLauncher(tmp_path / "launch", opener=RecordingOpener()))
    assert await engine.credentials() == ("Anthropic", "DeepSeek")
    await engine.logout()
    logouts = [item for item in fake.records("start") if item["argv"][:2] == ["auth", "logout"]]
    assert [item["argv"][2] for item in logouts] == ["Anthropic", "DeepSeek"]
    data = str((tmp_path / "data" / "agents" / "opencode" / "data").resolve())
    assert all(item["env"]["XDG_DATA_HOME"] == data for item in logouts)  # never the user's own OpenCode
    assert await engine.credentials() == ()


async def test_sign_out_route_for_each_agent(
    kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path, service: KnowledgeService,
) -> None:
    fake = FakeOpenCode(tmp_path / "bin", opencode_scenario())
    opencode = OpenCodeEngine(tmp_path / "data", locate_cli=fake.locate, user_home=tmp_path / "home",
                              launcher=TerminalLauncher(tmp_path / "launch", opener=RecordingOpener()))
    hub = build_agents_hub(tmp_path / "hub", settings=service.settings, codex=None,  # type: ignore[arg-type]
                           engines={"codex": FakeEngine("codex"), "claude_code": FakeEngine("claude_code"),
                                    "hermes": FakeEngine("hermes"), "opencode": opencode},
                           locate_cli=lambda name: None, user_home=tmp_path / "home")
    kb_app.state.runtime.kb_agents = hub
    signed_out = await kb_client.post("/kb/agents/opencode/logout")
    assert signed_out.status_code == 200, signed_out.text
    assert signed_out.json()["id"] == "opencode" and signed_out.json()["signed_in"] is False
    # Claude Code in SKAZ uses this Mac's own Claude Code sign-in: SKAZ never signs it out.
    claude = await kb_client.post("/kb/agents/claude_code/logout")
    assert claude.status_code == 409 and "Claude Code" in claude.json()["detail"]
    hermes = await kb_client.post("/kb/agents/hermes/logout")
    assert hermes.status_code == 409 and "provider" in hermes.json()["detail"]
    assert (await kb_client.post("/kb/agents/gemini/logout")).status_code == 422


async def test_registry_refuses_sign_out_where_it_isnt_skaz_own(
    service: KnowledgeService, tmp_path: Path,
) -> None:
    registry = hub_for(service, tmp_path).registry
    with pytest.raises(EngineUnavailable) as refused:
        await registry.logout("claude_code")
    assert "this Mac" in refused.value.message


# -- Hermes: named keys, removing a whole provider ---------------------------------------------


async def test_add_named_key_opens_hermes_with_the_label_and_never_the_key(tmp_path: Path) -> None:
    accounts, fake, opener = accounts_for(tmp_path, scenario())
    view = await accounts.add_key("openrouter", "  Team  ")
    script = Path(opener.calls[-1][3]).read_text(encoding="utf-8")
    assert f"{fake.binary} auth add openrouter --type api-key --label Team" in script
    assert "--api-key" not in script
    assert view.terminal is not None and view.terminal.provider == "openrouter"
    await accounts.add_key("deepseek", "Личный ключ 'x'")  # quoted for the shell, never run as words
    assert "--label 'Личный ключ '\"'\"'x'\"'\"''" in Path(opener.calls[-1][3]).read_text(encoding="utf-8")
    for bad in ("", "   ", "x" * 41, "a\nb", "a\x1bb"):
        with pytest.raises(AccountsError):
            await accounts.add_key("openrouter", bad)
    with pytest.raises(AccountsError, match="already has a key named"):
        await accounts.add_key("openrouter", "api-key-1")
    with pytest.raises(NotFound):
        await accounts.add_key("openai-codex", "Team")  # a sign-in provider: no keys to add
    with pytest.raises(NotFound):
        await accounts.add_key("../x", "Team")


async def test_remove_provider_removes_each_credential_through_hermes(tmp_path: Path) -> None:
    accounts, fake, opener = accounts_for(tmp_path, scenario(**{
        "auth remove openai-codex c0dex1": {"stdout": "Removed\n"},
        "auth remove openai-codex c0dex2": {"stdout": "Removed\n"},
        "auth remove openai-codex c0dex3": {"stdout": "Removed\n"},
    }))
    await accounts.remove_provider("openai-codex")
    removed = [" ".join(call["args"]) for call in fake.records("cli")
               if call["args"][:2] == ["auth", "remove"]]
    assert removed == ["auth remove openai-codex c0dex1", "auth remove openai-codex c0dex2",
                       "auth remove openai-codex c0dex3"]
    assert opener.calls == []
    with pytest.raises(NotFound):
        await accounts.remove_provider("nous")  # the free tier is not something the user added
    with pytest.raises(NotFound):
        await accounts.remove_provider("missing")


async def test_hermes_key_and_provider_routes(
    kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path,
) -> None:
    removal = {"auth remove anthropic a1b2c3": {"stdout": "ok\n"}}
    accounts, _fake, opener = accounts_for(tmp_path, scenario(**removal))
    kb_app.state.runtime.kb_agents.hermes_accounts = accounts
    added = await kb_client.post("/kb/agents/hermes/providers/openrouter/keys", json={"label": "Team"})
    assert added.status_code == 200, added.text
    assert added.json()["terminal"]["provider"] == "openrouter" and len(opener.calls) == 1
    bad = await kb_client.post("/kb/agents/hermes/providers/openrouter/keys", json={"label": "a\nb"})
    assert bad.status_code == 422
    removed = await kb_client.delete("/kb/agents/hermes/providers/anthropic")
    assert removed.status_code == 200, removed.text
    assert (await kb_client.delete("/kb/agents/hermes/providers/missing")).status_code == 404


def test_only_the_order_list_window_waits_for_return() -> None:
    assert order_command().close_on_success is False
    assert other_command().close_on_success is True
