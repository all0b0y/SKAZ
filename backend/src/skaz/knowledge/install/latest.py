"""The latest version of an agent in the channel it was installed from (U1 decision 7).

Only the version is asked for: no user data, no sign-in, no model call. Each source below was
requested for real on 2026-10-26 (read-only) and its answer is recorded in
``tests/knowledge/fixtures/agent_updates``:

* Codex, npm — ``https://registry.npmjs.org/@openai/codex/latest`` → ``version`` (the registry
  ``codex update`` installs from; Codex's binary itself reads ``registry.npmjs.org/@openai%2fcodex``).
* Codex, Homebrew — ``https://formulae.brew.sh/api/cask/codex.json`` → ``version`` (what
  ``brew upgrade --cask codex`` installs; the URL is in Codex's binary).
* Codex, standalone installer — ``https://releases.openai.com/codex/channels/latest`` →
  ``tag_name`` ``rust-v<version>``, falling back to
  ``https://api.github.com/repos/openai/codex/releases/latest`` (both in ``install.sh``).
* Claude Code, native — ``https://downloads.claude.ai/claude-code-releases/<latest|stable>`` → the
  version as plain text (``DOWNLOAD_BASE_URL`` of ``https://claude.ai/install.sh``).
* Claude Code, npm — ``https://registry.npmjs.org/@anthropic-ai/claude-code/<latest|stable>``.
* Claude Code, Homebrew — ``https://formulae.brew.sh/api/cask/<claude-code|claude-code@latest>.json``.
* OpenCode, curl — ``https://api.github.com/repos/anomalyco/opencode/releases/latest`` →
  ``tag_name`` ``v<version>``; npm — ``https://registry.npmjs.org/opencode-ai/latest``; Homebrew core —
  ``https://formulae.brew.sh/api/formula/opencode.json`` → ``versions.stable`` (OpenCode's own
  ``Installation.latest`` reads exactly these).
* Hermes Agent, git — ``hermes update --check`` (fetches, installs nothing): "Selected release
  available: stable v0.22.5 (…)". A branch channel (``main``) reports commits, not a version, and
  "newer than the selected release" means ``hermes update`` would move back: no offer then. A
  non-zero exit (offline, refused) raises like a failed request: the last result stays.

A channel SKAZ can't read (unknown install, a pre-release tag, an unexpected answer) gives
``None``: no offer is shown rather than a guessed version.
"""
from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .channels import ChannelInfo
from .system import Version

#: GET ``url`` → body text; raises on a network error or a non-2xx answer.
Fetch = Callable[[str], Awaitable[str]]


@dataclass(frozen=True)
class CheckOutput:
    returncode: int
    text: str


#: Runs ``hermes update --check`` (the user's own Hermes, nothing installed) and returns its output.
HermesCheck = Callable[[], Awaitable[CheckOutput]]


class HermesCheckFailed(RuntimeError):
    """``hermes update --check`` exited non-zero (offline: "Could not resolve the … source channel", or a
    refusal): a failed check like an HTTP error — the caller keeps what it knew (FIX-1 F3.5)."""

_RELEASE = re.compile(r"^(?:rust-)?v?(\d+)\.(\d+)\.(\d+)$")
_HERMES_AVAILABLE = re.compile(r"Selected release available:.*?\bv(\d+\.\d+\.\d+)\b")
_HERMES_CURRENT = re.compile(r"Up to date with the latest release|No newer release|Already up to date|"
                             r"newer than the selected release", re.I)

NPM = "https://registry.npmjs.org"
BREW = "https://formulae.brew.sh/api"
CLAUDE_RELEASES = "https://downloads.claude.ai/claude-code-releases"
CODEX_CHANNEL = "https://releases.openai.com/codex/channels/latest"
CODEX_GITHUB = "https://api.github.com/repos/openai/codex/releases/latest"
OPENCODE_GITHUB = "https://api.github.com/repos/anomalyco/opencode/releases/latest"


