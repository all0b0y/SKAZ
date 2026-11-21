"""Bounded, stateless Streamable HTTP client. Never forwards SKAZ credentials or ambient cookies."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx

from ..errors import KnowledgeError, NameRejected
from ..sources.fetch import MAX_REDIRECTS, Resolver, SafeFetcher, _pinned, literal_address, system_resolver

MAX_PACKET = 12 * 1024 * 1024
VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26")
ACCEPT = "application/json, text/event-stream"
BeforeSend = Callable[[], None]


def local(url: str) -> bool:
    host = urlsplit(url).hostname or ""
    return host == "localhost" or bool((addr := literal_address(host)) and addr.is_loopback)


def address(url: str) -> str:
    try:
        parsed = urlsplit(url)
        port = parsed.port
        if (
            parsed.scheme not in ("https", "http")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or "\\" in url
            or any(c.isspace() for c in url)
            or any(ord(c) < 32 for c in url)
            or port == 0
        ):
            raise ValueError
        if parsed.scheme != "https" and not local(url):
            raise NameRejected("A remote MCP requires HTTPS. HTTP is available on this computer.")
        return url
    except (ValueError, UnicodeError) as error:
        raise NameRejected("Enter a valid server URL without credentials or a fragment.") from error


def origin(url: str) -> tuple[str, str | None, int]:
    parsed = urlsplit(url)
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


@dataclass(frozen=True)
class Packet:
    url: str
    headers: httpx.Headers
    content: bytes


def rpc_result(packet: Packet, call_id: int) -> dict[str, Any]:
    try:
        reply = json.loads(packet.content)
        if not isinstance(reply, dict) or reply.get("jsonrpc") != "2.0" or reply.get("id") != call_id:
            raise NameRejected("The server returned a response for a different MCP request.")
        if not isinstance(reply.get("result"), dict):
            raise NameRejected("The server reported an MCP error.")
        return dict(reply["result"])
    except (UnicodeError, ValueError) as error:
        raise NameRejected("The server returned an invalid MCP response.") from error


async def response_body(response: httpx.Response, limit: int, call_id: int | None) -> bytes:
    """Stop a live event stream at this request's reply, even if the server keeps the socket open."""
    stream = response.headers.get("content-type", "").partition(";")[0].strip().lower() == "text/event-stream"
    received = 0
    buffer = bytearray()
    data: list[bytes] = []
    async for chunk in response.aiter_bytes():
        received += len(chunk)
        if received > limit:
            raise NameRejected("The server response exceeds the size limit.")
        buffer.extend(chunk)
        if not stream or call_id is None:
            continue
        start = 0
        while (end := buffer.find(b"\n", start)) >= 0:
            line = bytes(buffer[start:end]).removesuffix(b"\r")
            start = end + 1
            if line.startswith(b"data:"):
                data.append(line[5:].removeprefix(b" "))
            if not line and data:
                event = b"\n".join(data)
                data.clear()
                try:
                    message = json.loads(event)
                except (ValueError, UnicodeError) as error:
                    raise NameRejected("Invalid MCP server event.") from error
                if isinstance(message, dict) and message.get("id") == call_id:
                    return event
        del buffer[:start]
    if stream and call_id is not None:
        raise NameRejected("The MCP stream closed before its reply.")
    return bytes(buffer)


