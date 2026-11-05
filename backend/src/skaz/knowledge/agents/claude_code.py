"""Claude Code on the ``AgentEngine`` interface (WIKI-BACKEND-SPEC B2).

SKAZ runs the user's installed, unmodified ``claude`` in print mode with
stream-json in and out. Sign-in belongs to Claude Code: SKAZ never reads,
stores or forwards its tokens and only opens ``claude auth login`` in the
user's Terminal (``login``). Built-in tools are off; the only tools are the
SKAZ MCP tools of the turn, reached over HTTP with a per-run bearer token.

Flags (checked 2026-10-15 against code.claude.com/docs/en/cli-reference,
/headless, /permissions, /env-vars and ``claude --help`` of 2.1.281):

* ``-p --output-format stream-json --input-format stream-json --verbose
  --include-partial-messages``: newline-delimited events, token deltas,
  the prompt on stdin (no size limit of argv).
* ``--restricted`` (>= 2.1.248): no command-running tools, user/project/local
  settings files ignored (no user hooks, plugins, permission rules).
* ``--tools ""``: every built-in tool removed; ``--strict-mcp-config`` +
  ``--mcp-config <file>``: only the SKAZ server; without tools
  ``--disallowedTools "mcp__*"`` removes MCP tools from the context too.
* ``--permission-mode dontAsk --permission-prompts none`` (>= 2.1.259):
  anything not pre-approved is denied; ``--allowedTools mcp__skaz__<tool>``
  approves exactly the turn's tools.
* ``--disable-slash-commands``, ``--no-session-persistence`` (stateless runs; N6 chat sessions persist,
  see below) and ``CLAUDE_CODE_DISABLE_CLAUDE_MDS``/``..._AUTO_MEMORY``: no skills, memory or
  transcripts; ``CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK``: no automatic model
  switch (no silent substitution).
* ``--system-prompt-file``: SKAZ instructions replace the coding-assistant
  prompt; a file, so instruction text is never parsed as a flag.
* Interrupt: SIGINT ends the turn (headless docs: "To end the turn instead,
  send SIGINT"), then the process is stopped.

W-2 web search (chat turns with ``turn.web``; verified in the 2.1.281 binary,
see ``web.py``): ``--tools WebSearch`` (no WebFetch, shell or files),
``--permission-mode default --permission-prompt-tool stdio`` (no
``--permission-prompts none``): every WebSearch call arrives as a
``can_use_tool`` control request and waits on stdin for SKAZ's answer — the
user's Allow / Deny — before anything is sent; SKAZ allows with
``updatedInput`` = the exact approved input. Any other prompt or control
request is refused. A WebSearch result SKAZ never approved (or for another
query) fails the answer and turns web search off for Claude Code until restart.

N6 (decision 14, contract §8; ``claude_sessions.py``): Claude Code in SKAZ uses its own
``CLAUDE_CONFIG_DIR`` in SKAZ's data, with its own official sign-in (``claude auth login`` there, in
Terminal) — never the user's ``~/.claude``. A chat turn with a ``SessionPlan`` keeps one live session
per chat (no revert): ``start`` drops ``--no-session-persistence`` and passes ``--session-id <new
uuid>`` with the seed (``agents.history.seed_prompt``); ``continue`` passes ``--resume <id>`` with only
the new message. Both run in the session's own folder (``sessions/<id>``) with the instructions the
session started with. A ``continue`` that ends before Claude Code's ``system/init`` (2.1.281 prints
``No conversation found with session ID: <id>`` and a startup-failure result, then exits 1) fails with
``session_lost``: nothing reached the model. ``SessionBound`` follows ``system/init``; a
``system/compact_boundary`` message (the SDK's ``SDKCompactBoundaryMessage``, ``trigger`` manual|auto)
is ``Compacted``. ``delete_session`` is ``claude project purge <session folder> --yes``. Stateless runs
(``session is None``) are unchanged. :data:`OWN_FOLDER` ``False`` is the decision-14 fallback: the Mac's
own sign-in and stateless runs only.
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
import uuid
from collections import deque
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

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
from ..permissions.refusals import CLAUDE_MCP_TIMEOUT_MS
from ..processes import CHILDREN
from .claude_sessions import (
    NOTHING_TO_PURGE,
    PURGE_TIMEOUT_S,
    SWEEP_MIN_AGE_S,
    ClaudeFolder,
    is_session_id,
    new_session_id,
)
from .engine import (
    NO_SESSIONS,
    AgentEvent,
    AgentTurn,
    Compacted,
    Completed,
    EngineId,
    EngineStatus,
    Failed,
    FailureKind,
    ModelOption,
    SessionBound,
    SessionSupport,
    TextDelta,
    ToolCall,
    ToolResult,
)
from .history import seed_prompt
from .mcp_access import MCP_SERVER_NAME, MCP_TOOL_PREFIX, NO_TOOL_ACCESS, McpAccessProvider, tool_name
from .transcript import render_prompt
from .usage import claude_usage
from .web import CLAUDE_BLOCKED, WebLink, WebQuery, WebSearchGate, WebVerdict, clean_query, query_problem

log = logging.getLogger(__name__)

#: Oldest Claude Code whose flags SKAZ relies on: ``--permission-prompts`` needs
#: 2.1.259 (``--restricted`` 2.1.248, ``--mcp-config`` waiting for servers in -p
#: 2.1.221). Verified against 2.1.281. Newer releases are accepted.
MIN_CLAUDE_VERSION: Version = (2, 1, 259)
_VERSION = re.compile(r"^\s*(\d+)\.(\d+)\.(\d+)")
NAME = "Claude Code"
NOT_INSTALLED = "Claude Code is not installed."
UNUSABLE = f"This Claude Code version can't be used. Update to {dotted(MIN_CLAUDE_VERSION)} or newer."
MODEL_UNAVAILABLE = "This Claude model is not available for your account. Choose another model."
#: N6 decision 14 — the one switch. ``True``: Claude Code in SKAZ has its own folder
#: (``CLAUDE_CONFIG_DIR`` in SKAZ's data) with its own sign-in, and keeps a live session per chat.
#: ``False`` (fallback (в), if that sign-in doesn't survive a restart of SKAZ): this Mac's own Claude Code
#: sign-in (the user's ``~/.claude``) and stateless runs only — the behaviour before N6.
OWN_FOLDER = True
#: N6: a live session per chat; Claude Code can't drop turns in place (``--fork-session`` copies all).
CLAUDE_SESSIONS = SessionSupport(live=True, revert=False)
SIGN_IN = "Sign in to Claude Code in SKAZ."
NOT_SIGNED_IN = "Claude Code in SKAZ is not signed in. Sign in to Claude Code in SKAZ and try again."
#: Fallback (``OWN_FOLDER = False``): the Mac's own sign-in.
SHARED_SIGN_IN_REASON = "Sign in to Claude Code to use it in SKAZ."
SHARED_NOT_SIGNED_IN = "Claude Code is not signed in. Sign in to Claude Code and try again."
SIGN_IN_NAME = "claude-code-sign-in"
#: Fallback (``OWN_FOLDER = False``): Claude Code uses this Mac's own sign-in, so SKAZ never signs it out.
SHARED_SIGN_IN = (
    "Claude Code in SKAZ uses the Claude Code sign-in of this Mac, so SKAZ doesn't sign it out: that "
    "would sign Claude Code out in your other apps too. Sign out in Claude Code itself.")
SESSION_LOST = "Claude Code couldn't continue this chat's conversation."
STOPPED = "The answer was stopped."
_EFFORTS = ("low", "medium", "high", "xhigh", "max")
#: Documented model aliases (code.claude.com/docs/en/model-config#model-aliases).
CLAUDE_MODELS: tuple[ModelOption, ...] = (
    ModelOption("default", "Account default"),
    ModelOption("opus", "Opus (latest)", _EFFORTS),
    ModelOption("sonnet", "Sonnet (latest)", _EFFORTS),
    ModelOption("haiku", "Haiku (latest)"),
)
_LINE_LIMIT = 32 * 1024 * 1024
_STRUCTURED_TOOL = "StructuredOutput"
#: Claude Code's own web search tool (the only built-in tool a chat turn may get, W-2).
WEB_TOOL = "WebSearch"
#: Structured output is not a tool activity. Web search emits real events for the shared count;
#: its detail card, rather than this adapter, decides whether a separate chip is shown.
_NOT_CHIPS = (_STRUCTURED_TOOL,)
WEB_REFUSED = "Refused by SKAZ: only web searches the user approves are allowed here."
NOT_SUPPORTED = "Not supported by SKAZ."
_AUTH_ERRORS = {"authentication_failed", "oauth_org_not_allowed", "account_on_hold"}
_LIMIT_ERRORS = {"rate_limit", "billing_error"}
_MODEL_ERRORS = {"model_not_found"}


def parse_claude_version(text: str) -> Version | None:
    return parse_version(text, _VERSION)


def _retry_at(value: object) -> datetime | None:
    if not isinstance(value, int | float) or value <= 0:
        return None
    seconds = value / 1000 if value > 1e12 else value
    try:
        return datetime.fromtimestamp(seconds, UTC)
    except (OverflowError, OSError, ValueError):
        return None


def _text_of(content: object) -> str:
    """Text of a tool result: a string or a list of content blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(block.get("text", "")) for block in content
                         if isinstance(block, dict) and block.get("type") == "text")
    return ""