def parse_version(text: str) -> Version | None:
    """A release ``x.y.z`` (``v``/``rust-v`` prefix allowed); pre-releases and anything else: None."""
    match = _RELEASE.match(text.strip())
    if match is None:
        return None
    return int(match[1]), int(match[2]), int(match[3])


def newer(latest: str | None, installed: str | None) -> bool:
    a, b = parse_version(latest or ""), parse_version(installed or "")
    return a is not None and b is not None and a > b


def _clean(text: str | None) -> str | None:
    version = parse_version(text or "")
    return ".".join(map(str, version)) if version else None


def _field(body: str, *path: str) -> str | None:
    try:
        data: Any = json.loads(body)
    except ValueError:
        return None
    for key in path:
        if not isinstance(data, dict):
            return None
        data = data.get(key)
    return data if isinstance(data, str) else None


def npm_latest(body: str) -> str | None:
    return _clean(_field(body, "version"))


def cask_latest(body: str) -> str | None:
    return _clean(_field(body, "version"))


def formula_latest(body: str) -> str | None:
    return _clean(_field(body, "versions", "stable"))


def release_latest(body: str) -> str | None:
    """A GitHub (or OpenAI releases) ``tag_name``: ``rust-v0.164.0`` / ``v1.19.4``."""
    return _clean(_field(body, "tag_name"))


def text_latest(body: str) -> str | None:
    return _clean(body.strip().splitlines()[0] if body.strip() else "")


def hermes_latest(output: CheckOutput) -> str | None:
    """The release ``hermes update --check`` offers; ``None`` when up to date, on a branch channel
    (commit counts only) or when the checkout is newer (the update would move it back)."""
    if output.returncode != 0 or _HERMES_CURRENT.search(output.text):
        return None
    match = _HERMES_AVAILABLE.search(output.text)
    return _clean(match[1]) if match else None


def sources(info: ChannelInfo) -> tuple[tuple[str, Callable[[str], str | None]], ...]:
    """The URLs to ask, in order (a later one only when an earlier one failed), and their parser."""
    engine, channel = info.engine, info.channel
    if engine == "codex":
        if channel == "npm":
            return ((f"{NPM}/@openai/codex/latest", npm_latest),)
        if channel == "brew":
            return ((f"{BREW}/cask/codex.json", cask_latest),)
        if channel == "native":
            return ((CODEX_CHANNEL, release_latest), (CODEX_GITHUB, release_latest))
    if engine == "claude_code":
        tag = "stable" if info.detail == "stable" else "latest"
        if channel == "native":
            return ((f"{CLAUDE_RELEASES}/{tag}", text_latest),)
        if channel == "npm":
            return ((f"{NPM}/@anthropic-ai/claude-code/{tag}", npm_latest),)
        if channel == "brew" and info.detail in ("claude-code", "claude-code@latest"):
            return ((f"{BREW}/cask/{info.detail}.json", cask_latest),)
    if engine == "opencode":
        if channel == "curl":
            return ((OPENCODE_GITHUB, release_latest),)
        if channel == "npm":
            return ((f"{NPM}/opencode-ai/latest", npm_latest),)
        if channel == "brew" and info.detail == "opencode":
            return ((f"{BREW}/formula/opencode.json", formula_latest),)
    return ()


async def latest_version(info: ChannelInfo, *, fetch: Fetch,
                         hermes_check: HermesCheck | None = None) -> str | None:
    """The channel's latest release, ``None`` when the channel has none SKAZ can read.

    Raises when every source failed (network, refused): the caller keeps what it knew before.
    """
    if info.engine == "hermes":
        if info.channel != "git" or hermes_check is None:
            return None
        output = await hermes_check()
        if output.returncode != 0:
            raise HermesCheckFailed(f"hermes update --check exited with {output.returncode}")
        return hermes_latest(output)
    asked = sources(info)
    error: Exception | None = None
    for url, parse in asked:
        try:
            body = await fetch(url)
        except Exception as failure:  # the next source, else the caller keeps the old result
            error = failure
            continue
        return parse(body)
    if error is not None:
        raise error
    return None
