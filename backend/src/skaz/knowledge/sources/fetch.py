"""One bounded HTTP GET for a link the user pasted: public http(s) only, no cookies, ≤ 5 redirects.

* Every hop (the first URL and each redirect) must be http/https without
  credentials and resolve only to public addresses — no ``localhost``, private,
  link-local or reserved ranges (a page must not make SKAZ read the user's
  router or the SKAZ backend itself). A host written as a number in any form the
  system accepts (``3323068417``, ``198.18.1``, ``0xC6120001``, octal
  ``0300.0250.0.1``) is a literal address: the literal policy applies and DNS is
  never asked. DNS can change between the check and the connection (rebinding);
  every caller passes ``fetch(pin_address=True)``, which connects to the very
  address that was checked (the ``Host`` header and TLS SNI/certificate check keep
  the original name).
* ``allow_address`` is a test seam only (a local test server on 127.0.0.1);
  production code never passes it, so only global addresses are allowed.
* VPN fake-IP (``FAKE_IP``, 198.18.0.0/15, RFC 2544 benchmarking): VPN/proxy apps
  in TUN "fake-IP" mode (Clash, Mihomo, sing-box, Surge…) answer every name with
  such an address and route the connection by the name. Behind such a VPN SKAZ
  CANNOT see the real destination: the VPN's own rules decide where the
  connection goes. With a DIRECT rule the VPN resolves the name with real DNS and
  may connect to a LAN or loopback address — a hostile public name can then make
  SKAZ do one blind GET without cookies to a device on the user's network
  (residual risk, ``.dev/docs/SECURITY-NOTES-0.3.1.md``). So a fake-IP answer is
  accepted only when (user decision 2026-10-22, security review S-02):
  the caller passes ``allow_vpn_fake_ip=True`` — only requests started by the
  user's own click on that URL (W-3 Add to wiki of a web page, Add link and its
  link check), never automatic or follow-up requests; the host is a public-looking
  domain name (has a dot, not numeric, not a local/reserved suffix,
  :data:`LOCAL_SUFFIXES`); and the port is the default one (http 80, https 443).
  A typed literal 198.18.x.x address stays refused. IPv6 fake-IP ranges (e.g.
  ``fc00::/18``) are not recognised: such answers are refused as non-public.
* No cookies are kept (a fresh jar per hop), ``.netrc``/proxy variables are
  ignored (``trust_env=False``), the body is streamed and cut at the limit.
"""
from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

from ...version import app_version
from ..errors import KnowledgeError

MAX_REDIRECTS = 5
MAX_PAGE_BYTES = 10 * 1024 * 1024
TIMEOUT = httpx.Timeout(20.0, connect=10.0)
TOTAL_SECONDS = 60.0
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) "
    f"SKAZ/{app_version()}"
)

Resolver = Callable[[str], Awaitable[list[str]]]
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
AddressPolicy = Callable[[IPAddress], bool]
NOT_PUBLIC = "SKAZ only opens public websites, not addresses on this computer or network."
FAKE_IP = ipaddress.ip_network("198.18.0.0/15")
VPN_HIDDEN = (
    "Your VPN hides where this address really leads. SKAZ opens such sites only when you add the link "
    "or page yourself, by a public website name on the standard port."
)
INVALID = "This web address isn't valid."
#: Names that are never a public website (this computer, home/office networks, reserved test names).
LOCAL_SUFFIXES = (
    ".local", ".lan", ".internal", ".home.arpa", ".localhost", ".localdomain", ".intranet", ".corp",
    ".home", ".private", ".test", ".invalid", ".example",
)
#: Dotted numbers in decimal, octal or hex (``3323068417``, ``198.18.1``, ``0xC6.0x12.0.1``).
_NUMERIC_HOST = re.compile(r"(?:0x[0-9a-f]*|[0-9]+)(?:\.(?:0x[0-9a-f]*|[0-9]+))*", re.IGNORECASE)
_DEFAULT_PORTS = {"http": 80, "https": 443}


def public_address(address: IPAddress) -> bool:
    return address.is_global


def fake_ip(address: IPAddress) -> bool:
    """An address a VPN/proxy in fake-IP mode gives for a site name (see the module note)."""
    return address.version == 4 and address in FAKE_IP


def _host(url: str) -> str:
    return (urlsplit(url).hostname or "").lower().rstrip(".")


def literal_address(host: str) -> IPAddress | None:
    """The address ``host`` names by number in any form the system accepts, ``None`` for a name;
    ``LinkRejected`` for a number no parser accepts (security review S-03)."""
    host = host.lower().rstrip(".")
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM, flags=socket.AI_NUMERICHOST)
    except (OSError, UnicodeError, ValueError):
        infos = []
    for info in infos:
        try:
            return ipaddress.ip_address(str(info[4][0]).split("%", 1)[0])
        except ValueError:
            continue
    if _NUMERIC_HOST.fullmatch(host):
        raise LinkRejected(INVALID)
    return None


def public_name(url: str) -> bool:
    """A public-looking website name on the default port: what a fake-IP answer is accepted for."""
    parts = urlsplit(url)
    try:
        port = parts.port
    except ValueError:
        return False
    host = _host(url)
    labels = host.split(".")
    return (
        (port is None or port == _DEFAULT_PORTS.get(parts.scheme))
        and len(labels) >= 2 and all(labels) and not labels[-1].isdigit()
        and ":" not in host and _NUMERIC_HOST.fullmatch(host) is None
        and not host.endswith(LOCAL_SUFFIXES) and f".{host}" not in LOCAL_SUFFIXES
    )


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