@dataclass
class _RunState:
    """What the stream said so far, for the terminal decision."""

    run_id: str
    buffer_text: bool
    streamed_messages: set[str] = field(default_factory=set)
    current_message: str | None = None
    buffered: list[str] = field(default_factory=list)
    api_error: str | None = None
    retry_error: str | None = None
    no_response: bool = False
    limit_reset: datetime | None = None
    limit_rejected: bool = False
    #: W-2: tool_use ids of WebSearch calls the agent made, and SKAZ's answer to each prompt
    #: (allowed, the approved query, SKAZ's request id).
    web_uses: set[str] = field(default_factory=set)
    web_asked: dict[str, tuple[bool, str, str | None]] = field(default_factory=dict)
    #: A WebSearch ran that SKAZ never approved (or for another query): the answer fails.
    web_breach: bool = False
    #: What a sign-in failure says (SKAZ's own Claude Code folder, or the Mac's sign-in in the fallback).
    not_signed_in: str = NOT_SIGNED_IN
    #: N6: the live session this run uses (``None`` = a stateless run) and whether it is a ``continue``.
    session_id: str | None = None
    resuming: bool = False
    #: Claude Code's ``system/init`` arrived: the turn was accepted (before it, nothing reached the model).
    initialized: bool = False
    #: ``compact_boundary`` messages already reported as ``Compacted`` (by uuid).
    compactions: set[str] = field(default_factory=set)


