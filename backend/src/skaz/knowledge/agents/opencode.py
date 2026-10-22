"""OpenCode on the ``AgentEngine`` interface over ACP (W-1, decision 8 of 2026-10-20).

SKAZ starts ``opencode acp`` (Agent Client Protocol, JSON-RPC on stdio) with its own OpenCode
folder, ``<data_dir>/agents/opencode``: ``HOME``, ``XDG_CONFIG_HOME``, ``XDG_DATA_HOME``,
``XDG_CACHE_HOME``, ``XDG_STATE_HOME`` and ``TMPDIR`` all point inside it (``opencode debug paths``
on 1.17.18 shows every global path follows them). The user's ``~/.config/opencode``,
``~/.local/share/opencode`` (``auth.json``), ``~/.claude`` and API keys in SKAZ's own environment are
never seen: the environment is allowlisted (:func:`~..install.system.base_env`). Sign-in to model
providers happens in OpenCode itself: ``login`` opens ``opencode auth login`` for SKAZ's folder in
Terminal; OpenCode writes the credential to SKAZ's ``auth.json``, which SKAZ never reads.

Checked on OpenCode 1.17.18 (the installed binary, offline, isolated folder; source read from the
bundled JavaScript of that binary — no model was called):

* ``initialize``: ``mcpCapabilities.http``, one auth method ``opencode-login`` (terminal).
* ``session/new`` registers the ``mcpServers`` of the request as remote MCP servers of that
  directory (``n.mcp.add``); their tools are named ``<server>_<tool>`` with ``[^a-zA-Z0-9_-]``
  replaced by ``_`` — SKAZ's are ``skaz_<tool>``. The result has ``configOptions``: ``model``
  (``provider/model``), ``effort`` (category ``thought_level``, the model's *variants*, only when the
  model has some) and ``mode`` (the primary agents). Both are changed with
  ``session/set_config_option``.
* Text starting with ``/`` runs an OpenCode command instead of a prompt; SKAZ never sends one.
* Tool limits: the pinned policy (:data:`OPENCODE_POLICY`, the folder's global ``opencode.json``,
  plus ``OPENCODE_PERMISSION``) denies every permission (``"*": "deny"``) and allows only
  ``skaz_*`` on SKAZ's own primary agent ``skaz``; every other agent (``build``, ``plan``,
  ``general``, ``explore``, ``title``, ``summary``) is disabled, so no extra model call (session
  titles go to a "small" model) and no subagent. OpenCode removes a tool whose last matching rule
  is ``deny`` with pattern ``*``; before using OpenCode SKAZ reads the resolved agent with
  ``opencode debug agent skaz`` (local, no model) and refuses unless :func:`limits_applied`. Web
  tools (``webfetch``/``websearch``) are therefore off as well — web search is a separate task (W-2).
  A ``tool_call`` of any non-SKAZ tool during a run stops the run; permission requests are refused.
* Project files are not read: ``OPENCODE_DISABLE_PROJECT_CONFIG`` (no AGENTS.md/CLAUDE.md or
  ``.opencode`` above the run folder), ``OPENCODE_DISABLE_CLAUDE_CODE`` (no ``~/.claude``),
  ``OPENCODE_DISABLE_EXTERNAL_SKILLS``.
* Instructions: per run, ``OPENCODE_CONFIG`` names a file in the run folder setting the ``skaz``
  agent's ``prompt``, which replaces OpenCode's own coding prompt (``LLMRequestPrep.prepare``:
  ``agent.prompt ? [agent.prompt] : provider prompt``). OpenCode substitutes ``{env:…}`` and
  ``{file:…}`` in the *raw text* of config files (verified: ``{env:HOME}`` became the path), so SKAZ
  writes every brace inside the prompt as ``\\u007b``/``\\u007d``: the JSON value is the same text,
  the substitution never sees it.
* Free models: without any credential OpenCode still lists the free models of its own ``opencode``
  provider (``apiKey: "public"``) and picks one as the default. SKAZ never uses a provider the user
  has not signed in to in SKAZ's OpenCode folder: those models are not offered and never run.
  Signed in to OpenCode itself, its free tier (its own provider at zero cost, ``…-free``) still
  refuses every client but the OpenCode app (verified 1.17.18: ``-32603 … free tier can only be used
  from within OpenCode``), so SKAZ never offers those models and refuses them before sending.
* MCP calls: OpenCode's per-call limit is the server's ``timeout`` ?? ``experimental.mcp_timeout``
  ?? the MCP SDK default (60 s, reset on progress); servers given over ACP carry none, so the policy
  sets ``experimental.mcp_timeout`` to the largest timer value — a SKAZ tool waiting for the user's
  decision is not cut off by OpenCode.
* History: OpenCode keeps every session in ``<XDG_DATA_HOME>/opencode/opencode.db``; SKAZ deletes
  each run's session with ``opencode session delete <id>`` once the ACP process ended and retries
  ids it could not delete at the next start (``opencode-sessions.json``).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import uuid
from collections import deque
from collections.abc import AsyncIterator, Coroutine, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from ...native_io import disk_call
from ..install.system import (
    Located,
    LocateFn,
    Version,
    base_env,
    dotted,
    kill_group,
    locate,
    parse_version,
    refuse_sudo,
    run_capture,
)
from ..install.terminal import TerminalLauncher, terminal_progress
from ..permissions.refusals import OUTSIDE, refused
from ..processes import CHILDREN
from .acp_client import METHOD_NOT_FOUND, PROTOCOL_VERSION, AcpClosed, AcpConnection, AcpError
from .engine import (
    AgentEvent,
    AgentTurn,
    Completed,
    EngineId,
    EngineStatus,
    Failed,
    FailureKind,
    ModelOption,
    TextDelta,
    ToolCall,
    ToolResult,
    Usage,
)
from .mcp_access import MCP_SERVER_NAME, NO_TOOL_ACCESS, McpAccessProvider
from .transcript import render_prompt

logger = logging.getLogger(__name__)

#: The OpenCode build SKAZ verified (ACP config options, ``debug agent``, permission rules). Older
#: builds are refused; :func:`limits_applied` guards newer ones on every check.
MIN_OPENCODE_VERSION: Version = (1, 17, 18)
_VERSION = re.compile(r"^\s*v?(\d+)\.(\d+)\.(\d+)", re.MULTILINE)
NAME = "OpenCode"
NOT_INSTALLED = "OpenCode is not installed."
NO_PROVIDER = "Sign in to a model provider in OpenCode (opened from SKAZ) to use OpenCode."
LIMITS_NOT_APPLIED = "OpenCode did not apply SKAZ's tool limits, so SKAZ stopped. Update OpenCode."
UNREADABLE_NOTE = "OpenCode started but didn't say its version. Check it again."
RUN_FAIL_NOTE = "SKAZ couldn't start OpenCode. Check it again; if that keeps happening, reinstall it."
CHOOSE_MODEL = "Choose an OpenCode model in SKAZ: it has no model of a provider you signed in to."
MODEL_UNAVAILABLE = "This model is not available in OpenCode now. Choose another one."
EFFORT_UNAVAILABLE = "This reasoning level is not available for this model in OpenCode."
FREE_TIER_NOTE = ("OpenCode's free models work only inside the OpenCode app, not in SKAZ. "
                  "Choose another model in the message field.")
SIGN_IN_NAME = "opencode-sign-in"
SIGN_IN_TITLE = "SKAZ opened the OpenCode sign-in for SKAZ's own OpenCode folder."
#: SKAZ's own primary agent in OpenCode.
SKAZ_AGENT = "skaz"
#: OpenCode's own provider: free models without a credential (``apiKey: "public"``).
FREE_PROVIDER = "opencode"
#: Its name as ``opencode auth list`` prints it (models.dev ``name``).
FREE_PROVIDER_NAME = "OpenCode"
TOOL_PREFIX = f"{MCP_SERVER_NAME}_"
#: Largest ``setTimeout`` value; OpenCode passes it to the MCP SDK as the per-call timeout.
MCP_TIMEOUT_MS = 2_147_483_647
#: Built-in tools of 1.17.18 (``debug agent`` lists the always-present ones; the rest are
#: experimental or model-dependent). All must be denied; so must any other name.
BUILTIN_TOOLS = (
    "apply_patch", "bash", "batch", "codesearch", "edit", "glob", "grep", "invalid", "list", "lsp",
    "multiedit", "patch", "plan_enter", "plan_exit", "question", "read", "skill", "task", "todoread",
    "todowrite", "webfetch", "websearch", "write",
)
#: OpenCode's own agents, all off for SKAZ (``title``/``summary`` would call a "small" model).
DISABLED_AGENTS = ("build", "plan", "general", "explore", "title", "summary")
DENY_ALL: dict[str, str] = {"*": "deny"}
SKAZ_PERMISSION: dict[str, str] = {"*": "deny", f"{TOOL_PREFIX}*": "allow"}
OPENCODE_POLICY: dict[str, Any] = {
    "$schema": "https://opencode.ai/config.json",
    "autoupdate": False,
    "share": "disabled",
    "snapshot": False,
    "lsp": False,
    "formatter": False,
    "plugin": [],
    "instructions": [],
    "mcp": {},
    "default_agent": SKAZ_AGENT,
    "permission": DENY_ALL,
    "tools": {"*": False},
    "experimental": {"mcp_timeout": MCP_TIMEOUT_MS},
    "agent": {
        SKAZ_AGENT: {"mode": "primary", "description": "SKAZ library assistant",
                     "permission": SKAZ_PERMISSION, "tools": {"*": False, f"{TOOL_PREFIX}*": True}},
        **{name: {"disable": True} for name in DISABLED_AGENTS},
    },
}
#: OpenCode's own switches (``RuntimeFlags`` in 1.17.18). Never ``OPENCODE_ENABLE_EXA`` (web search).
OPENCODE_FLAGS: dict[str, str] = {
    "OPENCODE_DISABLE_AUTOUPDATE": "1",
    "OPENCODE_DISABLE_SHARE": "1",
    "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
    "OPENCODE_DISABLE_CLAUDE_CODE": "1",
    "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1",
    "OPENCODE_DISABLE_LSP_DOWNLOAD": "1",
}
#: Shown in the Terminal window SKAZ opens (the values SKAZ sets; nothing secret).
SHOWN_ENV = ("PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
             "XDG_STATE_HOME", *OPENCODE_FLAGS, "OPENCODE_PERMISSION")
HISTORY_FILE = "opencode-sessions.json"
MAX_DELETE_ATTEMPTS = 5
_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_COUNT = re.compile(r"(\d+)\s+credentials?\b")
_CREDENTIAL_TYPES = frozenset({"api", "oauth", "wellknown"})


# -- pure helpers ---------------------------------------------------------------


def parse_opencode_version(text: str) -> Version | None:
    return parse_version(text, _VERSION)


def user_opencode_dirs(home: Path | None = None) -> tuple[Path, ...]:
    base = home or Path.home()
    return (base / ".config" / "opencode", base / ".local" / "share" / "opencode", base / ".opencode",
            base / ".cache" / "opencode", base / ".local" / "state" / "opencode")


def ensure_private_folder(path: Path, *, home: Path | None = None) -> Path:
    """SKAZ's OpenCode folder must never be (or be inside) one of the user's own OpenCode folders."""
    resolved = path.expanduser().resolve()
    for own in user_opencode_dirs(home):
        mine = own.expanduser().resolve()
        if resolved == mine or mine in resolved.parents or resolved in mine.parents:
            raise ValueError("SKAZ must not use your own OpenCode folders.")
    return resolved


def _wildcard(pattern: str, name: str) -> bool:
    """OpenCode's ``Wildcard.match``: ``*`` any run, ``?`` one character, the whole name."""
    regex = re.escape(pattern).replace(r"\*", ".*").replace(r"\?", ".")
    return re.fullmatch(regex, name, re.DOTALL) is not None