class Transport:
    def __init__(self) -> None:
        self.resolve: Resolver = system_resolver
        self.http_transport: httpx.AsyncBaseTransport | None = None

    async def request(
        self,
        url: str,
        *,
        payload: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        discover: bool = False,
        end_session: bool = False,
        limit: int = MAX_PACKET,
        before_send: BeforeSend | None = None,
    ) -> Packet:
        current = address(url)
        guard = SafeFetcher(resolver=self.resolve)
        try:
            async with (
                asyncio.timeout(35),
                httpx.AsyncClient(
                    transport=self.http_transport, trust_env=False, follow_redirects=False, timeout=15.0
                ) as client,
            ):
                for _ in range(MAX_REDIRECTS + 1):
                    ip: str | None
                    destination = current
                    if local(current):
                        host = urlsplit(current).hostname
                        ip = "127.0.0.1" if host == "localhost" else str(literal_address(host or ""))
                    else:
                        guard.check(current)
                        ip = await guard._check_host(current, False)
                    pinned_headers: dict[str, str] = {}
                    extensions: dict[str, object] = {}
                    if ip:
                        destination, pinned_headers, extensions = _pinned(current, ip)
                    client.cookies.clear()
                    if before_send is not None:
                        before_send()
                    async with client.stream(
                        "DELETE" if end_session else "POST" if payload is not None else "GET",
                        destination,
                        json=payload,
                        headers={**(headers or {}), **pinned_headers},
                        extensions=extensions,
                    ) as res:
                        if res.is_redirect:
                            location = res.headers.get("location")
                            if not discover or not location:
                                raise NameRejected("The server changed address. Check its direct URL again.")
                            target = address(urljoin(current, location))
                            if origin(target) != origin(url):
                                raise NameRejected("Redirect to an unverified recipient. Use its direct URL.")
                            current = target
                            continue
                        if not res.is_success:
                            raise NameRejected(f"The server responded with HTTP {res.status_code}.")
                        call_id = payload.get("id") if payload else None
                        return Packet(current, res.headers, await response_body(res, limit, call_id))
        except (httpx.HTTPError, TimeoutError, OSError) as error:
            raise NameRejected("Could not reach the server. Check the address and try again.") from error
        raise NameRejected("The server redirected too many times.")

    @asynccontextmanager
    async def session(
        self, url: str, *, discover: bool = False, before_send: BeforeSend | None = None,
    ) -> AsyncIterator[McpSession]:
        packet = await self.request(
            url,
            payload={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": VERSIONS[0],
                    "capabilities": {},
                    "clientInfo": {"name": "SKAZ", "version": "1"},
                },
            },
            headers={"Accept": ACCEPT},
            discover=discover,
            limit=128 * 1024,
            before_send=before_send,
        )
        info = rpc_result(packet, 1)
        version = info.get("protocolVersion")
        if version not in VERSIONS or not isinstance(info.get("serverInfo"), dict):
            raise NameRejected("The endpoint did not identify itself as a supported MCP server.")
        headers = {"Accept": ACCEPT, "MCP-Protocol-Version": version}
        if session := packet.headers.get("mcp-session-id"):
            if len(session) > 512 or not session.isascii() or not session.isprintable():
                raise NameRejected("The server returned an invalid session identifier.")
            headers["Mcp-Session-Id"] = session
        try:
            await self.request(
                packet.url,
                payload={"jsonrpc": "2.0", "method": "notifications/initialized"},
                headers=headers,
                limit=65536,
                before_send=before_send,
            )
            yield McpSession(
                self, packet.url, headers, str(info["serverInfo"].get("name") or urlsplit(url).hostname),
                before_send,
            )
        finally:
            if session:
                # A server can decline client-initiated session termination (HTTP 405).
                with suppress(KnowledgeError, TimeoutError):
                    async with asyncio.timeout(2):
                        await self.request(packet.url, headers=headers, end_session=True, limit=4096)


@dataclass
class McpSession:
    transport: Transport
    url: str
    headers: dict[str, str]
    name: str
    before_send: BeforeSend | None = None

    async def rpc(self, method: str, params: dict[str, Any], call_id: int = 2) -> dict[str, Any]:
        packet = await self.transport.request(
            self.url,
            payload={"jsonrpc": "2.0", "id": call_id, "method": method, "params": params},
            headers=self.headers,
            before_send=self.before_send,
        )
        return rpc_result(packet, call_id)

    async def tools(self) -> list[dict[str, Any]]:
        tools: dict[str, dict[str, Any]] = {}
        params: dict[str, Any] = {}
        seen: set[str] = set()
        for page in range(32):
            listing = await self.rpc("tools/list", params, page + 2)
            batch = listing.get("tools")
            if not isinstance(batch, list):
                raise NameRejected("The MCP did not return a tool list.")
            for item in batch:
                if not isinstance(item, dict):
                    raise NameRejected("Invalid MCP tool description.")
                name, schema = item.get("name"), item.get("inputSchema")
                if (
                    not isinstance(name, str)
                    or not name
                    or len(name) > 256
                    or name in tools
                    or not isinstance(schema, dict)
                ):
                    raise NameRejected("Invalid or duplicate MCP tool.")
                required = schema.get("required", [])
                if (
                    schema.get("type") != "object"
                    or not isinstance(schema.get("properties", {}), dict)
                    or not isinstance(required, list)
                    or not all(isinstance(key, str) for key in required)
                ):
                    raise NameRejected("Invalid MCP tool argument schema.")
                tools[name] = {
                    "name": name,
                    "description": str(item.get("description") or "")[:4096],
                    "inputSchema": schema,
                }
            if len(tools) > 2048 or len(json.dumps(tools)) > 2_000_000:
                raise NameRejected("The MCP tool list is too large.")
            cursor = listing.get("nextCursor")
            if cursor is None:
                return list(tools.values())
            if not isinstance(cursor, str) or not cursor or cursor in seen:
                raise NameRejected("The MCP returned an invalid tool cursor.")
            seen.add(cursor)
            params = {"cursor": cursor}
        raise NameRejected("The MCP returned too many tool pages.")