def classify_failure(state: _RunState, result: Mapping[str, Any] | None) -> tuple[FailureKind, str,
                                                                                   datetime | None]:
    """Plain-words failure from what Claude Code reported; provider text is never shown."""
    status = result.get("api_error_status") if result else None
    text = str(result.get("result") or "") if result else ""
    error = state.api_error
    if state.limit_rejected or error in _LIMIT_ERRORS or status == 429:
        when = state.limit_reset
        suffix = f" It resets at {when.strftime('%H:%M UTC')}." if when else ""
        return "limit", f"Your Claude usage limit is reached.{suffix}", when
    if error in _AUTH_ERRORS or status in (401, 403) or "/login" in text or "Not logged in" in text:
        return "auth", state.not_signed_in, None
    if error in _MODEL_ERRORS or status == 404:
        return "incompatible", MODEL_UNAVAILABLE, None
    if state.no_response or (state.retry_error == "unknown" and status is None and error is None):
        return "network", "Claude Code couldn't reach Anthropic. Check the internet connection.", None
    return "other", "Claude Code could not finish the answer.", None


@dataclass
class _ActiveRun:
    process: asyncio.subprocess.Process | None = None
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    #: N6: the session a ``start`` run opened, and whether Claude Code took the turn (``SessionBound``).
    new_session: str | None = None
    bound: bool = False


