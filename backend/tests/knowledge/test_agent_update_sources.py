"""U1: install channel from the binary's path, and the latest version read from that same channel.

The answers are the real ones recorded on 2026-10-26 (``fixtures/agent_updates``); nothing here
touches the network or runs an agent.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from skaz.knowledge.install.channels import (
    ChannelInfo,
    can_roll_back,
    detect_channel,
    manual_update_command,
)
from skaz.knowledge.install.latest import (
    CheckOutput,
    HermesCheckFailed,
    hermes_latest,
    latest_version,
    newer,
    parse_version,
    sources,
)

FIXTURES = Path(__file__).parent / "fixtures" / "agent_updates"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def link(tmp_path: Path, target: str, name: str) -> Path:
    """``~/.local/bin/<name>`` pointing at ``target`` under ``tmp_path`` (as the installers leave it)."""
    real = tmp_path / target
    real.parent.mkdir(parents=True, exist_ok=True)
    real.write_text("#!/bin/sh\n")
    binary = tmp_path / ".local" / "bin" / name
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.symlink_to(real)
    return binary


def test_codex_channels_follow_where_the_binary_really_lives(tmp_path: Path) -> None:
    npm = link(tmp_path, ".local/lib/node_modules/@openai/codex/bin/codex.js", "codex")
    assert detect_channel("codex", npm, home=tmp_path) == ChannelInfo("codex", "npm")
    cask = tmp_path / "opt/homebrew/Caskroom/codex/0.164.0/codex"
    cask.parent.mkdir(parents=True)
    cask.write_text("")
    assert detect_channel("codex", cask, home=tmp_path) == ChannelInfo("codex", "brew", "codex")
    standalone = tmp_path / "s"
    standalone.mkdir()
    own = link(standalone, ".codex/packages/standalone/current/bin/codex", "codex")
    assert detect_channel("codex", own, home=standalone).channel == "native"
    other = tmp_path / "usr/local/bin/codex"
    other.parent.mkdir(parents=True)
    other.write_text("")
    assert detect_channel("codex", other, home=tmp_path).channel == "unknown"


def test_claude_native_follows_its_update_channel_setting(tmp_path: Path) -> None:
    binary = link(tmp_path, ".local/share/claude/versions/2.1.281", "claude")
    native = ChannelInfo("claude_code", "native", "latest")
    assert detect_channel("claude_code", binary, home=tmp_path) == native
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "settings.json").write_text(json.dumps({"autoUpdatesChannel": "stable", "x": 1}))
    assert detect_channel("claude_code", binary, home=tmp_path).detail == "stable"
    cask = tmp_path / "opt/homebrew/Caskroom/claude-code@latest/2.1.310/claude"
    cask.parent.mkdir(parents=True)
    cask.write_text("")
    assert detect_channel("claude_code", cask, home=tmp_path) == ChannelInfo("claude_code", "brew",
                                                                             "claude-code@latest")


def test_opencode_uses_opencodes_own_rule_and_refuses_the_ambiguous_tap(tmp_path: Path) -> None:
    curl = tmp_path / ".opencode" / "bin" / "opencode"
    curl.parent.mkdir(parents=True)
    curl.write_text("")
    assert detect_channel("opencode", curl, home=tmp_path).channel == "curl"
    # npm's link in ~/.local/bin (npm prefix ~/.local) is still npm, not "curl".
    npm = link(tmp_path, ".local/lib/node_modules/opencode-ai/bin/opencode", "opencode")
    assert detect_channel("opencode", npm, home=tmp_path).channel == "npm"
    brew = tmp_path / "opt/homebrew/Cellar/opencode/2.1.4/bin/opencode"
    brew.parent.mkdir(parents=True)
    brew.write_text("")
    assert detect_channel("opencode", brew, home=tmp_path) == ChannelInfo("opencode", "brew", "opencode")
    (tmp_path / "opt/homebrew/Library/Taps/anomalyco/homebrew-tap").mkdir(parents=True)
    assert detect_channel("opencode", brew, home=tmp_path).channel == "unknown"


def test_versions_are_releases_only() -> None:
    assert parse_version("0.164.0") == (0, 164, 0)
    assert parse_version("rust-v0.164.0") == (0, 164, 0)
    assert parse_version("v1.19.4") == (1, 19, 4)
    assert parse_version("0.165.0-alpha.1") is None
    assert parse_version("latest") is None
    assert newer("0.164.0", "0.160.0") and not newer("0.160.0", "0.160.0")
    assert newer("1.10.0", "1.9.9") and not newer("2.1.308", "2.1.310")
    assert not newer(None, "1.0.0") and not newer("1.0.1", None)


@pytest.mark.parametrize(("info", "url", "body", "version"), [
    (ChannelInfo("codex", "npm"), "https://registry.npmjs.org/@openai/codex/latest",
     "npm-openai-codex-latest.json", "0.164.0"),
    (ChannelInfo("codex", "brew", "codex"), "https://formulae.brew.sh/api/cask/codex.json",
     "brew-cask-codex.json", "0.164.0"),
    (ChannelInfo("codex", "native"), "https://releases.openai.com/codex/channels/latest",
     "openai-codex-channel-latest.json", "0.164.0"),
    (ChannelInfo("claude_code", "native", "latest"), "https://downloads.claude.ai/claude-code-releases/latest",
     "claude-releases-latest.txt", "2.1.310"),
    (ChannelInfo("claude_code", "native", "stable"), "https://downloads.claude.ai/claude-code-releases/stable",
     "claude-releases-stable.txt", "2.1.308"),
    (ChannelInfo("claude_code", "npm", "latest"), "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
     "npm-claude-code-latest.json", "2.1.310"),
    (ChannelInfo("claude_code", "brew", "claude-code"), "https://formulae.brew.sh/api/cask/claude-code.json",
     "brew-cask-claude-code.json", "2.1.308"),
    (ChannelInfo("opencode", "curl"), "https://api.github.com/repos/anomalyco/opencode/releases/latest",
     "github-opencode-latest.json", "1.19.4"),
    (ChannelInfo("opencode", "npm"), "https://registry.npmjs.org/opencode-ai/latest",
     "npm-opencode-ai-latest.json", "1.19.4"),
    (ChannelInfo("opencode", "brew", "opencode"), "https://formulae.brew.sh/api/formula/opencode.json",
     "brew-formula-opencode.json", "2.1.4"),
])
async def test_each_channel_reads_its_own_source(info: ChannelInfo, url: str, body: str,
                                                 version: str) -> None:
    asked: list[str] = []

    async def fetch(target: str) -> str:
        asked.append(target)
        return fixture(body)

    assert await latest_version(info, fetch=fetch) == version
    assert asked == [url]


async def test_codex_standalone_falls_back_to_github_releases() -> None:
    asked: list[str] = []

    async def fetch(target: str) -> str:
        asked.append(target)
        if "releases.openai.com" in target:
            raise OSError("unreachable")
        return fixture("github-openai-codex-latest.json")

    assert await latest_version(ChannelInfo("codex", "native"), fetch=fetch) == "0.164.0"
    assert asked[1] == "https://api.github.com/repos/openai/codex/releases/latest"


async def test_a_network_error_raises_so_the_caller_keeps_what_it_knew() -> None:
    async def fetch(target: str) -> str:
        raise OSError("offline")

    with pytest.raises(OSError):
        await latest_version(ChannelInfo("codex", "npm"), fetch=fetch)


async def test_unknown_channels_and_unexpected_answers_offer_nothing() -> None:
    async def fetch(target: str) -> str:
        return '{"version": "0.165.0-alpha.1"}'

    assert sources(ChannelInfo("codex", "unknown")) == ()
    assert sources(ChannelInfo("opencode", "unknown", "anomalyco/tap/opencode")) == ()
    assert await latest_version(ChannelInfo("codex", "unknown"), fetch=fetch) is None
    assert await latest_version(ChannelInfo("codex", "npm"), fetch=fetch) is None  # a pre-release is no offer


async def test_hermes_reads_its_own_check() -> None:
    async def check() -> CheckOutput:
        return CheckOutput(0, fixture("hermes-update-check-available.txt"))

    assert await latest_version(ChannelInfo("hermes", "git"), fetch=_never, hermes_check=check) == "0.22.5"


@pytest.mark.parametrize("text", [
    # The other verdicts of ``hermes update --check`` (hermes_cli/update_cmd_check.py, 0.22.1).
    "→ Update channel: stable\n✓ Up to date with the latest release (stable v0.22.5 (bf0203a794a0)).\n",
    "→ Update channel: stable\n✓ No newer release: stable v0.22.5 (bf0203a794a0).\n",
    "→ Update channel: stable\n→ This checkout is newer than the selected release: "
    "stable v0.22.5 (bf0203a794a0).\n  `hermes update` moves it back to that release.\n",
    "→ Update channel: main\n→ Fetching from origin...\n⚕ Update available: 12 commits behind origin/main.\n",
    "→ Update channel: main\n✓ Already up to date.\n",
])
def test_hermes_offers_only_a_newer_release(text: str) -> None:
    assert hermes_latest(CheckOutput(0, text)) is None


def test_hermes_refusal_offers_nothing() -> None:
    assert hermes_latest(CheckOutput(2, "This install is updated by pulling a new image.")) is None


async def test_a_failed_hermes_check_raises_so_the_caller_keeps_what_it_knew() -> None:
    """FIX-1 F3.5: a non-zero ``hermes update --check`` (offline, refused) is a failed check, like an
    HTTP error — not "no newer release"."""
    async def offline() -> CheckOutput:
        return CheckOutput(1, "→ Update channel: stable\n✗ Could not resolve the stable source channel: …")

    with pytest.raises(HermesCheckFailed):
        await latest_version(ChannelInfo("hermes", "git"), fetch=_never, hermes_check=offline)


async def _never(target: str) -> str:
    raise AssertionError("no request expected")


def test_manual_commands_and_rollback_per_channel() -> None:
    assert manual_update_command(ChannelInfo("codex", "npm")) == "npm install -g @openai/codex@latest"
    assert manual_update_command(ChannelInfo("codex", "brew", "codex")) == "brew upgrade --cask codex"
    brew = ChannelInfo("claude_code", "brew", "claude-code")
    assert manual_update_command(brew) == "brew upgrade claude-code"
    assert manual_update_command(ChannelInfo("opencode", "curl")) == "opencode upgrade"
    assert manual_update_command(ChannelInfo("hermes", "git")) == "hermes update"
    assert can_roll_back(ChannelInfo("opencode", "curl")) and can_roll_back(ChannelInfo("opencode", "npm"))
    assert can_roll_back(ChannelInfo("claude_code", "native", "latest"))
    assert not can_roll_back(ChannelInfo("opencode", "brew", "opencode"))
    assert not can_roll_back(ChannelInfo("claude_code", "brew", "claude-code"))
    assert not can_roll_back(ChannelInfo("codex", "npm")) and not can_roll_back(ChannelInfo("hermes", "git"))