def check_url(value: str, *, allow_address: AddressPolicy = public_address) -> str:
    """The trimmed URL when it is a plain public-looking http(s) address; ``LinkRejected`` otherwise."""
    url = value.strip()
    if not url or len(url) > 4096 or any(ord(char) < 32 for char in url):
        raise LinkRejected("Enter a web address starting with http:// or https://.")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as error:
        raise LinkRejected(INVALID) from error
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise LinkRejected("Enter a web address starting with http:// or https://.")
    if parts.username is not None or parts.password is not None:
        raise LinkRejected("Links with a user name or password aren't supported.")
    if port is not None and not 0 < port < 65536:
        raise LinkRejected(INVALID)
    host = parts.hostname.lower().rstrip(".")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".home.arpa")):
        raise LinkRejected(NOT_PUBLIC)
    address = literal_address(host)
    if address is None:
        return url
    if not allow_address(address):
        raise LinkRejected(NOT_PUBLIC)
    return url


def _pinned(url: str, address: str) -> tuple[str, dict[str, str], dict[str, object]]:
    """``url`` aimed at the checked ``address``: the ``Host`` header and TLS name stay the original."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    literal = f"[{address}]" if ":" in address else address
    netloc = f"{literal}:{parts.port}" if parts.port is not None else literal
    host_header = f"{host}:{parts.port}" if parts.port is not None else host
    extensions: dict[str, object] = {"sni_hostname": host} if parts.scheme == "https" else {}
    return parts._replace(netloc=netloc).geturl(), {"Host": host_header}, extensions


async def system_resolver(host: str) -> list[str]:
    infos = await asyncio.to_thread(socket.getaddrinfo, host, None, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


class SafeFetcher:
    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        resolver: Resolver | None = None,
        allow_address: AddressPolicy = public_address,
    ) -> None:
        self.transport = transport
        self.resolver = resolver or system_resolver
        self.allow_address = allow_address

    def check(self, url: str) -> str:
        """``check_url`` with this fetcher's address policy."""
        return check_url(url, allow_address=self.allow_address)

    async def _check_host(self, url: str, allow_vpn_fake_ip: bool) -> str | None:
        """The first checked address of a host name; ``None`` for a literal address."""
        host = (urlsplit(url).hostname or "").lower()
        if literal_address(host) is not None:
            return None  # literal addresses (any numeric form) were checked by ``check_url``
        try:
            addresses = await self.resolver(host)
        except (OSError, UnicodeError) as error:
            raise FetchFailed(
                "SKAZ couldn't find this website. Check the address and the connection."
            ) from error
        if not addresses:
            raise FetchFailed("SKAZ couldn't find this website. Check the address and the connection.")
        checked: list[str] = []
        for raw in addresses:
            try:
                address = ipaddress.ip_address(raw.split("%", 1)[0])
            except ValueError:
                continue
            if not self.allow_address(address):
                if not fake_ip(address):
                    raise LinkRejected(NOT_PUBLIC)
                if not (allow_vpn_fake_ip and public_name(url)):
                    raise LinkRejected(VPN_HIDDEN)
            checked.append(str(address))
        if not checked:
            raise FetchFailed("SKAZ couldn't find this website. Check the address and the connection.")
        return checked[0]

    async def fetch(
        self,
        url: str,
        *,
        max_bytes: int = MAX_PAGE_BYTES,
        allow_partial: bool = False,
        accept: str = "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5",
        total_seconds: float | None = None,
        pin_address: bool = False,
        allow_vpn_fake_ip: bool = False,
    ) -> Fetched:
        """``allow_vpn_fake_ip``: only for a request started by the user's own click on ``url`` (see the
        module note); its redirects are held to the same rules."""
        try:
            async with asyncio.timeout(TOTAL_SECONDS if total_seconds is None else total_seconds):
                return await self._fetch(
                    url, max_bytes, allow_partial, accept, pin_address, allow_vpn_fake_ip
                )
        except TimeoutError as error:
            raise FetchFailed("The website took too long to answer. Try again later.") from error

    async def _fetch(
        self, url: str, max_bytes: int, allow_partial: bool, accept: str, pin_address: bool,
        allow_vpn_fake_ip: bool,
    ) -> Fetched:
        current = self.check(url)
        headers = {"User-Agent": USER_AGENT, "Accept": accept, "Accept-Language": "en,ru;q=0.9"}
        async with httpx.AsyncClient(
            transport=self.transport,
            follow_redirects=False,
            trust_env=False,
            timeout=TIMEOUT,
            headers=headers,
        ) as client:
            for _hop in range(MAX_REDIRECTS + 1):
                checked = await self._check_host(current, allow_vpn_fake_ip)
                client.cookies.clear()
                target, pinned_headers, extensions = current, dict[str, str](), dict[str, object]()
                if pin_address and checked is not None:
                    target, pinned_headers, extensions = _pinned(current, checked)
                try:
                    async with client.stream(
                        "GET", target, headers=pinned_headers, extensions=extensions
                    ) as response:
                        if response.is_redirect:
                            location = response.headers.get("location")
                            if not location:
                                raise FetchFailed("The website sent a broken redirect.")
                            current = self.check(urljoin(current, location))
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
        if status == 402:
            raise FetchFailed("This page needs a paid subscription.")
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