def _decision(rules: Sequence[Mapping[str, Any]], tool: str) -> str:
    """What OpenCode decides for a whole tool: the last rule whose ``permission`` matches it;
    a pattern other than ``*`` leaves the tool on (it then asks per argument)."""
    for rule in reversed(rules):
        if _wildcard(str(rule.get("permission", "")), tool):
            return str(rule.get("action")) if rule.get("pattern") == "*" else "partial"
    return "allow"


def limits_applied(agent: Mapping[str, Any]) -> bool:
    """``opencode debug agent skaz`` shows SKAZ's agent with every tool but SKAZ's own off."""
    if agent.get("name") != SKAZ_AGENT or agent.get("mode") != "primary":
        return False
    tools = agent.get("tools")
    rules = agent.get("permission")
    if not isinstance(tools, dict) or not isinstance(rules, list):
        return False
    if any(value is not False for value in tools.values()):
        return False
    if not all(isinstance(rule, dict) for rule in rules):
        return False
    probes = {*BUILTIN_TOOLS, *tools, "other_server_tool", MCP_SERVER_NAME, "x"}
    if any(_decision(rules, name) != "deny" for name in probes):
        return False
    return _decision(rules, f"{TOOL_PREFIX}search") == "allow"


def parse_credentials(text: str) -> tuple[str, ...]:
    """Provider names in ``opencode auth list`` (``●  Anthropic api`` …); never values (none are shown).

    Only the ``Credentials`` section counts: the ``Environment`` section lists keys of the
    environment, which SKAZ never passes.
    """
    names: list[str] = []
    for raw in _ANSI.sub("", text).splitlines():
        line = raw.strip().lstrip("┌│└●◆◇▲■•").strip()
        if not line or line.startswith("Credentials"):
            continue
        if line.startswith("Environment") or _COUNT.fullmatch(line):
            break
        name, _sep, kind = line.rpartition(" ")
        if kind in _CREDENTIAL_TYPES and name.strip():
            names.append(name.strip())
    return tuple(dict.fromkeys(names))


