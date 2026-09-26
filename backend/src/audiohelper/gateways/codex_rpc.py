"""Bounded stdio transport for Codex App Server, not an agent or auth policy.

The caller owns the executable, isolated cwd/environment and OS sandbox. This
transport never inherits the parent environment, retries a request, or approves
unregistered server actions. Provider payloads and stderr must not enter errors.
"""
from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Callable, Mapping
from contextlib import suppress
from pathlib import Path
from types import TracebackType
from typing import Any

from .codex_tools import CodexTools, tool_failure


class CodexRpcError(RuntimeError):
    """Sanitized transport/protocol failure; no provider message attached."""


class CodexRpc:
    """One single-use process connection; context exit reaps its direct child."""

    def __init__(
        self, command: tuple[str, ...], *, cwd: Path, env: Mapping[str, str],
        timeout: float = 15, max_message_bytes: int = 1024 * 1024,
        max_events: int = 128, tools: CodexTools | None = None,
    ) -> None:
        if (
            not command or not math.isfinite(timeout) or timeout <= 0
            or max_message_bytes < 1 or max_events < 1
        ):
            raise ValueError("Invalid Codex transport limits")
        self._tools = tools
        self._tool_task: asyncio.Task[None] | None = None
        self._command = command
        self._cwd = cwd
        self._env = dict(env)
        self._timeout = timeout
        self._max_message_bytes = max_message_bytes
        self._events: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=max_events)
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._on_result: dict[int, Callable[[Any], None]] = {}
        self._process: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task[None] | None = None
        self._write_lock = asyncio.Lock()
        self._ended = asyncio.Event()
        self._started = False
        self._next_id = 0
        self._failure: str | None = None

    @property
    def closed(self) -> bool:
        return self._ended.is_set()

    async def __aenter__(self) -> CodexRpc:
        if self._started:
            raise CodexRpcError("Codex connection cannot be reused")
        self._started = True
        try:
            self._process = await asyncio.create_subprocess_exec(
                *self._command, cwd=self._cwd, env=self._env,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, limit=self._max_message_bytes,
            )
            self._reader = asyncio.create_task(self._receive())
            await self.request("initialize", {
                "clientInfo": {"name": "skaz", "version": "0.1.0"},
                "capabilities": {"experimentalApi": True},
            })
            await self._send({"method": "initialized", "params": {}})
            return self
        except OSError:
            await self.close()
            raise CodexRpcError("Codex process could not start") from None
        except BaseException:
            await self.close()
            raise

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.close()

    async def _send(self, message: dict[str, Any]) -> None:
        if self.closed or self._process is None or self._process.stdin is None:
            raise CodexRpcError(self._failure or "Codex connection is closed")
        try:
            payload = (json.dumps(message, allow_nan=False) + "\n").encode()
        except (TypeError, ValueError):
            raise CodexRpcError("Invalid outgoing Codex message") from None
        if len(payload) > self._max_message_bytes:
            raise CodexRpcError("Outgoing Codex message exceeds limit")
        async with self._write_lock:
            self._process.stdin.write(payload)
            await self._process.stdin.drain()

    def bind_tools(self, tools: CodexTools) -> None:
        if self.closed or (self._tool_task is not None and not self._tool_task.done()):
            raise CodexRpcError("Cannot replace active Codex tool scope")
        if self._tools is not None:
            self._tools.revoke()
        self._tools = tools

    async def request(
        self, method: str, params: dict[str, Any], *,
        on_result: Callable[[Any], None] | None = None,
    ) -> Any:
        self._next_id += 1
        identity = self._next_id
        future = asyncio.get_running_loop().create_future()
        self._pending[identity] = future
        if on_result is not None:
            self._on_result[identity] = on_result
        try:
            async with asyncio.timeout(self._timeout):
                await self._send({"id": identity, "method": method, "params": params})
                return await future
        except TimeoutError:
            await self.close()
            raise CodexRpcError("Codex request timed out; not retried") from None
        except (BrokenPipeError, ConnectionResetError):
            await self.close()
            raise CodexRpcError("Codex process disconnected") from None
        except asyncio.CancelledError:
            if not self.closed:
                await self.close()
            raise
        finally:
            self._pending.pop(identity, None)
            self._on_result.pop(identity, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()

    def _end(self, reason: str) -> None:
        if self.closed:
            return
        self._failure = reason
        self._ended.set()
        for future in self._pending.values():
            if not future.done():
                future.set_exception(CodexRpcError(reason))

    async def _receive(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        try:
            while line := await self._process.stdout.readline():
                if len(line) > self._max_message_bytes or not line.endswith(b"\n"):
                    raise CodexRpcError("Invalid Codex frame")
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise CodexRpcError("Invalid Codex message")
                if "method" in message:
                    if not isinstance(message["method"], str):
                        raise CodexRpcError("Invalid Codex method")
                    if "params" in message and not isinstance(message["params"], dict):
                        raise CodexRpcError("Invalid Codex parameters")
                    if "id" in message:
                        if type(message["id"]) not in (int, str):
                            raise CodexRpcError("Invalid Codex server request ID")
                        if message["method"] == "item/tool/call" and self._tools is not None:
                            if self._tool_task is not None and not self._tool_task.done():
                                await self._send({"id": message["id"], "result": tool_failure()})
                            else:
                                self._tool_task = asyncio.create_task(self._run_tool(message))
                        else:
                            await self._send({"id": message["id"], "error": {
                                "code": -32601, "message": "Action not permitted",
                            }})
                    else:
                        if message["method"] == "turn/completed" and self._tools is not None:
                            params = message.get("params", {})
                            turn = params.get("turn", {})
                            if isinstance(turn, dict) and self._tools.end_turn(
                                params.get("threadId"), turn.get("id"),
                            ) and self._tool_task is not None:
                                self._tool_task.cancel()
                        self._events.put_nowait(message)
                else:
                    identity = message.get("id")
                    if type(identity) is not int or identity not in self._pending:
                        raise CodexRpcError("Unexpected Codex response")
                    if ("result" in message) == ("error" in message):
                        raise CodexRpcError("Invalid Codex response")
                    future = self._pending[identity]
                    if future.done():
                        raise CodexRpcError("Duplicate Codex response")
                    if "error" in message:
                        future.set_exception(CodexRpcError("Codex request rejected"))
                    else:
                        # Bind scope before reading the next buffered server call.
                        callback = self._on_result.get(identity)
                        if callback is not None:
                            callback(message["result"])
                        future.set_result(message["result"])
            self._end("Codex process disconnected")
        except asyncio.CancelledError:
            raise
        except Exception:
            self._end("Codex protocol failure")
        finally:
            self._end("Codex connection closed")
            if self._tools is not None:
                self._tools.revoke()
            if self._tool_task is not None:
                self._tool_task.cancel()

    async def _run_tool(self, message: dict[str, Any]) -> None:
        assert self._tools is not None
        try:
            result = await self._tools.invoke(message.get("params", {}))
            async with asyncio.timeout(self._timeout):
                await self._send({"id": message["id"], "result": result})
        except asyncio.CancelledError:
            raise
        except Exception:
            self._end("Codex tool response failed")

    async def next_event(self) -> dict[str, Any]:
        if not self._events.empty():
            return self._events.get_nowait()
        if self.closed:
            raise CodexRpcError(self._failure or "Codex connection closed")
        event = asyncio.create_task(self._events.get())
        ended = asyncio.create_task(self._ended.wait())
        try:
            await asyncio.wait({event, ended}, return_when=asyncio.FIRST_COMPLETED)
            if event.done():
                return event.result()
            raise CodexRpcError(self._failure or "Codex connection closed")
        finally:
            for task in (event, ended):
                task.cancel()
            await asyncio.gather(event, ended, return_exceptions=True)

    async def close(self) -> None:
        self._end("Codex connection closed")
        if self._tools is not None:
            self._tools.revoke()
        if self._tool_task is not None and self._tool_task is not asyncio.current_task():
            self._tool_task.cancel()
            await asyncio.gather(self._tool_task, return_exceptions=True)
        if self._reader is not None:
            self._reader.cancel()
            await asyncio.gather(self._reader, return_exceptions=True)
        if self._process is not None and self._process.returncode is None:
            with suppress(ProcessLookupError):
                self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=2)
            except TimeoutError:
                with suppress(ProcessLookupError):
                    self._process.kill()
                await self._process.wait()
