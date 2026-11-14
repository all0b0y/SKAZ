"""The one door to the science bases: consent gate → budget → journal row → request.

Every outgoing request is journalled (``science_egress``) BEFORE it leaves, with only the topics, DOIs
and public ids it carries, and closed with its outcome afterwards. With the integration off nothing leaves
(``ScienceConsentRequired``). OpenAlex spends a day budget: SKAZ books each request against it and stops
honestly (``ScienceDailyLimit`` with ``retry_at``) before the budget or after a 429 — it never switches
to another provider. The key travels only in the ``Authorization`` header (httpx drops it on a redirect
to another host); it is never journalled or logged.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable, Collection, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Literal

import httpx

from ...native_io import disk_call
from ..api.schemas_science import KbSciencePayload, KbScienceProvider
from ..errors import KnowledgeError
from ..sources.fetch import Fetched, SafeFetcher
from ..sources.web_page import ACCEPT as HTML_ACCEPT
from ..sources.web_page import HTML_TYPES, MAX_PAGE_BYTES
from . import openalex
from .protocols import ScienceConsentRequired, ScienceDailyLimit, ScienceUnavailable
from .store import ScienceStore, next_midnight

logger = logging.getLogger(__name__)

Operation = Literal["search", "metadata", "citations", "full_text", "alternatives", "taxonomy"]
USER_AGENT = "SKAZ science client"
TIMEOUT = httpx.Timeout(20.0, connect=10.0)
MAX_BODY_BYTES = 20 * 1024 * 1024
PAGE_SECONDS = 30.0
#: A 429 that asks to wait this long or less is the per-second limit: wait once, then ask again.
SHORT_WAIT = 3.0
#: arXiv asks for one request every three seconds.
MIN_INTERVAL: Mapping[str, float] = {"arxiv": 3.0}


@dataclass(frozen=True)
class Call:
    provider: KbScienceProvider
    operation: Operation
    url: str
    payload: KbSciencePayload
    params: Mapping[str, str] = field(default_factory=dict)
    #: OpenAlex budget in USD (see ``openalex``); other providers are free.
    cost: float = 0.0
    accept: str = "application/json"

    @property
    def host(self) -> str:
        return httpx.URL(self.url).host


class _TooLarge(Exception):
    pass


def _seconds(value: str | None, now: datetime) -> float | None:
    if not value:
        return None
    text = value.strip()
    try:
        return max(0.0, float(text))
    except ValueError:
        pass
    with contextlib.suppress(TypeError, ValueError, IndexError):
        when = parsedate_to_datetime(text)
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        return max(0.0, (when - now).total_seconds())
    return None


class ScienceTransport:
    def __init__(
        self,
        store: ScienceStore,
        http: httpx.AsyncClient,
        key: Callable[[], str | None],
        fetcher: SafeFetcher,
        *,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.store = store
        self.http = http
        self.key = key
        self.fetcher = fetcher
        self.now = now
        self.sleep = sleep
        self.monotonic = monotonic
        self._last: dict[str, float] = {}
        self._pace_locks: dict[str, asyncio.Lock] = {}

    # -- gates -----------------------------------------------------------------------------------------

    async def _gate(self, call: Call, key: str | None) -> None:
        if not await disk_call(self.store.enabled):
            raise ScienceConsentRequired()
        if call.host in (openalex.API_HOST, openalex.CONTENT_HOST):
            allowance = openalex.ALLOWANCE_KEY if key else openalex.ALLOWANCE_KEYLESS
            retry_at = await disk_call(self.store.reserve, call.cost, allowance, self.now())
            if retry_at is not None:
                raise ScienceDailyLimit(retry_at)

    async def _pace(self, provider: str) -> None:
        interval = MIN_INTERVAL.get(provider)
        if interval is None:
            return
        lock = self._pace_locks.setdefault(provider, asyncio.Lock())
        async with lock:
            last = self._last.get(provider)
            if last is not None:
                wait = interval - (self.monotonic() - last)
                if wait > 0:
                    await self.sleep(wait)
            self._last[provider] = self.monotonic()

    async def _open(self, call: Call, run_id: str | None, key: str | None = None) -> str:
        await self._gate(call, key)
        await self._pace(call.provider)
        # Pacing can wait seconds: ``journal_open`` re-checks consent in the same write as the journal row,
        # right before the request leaves (review R1-02).
        return await disk_call(
            self.store.journal_open,
            call.provider,
            call.operation,
            call.host,
            call.payload,
            run_id,
            self.now(),
        )

    async def _close(self, record_id: str, outcome: str, status: int | None) -> None:
        await disk_call(self.store.journal_close, record_id, outcome, status)

    # -- API requests ---------------------------------------------------------------------------------

    async def body(self, call: Call, *, run_id: str | None = None) -> bytes | None:
        """The answer's body; ``None`` when the base says the thing does not exist (404 / 410)."""
        key = await disk_call(self.key) if call.host in (openalex.API_HOST, openalex.CONTENT_HOST) else None
        for attempt in (0, 1):
            record_id = await self._open(call, run_id, key)
            headers = {"Accept": call.accept, "User-Agent": USER_AGENT}
            if key:
                headers["Authorization"] = f"Bearer {key}"
            try:
                async with self.http.stream(
                    "GET",
                    call.url,
                    params=dict(call.params),
                    headers=headers,
                    timeout=TIMEOUT,
                    follow_redirects=True,
                ) as response:
                    status = response.status_code
                    if 200 <= status < 300:
                        data = await self._read(response)
                        await self._close(record_id, "succeeded", status)
                        return data
                    if status in (404, 410):
                        await self._close(record_id, "succeeded", status)
                        return None
                    if status == 429:
                        await self._close(record_id, "rate_limited", status)
                        wait = await self._rate_limited(call, response, attempt)
                    else:
                        await self._close(record_id, "failed", status)
                        logger.warning(
                            "Science request failed: %s %s %s", call.provider, call.operation, status
                        )
                        raise ScienceUnavailable()
            except (httpx.HTTPError, _TooLarge) as error:
                await self._close(record_id, "failed", None)
                logger.warning(
                    "Science request failed: %s %s %s", call.provider, call.operation, type(error).__name__
                )
                raise ScienceUnavailable() from error
            await self.sleep(wait)
        raise ScienceUnavailable()  # pragma: no cover - the second 429 always raises

    async def _read(self, response: httpx.Response) -> bytes:
        chunks: list[bytes] = []
        size = 0
        async for chunk in response.aiter_bytes():
            size += len(chunk)
            if size > MAX_BODY_BYTES:
                raise _TooLarge()
            chunks.append(chunk)
        return b"".join(chunks)

    async def _rate_limited(self, call: Call, response: httpx.Response, attempt: int) -> float:
        """Seconds to wait before one more try, or the honest stop."""
        now = self.now()
        retry_after = _seconds(response.headers.get("retry-after"), now)
        remaining = response.headers.get("x-ratelimit-remaining")
        per_second = (retry_after is not None and retry_after <= SHORT_WAIT) or (
            retry_after is None and remaining is not None and remaining.strip() not in ("", "0")
        )
        if per_second and attempt == 0:
            return retry_after if retry_after is not None else 1.0
        if call.host not in (openalex.API_HOST, openalex.CONTENT_HOST) or per_second:
            raise ScienceUnavailable(
                now + timedelta(seconds=retry_after) if retry_after is not None else None
            )
        reset = _seconds(response.headers.get("x-ratelimit-reset"), now)
        if reset is not None:
            retry_at = now + timedelta(seconds=reset)
        elif retry_after is not None:
            retry_at = now + timedelta(seconds=retry_after)
        else:
            retry_at = next_midnight(now)  # the budget resets at midnight UTC
        await disk_call(self.store.block_until, retry_at, now)
        raise ScienceDailyLimit(retry_at)

    # -- article pages (arXiv HTML, open pages) -------------------------------------------------------

    async def page(
        self, call: Call, *, run_id: str | None = None, allow_vpn_fake_ip: bool = False,
    ) -> Fetched | None:
        """An HTML page through the shared fetch guard (public address, size and time limits).

        A page that can't be read is ``None`` (journalled ``failed``): the next text source is tried.
        """
        record_id = await self._open(call, run_id)
        try:
            fetched = await self.fetcher.fetch(
                call.url,
                max_bytes=MAX_PAGE_BYTES,
                accept=HTML_ACCEPT,
                total_seconds=PAGE_SECONDS,
                pin_address=True,
                content_types=HTML_TYPES,
                allow_vpn_fake_ip=allow_vpn_fake_ip,
            )
        except KnowledgeError as error:
            await self._close(record_id, "failed", None)
            logger.info("Science page unavailable: %s %s", call.provider, type(error).__name__)
            return None
        await self._close(record_id, "succeeded", fetched.status)
        return fetched

    async def download(
        self,
        call: Call,
        *,
        run_id: str | None = None,
        max_bytes: int = MAX_BODY_BYTES,
        accept: str = "*/*",
        content_types: Collection[str] | None = None,
        allow_vpn_fake_ip: bool = True,
    ) -> Fetched | None:
        """A bounded file download for Add to materials, through the same consent and URL guards."""
        record_id = await self._open(call, run_id)
        try:
            fetched = await self.fetcher.fetch(
                call.url,
                max_bytes=max_bytes,
                accept=accept,
                content_types=content_types,
                total_seconds=PAGE_SECONDS,
                allow_vpn_fake_ip=allow_vpn_fake_ip,
                pin_address=True,
            )
        except KnowledgeError as error:
            await self._close(record_id, "failed", None)
            logger.info("Science file unavailable: %s %s", call.provider, type(error).__name__)
            return None
        except BaseException:
            # Cancellation is an outcome too: never leave a journal row in «sent».
            await self._close(record_id, "failed", None)
            raise
        await self._close(record_id, "succeeded", fetched.status)
        return fetched