def parse_models(text: str) -> list[dict[str, Any]]:
    """``opencode models --verbose``: ``<provider>/<model>`` then that model's JSON, per model."""
    decoder = json.JSONDecoder()
    models: list[dict[str, Any]] = []
    position = 0
    while True:
        start = text.find("{", position)
        if start < 0:
            return models
        try:
            value, end = decoder.raw_decode(text, start)
        except ValueError:
            position = start + 1
            continue
        position = end
        if (isinstance(value, dict) and isinstance(value.get("id"), str)
                and isinstance(value.get("providerID"), str)):
            models.append(value)


def provider_allowed(model_id: str, credentials: Sequence[str]) -> bool:
    """A model SKAZ may use: never OpenCode's free provider unless the user signed in to it."""
    provider = model_id.split("/", 1)[0]
    return provider != FREE_PROVIDER or FREE_PROVIDER_NAME in credentials


def free_tier(model: Mapping[str, Any]) -> bool:
    """OpenCode's own free models: they answer only inside the OpenCode app."""
    if model.get("providerID") != FREE_PROVIDER:
        return False
    cost = model.get("cost")
    zero = isinstance(cost, Mapping) and not cost.get("input") and not cost.get("output")
    return zero or str(model.get("id", "")).endswith("-free")


def model_options(models: Sequence[Mapping[str, Any]], credentials: Sequence[str]) -> tuple[ModelOption, ...]:
    entries: list[tuple[str, str, tuple[str, ...]]] = []
    for model in models:
        model_id = f"{model['providerID']}/{model['id']}"
        if not provider_allowed(model_id, credentials) or free_tier(model):
            continue
        variants = model.get("variants")
        efforts = tuple(key for key in variants if key != "default") if isinstance(variants, dict) else ()
        entries.append((model_id, str(model.get("name") or model["id"]), efforts))
    names = [name for _id, name, _efforts in entries]
    def label(model_id: str, name: str) -> str:
        return name if names.count(name) == 1 else f"{name} · {model_id.split('/', 1)[0]}"

    return tuple(ModelOption(model_id, label(model_id, name), efforts) for model_id, name, efforts in entries)


def run_config_text(instructions: str) -> str:
    """The per-run config file: the ``skaz`` agent's prompt, braces escaped (no ``{env:}``/``{file:}``)."""
    prompt = json.dumps(instructions, ensure_ascii=True).replace("{", "\\u007b").replace("}", "\\u007d")
    return '{"agent": {"' + SKAZ_AGENT + '": {"prompt": ' + prompt + "}}}\n"


_AUTH_MARKS = ("auth", "api key", "401", "unauthorized", "credential")
_LIMIT_MARKS = ("429", "rate limit", "rate-limit", "quota", "usage limit", "insufficient")
_NETWORK_MARKS = ("connection", "network", "timed out", "unreachable", "econn", "fetch failed")


