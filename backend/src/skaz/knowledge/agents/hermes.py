"""Hermes Agent on the ``AgentEngine`` interface over ACP (WIKI-BACKEND-SPEC B2).

SKAZ starts ``hermes acp`` (Agent Client Protocol, JSON-RPC on stdio) with its
own Hermes folder, ``<data_dir>/agents/hermes-home`` as ``HERMES_HOME`` — never
the user's ``~/.hermes``: no memory, skills or keys of the user. Model and
provider are chosen in Hermes (decision 34-UI): ``login`` opens ``hermes model``
for that folder in Terminal; SKAZ never sees keys or sign-ins.

Tool limits (checked 2026-10-15 against hermes-agent.nousresearch.com/docs
user-guide/features/acp, user-guide/managed-scope and the source of
v0.21.5+6627.g4bb9e57):

* A managed-scope layer (``HERMES_MANAGED_DIR=<data_dir>/agents/hermes-policy``,
  ``config.yaml`` there) pins ``platform_toolsets.acp: [no_mcp]`` (no built-in
  toolsets, no configured MCP servers), ``agent.disabled_toolsets`` (every
  built-in and known plugin toolset), memory off and project skill discovery
  off. Leaf-level merge: the user's model/provider choice in the Hermes folder
  stays theirs, and ``hermes config set`` cannot change pinned keys.
* The SKAZ MCP server is passed per session in ``session/new`` ``mcpServers``.
* Before every prompt SKAZ sends ``/tools`` (answered by Hermes locally, no
  model call) and refuses the run if anything but SKAZ tools is listed.
  Offline check on the installed build: "No tools available." with the policy,
  23 tools without it.
* Permission requests are always answered with the reject option.

History (review B2 #4): Hermes ACP saves every prompted session — the whole
SKAZ prompt: question, transcript, source excerpts — to ``HERMES_HOME/state.db``
and has no setting to turn that off (``acp_adapter/session.py`` ``_persist``;
docs user-guide/features/acp "Session behavior"). Claude Code runs with
``--no-session-persistence`` and Codex ``ephemeral``; for Hermes SKAZ deletes
each run's session from its own folder once the ACP process ended, with the
documented ``hermes sessions delete <id> --yes``. Ids not deleted yet are kept
in ``hermes-sessions.json`` beside the folder and swept (with
``hermes sessions prune --source acp --yes`` for ended leftovers) on the next
start. The user's ``~/.hermes`` is never touched (``HERMES_HOME`` is SKAZ's).
An id is given up after ``MAX_DELETE_ATTEMPTS`` failed deletions or
``HISTORY_TTL_S`` (logged by id only); ``prune`` still removes ended ACP sessions.

The user's installation (review C1): a ``HERMES_HOME`` outside ``~/.hermes`` makes
Hermes build its own tool store there and re-point the user's shared launcher at
it. Every invocation therefore also gets ``HERMES_RUNTIME_DIR`` = the user's own
store and runs under :class:`~.hermes_launchers.LauncherWatch` (see that module
for the exact Hermes source lines).

First start (decision B10): the first ``hermes acp`` in a new Hermes folder
prepares Hermes' own environment (~1.5 GB, a few minutes). With
``first_run_gate`` (the app's engine) SKAZ never starts ACP — not for a status
check, models or a run — until the user ran the ``prepare`` task
(``install/recipes.py``), which leaves ``hermes-prepared.json`` beside the folder.
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
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ...native_io import disk_call
from ..install.recipes import HERMES_PREPARE_BYTES
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
from ..install.terminal import TerminalLauncher
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
from .hermes_launchers import LauncherTampered, LauncherWatch, launcher_files, user_store
from .mcp_access import MCP_SERVER_NAME, MCP_TOOL_PREFIX, NO_TOOL_ACCESS, McpAccessProvider, tool_name
from .registry import FirstRun
from .transcript import render_prompt

logger = logging.getLogger(__name__)

#: Oldest Hermes build SKAZ verified (ACP session MCP servers, platform_toolsets.acp,
#: agent.disabled_toolsets, managed scope via HERMES_MANAGED_DIR, ``/tools`` in ACP):
#: 0.21.5+6627.g4bb9e57. Older tags are refused; the per-run ``/tools`` check guards newer ones.
MIN_HERMES_VERSION: Version = (0, 21, 5)
_VERSION = re.compile(r"Hermes Agent v(\d+)\.(\d+)\.(\d+)")
_INSTALL_DIR = re.compile(r"^Install directory:\s*(.+)$", re.MULTILINE)
NOT_INSTALLED = "Hermes Agent is not installed."
NO_PROVIDER = "Choose a model and provider for Hermes in its setup (opened from SKAZ)."
SETUP_AUTH_METHOD = "hermes-setup"
NO_TOOLS_LISTING = "No tools available."
SETUP_TITLE = "SKAZ opened the Hermes model setup for SKAZ's own Hermes folder."
LIMITS_NOT_APPLIED = "Hermes did not apply SKAZ's tool limits, so SKAZ stopped the run. Update Hermes."
PREPARED_FILE = "hermes-prepared.json"
#: Session ids SKAZ created in its Hermes folder and has not deleted yet.
HISTORY_FILE = "hermes-sessions.json"
#: Review Low: an id Hermes refuses to delete this many times (one try per run end / app start) is
#: given up, and so is one older than the TTL — never retried on every start forever.
MAX_DELETE_ATTEMPTS = 5
HISTORY_TTL_S = 30 * 24 * 3600
PREPARING_NOTE = "Hermes is preparing its environment (~1.5 GB, a few minutes)."
PREPARE_FIRST = ("Hermes prepares its environment once before first use (~1.5 GB, a few minutes). "
                 "Start it from SKAZ when you're ready.")
#: Every toolset Hermes ships (core + platform + known plugin toolsets), all disabled for SKAZ.
DISABLED_TOOLSETS = (
    "a2a", "browser", "clarify", "code_execution", "computer_use", "context_engine", "cronjob",
    "delegation", "discord", "discord_admin", "file", "homeassistant", "image_gen", "kanban", "memory",
    "messaging", "moa", "session_search", "skills", "spotify", "terminal", "todo", "tts", "vision", "web",
    "youtube",
)
HERMES_POLICY: dict[str, Any] = {
    "platform_toolsets": {"acp": ["no_mcp"]},
    "agent": {"disabled_toolsets": list(DISABLED_TOOLSETS)},
    "memory": {"memory_enabled": False, "user_profile_enabled": False},
    "skills": {"project_discovery": False, "external_dirs": []},
}


def parse_hermes_version(text: str) -> Version | None:
    return parse_version(text, _VERSION)


def install_dir_of(version_output: str) -> Path | None:
    """``hermes --version`` prints ``Install directory: <path>`` (source installs)."""
    match = _INSTALL_DIR.search(version_output)
    return Path(match[1].strip()) if match else None


def user_hermes_home(home: Path | None = None) -> Path:
    return (home or Path.home()) / ".hermes"


def ensure_private_home(path: Path, *, home: Path | None = None) -> Path:
    """SKAZ's Hermes folder must never be (or be inside) the user's ``~/.hermes``."""
    resolved = path.expanduser().resolve()
    user = user_hermes_home(home).resolve()
    if resolved == user or user in resolved.parents:
        raise ValueError("SKAZ must not use your own Hermes folder (~/.hermes).")
    return resolved


def tools_listing_allowed(listing: str) -> bool:
    """``/tools`` output lists only SKAZ MCP tools (or none at all)."""
    text = listing.strip()
    if text == NO_TOOLS_LISTING:
        return True
    lines = text.splitlines()
    if not lines or not lines[0].startswith("Available tools"):
        return False
    names = [line.strip().split(":", 1)[0].strip() for line in lines[1:] if line.strip()]
    return all(name.startswith(MCP_TOOL_PREFIX) for name in names)


def classify_error(text: str) -> tuple[FailureKind, str]:
    lowered = text.lower()
    if any(mark in lowered for mark in ("not connected to any ai provider", "no llm provider", "hermes model",
                                        "hermes auth", "api key", "401", "unauthorized", "re-authenticate")):
        return "auth", "Hermes has no working model provider. Open the Hermes setup from SKAZ and choose one."
    if any(mark in lowered for mark in ("429", "rate limit", "rate-limit", "quota", "usage limit")):
        return "limit", "The Hermes model provider says the usage limit is reached."
    if any(mark in lowered for mark in ("connection", "network", "timed out", "unreachable", "resolve host")):
        return "network", "Hermes couldn't reach its model provider. Check the internet connection."
    return "other", "Hermes could not finish the answer."


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
    return raw if isinstance(raw, str) else (json.dumps(raw, ensure_ascii=False) if raw is not None else "")


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


async def _deny_requests(method: str, params: Mapping[str, Any]) -> dict[str, Any]:
    """Permission prompts are always rejected; file/terminal access is not offered at all."""
    if method == "session/request_permission":
        options = params.get("options") or []
        for kind in ("reject_once", "reject_always"):
            for option in options:
                if isinstance(option, dict) and option.get("kind") == kind and option.get("optionId"):
                    return {"outcome": {"outcome": "selected", "optionId": option["optionId"]}}
        return {"outcome": {"outcome": "cancelled"}}
    raise AcpError(METHOD_NOT_FOUND, "Not available in SKAZ.")


class HermesEngine:
    def __init__(self, data_dir: Path, *, mcp: McpAccessProvider | None = None,
                 locate_cli: LocateFn | None = None, launcher: TerminalLauncher | None = None,
                 user_home: Path | None = None, start_timeout_s: float = 180.0,
                 status_timeout_s: float = 20.0, interrupt_grace_s: float = 5.0,
                 first_run_gate: bool = False) -> None:
        root = data_dir / "agents"
        self.agents_dir = root
        self.home = ensure_private_home(root / "hermes-home", home=user_home)
        self.prepared_marker = root / PREPARED_FILE
        self.history_file = root / HISTORY_FILE
        self._gate = first_run_gate
        self.policy_dir = root / "hermes-policy"
        self.runs_dir = root / "hermes-runs"
        self.mcp = mcp
        self._locate: LocateFn = locate_cli or locate
        self._launcher = launcher or TerminalLauncher(root / "launch")
        self._user_home = user_home
        self._start_timeout = start_timeout_s
        self._status_timeout = status_timeout_s
        self._grace = interrupt_grace_s
        self._runs: dict[str, _ActiveRun] = {}
        self._checked: dict[tuple[str, float], tuple[Version | None, Path | None]] = {}
        self.current_model: str | None = None
        self._history_tasks: set[asyncio.Task[None]] = set()
        self._swept = False

    @property
    def id(self) -> EngineId:
        return "hermes"

    # -- folder and environment ----------------------------------------------

    def prepare(self) -> None:
        """Create the private Hermes folder and (re)write the pinned SKAZ policy."""
        self.home.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.policy_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        target = self.policy_dir / "config.yaml"
        temporary = target.with_suffix(".tmp")
        # JSON is valid YAML; no YAML writer is needed.
        temporary.write_text(json.dumps(HERMES_POLICY, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, target)

    def prepared(self) -> bool:
        """The first start (Hermes' own environment) was done by the user's ``prepare`` task."""
        return not self._gate or self.prepared_marker.is_file()

    def first_run(self) -> FirstRun:
        return FirstRun(HERMES_PREPARE_BYTES, self.prepared(),
                        needed=self._gate and self.set_up() and not self.prepared(), note=PREPARING_NOTE)

    def mark_prepared(self) -> None:
        self.prepared_marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self.prepared_marker.with_suffix(".tmp")
        temporary.write_text(json.dumps({"prepared": True}) + "\n", encoding="utf-8")
        os.replace(temporary, self.prepared_marker)

    def set_up(self) -> bool:
        """``hermes model`` has written a configuration into SKAZ's Hermes folder (contents are not read)."""
        return (self.home / "config.yaml").is_file() or (self.home / ".env").is_file()

    def environment(self, located: Located) -> dict[str, str]:
        env = base_env(located.path, self._user_home)
        env["HERMES_HOME"] = str(ensure_private_home(self.home, home=self._user_home))
        env["HERMES_MANAGED_DIR"] = str(self.policy_dir)
        env["HERMES_RUNTIME_DIR"] = str(self.runtime_dir(located))
        return env

    def runtime_dir(self, located: Located) -> Path:
        """The tool store the user's own ``hermes`` runs on (never one in SKAZ's folder)."""
        return user_store(located.binary, self._user_home or Path.home())

    def watch(self, located: Located, *, strict: bool = True) -> LauncherWatch:
        """Snapshot of the user's Hermes launchers; ``LauncherTampered`` if one already points into SKAZ."""
        home = self._user_home or Path.home()
        system = () if self._user_home is not None else (Path("/usr/local/bin"),)
        watch = LauncherWatch(launcher_files(located.binary, home, system_bins=system),
                              skaz_dirs=[self.agents_dir], stores=[self.home / "tools"], strict=strict)
        if strict:
            watch.refuse_if_tainted()
        return watch

    # -- status ---------------------------------------------------------------

    def reset_cache(self) -> None:
        """Forget the remembered version (the launcher script does not change on ``hermes update``)."""
        self._checked.clear()

    async def _version(self, located: Located) -> tuple[Version | None, Path | None]:
        try:
            stamp = located.binary.stat().st_mtime
        except OSError:
            stamp = 0.0
        key = (str(located.binary), stamp)
        if key not in self._checked:
            self.prepare()
            watch = self.watch(located)
            try:
                out = await run_capture([str(located.binary), "--version"], env=self.environment(located),
                                        timeout=self._status_timeout)
            finally:
                watch.check()
            self._checked[key] = (parse_hermes_version(out.stdout), install_dir_of(out.stdout))
        return self._checked[key]

    async def install_dir(self) -> Path | None:
        located = self._locate("hermes")
        if located is None:
            return None
        return (await self._version(located))[1]

    async def status(self) -> EngineStatus:
        located = self._locate("hermes")
        if located is None:
            return EngineStatus("hermes", installed=False, reason=NOT_INSTALLED)
        try:
            version, _ = await self._version(located)
        except LauncherTampered as error:
            return EngineStatus("hermes", installed=True, incompatible=True, reason=str(error))
        except (OSError, TimeoutError):
            return EngineStatus("hermes", installed=True, incompatible=True,
                                reason="SKAZ couldn't start Hermes Agent. Reinstall it.")
        if version is None:
            return EngineStatus("hermes", installed=True, incompatible=True,
                                reason="SKAZ couldn't read the Hermes Agent version. Reinstall it.")
        shown = dotted(version)
        if version < MIN_HERMES_VERSION:
            return EngineStatus("hermes", installed=True, version=shown, incompatible=True,
                                reason=(f"Hermes Agent {shown} is outdated — version "
                                        f"{dotted(MIN_HERMES_VERSION)} or newer is required. Update it."))
        if not self.set_up():
            # Never start Hermes for a folder nobody set up: the first ``hermes acp`` in a new
            # HERMES_HOME may prepare Hermes' own runtime. The user starts that from "Set up".
            return EngineStatus("hermes", installed=True, version=shown, reason=NO_PROVIDER)
        if not self.prepared():
            return EngineStatus("hermes", installed=True, version=shown, reason=PREPARE_FIRST)
        self._sweep_once()
        try:
            async with self._acp(located, self.runs_dir / "status") as (_connection, initialized):
                methods = initialized.get("authMethods") or []
        except _Refused as refused:
            incompatible = refused.failure.kind == "incompatible"
            # A start failure that is not about the version: no version shown, so the action is "check".
            return EngineStatus("hermes", installed=True, version=shown if incompatible else None,
                                incompatible=incompatible, reason=refused.failure.message)
        configured = any(isinstance(method, dict) and method.get("id") not in (None, SETUP_AUTH_METHOD)
                         for method in methods)
        return EngineStatus("hermes", installed=True, version=shown, signed_in=configured,
                            reason=None if configured else NO_PROVIDER)

    async def models(self) -> Sequence[ModelOption]:
        """What is set up in SKAZ's Hermes folder; empty until a provider is chosen there."""
        located = self._locate("hermes")
        if located is None or not self.set_up() or not self.prepared():
            return ()
        work = self.runs_dir / f"models-{uuid.uuid4().hex}"
        try:
            async with self._acp(located, work) as (connection, _initialized):
                session = await connection.request("session/new", {"cwd": str(work), "mcpServers": []},
                                                   timeout=self._start_timeout)
        except (_Refused, AcpError, AcpClosed, TimeoutError, LauncherTampered):
            return ()
        finally:
            shutil.rmtree(work, ignore_errors=True)
        state = session.get("models") or {}
        current = state.get("currentModelId")
        self.current_model = current if isinstance(current, str) else None
        options = [ModelOption(str(m["modelId"]), str(m.get("name") or m["modelId"]))
                   for m in state.get("availableModels") or [] if isinstance(m, dict) and m.get("modelId")]
        options.sort(key=lambda option: option.id != self.current_model)
        return tuple(options)

    async def login(self) -> None:
        """Open ``hermes model`` for SKAZ's Hermes folder in Terminal (provider, keys, sign-in)."""
        located = self._locate("hermes")
        if located is None:
            raise FileNotFoundError(NOT_INSTALLED)
        self.prepare()
        self.watch(located)  # never open it on a launcher that already points into SKAZ's folder
        env = self.environment(located)
        shown = {key: env[key] for key in ("PATH", "HERMES_HOME", "HERMES_MANAGED_DIR", "HERMES_RUNTIME_DIR")}
        await self._launcher.open("hermes-setup", SETUP_TITLE, [str(located.binary), "model"], shown)

    # -- SKAZ conversations in Hermes' session store ----------------------------

    def _read_history(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.history_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def pending_history(self) -> list[str]:
        """Session ids SKAZ created in its Hermes folder and has not deleted yet."""
        items = self._read_history().get("sessions")
        return [str(item) for item in items if isinstance(item, str)] if isinstance(items, list) else []

    def _write_history(self, ids: Sequence[str], *, attempts: Mapping[str, int] | None = None) -> None:
        """The pending ids with their failed-delete counts and first-seen times (kept for those that stay)."""
        old = self._read_history()
        keep = list(dict.fromkeys(ids))
        old_tries = old.get("attempts")
        tries = {**(old_tries if isinstance(old_tries, dict) else {}), **(attempts or {})}
        old_seen = old.get("first_seen")
        seen: dict[str, Any] = old_seen if isinstance(old_seen, dict) else {}
        now = datetime.now(UTC).isoformat(timespec="seconds")
        body = {"sessions": keep,
                "attempts": {item: int(tries[item]) for item in keep if item in tries},
                "first_seen": {item: str(seen.get(item) or now) for item in keep}}
        self.history_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self.history_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(body) + "\n", encoding="utf-8")
        os.replace(temporary, self.history_file)

    def _remember(self, session_id: str) -> None:
        self._write_history([*self.pending_history(), session_id])

    def _expired(self, session_id: str) -> bool:
        first = self._read_history().get("first_seen")
        seen = first.get(session_id) if isinstance(first, dict) else None
        try:
            since = datetime.fromisoformat(str(seen))
        except ValueError:
            return False
        return (datetime.now(UTC) - since).total_seconds() > HISTORY_TTL_S

    async def _forget(self, session_ids: Sequence[str]) -> None:
        """``hermes sessions delete <id> --yes`` in SKAZ's folder; ids it could not delete stay listed
        until ``MAX_DELETE_ATTEMPTS`` failures or ``HISTORY_TTL_S``, then they are given up."""
        located = self._locate("hermes")
        if located is None:
            return
        counted = self._read_history().get("attempts")
        tries: dict[str, int] = ({str(k): int(v) for k, v in counted.items()}
                                 if isinstance(counted, dict) else {})
        done: set[str] = set()
        failed: dict[str, int] = {}
        for session_id in session_ids:
            if self._expired(session_id):
                logger.warning("Giving up deleting Hermes session %s: older than %d days", session_id,
                               HISTORY_TTL_S // 86400)
                done.add(session_id)
                continue
            try:
                code, out = await disk_call(self._cli, located, "sessions", "delete", session_id, "--yes")
            except LauncherTampered:
                break  # nothing more runs against a Hermes that touched the user's launchers
            except (OSError, subprocess.SubprocessError):
                code, out = 1, ""
            # "No session '<id>'" (sessions_cmd._not_found): Hermes holds nothing of it (never prompted).
            if code == 0 or f"No session '{session_id}'" in out:
                done.add(session_id)
                continue
            failed[session_id] = tries.get(session_id, 0) + 1
            if failed[session_id] >= MAX_DELETE_ATTEMPTS:
                logger.warning("Giving up deleting Hermes session %s after %d attempts", session_id,
                               failed[session_id])
                done.add(session_id)
        if done or failed:
            left = [item for item in self.pending_history() if item not in done]
            self._write_history(left, attempts=failed)

    async def sweep_history(self) -> None:
        """Start of SKAZ: delete what earlier runs left in Hermes' store (a quit mid-answer, a failed delete).

        Never starts Hermes before the user prepared it (B10) — nothing can be stored before that.
        """
        self._swept = True
        located = self._locate("hermes")
        if located is None or not self.prepared() or not (self.set_up() or self.pending_history()):
            return
        running = {active.session_id for active in self._runs.values()}
        await self._forget([item for item in self.pending_history() if item not in running])
        if self._runs:
            return  # prune refuses while another Hermes process holds the store; next start
        with contextlib.suppress(OSError, subprocess.SubprocessError, LauncherTampered):
            # Ended ACP sessions SKAZ does not know by id (e.g. a compressed continuation).
            await disk_call(self._cli, located, "sessions", "prune", "--source", "acp", "--yes")

    def _cli(self, located: Located, *args: str) -> tuple[int, str]:
        """A short Hermes command in SKAZ's folder, in a worker thread.

        Not ``run_capture``: these run in the background, and an asyncio task cancelled while its
        subprocess is being created (app or test loop closing) waits for that process forever.
        """
        argv = [str(located.binary), *args]
        refuse_sudo(argv)
        watch = self.watch(located)
        process = subprocess.Popen(argv, env=self.environment(located), start_new_session=True,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL)
        CHILDREN.add(process, group=True)
        try:
            out, _ = process.communicate(timeout=self._status_timeout)
        except subprocess.TimeoutExpired:
            kill_group(process.pid)
            process.communicate()
            raise
        finally:
            CHILDREN.discard(process)
            watch.check()
        return process.returncode, out.decode(errors="replace")

    def sweep_at_start(self) -> bool:
        """App start: sweep in the background if Hermes is prepared; never starts it before (B10).

        An unprepared Hermes holds nothing of SKAZ's yet; its first use after preparing sweeps.
        """
        if not self.prepared():
            return False
        self._sweep_once()
        return True

    def _sweep_once(self) -> None:
        if not self._swept:
            self._swept = True
            self._in_background(self.sweep_history())

    def _in_background(self, work: Coroutine[Any, Any, None]) -> None:
        task = asyncio.create_task(work, name="hermes-history")
        self._history_tasks.add(task)
        task.add_done_callback(self._history_tasks.discard)

    async def settle_history(self) -> None:
        """Wait for the deletions started so far (tests; nothing in the app waits for them)."""
        while self._history_tasks:
            await asyncio.gather(*list(self._history_tasks), return_exceptions=True)

    # -- ACP process ------------------------------------------------------------

    @contextlib.asynccontextmanager
    async def _acp(self, located: Located, work: Path,
                   active: _ActiveRun | None = None) -> AsyncIterator[tuple[AcpConnection, dict[str, Any]]]:
        self.prepare()
        work.mkdir(mode=0o700, parents=True, exist_ok=True)
        argv = [str(located.binary), "acp"]
        refuse_sudo(argv)
        try:
            watch = self.watch(located)
        except LauncherTampered as error:
            raise _Refused(Failed("", "incompatible", str(error))) from error
        process = await asyncio.create_subprocess_exec(
            *argv, cwd=str(work), env=self.environment(located), start_new_session=True,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=32 * 1024 * 1024,
        )
        CHILDREN.add(process, group=True)  # quitting SKAZ signals it first (knowledge.shutdown)
        if active is not None:
            active.process = process
        assert process.stdin is not None and process.stdout is not None and process.stderr is not None
        tail: deque[str] = deque(maxlen=60)
        drain = asyncio.create_task(_drain(process.stderr, tail))
        connection = AcpConnection(process.stdout, process.stdin, on_request=_deny_requests)
        if active is not None:
            active.connection = connection
        try:
            try:
                initialized = await connection.request("initialize", {
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False},
                                           "terminal": False},
                    "clientInfo": {"name": "skaz", "title": "SKAZ", "version": "1"},
                }, timeout=self._start_timeout)
            except (AcpClosed, AcpError, TimeoutError) as error:
                await asyncio.sleep(0)
                raise _Refused(self._startup_failure(tail, error)) from error
            try:
                watch.check()  # Hermes publishes launchers while it boots, before it answers ``initialize``
            except LauncherTampered as error:
                raise _Refused(Failed("", "incompatible", str(error))) from error
            yield connection, initialized
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
            with contextlib.suppress(LauncherTampered):
                watch.check()  # a late change pointing into SKAZ's folder is put back here too

    def _startup_failure(self, tail: deque[str], error: BaseException) -> Failed:
        text = " ".join(tail)
        if "agent-client-protocol" in text or "No module named 'acp'" in text:
            return Failed("", "incompatible",
                          "Hermes Agent is installed without ACP support. Update Hermes from SKAZ to add it.")
        if isinstance(error, TimeoutError):
            return Failed("", "other", "Hermes Agent took too long to start. Try again.")
        return Failed("", "other", "Hermes Agent stopped while starting.")

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
            located = self._locate("hermes")
            if located is None:
                yield Failed(run_id, "incompatible", NOT_INSTALLED)
                return
            if not self.prepared():
                yield Failed(run_id, "other", PREPARE_FIRST)
                return
            self._sweep_once()
            try:
                version, _ = await self._version(located)
            except LauncherTampered as error:
                yield Failed(run_id, "incompatible", str(error))
                return
            if version is None or version < MIN_HERMES_VERSION:
                yield Failed(run_id, "incompatible", f"This Hermes Agent version can't be used. Update to "
                                                     f"{dotted(MIN_HERMES_VERSION)} or newer.")
                return
            prompt = render_prompt(turn, include_instructions=True, include_schema=True)
            if prompt.lstrip().startswith("/"):
                # Hermes runs text starting with "/" as its own command (/reset, /model); requests never are.
                prompt = f"Current request:\n{prompt}"
            servers: list[dict[str, Any]] = []
            if turn.tools:
                assert self.mcp is not None
                access = self.mcp.grant(run_id, turn.tools)
                granted = True
                servers.append({"type": "http", "name": MCP_SERVER_NAME, "url": access.url,
                                "headers": [{"name": "Authorization", "value": f"Bearer {access.token}"}]})
            async with self._acp(located, work, active) as (connection, _initialized):
                async for event in self._session(turn, prompt, servers, work, connection, active):
                    yield event
        except _Refused as refused:
            failure = refused.failure
            yield Failed(run_id, "cancelled" if active.cancel.is_set() else failure.kind,
                         "The answer was stopped." if active.cancel.is_set() else failure.message)
        except (OSError, ValueError) as error:
            yield Failed(run_id, "other", "SKAZ couldn't start Hermes Agent." if isinstance(error, OSError)
                         else str(error))
        finally:
            self._runs.pop(run_id, None)
            if granted and self.mcp is not None:
                self.mcp.revoke(run_id)
            shutil.rmtree(work, ignore_errors=True)
            if active.session_id:  # the ACP process has ended here (``_acp`` closed it)
                self._in_background(self._forget([active.session_id]))

    async def _session(self, turn: AgentTurn, prompt: str, servers: list[dict[str, Any]], work: Path,
                       connection: AcpConnection, active: _ActiveRun) -> AsyncIterator[AgentEvent]:
        run_id = turn.run_id
        try:
            session = await connection.request("session/new", {"cwd": str(work), "mcpServers": servers},
                                               timeout=self._start_timeout)
        except AcpError as error:
            kind, message = classify_error(error.details())
            raise _Refused(Failed(run_id, kind, message)) from error
        except (AcpClosed, TimeoutError) as error:
            raise _Refused(Failed(run_id, "other", "Hermes Agent stopped while starting.")) from error
        session_id = str(session.get("sessionId") or "")
        active.session_id = session_id
        if session_id:
            self._remember(session_id)  # before any prompt: Hermes saves the session from the first one
        await self._select_model(turn, session, connection, session_id)
        listing = await self._local_command(connection, session_id, "/tools")
        if not tools_listing_allowed(listing):
            raise _Refused(Failed(run_id, "incompatible", LIMITS_NOT_APPLIED))
        if active.cancel.is_set():
            yield Failed(run_id, "cancelled", "The answer was stopped.")
            return
        watcher = asyncio.create_task(self._stop_after_cancel(active))
        try:
            request = asyncio.create_task(connection.request(
                "session/prompt", {"sessionId": session_id, "prompt": [{"type": "text", "text": prompt}]}))
            async for event in self._updates(run_id, session_id, connection, request):
                yield event
            try:
                reply = request.result()
            except AcpError as error:
                if active.cancel.is_set():
                    yield Failed(run_id, "cancelled", "The answer was stopped.")
                    return
                kind, message = classify_error(error.details())
                yield Failed(run_id, kind, message)
                return
            except AcpClosed:
                yield (Failed(run_id, "cancelled", "The answer was stopped.") if active.cancel.is_set()
                       else Failed(run_id, "other", "Hermes Agent stopped unexpectedly."))
                return
            stop = reply.get("stopReason")
            if stop == "cancelled" or active.cancel.is_set():
                yield Failed(run_id, "cancelled", "The answer was stopped.")
            elif stop == "refusal":
                yield Failed(run_id, "other", "Hermes declined to answer this request.")
            else:
                raw_usage = reply.get("usage")
                usage: dict[str, Any] = raw_usage if isinstance(raw_usage, dict) else {}
                yield Completed(run_id, Usage(usage.get("inputTokens"), usage.get("outputTokens")))
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)

    async def _select_model(self, turn: AgentTurn, session: Mapping[str, Any], connection: AcpConnection,
                            session_id: str) -> None:
        if not turn.model:
            return
        state = session.get("models") or {}
        available = {str(m.get("modelId")) for m in state.get("availableModels") or [] if isinstance(m, dict)}
        if turn.model not in available:
            raise _Refused(Failed(turn.run_id, "incompatible",
                                  "This model is not set up in Hermes. Choose it in the Hermes setup."))
        if state.get("currentModelId") != turn.model:
            try:
                await connection.request("session/set_model",
                                         {"sessionId": session_id, "modelId": turn.model},
                                         timeout=self._start_timeout)
            except (AcpError, AcpClosed, TimeoutError) as error:
                raise _Refused(Failed(turn.run_id, "incompatible",
                                      "Hermes could not switch to this model.")) from error

    async def _local_command(self, connection: AcpConnection, session_id: str, command: str) -> str:
        """Run a Hermes slash command (handled locally, never sent to the model) and return its text."""
        request = asyncio.create_task(connection.request(
            "session/prompt", {"sessionId": session_id, "prompt": [{"type": "text", "text": command}]},
            timeout=self._start_timeout))
        parts: list[str] = []
        async for method, params in _until(connection, request):
            update = params.get("update") or {}
            if method == "session/update" and update.get("sessionUpdate") == "agent_message_chunk":
                parts.append(_chunk_text(update))
        with contextlib.suppress(AcpError, AcpClosed, TimeoutError):
            request.result()
        return "".join(parts)

    async def _updates(self, run_id: str, session_id: str, connection: AcpConnection,
                       request: asyncio.Task[dict[str, Any]]) -> AsyncIterator[AgentEvent]:
        names: dict[str, str] = {}
        async for method, params in _until(connection, request):
            if method != "session/update" or params.get("sessionId") not in (None, session_id):
                continue
            update = params.get("update") or {}
            kind = update.get("sessionUpdate")
            if kind == "agent_message_chunk":
                text = _chunk_text(update)
                if text:
                    yield TextDelta(run_id, text)
            elif kind == "tool_call":
                call_id = str(update.get("toolCallId") or "")
                name = str(update.get("title") or "").split(":", 1)[0].strip()
                names[call_id] = name
                raw = update.get("rawInput")
                yield ToolCall(run_id, call_id, tool_name(name), raw if isinstance(raw, dict) else {})
            elif kind == "tool_call_update" and update.get("status") in ("completed", "failed"):
                call_id = str(update.get("toolCallId") or "")
                yield ToolResult(run_id, call_id, _tool_output(update), update.get("status") == "failed")

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
    """Keep the last stderr lines for startup diagnosis only; never logged or shown."""
    while True:
        line = await stream.readline()
        if not line:
            return
        tail.append(line.decode(errors="replace").strip())
