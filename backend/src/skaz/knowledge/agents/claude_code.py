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
* ``--disable-slash-commands``, ``--no-session-persistence`` and
  ``CLAUDE_CODE_DISABLE_CLAUDE_MDS``/``..._AUTO_MEMORY``: no skills, memory or
  transcripts; ``CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK``: no automatic model
  switch (no silent substitution).
* ``--system-prompt-file``: SKAZ instructions replace the coding-assistant
  prompt; a file, so instruction text is never parsed as a flag.
* Interrupt: SIGINT ends the turn (headless docs: "To end the turn instead,
  send SIGINT"), then the process is stopped.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shutil
import signal
import uuid
from collections import deque
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

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
from .mcp_access import MCP_SERVER_NAME, MCP_TOOL_PREFIX, NO_TOOL_ACCESS, McpAccessProvider, tool_name
from .transcript import render_prompt

#: Oldest Claude Code whose flags SKAZ relies on: ``--permission-prompts`` needs
#: 2.1.259 (``--restricted`` 2.1.248, ``--mcp-config`` waiting for servers in -p
#: 2.1.221). Verified against 2.1.281. Newer releases are accepted.
MIN_CLAUDE_VERSION: Version = (2, 1, 259)
_VERSION = re.compile(r"^\s*(\d+)\.(\d+)\.(\d+)")
NAME = "Claude Code"
NOT_INSTALLED = "Claude Code is not installed."
UNUSABLE = f"This Claude Code version can't be used. Update to {dotted(MIN_CLAUDE_VERSION)} or newer."
MODEL_UNAVAILABLE = "This Claude model is not available for your account. Choose another model."
SIGN_IN = "Sign in to Claude Code to use it in SKAZ."
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
        return "auth", "Claude Code is not signed in. Sign in to Claude Code and try again.", None
    if error in _MODEL_ERRORS or status == 404:
        return "incompatible", MODEL_UNAVAILABLE, None
    if state.no_response or (state.retry_error == "unknown" and status is None and error is None):
        return "network", "Claude Code couldn't reach Anthropic. Check the internet connection.", None
    return "other", "Claude Code could not finish the answer.", None


@dataclass
class _ActiveRun:
    process: asyncio.subprocess.Process | None = None
    cancel: asyncio.Event = field(default_factory=asyncio.Event)


class ClaudeCodeEngine:
    def __init__(self, work_root: Path, *, mcp: McpAccessProvider | None = None,
                 locate_cli: LocateFn | None = None, launcher: TerminalLauncher | None = None,
                 interrupt_grace_s: float = 5.0, status_timeout_s: float = 15.0) -> None:
        self.work_root = work_root
        self.mcp = mcp
        self._locate: LocateFn = locate_cli or locate
        self._launcher = launcher or TerminalLauncher(work_root / "launch")
        self._grace = interrupt_grace_s
        self._status_timeout = status_timeout_s
        self._runs: dict[str, _ActiveRun] = {}
        self._checked: dict[tuple[str, float], Version | None] = {}

    @property
    def id(self) -> EngineId:
        return "claude_code"

    # -- status ---------------------------------------------------------------

    def reset_cache(self) -> None:
        """Forget the remembered version (after an install or update)."""
        self._checked.clear()

    def _env(self, located: Located) -> dict[str, str]:
        return base_env(located.path)

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
        return EngineStatus("claude_code", installed=True, version=shown, signed_in=signed_in,
                            reason=None if signed_in else SIGN_IN)

    async def models(self) -> Sequence[ModelOption]:
        return CLAUDE_MODELS

    async def login(self) -> None:
        """Open Claude Code's own sign-in in Terminal; SKAZ sees nothing of it."""
        located = self._locate("claude")
        if located is None:
            raise FileNotFoundError(NOT_INSTALLED)
        await self._launcher.open("claude-code-sign-in", "SKAZ opened the Claude Code sign-in.",
                                  [str(located.binary), "auth", "login"], {"PATH": located.path})

    # -- run ------------------------------------------------------------------

    def command(self, binary: str, turn: AgentTurn, mcp_config: Path | None,
                system_prompt: Path) -> list[str]:
        """``system_prompt`` is a file, so instruction text never becomes a command-line word."""
        argv = [binary, "-p", "--output-format", "stream-json", "--input-format", "stream-json",
                "--verbose", "--include-partial-messages", "--restricted", "--tools", "",
                "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
                "--permission-mode", "dontAsk", "--permission-prompts", "none",
                "--system-prompt-file", str(system_prompt)]
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
            work = run_dir / "work"
            work.mkdir(mode=0o700, parents=True)
            mcp_config: Path | None = None
            if turn.tools:
                assert self.mcp is not None
                access = self.mcp.grant(run_id, turn.tools)
                granted = True
                mcp_config = self._write_mcp_config(run_dir, access.url, access.token)
            prompt = render_prompt(turn, include_instructions=False, include_schema=False)
            system_prompt = run_dir / "system-prompt.txt"
            system_prompt.write_text(turn.instructions, encoding="utf-8")
            argv = self.command(str(located.binary), turn, mcp_config, system_prompt)
            if active.cancel.is_set():
                yield Failed(run_id, "cancelled", "The answer was stopped.")
                return
            process = await asyncio.create_subprocess_exec(
                *argv, cwd=str(work), env=self.run_env(located), start_new_session=True,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, limit=_LINE_LIMIT,
            )
            CHILDREN.add(process, group=True)  # quitting SKAZ signals it first (knowledge.shutdown)
            active.process = process
            async for event in self._stream(turn, prompt, process, active):
                yield event
        except (OSError, ValueError) as error:
            message = "SKAZ couldn't start Claude Code." if isinstance(error, OSError) else str(error)
            yield Failed(run_id, "other", message)
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

    async def _precheck(self, turn: AgentTurn) -> Failed | None:
        if turn.tools and self.mcp is None:
            return Failed(turn.run_id, "other", NO_TOOL_ACCESS)
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
        config = {"mcpServers": {MCP_SERVER_NAME: {"type": "http", "url": url,
                                                    "headers": {"Authorization": f"Bearer {token}"}}}}
        path = run_dir / "mcp.json"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(config, handle)
        return path

    async def _stream(self, turn: AgentTurn, prompt: str, process: asyncio.subprocess.Process,
                      active: _ActiveRun) -> AsyncIterator[AgentEvent]:
        run_id = turn.run_id
        assert process.stdin is not None and process.stdout is not None and process.stderr is not None
        message = {"type": "user", "message": {"role": "user", "content": prompt},
                   "parent_tool_use_id": None}
        try:
            process.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode())
            await process.stdin.drain()
            process.stdin.close()
        except (BrokenPipeError, ConnectionResetError):
            pass
        stderr_tail: deque[str] = deque(maxlen=40)
        stderr_task = asyncio.create_task(_drain(process.stderr, stderr_tail))
        killer = asyncio.create_task(self._stop_after_cancel(process, active))
        state = _RunState(run_id, buffer_text=turn.response_schema is not None)
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
                if item.get("type") == "result":
                    for event in self._finish(state, item, active):
                        yield event
                    return
                for event in self._translate(state, item):
                    yield event
            await process.wait()
            if active.cancel.is_set():
                yield Failed(run_id, "cancelled", "The answer was stopped.")
            elif any("unknown option" in line or "error: option" in line for line in stderr_tail):
                yield Failed(run_id, "incompatible", UNUSABLE)
            else:
                kind, text, when = classify_failure(state, None)
                shown = text if kind != "other" else "Claude Code stopped unexpectedly."
                yield Failed(run_id, kind, shown, when)
        finally:
            killer.cancel()
            stderr_task.cancel()
            await asyncio.gather(killer, stderr_task, return_exceptions=True)

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
                elif block.get("type") == "tool_use" and block.get("name") != _STRUCTURED_TOOL:
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
        events.append(Completed(run_id, Usage(usage.get("input_tokens"), usage.get("output_tokens"))))
        return events


async def _drain(stream: asyncio.StreamReader, tail: deque[str]) -> None:
    """Keep the last stderr lines for classification only; they are never logged or shown."""
    while True:
        line = await stream.readline()
        if not line:
            return
        tail.append(line.decode(errors="replace").strip())