def classify_error(text: str, code: int | None = None) -> tuple[FailureKind, str]:
    lowered = text.lower()
    if "free tier" in lowered and "within opencode" in lowered:
        return "other", FREE_TIER_NOTE
    if code == -32000 or any(mark in lowered for mark in _AUTH_MARKS):
        return "auth", "OpenCode's sign-in to the model provider didn't work. Sign in again from SKAZ."
    if any(mark in lowered for mark in _LIMIT_MARKS):
        return "limit", "The OpenCode model provider says the usage limit is reached."
    if any(mark in lowered for mark in _NETWORK_MARKS):
        return "network", "OpenCode couldn't reach its model provider. Check the internet connection."
    return "other", "OpenCode could not finish the answer."


def _config_option(options: object, option_id: str) -> Mapping[str, Any] | None:
    if not isinstance(options, list):
        return None
    for option in options:
        if isinstance(option, dict) and option.get("id") == option_id:
            return option
    return None


def _values(option: Mapping[str, Any] | None) -> list[str]:
    if option is None:
        return []
    out: list[str] = []
    for item in option.get("options") or []:
        if isinstance(item, dict) and isinstance(item.get("value"), str):
            out.append(item["value"])
        elif isinstance(item, dict) and isinstance(item.get("options"), list):  # grouped select
            out.extend(str(inner["value"]) for inner in item["options"]
                       if isinstance(inner, dict) and isinstance(inner.get("value"), str))
    return out


def _chunk_text(update: Mapping[str, Any]) -> str:
    content = update.get("content")
    if isinstance(content, dict) and content.get("type") == "text":
        return str(content.get("text") or "")
    return ""


def _tool_output(update: Mapping[str, Any]) -> str:
    parts: list[str] = []
    for item in update.get("content") or []:
        if isinstance(item, dict):
            inner = item.get("content")
            if isinstance(inner, dict) and inner.get("type") == "text":
                parts.append(str(inner.get("text") or ""))
    if parts:
        return "\n".join(parts)
    raw = update.get("rawOutput")
    if isinstance(raw, dict) and isinstance(raw.get("output"), str):
        return str(raw["output"])
    return raw if isinstance(raw, str) else (json.dumps(raw, ensure_ascii=False) if raw is not None else "")


def _reject(params: Mapping[str, Any]) -> dict[str, Any]:
    for kind in ("reject_once", "reject_always"):
        for option in params.get("options") or []:
            if isinstance(option, dict) and option.get("kind") == kind and option.get("optionId"):
                return {"outcome": {"outcome": "selected", "optionId": option["optionId"]}}
    return {"outcome": {"outcome": "cancelled"}}


async def _requests(method: str, params: Mapping[str, Any]) -> dict[str, Any]:
    """OpenCode's own requests: permission prompts are rejected; fs/terminal are not offered."""
    if method == "session/request_permission":
        refused("opencode", "permission")
        return _reject(params)
    refused("opencode", method)
    raise AcpError(METHOD_NOT_FOUND, OUTSIDE)