class ClaudeCodeEngine:
    def __init__(self, work_root: Path, *, mcp: McpAccessProvider | None = None,
                 locate_cli: LocateFn | None = None, launcher: TerminalLauncher | None = None,
                 interrupt_grace_s: float = 5.0, status_timeout_s: float = 15.0,
                 own_folder: bool | None = None) -> None:
        self.work_root = work_root
        self.mcp = mcp
        self._locate: LocateFn = locate_cli or locate
        self._launcher = launcher or TerminalLauncher(work_root / "launch")
        self._grace = interrupt_grace_s
        self._status_timeout = status_timeout_s
        self._runs: dict[str, _ActiveRun] = {}
        self._checked: dict[tuple[str, float], Version | None] = {}
        #: W-2: set when Claude Code searched the web without SKAZ's approval; web stays off until restart.
        self.web_blocked: str | None = None
        #: N6 decision 14: SKAZ's own Claude Code folder and sign-in (:data:`OWN_FOLDER`).
        self.own_folder = OWN_FOLDER if own_folder is None else own_folder
        self.folder = ClaudeFolder(work_root)

    @property
    def id(self) -> EngineId:
        return "claude_code"

    @property
    def sessions(self) -> SessionSupport:
        """N6: a live session per chat, only in SKAZ's own Claude Code folder (decision 14)."""
        return CLAUDE_SESSIONS if self.own_folder else NO_SESSIONS

    @property
    def config_dir(self) -> Path | None:
        """SKAZ's ``CLAUDE_CONFIG_DIR`` (``None`` in the fallback: the user's own ``~/.claude``)."""
        return self.folder.config_dir if self.own_folder else None

    # -- status ---------------------------------------------------------------

    def reset_cache(self) -> None:
        """Forget the remembered version (after an install or update)."""
        self._checked.clear()

    def _env(self, located: Located) -> dict[str, str]:
        env = base_env(located.path)
        if self.own_folder:
            env["CLAUDE_CONFIG_DIR"] = str(self.folder.prepare())
        return env

    async def _version(self, located: Located) -> Version | None:
        try:
            stamp = located.binary.stat().st_mtime
        except OSError:
            stamp = 0.0
        key = (str(located.binary), stamp)
        if key not in self._checked:
            out = await run_capture([str(located.binary), "--version"], env=self._env(located),
                                    timeout=self._status_timeout)
            self._checked[key] = parse_claude_version(out.stdout)
        return self._checked[key]

    async def status(self) -> EngineStatus:
        located = self._locate("claude")
        if located is None:
            return EngineStatus("claude_code", installed=False, reason=NOT_INSTALLED)
        try:
            version = await self._version(located)
        except (OSError, TimeoutError):
            return EngineStatus("claude_code", installed=True, incompatible=True,
                                reason="SKAZ couldn't start Claude Code. Reinstall it.")
        if version is None:
            return EngineStatus("claude_code", installed=True, incompatible=True,
                                reason="SKAZ couldn't read the Claude Code version. Reinstall it.")
        shown = dotted(version)
        if version < MIN_CLAUDE_VERSION:
            return EngineStatus("claude_code", installed=True, version=shown, incompatible=True,
                                reason=(f"Claude Code {shown} is outdated — version "
                                        f"{dotted(MIN_CLAUDE_VERSION)} or newer is required. Update it."))
        try:
            auth = await run_capture([str(located.binary), "auth", "status"], env=self._env(located),
                                     timeout=self._status_timeout)
        except (OSError, TimeoutError):
            return EngineStatus("claude_code", installed=True, version=shown,
                                reason="SKAZ couldn't check the Claude Code sign-in.")
        # Documented: JSON on stdout, exit code 0 when logged in, 1 when not.
        signed_in = auth.returncode == 0
        with contextlib.suppress(ValueError):
            payload = json.loads(auth.stdout)
            if isinstance(payload, dict) and isinstance(payload.get("loggedIn"), bool):
                signed_in = signed_in and payload["loggedIn"]
        sign_in = SIGN_IN if self.own_folder else SHARED_SIGN_IN_REASON
        return EngineStatus("claude_code", installed=True, version=shown, signed_in=signed_in,
                            reason=None if signed_in else sign_in)

    async def models(self) -> Sequence[ModelOption]:
        return CLAUDE_MODELS

    async def login(self) -> None:
        """Open Claude Code's own sign-in in Terminal — in SKAZ's ``CLAUDE_CONFIG_DIR`` (decision 14), so it
        is a sign-in of Claude Code in SKAZ only; SKAZ sees nothing of it."""
        located = self._locate("claude")
        if located is None:
            raise FileNotFoundError(NOT_INSTALLED)
        shown = {"PATH": located.path}
        if self.own_folder:
            shown["CLAUDE_CONFIG_DIR"] = str(self.folder.prepare())
        await self._launcher.open(SIGN_IN_NAME, "SKAZ opened the Claude Code sign-in.",
                                  [str(located.binary), "auth", "login"], shown, agent="Claude Code")

    def login_progress(self) -> Literal["waiting", "done", "failed"] | None:
        """The sign-in window SKAZ opened: still open, finished, or stopped (``None``: never opened)."""
        return terminal_progress(self._launcher, SIGN_IN_NAME)

    async def logout(self) -> None:
        """``claude auth logout`` in SKAZ's own folder: only Claude Code in SKAZ signs out (its keychain item
        is named after this folder); Claude Code elsewhere on this Mac stays signed in."""
        if not self.own_folder:
            raise ValueError(SHARED_SIGN_IN)
        located = self._locate("claude")
        if located is None:
            raise ValueError(NOT_INSTALLED)
        out = await run_capture([str(located.binary), "auth", "logout"], env=self._env(located),
                                cwd=self.folder.root, timeout=self._status_timeout)
        if out.returncode != 0:
            raise RuntimeError("claude auth logout failed")

    # -- live sessions (N6) ---------------------------------------------------

    async def delete_session(self, session_id: str) -> None:
        """Delete a chat's session from SKAZ's Claude Code folder only: Claude Code's own ``claude project
        purge <session folder> --yes`` (its transcripts, task list, debug log, file history, config entry),
        then SKAZ's copies. Raises when it couldn't (the caller retries); an id SKAZ never minted, or a
        session already gone, returns normally. Works in the fallback too: the files are SKAZ's either way."""
        if not is_session_id(session_id):
            return
        located = self._locate("claude")
        if located is not None:
            env = base_env(located.path)
            env["CLAUDE_CONFIG_DIR"] = str(self.folder.prepare())  # never the user's ~/.claude
            out = await run_capture(
                [str(located.binary), "project", "purge", str(self.folder.session_dir(session_id)), "--yes"],
                env=env, cwd=self.folder.root, timeout=PURGE_TIMEOUT_S)
            if out.returncode != 0 and NOTHING_TO_PURGE not in out.stdout + out.stderr:
                raise RuntimeError("claude project purge failed")
        # Without the CLI (uninstalled) SKAZ still removes the transcript files it can see.
        await asyncio.to_thread(self.folder.remove_local, session_id)

    def forget_session(self, session_id: str) -> None:
        """SKAZ gave the session up (its deletion kept failing): at least SKAZ's own files of it go — its
        working folder, its kept instructions and any transcript file SKAZ can see."""
        if is_session_id(session_id):
            with contextlib.suppress(OSError):
                self.folder.remove_local(session_id)

    async def sweep_sessions(self, known: Callable[[str], bool]) -> None:
        """App start: sessions with files here that no chat holds and no deletion waits for (SKAZ quit
        between their start and the record) are deleted like any other. A session touched within
        ``SWEEP_MIN_AGE_S``, or one a run is starting now, is left for the next start."""
        starting = {active.new_session for active in self._runs.values() if active.new_session}
        found = await asyncio.to_thread(self.folder.local_sessions, SWEEP_MIN_AGE_S)
        for session_id in found:
            if known(session_id) or session_id in starting:
                continue
            try:
                await self.delete_session(session_id)
            except Exception as error:  # best effort: the next start tries again
                log.info("Sweeping a Claude Code session failed (%s)", type(error).__name__)

    # -- run ------------------------------------------------------------------

    def command(self, binary: str, turn: AgentTurn, mcp_config: Path | None,
                system_prompt: Path, session_id: str | None = None) -> list[str]:
        """``system_prompt`` is a file, so instruction text never becomes a command-line word.

        ``session_id``: the live session of a chat turn (N6) — ``--session-id`` to start it, ``--resume``
        to continue it; without one the run leaves nothing behind (``--no-session-persistence``)."""
        web = turn.web is not None and self.web_blocked is None
        argv = [binary, "-p", "--output-format", "stream-json", "--input-format", "stream-json",
                "--verbose", "--include-partial-messages", "--restricted", "--tools", WEB_TOOL if web else "",
                "--strict-mcp-config", "--disable-slash-commands"]
        if turn.session is None or session_id is None:
            argv.append("--no-session-persistence")
        elif turn.session.mode == "start":
            argv += ["--session-id", session_id]
        else:
            argv += ["--resume", session_id]
        if web:
            # Every WebSearch call asks SKAZ over stdio before it runs (W-2); nothing else may ask.
            argv += ["--permission-mode", "default", "--permission-prompt-tool", "stdio"]
        else:
            argv += ["--permission-mode", "dontAsk", "--permission-prompts", "none"]
        argv += ["--system-prompt-file", str(system_prompt)]
        if turn.model and turn.model != "default":
            argv += ["--model", turn.model]
        if turn.effort:
            argv += ["--effort", turn.effort]
        if turn.response_schema is not None:
            argv += ["--json-schema", json.dumps(turn.response_schema, ensure_ascii=False)]
        if mcp_config is not None and turn.tools:
            argv += ["--mcp-config", str(mcp_config),
                     "--allowedTools", ",".join(f"{MCP_TOOL_PREFIX}{tool.name}" for tool in turn.tools)]
        else:
            argv += ["--disallowedTools", "mcp__*"]
        refuse_sudo(argv)
        return argv

    def run_env(self, located: Located) -> dict[str, str]:
        env = self._env(located)
        env.update({
            "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
            "CLAUDE_CODE_SKIP_PROMPT_HISTORY": "1", "CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK": "1",
            "MCP_TIMEOUT": "15000",
        })
        return env

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
        process = active.process
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.send_signal(signal.SIGINT)

    async def _events(self, turn: AgentTurn, active: _ActiveRun) -> AsyncIterator[AgentEvent]:
        run_id = turn.run_id
        run_dir = self.work_root / "runs" / uuid.uuid4().hex
        granted = False
        try:
            failure = await self._precheck(turn)
            if failure is not None:
                yield failure
                return
            located = self._locate("claude")
            assert located is not None  # checked by _precheck
            plan = turn.session if self.sessions.live else None
            session_id: str | None = None
            run_dir.mkdir(mode=0o700, parents=True)
            if plan is None:
                work = run_dir / "work"
                work.mkdir(mode=0o700)
                # Stateless (no plan, or the fallback without live sessions): as before N6.
                prompt = render_prompt(turn, include_instructions=False, include_schema=False)
                system_prompt = run_dir / "system-prompt.txt"
                system_prompt.write_text(turn.instructions, encoding="utf-8")
            elif plan.mode == "start":
                session_id = new_session_id()
                active.new_session = session_id
                work = self.folder.open_session(session_id)
                prompt = seed_prompt(turn.messages, turn.history_summary)  # the one seed serializer (N6)
                # The session keeps these instructions for every later turn (contract §2 rule 1).
                system_prompt = self.folder.save_prompt(session_id, turn.instructions)
            else:
                assert plan.session_id is not None  # SessionPlan checks it
                session_id = plan.session_id
                kept = self.folder.prompt(session_id)
                if kept is None:
                    # The instructions it started with are gone: resuming under today's would change the
                    # session's system prompt mid-session (contract §2 rule 1) — a new session instead.
                    yield Failed(run_id, "other", SESSION_LOST, unsent=True, session_lost=True)
                    return
                work = self.folder.open_session(session_id)
                prompt = seed_prompt(turn.messages[-1:])  # only the new message: the session holds the rest
                system_prompt = kept
            mcp_config: Path | None = None
            if turn.tools:
                assert self.mcp is not None
                access = self.mcp.grant(run_id, turn.tools)
                granted = True
                mcp_config = self._write_mcp_config(run_dir, access.url, access.token)
            argv = self.command(str(located.binary), turn, mcp_config, system_prompt, session_id)
            if active.cancel.is_set():
                yield Failed(run_id, "cancelled", STOPPED)
                return
            process = await asyncio.create_subprocess_exec(
                *argv, cwd=str(work), env=self.run_env(located), start_new_session=True,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, limit=_LINE_LIMIT,
            )
            CHILDREN.add(process, group=True)  # quitting SKAZ signals it first (knowledge.shutdown)
            active.process = process
            async for event in self._stream(turn, prompt, process, active, session_id):
                yield event
        except (OSError, ValueError) as error:
            message = "SKAZ couldn't start Claude Code." if isinstance(error, OSError) else str(error)
            # Before the process exists nothing was sent; after that, the request may have been.
            yield Failed(run_id, "other", message, unsent=active.process is None)
        finally:
            self._runs.pop(run_id, None)
            running = active.process
            if running is not None and running.returncode is None:
                kill_group(running.pid)
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(running.wait(), 5)
            CHILDREN.discard(running)
            if granted and self.mcp is not None:
                self.mcp.revoke(run_id)
            shutil.rmtree(run_dir, ignore_errors=True)
            if active.new_session is not None and not active.bound:
                # A new session Claude Code never took (it ended before ``system/init``): nothing to keep.
                with contextlib.suppress(OSError, ValueError):
                    self.folder.remove_local(active.new_session)

    async def _precheck(self, turn: AgentTurn) -> Failed | None:
        if turn.tools and self.mcp is None:
            return Failed(turn.run_id, "other", NO_TOOL_ACCESS, unsent=True, permanent=True)
        plan = turn.session
        foreign = plan is not None and plan.mode == "continue" and not is_session_id(plan.session_id or "")
        if plan is not None and self.sessions.live and (plan.mode == "revert" or foreign):
            # No revert in Claude Code (SKAZ never asks; SessionSupport.revert is False), and an id SKAZ never
            # minted can't be resumed: SKAZ starts a new seeded session instead.
            return Failed(turn.run_id, "other", SESSION_LOST, unsent=True, session_lost=True)
        located = self._locate("claude")
        if located is None:
            return Failed(turn.run_id, "incompatible", NOT_INSTALLED)
        try:
            version = await self._version(located)
        except (OSError, TimeoutError):
            version = None
        if version is None or version < MIN_CLAUDE_VERSION:
            return Failed(turn.run_id, "incompatible", UNUSABLE)
        return None

    @staticmethod
    def _write_mcp_config(run_dir: Path, url: str, token: str) -> Path:
        """The token goes to a 0600 file in the run folder, never onto the command line."""
        # ``timeout``: a SKAZ wiki tool waits for the user (P3) — Claude Code's per-call and idle
        # limits for this one server, raised to its clamp (``permissions/refusals.py``).
        config = {"mcpServers": {MCP_SERVER_NAME: {"type": "http", "url": url,
                                                    "headers": {"Authorization": f"Bearer {token}"},
                                                    "timeout": CLAUDE_MCP_TIMEOUT_MS}}}
        path = run_dir / "mcp.json"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(config, handle)
        return path

    async def _stream(self, turn: AgentTurn, prompt: str, process: asyncio.subprocess.Process,
                      active: _ActiveRun, session_id: str | None = None) -> AsyncIterator[AgentEvent]:
        run_id = turn.run_id
        assert process.stdin is not None and process.stdout is not None and process.stderr is not None
        message = {"type": "user", "message": {"role": "user", "content": prompt},
                   "parent_tool_use_id": None}
        gate = turn.web if self.web_blocked is None else None
        try:
            process.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode())
            await process.stdin.drain()
            if gate is None:
                process.stdin.close()
        except (BrokenPipeError, ConnectionResetError):
            pass
        stderr_tail: deque[str] = deque(maxlen=40)
        stderr_task = asyncio.create_task(_drain(process.stderr, stderr_tail))
        killer = asyncio.create_task(self._stop_after_cancel(process, active))
        state = _RunState(run_id, buffer_text=turn.response_schema is not None,
                          not_signed_in=NOT_SIGNED_IN if self.own_folder else SHARED_NOT_SIGNED_IN,
                          session_id=session_id,
                          resuming=session_id is not None and turn.session is not None
                          and turn.session.mode != "start")
        try:
            while True:
                raw = await process.stdout.readline()
                if not raw:
                    break
                try:
                    item = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "control_request":
                    await self._control(process, item, gate, state, active)
                    continue
                if item.get("type") == "result":
                    _close_stdin(process)
                    if self._lost(state, active):
                        # 2.1.281: a session it can't resume ends with a startup-failure result before
                        # ``system/init`` ("No conversation found with session ID: …"): nothing was sent.
                        yield Failed(run_id, "other", SESSION_LOST, unsent=True, session_lost=True)
                        return
                    for event in self._finish(state, item, active):
                        yield event
                    return
                await self._web_result(item, gate, state)
                if state.web_breach:
                    # Fail closed: Claude Code searched without SKAZ's approval (or for another query).
                    self.web_blocked = CLAUDE_BLOCKED
                    log.warning("Claude Code ran a web search SKAZ didn't approve; web search is off")
                    yield Failed(run_id, "other", CLAUDE_BLOCKED)
                    return
                for event in self._translate(state, item):
                    if isinstance(event, SessionBound):
                        active.bound = True
                    yield event
            await process.wait()
            if active.cancel.is_set():
                yield Failed(run_id, "cancelled", STOPPED)
            elif any("unknown option" in line or "error: option" in line for line in stderr_tail):
                yield Failed(run_id, "incompatible", UNUSABLE)
            elif self._lost(state, active):
                yield Failed(run_id, "other", SESSION_LOST, unsent=True, session_lost=True)
            else:
                kind, text, when = classify_failure(state, None)
                shown = text if kind != "other" else "Claude Code stopped unexpectedly."
                yield Failed(run_id, kind, shown, when)
        finally:
            killer.cancel()
            stderr_task.cancel()
            await asyncio.gather(killer, stderr_task, return_exceptions=True)

    @staticmethod
    def _lost(state: _RunState, active: _ActiveRun) -> bool:
        """A ``continue`` that ended before Claude Code took the turn (no ``system/init``): the session
        can't be resumed (not found, held by another process, unreadable) and nothing reached the model."""
        return state.resuming and not state.initialized and not active.cancel.is_set()

    # -- W-2 web search ----------------------------------------------------------------

    async def _control(self, process: asyncio.subprocess.Process, item: Mapping[str, Any],
                       gate: WebSearchGate | None, state: _RunState, active: _ActiveRun) -> None:
        """Answer one control request: a WebSearch prompt goes to the user (through ``gate``),
        every other prompt is denied and every other request refused."""
        request_id = item.get("request_id")
        request = item.get("request")
        body: Mapping[str, Any] = request if isinstance(request, Mapping) else {}
        if body.get("subtype") != "can_use_tool":
            await _answer(process, {"subtype": "error", "request_id": request_id, "error": NOT_SUPPORTED})
            return
        decision = await self._decide(body, gate, state, active)
        sent = await _answer(process, {"subtype": "success", "request_id": request_id, "response": decision})
        asked = state.web_asked.get(str(body.get("tool_use_id") or ""))
        if sent and decision.get("behavior") == "allow" and gate is not None and asked and asked[2]:
            await gate.started(asked[2])

    async def _decide(self, body: Mapping[str, Any], gate: WebSearchGate | None, state: _RunState,
                      active: _ActiveRun) -> dict[str, Any]:
        tool = body.get("tool_name")
        raw = body.get("input")
        given: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}
        use_id = str(body.get("tool_use_id") or "")
        # Machine-added site operators may exceed the raw 400-character query cap. Only the
        # clean search runner owns this exact preapproval; ordinary chat gates have no bypass.
        preapproved = getattr(gate, "preapproved_query", None)
        raw_query = given.get("query")
        query = (preapproved if isinstance(preapproved, str) and raw_query == preapproved
                 else clean_query(raw_query))
        domains = {key: tuple(str(d) for d in given.get(key) or () if isinstance(d, str))
                   for key in ("allowed_domains", "blocked_domains")}
        unknown = set(given) - {"query", "allowed_domains", "blocked_domains"}
        refused = tool != WEB_TOOL or gate is None or query is None or unknown or not use_id
        if refused or gate is None or query is None or active.cancel.is_set():
            if use_id and tool == WEB_TOOL:
                state.web_asked[use_id] = (False, str(given.get("query") or ""), None)
            log.info("Refused a %s prompt of Claude Code", str(tool)[:40])
            reason = query_problem(given.get("query")) if tool == WEB_TOOL and not unknown else None
            return {"behavior": "deny", "message": reason or WEB_REFUSED}
        verdict: WebVerdict = await gate.approve(WebQuery(use_id, query, domains["allowed_domains"],
                                                          domains["blocked_domains"]))
        allowed = verdict.allowed and not active.cancel.is_set()
        state.web_asked[use_id] = (allowed, query, verdict.search_id)
        if not allowed:
            return {"behavior": "deny", "message": verdict.message or WEB_REFUSED}
        # Exactly what the user saw — nothing the model might add later. N7: SKAZ's domain filters (the
        # user's Never / «only these sites») replace the agent's own when the gate gives them.
        if verdict.allowed_domains is not None or verdict.blocked_domains is not None:
            domains = {"allowed_domains": verdict.allowed_domains or (),
                       "blocked_domains": verdict.blocked_domains or ()}
        exact: dict[str, Any] = {"query": query}
        exact.update({key: list(value) for key, value in domains.items() if value})
        return {"behavior": "allow", "updatedInput": exact}

    async def _web_result(self, item: Mapping[str, Any], gate: WebSearchGate | None,
                          state: _RunState) -> None:
        """Note WebSearch calls; check each WebSearch result against SKAZ's approval; keep its links."""
        kind = item.get("type")
        content = (item.get("message") or {}).get("content")
        blocks = [block for block in content if isinstance(block, dict)] if isinstance(content, list) else []
        if kind == "assistant":
            state.web_uses.update(str(block.get("id") or "") for block in blocks
                                  if block.get("type") == "tool_use" and block.get("name") == WEB_TOOL)
            return
        if kind != "user":
            return
        for block in blocks:
            use_id = str(block.get("tool_use_id") or "")
            if block.get("type") != "tool_result" or use_id not in state.web_uses:
                continue
            asked = state.web_asked.get(use_id)
            output = item.get("tool_use_result")
            if asked is None:
                state.web_breach = True
                return
            allowed, query, search_id = asked
            if not isinstance(output, dict):
                if allowed and gate is not None and search_id and block.get("is_error"):
                    await gate.results(search_id, (), is_error=True)
                continue  # no result links; a denial is not a completed search
            if not allowed or output.get("query") != query:
                state.web_breach = True
                return
            if gate is not None and search_id:
                await gate.results(search_id, _links(output), is_error=bool(block.get("is_error")))

    async def _stop_after_cancel(self, process: asyncio.subprocess.Process, active: _ActiveRun) -> None:
        await active.cancel.wait()
        try:
            await asyncio.wait_for(process.wait(), self._grace)
        except TimeoutError:
            kill_group(process.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(process.wait(), 2)
            except TimeoutError:
                kill_group(process.pid)

    def _translate(self, state: _RunState, item: Mapping[str, Any]) -> list[AgentEvent]:
        kind = item.get("type")
        run_id = state.run_id
        if item.get("parent_tool_use_id") is not None:
            return []  # subagent traffic; built-in agents are disabled, ignore defensively
        events: list[AgentEvent] = []
        if kind == "stream_event":
            event = item.get("event") or {}
            if event.get("type") == "message_start":
                state.current_message = str((event.get("message") or {}).get("id") or "")
            delta = event.get("delta") or {}
            if event.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                text = str(delta.get("text") or "")
                if state.current_message:
                    state.streamed_messages.add(state.current_message)
                if text:
                    events.extend(self._text(state, text))
        elif kind == "assistant":
            body = item.get("message") or {}
            if isinstance(item.get("error"), str):
                state.api_error = item["error"]
                return events  # synthetic error text is CLI output, not an answer
            message_id = str(body.get("id") or "")
            for block in body.get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and message_id not in state.streamed_messages:
                    events.extend(self._text(state, str(block.get("text") or "")))
                elif block.get("type") == "tool_use" and block.get("name") not in _NOT_CHIPS:
                    raw_input = block.get("input")
                    arguments: dict[str, Any] = raw_input if isinstance(raw_input, dict) else {}
                    events.append(ToolCall(run_id, str(block.get("id") or ""),
                                           tool_name(str(block.get("name") or "")), arguments))
        elif kind == "user":
            content = (item.get("message") or {}).get("content")
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    events.append(ToolResult(run_id, str(block.get("tool_use_id") or ""),
                                             _text_of(block.get("content")), bool(block.get("is_error"))))
        elif kind == "rate_limit_event":
            info = item.get("rate_limit_info") or {}
            if info.get("status") == "rejected":
                state.limit_rejected = True
                state.limit_reset = _retry_at(info.get("resetsAt"))
        elif kind == "system" and item.get("subtype") == "api_retry":
            state.retry_error = str(item.get("error") or "")
            state.no_response = state.no_response or (item.get("error_status") is None
                                                      and "no_response" in item)
        elif kind == "system" and item.get("subtype") == "init" and not state.initialized:
            state.initialized = True
            if state.session_id is not None:
                reported = item.get("session_id")
                if isinstance(reported, str) and reported and reported != state.session_id:
                    # Not expected (``--session-id`` / ``--resume`` keep the id); the session folder and
                    # its deletion are keyed by SKAZ's id, so that stays the one SKAZ records.
                    log.warning("Claude Code reported session %s for SKAZ's session %s", reported[:40],
                                state.session_id)
                # No revert in Claude Code: the run id is this turn's unique id.
                events.append(SessionBound(run_id, state.session_id, run_id))
        elif kind == "system" and item.get("subtype") == "compact_boundary" and state.session_id is not None:
            # Claude Code compacted the session's conversation (auto or /compact): once per boundary.
            marker = str(item.get("uuid") or f"#{len(state.compactions)}")
            if marker not in state.compactions:
                state.compactions.add(marker)
                events.append(Compacted(run_id))
        return events

    def _text(self, state: _RunState, text: str) -> list[AgentEvent]:
        if state.buffer_text:
            state.buffered.append(text)
            return []
        return [TextDelta(state.run_id, text)]

    def _finish(self, state: _RunState, result: Mapping[str, Any], active: _ActiveRun) -> list[AgentEvent]:
        run_id = state.run_id
        if active.cancel.is_set():
            return [Failed(run_id, "cancelled", "The answer was stopped.")]
        if result.get("is_error") or result.get("subtype") != "success" or state.api_error:
            kind, message, when = classify_failure(state, result)
            return [Failed(run_id, kind, message, when)]
        events: list[AgentEvent] = []
        if state.buffer_text:
            structured = result.get("structured_output")
            text = (json.dumps(structured, ensure_ascii=False) if structured is not None
                    else "".join(state.buffered) or str(result.get("result") or ""))
            if text:
                events.append(TextDelta(run_id, text))
        raw_usage = result.get("usage")
        usage: dict[str, Any] = raw_usage if isinstance(raw_usage, dict) else {}
        events.append(Completed(run_id, claude_usage(usage)))
        return events


async def _drain(stream: asyncio.StreamReader, tail: deque[str]) -> None:
    """Keep the last stderr lines for classification only; they are never logged or shown."""
    while True:
        line = await stream.readline()
        if not line:
            return
        tail.append(line.decode(errors="replace").strip())


async def _answer(process: asyncio.subprocess.Process, response: Mapping[str, Any]) -> bool:
    """Report whether the control response reached stdin; a closed pipe is not an execution start."""
    if process.stdin is None or process.stdin.is_closing():
        return False
    line = json.dumps({"type": "control_response", "response": response}, ensure_ascii=False) + "\n"
    with contextlib.suppress(BrokenPipeError, ConnectionResetError, RuntimeError):
        process.stdin.write(line.encode())
        await process.stdin.drain()
        return True
    return False


def _close_stdin(process: asyncio.subprocess.Process) -> None:
    if process.stdin is not None and not process.stdin.is_closing():
        with contextlib.suppress(Exception):
            process.stdin.close()


def _links(output: Mapping[str, Any]) -> list[WebLink]:
    """Links of a WebSearch ``tool_use_result``: ``results`` holds ``{tool_use_id, content: [{title,
    url}]}`` entries and plain text commentary (2.1.281 ``dn``)."""
    links: list[WebLink] = []
    for entry in output.get("results") or []:
        hits = entry.get("content") if isinstance(entry, dict) else None
        for hit in hits if isinstance(hits, list) else []:
            if isinstance(hit, dict) and isinstance(hit.get("url"), str):
                links.append(WebLink(str(hit.get("title") or ""), hit["url"]))
    return links
