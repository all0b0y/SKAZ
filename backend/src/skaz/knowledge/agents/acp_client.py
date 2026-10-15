"""A small client for the Agent Client Protocol (JSON-RPC 2.0, one JSON object per line on stdio).

Only what SKAZ needs as an ACP *client*: requests with ids, notifications in
order, and answering the agent's own requests (permission prompts, file or
terminal access — SKAZ declares neither capability and refuses them).
Spec: agentclientprotocol.com (protocol version 1).
"""
from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

PROTOCOL_VERSION = 1
#: Answer to the agent's requests: result object, or raise ``AcpError``.
RequestHandler = Callable[[str, Mapping[str, Any]], Awaitable[dict[str, Any]]]
METHOD_NOT_FOUND = -32601


class AcpError(Exception):
    def __init__(self, code: int, message: str, data: object = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def details(self) -> str:
        """The error text the agent attached (``data.details`` in Hermes), for classification only."""
        if isinstance(self.data, dict) and isinstance(self.data.get("details"), str):
            return f"{self.message} {self.data['details']}"
        return self.message if self.data is None else f"{self.message} {self.data}"


class AcpClosed(Exception):
    """The agent process closed its output."""


class AcpConnection:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, *,
                 on_request: RequestHandler) -> None:
        self._reader = reader
        self._writer = writer
        self._on_request = on_request
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        #: Notifications in arrival order: ``(method, params)``; ``None`` marks the end of the stream.
        self.notifications: asyncio.Queue[tuple[str, dict[str, Any]] | None] = asyncio.Queue()
        self._tasks: set[asyncio.Task[None]] = set()
        self._reader_task = asyncio.create_task(self._read())

    async def request(self, method: str, params: Mapping[str, Any], *, timeout: float | None = None,
                      ) -> dict[str, Any]:
        request_id = next(self._ids)
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)})
            async with asyncio.timeout(timeout):
                return await future
        finally:
            self._pending.pop(request_id, None)

    async def notify(self, method: str, params: Mapping[str, Any]) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": dict(params)})

    async def _send(self, message: Mapping[str, Any]) -> None:
        if self._writer.is_closing():
            raise AcpClosed("The agent connection is closed.")
        self._writer.write((json.dumps(message, ensure_ascii=False) + "\n").encode())
        await self._writer.drain()

    async def _read(self) -> None:
        try:
            while True:
                raw = await self._reader.readline()
                if not raw:
                    return
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue  # stdout is protocol-only; ignore stray lines rather than guess
                if isinstance(message, dict):
                    self._dispatch(message)
        finally:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(AcpClosed("The agent stopped."))
            self.notifications.put_nowait(None)

    def _dispatch(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        raw_params = message.get("params")
        params: dict[str, Any] = raw_params if isinstance(raw_params, dict) else {}
        if isinstance(method, str) and "id" in message:
            task = asyncio.create_task(self._answer(message["id"], method, params))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        elif isinstance(method, str):
            self.notifications.put_nowait((method, params))
        elif isinstance(message.get("id"), int):
            future = self._pending.get(message["id"])
            if future is None or future.done():
                return
            error = message.get("error")
            if isinstance(error, dict):
                future.set_exception(AcpError(int(error.get("code", -32603)), str(error.get("message", "")),
                                              error.get("data")))
            else:
                result = message.get("result")
                future.set_result(result if isinstance(result, dict) else {})

    async def _answer(self, request_id: object, method: str, params: Mapping[str, Any]) -> None:
        try:
            result = await self._on_request(method, params)
            reply: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "result": result}
        except AcpError as error:
            reply = {"jsonrpc": "2.0", "id": request_id,
                     "error": {"code": error.code, "message": error.message}}
        with contextlib.suppress(AcpClosed, ConnectionError):
            await self._send(reply)

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            self._writer.close()
        self._reader_task.cancel()
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(self._reader_task, *self._tasks, return_exceptions=True)