def locate_opencode(name: str = "opencode", *, home: Path | None = None) -> Located | None:
    """The usual lookup, then the official installer's own folder ``~/.opencode/bin``."""
    found = locate(name)
    if found is not None:
        return found
    binary = (home or Path.home()) / ".opencode" / "bin" / name
    if binary.is_file() and os.access(binary, os.X_OK):
        path = [str(binary.parent), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        return Located(binary, os.pathsep.join(path))
    return None


@dataclass
class _ActiveRun:
    process: asyncio.subprocess.Process | None = None
    connection: AcpConnection | None = None
    session_id: str | None = None
    cancel: asyncio.Event = field(default_factory=asyncio.Event)


class _Refused(Exception):
    def __init__(self, failure: Failed) -> None:
        super().__init__(failure.message)
        self.failure = failure


@dataclass(frozen=True)
class _Facts:
    version: Version | None
    limits: bool


class OpenCodeEngine:
    def __init__(self, data_dir: Path, *, mcp: McpAccessProvider | None = None,
                 locate_cli: LocateFn | None = None, launcher: TerminalLauncher | None = None,
                 user_home: Path | None = None, start_timeout_s: float = 120.0,
                 status_timeout_s: float = 30.0, interrupt_grace_s: float = 5.0) -> None:
        self.root = ensure_private_folder(data_dir / "agents" / "opencode", home=user_home)
        self.home = self.root / "home"
        self.config_home = self.root / "config"
        self.data_home = self.root / "data"
        self.cache_home = self.root / "cache"
        self.state_home = self.root / "state"
        self.tmp = self.root / "tmp"
        self.runs_dir = self.root / "runs"
        self.policy_file = self.config_home / "opencode" / "opencode.json"
        self.history_file = self.root / HISTORY_FILE
        self.mcp = mcp
        self._locate: LocateFn = locate_cli or (lambda name: locate_opencode(name, home=user_home))
        self._launcher = launcher or TerminalLauncher(data_dir / "agents" / "launch")
        self._start_timeout = start_timeout_s
        self._status_timeout = status_timeout_s
        self._grace = interrupt_grace_s
        self._runs: dict[str, _ActiveRun] = {}
        self._facts: dict[tuple[str, float], _Facts] = {}
        self._history_tasks: set[asyncio.Task[None]] = set()
        #: Ids of OpenCode's free-tier models from the last catalogue read (``None`` = not read yet).
        self._free: frozenset[str] | None = None
        self.current_model: str | None = None

    @property
    def id(self) -> EngineId:
        return "opencode"

    # -- folder and environment ----------------------------------------------

    def prepare(self) -> None:
        """Create SKAZ's OpenCode folder and (re)write the pinned policy."""
        for folder in (self.home, self.config_home, self.data_home, self.cache_home, self.state_home,
                       self.tmp, self.runs_dir, self.policy_file.parent):
            folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self.policy_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(OPENCODE_POLICY, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, self.policy_file)

    def environment(self, located: Located, *, run_config: Path | None = None) -> dict[str, str]:
        env = base_env(located.path, self.home)
        env["TMPDIR"] = str(self.tmp)
        env["XDG_CONFIG_HOME"] = str(self.config_home)
        env["XDG_DATA_HOME"] = str(self.data_home)
        env["XDG_CACHE_HOME"] = str(self.cache_home)
        env["XDG_STATE_HOME"] = str(self.state_home)
        env.update(OPENCODE_FLAGS)
        # Applied after every config file (``config.ts``: ``OPENCODE_PERMISSION`` merged last).
        env["OPENCODE_PERMISSION"] = json.dumps(DENY_ALL)
        if run_config is not None:
            env["OPENCODE_CONFIG"] = str(run_config)
        return env

    def reset_cache(self) -> None:
        self._facts.clear()

    @staticmethod
    def _key(located: Located) -> tuple[str, float]:
        try:
            stamp = located.binary.stat().st_mtime
        except OSError:
            stamp = 0.0
        return (str(located.binary), stamp)

    async def _cli(self, located: Located, *args: str, timeout: float | None = None) -> tuple[int, str]:
        self.prepare()
        out = await run_capture([str(located.binary), *args], env=self.environment(located), cwd=self.home,
                                timeout=timeout or self._status_timeout)
        return out.returncode, out.stdout

    async def _read_facts(self, located: Located) -> _Facts:
        key = self._key(located)
        if key in self._facts:
            return self._facts[key]
        code, out = await self._cli(located, "--version")
        version = parse_opencode_version(out) if code == 0 else None
        if version is None:
            return _Facts(None, False)  # never remembered: asked again next time
        limits = False
        if version >= MIN_OPENCODE_VERSION:
            code, out = await self._cli(located, "debug", "agent", SKAZ_AGENT)
            try:
                agent = json.loads(out) if code == 0 else None
            except ValueError:
                agent = None
            limits = isinstance(agent, dict) and limits_applied(agent)
            if not limits:
                logger.warning("OpenCode %s did not show SKAZ's tool limits (exit %s).",
                               dotted(version), code)
        facts = _Facts(version, limits)
        self._facts[key] = facts
        return facts

    async def credentials(self) -> tuple[str, ...]:
        """Names of the providers signed in in SKAZ's OpenCode folder (``opencode auth list``)."""
        located = self._locate("opencode")
        if located is None:
            return ()
        code, out = await self._cli(located, "auth", "list")
        return parse_credentials(out) if code == 0 else ()

    # -- status ---------------------------------------------------------------

    async def status(self) -> EngineStatus:
        located = self._locate("opencode")
        if located is None:
            return EngineStatus("opencode", installed=False, reason=NOT_INSTALLED)
        try:
            facts = await self._read_facts(located)
        except (OSError, TimeoutError):
            return EngineStatus("opencode", installed=True, reason=RUN_FAIL_NOTE)
        if facts.version is None:
            return EngineStatus("opencode", installed=True, reason=UNREADABLE_NOTE)
        shown = dotted(facts.version)
        if facts.version < MIN_OPENCODE_VERSION:
            return EngineStatus("opencode", installed=True, version=shown, incompatible=True,
                                reason=(f"OpenCode {shown} is outdated — version "
                                        f"{dotted(MIN_OPENCODE_VERSION)} or newer is required. Update it."))
        if not facts.limits:
            return EngineStatus("opencode", installed=True, version=shown, incompatible=True,
                                reason=LIMITS_NOT_APPLIED)
        try:
            signed_in = bool(await self.credentials())
        except (OSError, TimeoutError):
            return EngineStatus("opencode", installed=True, reason=RUN_FAIL_NOTE)
        return EngineStatus("opencode", installed=True, version=shown, signed_in=signed_in,
                            reason=None if signed_in else NO_PROVIDER)

    async def models(self) -> Sequence[ModelOption]:
        """OpenCode's catalogue for the providers signed in in SKAZ's folder, with their efforts."""
        located = self._locate("opencode")
        if located is None:
            return ()
        credentials = await self.credentials()
        if not credentials:
            return ()
        code, out = await self._cli(located, "models", "--verbose", timeout=max(self._status_timeout, 60.0))
        if code != 0:
            return ()
        models = parse_models(out)
        self._free = frozenset(f"{m['providerID']}/{m['id']}" for m in models if free_tier(m))
        return model_options(models, credentials)

    async def _is_free_tier(self, model_id: str) -> bool:
        if model_id.split("/", 1)[0] != FREE_PROVIDER:
            return False
        if self._free is None:
            await self.models()
        return model_id in (self._free or frozenset()) or model_id.endswith("-free")

    async def login(self) -> None:
        """Open ``opencode auth login`` for SKAZ's OpenCode folder in Terminal (SKAZ sees nothing)."""
        located = self._locate("opencode")
        if located is None:
            raise FileNotFoundError(NOT_INSTALLED)
        self.prepare()
        env = self.environment(located)
        shown = {key: env[key] for key in SHOWN_ENV if key in env}
        await self._launcher.open(SIGN_IN_NAME, SIGN_IN_TITLE,
                                  [str(located.binary), "auth", "login"], shown, agent="OpenCode")

    def login_progress(self) -> Literal["waiting", "done", "failed"] | None:
        """The sign-in window SKAZ opened: still open, finished, or stopped (``None``: never opened)."""
        return terminal_progress(self._launcher, SIGN_IN_NAME)

    async def logout(self) -> None:
        """``opencode auth logout <provider>`` for every provider signed in in SKAZ's OpenCode folder
        (XDG_DATA_HOME is SKAZ's own: OpenCode outside SKAZ keeps its sign-ins). Checked with OpenCode
        1.17.18: non-interactive with the provider's name, exit 0."""
        located = self._locate("opencode")
        if located is None:
            raise FileNotFoundError(NOT_INSTALLED)
        for name in await self.credentials():
            code, _out = await self._cli(located, "auth", "logout", name)
            if code != 0:
                raise ValueError(f"OpenCode didn't sign out of {name}")
        self._facts.clear()

    # -- SKAZ conversations in OpenCode's session store -------------------------

    def _read_history(self) -> dict[str, int]:
        try:
            raw = json.loads(self.history_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        sessions = raw.get("sessions") if isinstance(raw, dict) else None
        return {str(k): int(v) for k, v in sessions.items()} if isinstance(sessions, dict) else {}

    def _write_history(self, sessions: Mapping[str, int]) -> None:
        self.history_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self.history_file.with_suffix(".tmp")
        temporary.write_text(json.dumps({"sessions": dict(sessions)}) + "\n", encoding="utf-8")
        os.replace(temporary, self.history_file)

    def pending_history(self) -> list[str]:
        return list(self._read_history())

    def _remember(self, session_id: str) -> None:
        self._write_history({**self._read_history(), session_id: 0})

    def _delete_sync(self, located: Located, session_id: str) -> int:
        """``opencode session delete <id>`` in a worker thread (cancel-safe, unlike ``run_capture``)."""
        argv = [str(located.binary), "session", "delete", session_id]
        refuse_sudo(argv)
        process = subprocess.Popen(argv, env=self.environment(located), cwd=str(self.home),
                                   start_new_session=True, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        CHILDREN.add(process, group=True)
        try:
            process.wait(timeout=self._status_timeout)
        except subprocess.TimeoutExpired:
            kill_group(process.pid)
            process.wait()
        finally:
            CHILDREN.discard(process)
        return process.returncode

    async def _forget(self, session_ids: Sequence[str]) -> None:
        located = self._locate("opencode")
        if located is None:
            return
        done: set[str] = set()
        tries = self._read_history()
        for session_id in session_ids:
            try:
                code = await disk_call(self._delete_sync, located, session_id)
            except (OSError, subprocess.SubprocessError):
                code = 1
            if code == 0:
                done.add(session_id)
                continue
            tries[session_id] = tries.get(session_id, 0) + 1
            if tries[session_id] >= MAX_DELETE_ATTEMPTS:
                logger.warning("Giving up deleting OpenCode session %s after %d attempts", session_id,
                               tries[session_id])
                done.add(session_id)
        current = self._read_history()
        self._write_history({key: tries.get(key, value) for key, value in current.items() if key not in done})

    def sweep_at_start(self) -> bool:
        """App start: delete what earlier runs left in OpenCode's store (a quit mid-answer)."""
        pending = [item for item in self.pending_history()
                   if item not in {active.session_id for active in self._runs.values()}]
        if not pending:
            return False
        self._in_background(self._forget(pending))
        return True

    def _in_background(self, work: Coroutine[Any, Any, None]) -> None:
        task = asyncio.create_task(work, name="opencode-history")
        self._history_tasks.add(task)
        task.add_done_callback(self._history_tasks.discard)

    async def settle_history(self) -> None:
        while self._history_tasks:
            await asyncio.gather(*list(self._history_tasks), return_exceptions=True)

    # -- ACP process ------------------------------------------------------------

    @contextlib.asynccontextmanager
    async def _acp(self, located: Located, work: Path, run_config: Path,
                   active: _ActiveRun) -> AsyncIterator[AcpConnection]:
        self.prepare()
        argv = [str(located.binary), "acp"]
        refuse_sudo(argv)
        process = await asyncio.create_subprocess_exec(
            *argv, cwd=str(work), env=self.environment(located, run_config=run_config),
            start_new_session=True,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=32 * 1024 * 1024,
        )
        CHILDREN.add(process, group=True)
        active.process = process
        assert process.stdin is not None and process.stdout is not None and process.stderr is not None
        tail: deque[str] = deque(maxlen=40)
        drain = asyncio.create_task(_drain(process.stderr, tail))
        connection = AcpConnection(process.stdout, process.stdin, on_request=_requests)
        active.connection = connection
        try:
            try:
                await connection.request("initialize", {
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False},
                                           "terminal": False},
                    "clientInfo": {"name": "skaz", "title": "SKAZ", "version": "1"},
                }, timeout=self._start_timeout)
            except TimeoutError as error:
                raise _Refused(Failed("", "other", "OpenCode took too long to start. Try again.")) from error
            except (AcpClosed, AcpError) as error:
                raise _Refused(Failed("", "other", "OpenCode stopped while starting.")) from error
            yield connection
        finally:
            await connection.close()
            if process.returncode is None:
                kill_group(process.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(process.wait(), 3)
                except TimeoutError:
                    kill_group(process.pid)
                    await process.wait()
            CHILDREN.discard(process)
            drain.cancel()
            await asyncio.gather(drain, return_exceptions=True)

    # -- run --------------------------------------------------------------------

    def run(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        if turn.run_id in self._runs:
            raise ValueError(f"Run {turn.run_id} is already active.")
        active = _ActiveRun()
        self._runs[turn.run_id] = active
        return self._events(turn, active)

    async def interrupt(self, run_id: str) -> None:
        active = self._runs.get(run_id)
        if active is None:
            return
        active.cancel.set()
        if active.connection is not None and active.session_id is not None:
            with contextlib.suppress(AcpClosed, ConnectionError):
                await active.connection.notify("session/cancel", {"sessionId": active.session_id})
        elif active.process is not None and active.process.returncode is None:
            kill_group(active.process.pid, signal.SIGTERM)

    async def _events(self, turn: AgentTurn, active: _ActiveRun) -> AsyncIterator[AgentEvent]:
        run_id = turn.run_id
        work = self.runs_dir / uuid.uuid4().hex
        granted = False
        try:
            if turn.tools and self.mcp is None:
                yield Failed(run_id, "other", NO_TOOL_ACCESS)
                return
            located = self._locate("opencode")
            if located is None:
                yield Failed(run_id, "incompatible", NOT_INSTALLED)
                return
            facts = await self._read_facts(located)
            if facts.version is None or facts.version < MIN_OPENCODE_VERSION:
                yield Failed(run_id, "incompatible", f"This OpenCode version can't be used. Update to "
                                                     f"{dotted(MIN_OPENCODE_VERSION)} or newer.")
                return
            if not facts.limits:
                yield Failed(run_id, "incompatible", LIMITS_NOT_APPLIED)
                return
            credentials = await self.credentials()
            if not credentials:
                yield Failed(run_id, "auth", NO_PROVIDER)
                return
            allowed = bool(turn.model) and provider_allowed(turn.model or "", credentials)
            if allowed and await self._is_free_tier(turn.model or ""):
                # "other", not "incompatible": the agent needs no update, the model is the problem.
                yield Failed(run_id, "other", FREE_TIER_NOTE)
                return
            prompt = render_prompt(turn, include_instructions=False, include_schema=True)
            if prompt.lstrip().startswith("/"):
                prompt = f"Current request:\n{prompt}"  # ``/name`` would run an OpenCode command
            self.prepare()
            work.mkdir(mode=0o700, parents=True, exist_ok=True)
            run_config = work / "skaz-run.json"
            run_config.write_text(run_config_text(turn.instructions.strip() or "Answer the request."),
                                  encoding="utf-8")
            servers: list[dict[str, Any]] = []
            if turn.tools:
                assert self.mcp is not None
                access = self.mcp.grant(run_id, turn.tools)
                granted = True
                servers.append({"type": "http", "name": MCP_SERVER_NAME, "url": access.url,
                                "headers": [{"name": "Authorization", "value": f"Bearer {access.token}"}]})
            async with self._acp(located, work, run_config, active) as connection:
                events = self._session(turn, prompt, servers, work, credentials, connection, active)
                async for event in events:
                    yield event
        except _Refused as refusal:
            failure = refusal.failure
            yield Failed(run_id, "cancelled" if active.cancel.is_set() else failure.kind,
                         "The answer was stopped." if active.cancel.is_set() else failure.message)
        except (OSError, TimeoutError) as error:
            logger.warning("OpenCode run %s couldn't start: %s", run_id, type(error).__name__)
            yield Failed(run_id, "other", "SKAZ couldn't start OpenCode.")
        except ValueError as error:
            yield Failed(run_id, "other", str(error))
        finally:
            self._runs.pop(run_id, None)
            if granted and self.mcp is not None:
                self.mcp.revoke(run_id)
            shutil.rmtree(work, ignore_errors=True)
            if active.session_id:  # the ACP process has ended here
                self._in_background(self._forget([active.session_id]))

    async def _session(self, turn: AgentTurn, prompt: str, servers: list[dict[str, Any]], work: Path,
                       credentials: Sequence[str], connection: AcpConnection,
                       active: _ActiveRun) -> AsyncIterator[AgentEvent]:
        run_id = turn.run_id
        try:
            session = await connection.request("session/new", {"cwd": str(work), "mcpServers": servers},
                                               timeout=self._start_timeout)
        except AcpError as error:
            kind, message = classify_error(error.details(), error.code)
            raise _Refused(Failed(run_id, kind, message)) from error
        except (AcpClosed, TimeoutError) as error:
            raise _Refused(Failed(run_id, "other", "OpenCode stopped while starting.")) from error
        session_id = str(session.get("sessionId") or "")
        active.session_id = session_id or None
        if session_id:
            self._remember(session_id)  # OpenCode stores the session from ``session/new`` on
        options = session.get("configOptions")
        mode = _config_option(options, "mode")
        if mode is None or mode.get("currentValue") != SKAZ_AGENT:
            raise _Refused(Failed(run_id, "incompatible", LIMITS_NOT_APPLIED))
        await self._select(turn, options, credentials, session_id, connection)
        if active.cancel.is_set():
            yield Failed(run_id, "cancelled", "The answer was stopped.")
            return
        watcher = asyncio.create_task(self._stop_after_cancel(active))
        try:
            request = asyncio.create_task(connection.request(
                "session/prompt", {"sessionId": session_id, "prompt": [{"type": "text", "text": prompt}]}))
            outside = False
            async for event in self._updates(run_id, session_id, connection, request):
                if event is None:  # a tool outside SKAZ's: stop at once, never wait for its result
                    outside = True
                    active.cancel.set()
                    with contextlib.suppress(AcpClosed, ConnectionError):
                        await connection.notify("session/cancel", {"sessionId": session_id})
                    break
                yield event
            if outside:
                request.cancel()
                await asyncio.gather(request, return_exceptions=True)
                yield Failed(run_id, "incompatible", LIMITS_NOT_APPLIED)
                return
            try:
                reply = request.result()
            except AcpError as error:
                if active.cancel.is_set():
                    yield Failed(run_id, "cancelled", "The answer was stopped.")
                    return
                kind, message = classify_error(error.details(), error.code)
                yield Failed(run_id, kind, message)
                return
            except AcpClosed:
                yield (Failed(run_id, "cancelled", "The answer was stopped.") if active.cancel.is_set()
                       else Failed(run_id, "other", "OpenCode stopped unexpectedly."))
                return
            stop = reply.get("stopReason")
            if stop == "cancelled" or active.cancel.is_set():
                yield Failed(run_id, "cancelled", "The answer was stopped.")
            elif stop == "refusal":
                yield Failed(run_id, "other", "The OpenCode model declined to answer this request.")
            elif stop == "max_tokens":
                yield Failed(run_id, "other", "The answer reached the model's output limit before it ended.")
            else:
                raw_usage = reply.get("usage")
                usage: dict[str, Any] = raw_usage if isinstance(raw_usage, dict) else {}
                yield Completed(run_id, Usage(usage.get("inputTokens"), usage.get("outputTokens")))
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)

    async def _select(self, turn: AgentTurn, options: object, credentials: Sequence[str], session_id: str,
                      connection: AcpConnection) -> None:
        """The model and reasoning the user chose — exactly, or the run is refused (no fallback)."""
        run_id = turn.run_id
        model_option = _config_option(options, "model")
        current = model_option.get("currentValue") if model_option is not None else None
        wanted = turn.model or (current if isinstance(current, str) else None)
        if not wanted or not provider_allowed(wanted, credentials):
            message = CHOOSE_MODEL if not turn.model else MODEL_UNAVAILABLE
            raise _Refused(Failed(run_id, "incompatible", message))
        if wanted not in _values(model_option):
            raise _Refused(Failed(run_id, "incompatible", MODEL_UNAVAILABLE))
        if wanted != current:
            options = (await self._set(connection, session_id, "model", wanted, run_id, MODEL_UNAVAILABLE)
                       ).get("configOptions", options)
        if not turn.effort:
            return
        effort = _config_option(options, "effort")
        if turn.effort not in _values(effort):
            raise _Refused(Failed(run_id, "incompatible", EFFORT_UNAVAILABLE))
        if effort is not None and effort.get("currentValue") != turn.effort:
            await self._set(connection, session_id, "effort", turn.effort, run_id, EFFORT_UNAVAILABLE)

    async def _set(self, connection: AcpConnection, session_id: str, config_id: str, value: str, run_id: str,
                   message: str) -> dict[str, Any]:
        try:
            return await connection.request("session/set_config_option",
                                            {"sessionId": session_id, "configId": config_id, "value": value},
                                            timeout=self._start_timeout)
        except (AcpError, AcpClosed, TimeoutError) as error:
            raise _Refused(Failed(run_id, "incompatible", message)) from error

    async def _updates(self, run_id: str, session_id: str, connection: AcpConnection,
                       request: asyncio.Task[dict[str, Any]]) -> AsyncIterator[AgentEvent | None]:
        """Events of one prompt; ``None`` = OpenCode started a tool that is not SKAZ's."""
        names: dict[str, str] = {}
        announced: set[str] = set()
        async for method, params in _until(connection, request):
            if method != "session/update" or params.get("sessionId") not in (None, session_id):
                continue
            update = params.get("update") or {}
            kind = update.get("sessionUpdate")
            if kind == "agent_message_chunk":
                text = _chunk_text(update)
                if text:
                    yield TextDelta(run_id, text)
                continue
            if kind not in ("tool_call", "tool_call_update"):
                continue
            call_id = str(update.get("toolCallId") or "")
            if call_id not in names:
                title = str(update.get("title") or "")
                if not title.startswith(TOOL_PREFIX) or len(title) == len(TOOL_PREFIX):
                    refused("opencode", "tool")
                    yield None
                    return
                names[call_id] = title[len(TOOL_PREFIX):]
            raw = update.get("rawInput")
            status = update.get("status")
            finished = kind == "tool_call_update" and status in ("completed", "failed")
            # OpenCode announces a tool while its input still streams (``pending``, ``{}``); the
            # arguments arrive with ``in_progress``. SKAZ shows the call once, with them.
            if call_id not in announced and (finished or (isinstance(raw, dict) and raw)):
                announced.add(call_id)
                yield ToolCall(run_id, call_id, names[call_id], raw if isinstance(raw, dict) else {})
            if finished:
                yield ToolResult(run_id, call_id, _tool_output(update), status == "failed")

    async def _stop_after_cancel(self, active: _ActiveRun) -> None:
        await active.cancel.wait()
        process = active.process
        if process is None:
            return
        try:
            await asyncio.wait_for(process.wait(), self._grace)
        except TimeoutError:
            kill_group(process.pid, signal.SIGTERM)


async def _until(connection: AcpConnection, request: asyncio.Task[dict[str, Any]],
                 ) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Notifications in order until ``request`` has its reply (then whatever already arrived)."""
    queue = connection.notifications
    while True:
        getter = asyncio.create_task(queue.get())
        done, _ = await asyncio.wait({request, getter}, return_when=asyncio.FIRST_COMPLETED)
        if getter in done:
            item = getter.result()
            if item is None:
                await asyncio.wait({request})
                return
            yield item
            continue
        getter.cancel()
        await asyncio.gather(getter, return_exceptions=True)
        while not queue.empty():
            item = queue.get_nowait()
            if item is None:
                queue.put_nowait(None)
                return
            yield item
        return


async def _drain(stream: asyncio.StreamReader, tail: deque[str]) -> None:
    """Keep the last stderr lines for diagnosis only; never logged or shown."""
    while True:
        line = await stream.readline()
        if not line:
            return
        tail.append(line.decode(errors="replace").strip())
