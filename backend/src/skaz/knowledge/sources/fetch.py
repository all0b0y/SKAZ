"""One bounded HTTP GET for a link the user pasted: public http(s) only, no cookies, ≤ 5 redirects.

* Every hop (the first URL and each redirect) must be http/https without
  credentials and resolve only to public addresses — no ``localhost``, private,
  link-local or reserved ranges (a page must not make SKAZ read the user's
  router or the SKAZ backend itself). DNS can change between this check and
  the connection (rebinding); that window is not closed here.
* No cookies are kept (a fresh jar per hop), ``.netrc``/proxy variables are
  ignored (``trust_env=False``), the body is streamed and cut at the limit.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

from ..errors import KnowledgeError

MAX_REDIRECTS = 5
MAX_PAGE_BYTES = 10 * 1024 * 1024
TIMEOUT = httpx.Timeout(20.0, connect=10.0)
TOTAL_SECONDS = 60.0
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) SKAZ/0.2"
)

Resolver = Callable[[str], Awaitable[list[str]]]


class LinkRejected(KnowledgeError):
    """The address itself is not acceptable (scheme, host, playlist…): fix the link."""

    status_code = 422


class FetchFailed(KnowledgeError):
    """The site could not be read: unavailable, an error answer, too large."""

    status_code = 502


@dataclass(frozen=True)
class Fetched:
    url: str
    status: int
    #: Lower-case MIME type without parameters ("" when missing).
    content_type: str
    charset: str | None
    body: bytes
    #: True when ``allow_partial`` cut the body at the limit.
    truncated: bool = False


def check_url(value: str) -> str:
    """The trimmed URL when it is a plain public-looking http(s) address; ``LinkRejected`` otherwise."""
    url = value.strip()
    if not url or len(url) > 4096 or any(ord(char) < 32 for char in url):
        raise LinkRejected("Enter a web address starting with http:// or https://.")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as error:
        raise LinkRejected("This web address isn't valid.") from error
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise LinkRejected("Enter a web address starting with http:// or https://.")
    if parts.username is not None or parts.password is not None:
        raise LinkRejected("Links with a user name or password aren't supported.")
    if port is not None and not 0 < port < 65536:
        raise LinkRejected("This web address isn't valid.")
    host = parts.hostname.lower().rstrip(".")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".home.arpa")):
        raise LinkRejected("SKAZ only opens public websites, not addresses on this computer or network.")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return url
    if not address.is_global:
        raise LinkRejected("SKAZ only opens public websites, not addresses on this computer or network.")
    return url


async def system_resolver(host: str) -> list[str]:
    infos = await asyncio.to_thread(socket.getaddrinfo, host, None, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


class SafeFetcher:
    def __init__(
        self, *, transport: httpx.AsyncBaseTransport | None = None, resolver: Resolver | None = None
    ) -> None:
        self.transport = transport
        self.resolver = resolver or system_resolver

    async def _check_host(self, url: str) -> None:
        host = (urlsplit(url).hostname or "").lower()
        try:
            ipaddress.ip_address(host)
            return  # literal addresses were checked by ``check_url``
        except ValueError:
            pass
        try:
            addresses = await self.resolver(host)
        except (OSError, UnicodeError) as error:
            raise FetchFailed(
                "SKAZ couldn't find this website. Check the address and the connection."
            ) from error
        if not addresses:
            raise FetchFailed("SKAZ couldn't find this website. Check the address and the connection.")
        for raw in addresses:
            try:
                address = ipaddress.ip_address(raw.split("%", 1)[0])
            except ValueError:
                continue
            if not address.is_global:
                raise LinkRejected(
                    "SKAZ only opens public websites, not addresses on this computer or network."
                )

    async def fetch(
        self,
        url: str,
        *,
        max_bytes: int = MAX_PAGE_BYTES,
        allow_partial: bool = False,
        accept: str = "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5",
    ) -> Fetched:
        try:
            async with asyncio.timeout(TOTAL_SECONDS):
                return await self._fetch(url, max_bytes, allow_partial, accept)
        except TimeoutError as error:
            raise FetchFailed("The website took too long to answer. Try again later.") from error

    async def _fetch(self, url: str, max_bytes: int, allow_partial: bool, accept: str) -> Fetched:
        current = check_url(url)
        headers = {"User-Agent": USER_AGENT, "Accept": accept, "Accept-Language": "en,ru;q=0.9"}
        async with httpx.AsyncClient(
            transport=self.transport,
            follow_redirects=False,
            trust_env=False,
            timeout=TIMEOUT,
            headers=headers,
        ) as client:
            for _hop in range(MAX_REDIRECTS + 1):
                await self._check_host(current)
                client.cookies.clear()
                try:
                    async with client.stream("GET", current) as response:
                        if response.is_redirect:
                            location = response.headers.get("location")
                            if not location:
                                raise FetchFailed("The website sent a broken redirect.")
                            current = check_url(urljoin(current, location))
                            continue
                        return await self._read(response, current, max_bytes, allow_partial)
                except httpx.TimeoutException as error:
                    raise FetchFailed("The website took too long to answer. Try again later.") from error
                except httpx.HTTPError as error:
                    raise FetchFailed(
                        "SKAZ couldn't reach this website. Check the address and the connection."
                    ) from error
            raise FetchFailed("The link redirects too many times.")

    @staticmethod
    async def _read(response: httpx.Response, url: str, max_bytes: int, allow_partial: bool) -> Fetched:
        status = response.status_code
        if status in (401, 403):
            raise FetchFailed("This page needs a sign-in or blocks automatic access.")
        if status == 404 or status == 410:
            raise FetchFailed("The page wasn't found. Check the address.")
        if status == 451:
            raise FetchFailed("The page isn't available in your region.")
        if status >= 400:
            raise FetchFailed(f"The website answered with an error ({status}). Try again later.")
        if not 200 <= status < 300:
            raise FetchFailed(f"The website gave an unexpected answer ({status}).")
        raw_type = response.headers.get("content-type", "")
        content_type = raw_type.split(";", 1)[0].strip().lower()
        charset = response.charset_encoding
        declared = response.headers.get("content-length")
        too_big = FetchFailed(f"The page is larger than {max_bytes // (1024 * 1024)} MB.")
        if declared and declared.isdigit() and int(declared) > max_bytes and not allow_partial:
            raise too_big
        chunks: list[bytes] = []
        size = 0
        truncated = False
        async for chunk in response.aiter_bytes():
            size += len(chunk)
            if size > max_bytes:
                if not allow_partial:
                    raise too_big
                chunks.append(chunk[: len(chunk) - (size - max_bytes)])
                truncated = True
                break
            chunks.append(chunk)
        return Fetched(url, status, content_type, charset, b"".join(chunks), truncated)
