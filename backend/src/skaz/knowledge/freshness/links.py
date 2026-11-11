"""Manual link check probing and two-step 1-day gone confirmation (0.4.0 B5).

Reuses ``sources/fetch.py`` read-only so every probe goes through the same URL
guard, DNS pinning and redirect caps as ``Add link``.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

import httpx

from ..api.schemas_freshness import KbLinkObservation
from ..sources.fetch import DnsFailed, Fetched, FetchFailed, LinkRejected, SafeFetcher
from ..store.records import MaterialRecord

LinkReason = Literal["http_404", "http_410", "no_domain", "http_403", "http_429", "timeout", "other"]
ONE_DAY = timedelta(days=1)


class _HttpStatusError(FetchFailed):
    def __init__(self, status_code: int) -> None:
        super().__init__(f"HTTP {status_code}")
        self.status_code = status_code


class _NoDomainError(FetchFailed):
    def __init__(self) -> None:
        super().__init__("No domain")


class _ProbeFetcher(SafeFetcher):
    """``SafeFetcher`` adapter that stops after response headers and reports exact status codes."""

    async def _check_host(self, url: str, allow_vpn_fake_ip: bool) -> str | None:
        try:
            return await super()._check_host(url, allow_vpn_fake_ip)
        except DnsFailed as error:
            # Only a resolver that answered "no such name" is evidence of a gone domain; offline or a DNS
            # outage is "couldn't check" and never starts or confirms a gone mark (0.4.0 review R2-05).
            if error.kind == "no_such_host":
                raise _NoDomainError() from error
            raise

    @staticmethod
    async def _read(
        response: httpx.Response,
        url: str,
        max_bytes: int | None,
        allow_partial: bool,
        *,
        write_body: Any = None,
        content_types: Collection[str] | None = None,
    ) -> Fetched:
        status = response.status_code
        if 200 <= status < 300:
            return Fetched(
                url=url,
                status=status,
                content_type=response.headers.get("content-type", ""),
                charset=None,
                body=b"",
                truncated=True,
            )
        raise _HttpStatusError(status)


@dataclass(frozen=True, slots=True)
class RawLinkProbe:
    kind: Literal["ok", "gone", "could_not_check"]
    reason: LinkReason | None
    status_code: int | None


def material_check_url(record: MaterialRecord) -> str | None:
    """Return the checkable URL of a material from its ``origin``, or ``None``."""
    origin = record.origin if isinstance(record.origin, dict) else {}
    for key in ("url", "final_url"):
        val = origin.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


async def probe_link(fetcher: SafeFetcher, url: str) -> RawLinkProbe:
    """Probe ``url`` through ``SafeFetcher``'s URL guard and classify the answer."""
    probe_fetcher = _ProbeFetcher(
        transport=fetcher.transport,
        resolver=fetcher.resolver,
        allow_address=fetcher.allow_address,
    )
    try:
        fetched = await probe_fetcher.fetch(
            url,
            max_bytes=1024,
            allow_partial=True,
            pin_address=True,
            allow_vpn_fake_ip=True,
        )
        return RawLinkProbe(kind="ok", reason=None, status_code=fetched.status)
    except _NoDomainError:
        return RawLinkProbe(kind="gone", reason="no_domain", status_code=None)
    except _HttpStatusError as error:
        code = error.status_code
        if code == 404:
            return RawLinkProbe(kind="gone", reason="http_404", status_code=404)
        if code == 410:
            return RawLinkProbe(kind="gone", reason="http_410", status_code=410)
        if code == 403:
            return RawLinkProbe(kind="could_not_check", reason="http_403", status_code=403)
        if code == 429:
            return RawLinkProbe(kind="could_not_check", reason="http_429", status_code=429)
        return RawLinkProbe(kind="could_not_check", reason="other", status_code=code)
    except LinkRejected:
        return RawLinkProbe(kind="could_not_check", reason="other", status_code=None)
    except FetchFailed as error:
        if isinstance(error.__cause__, (TimeoutError, httpx.TimeoutException)) or (
            "took too long" in error.message
        ):
            return RawLinkProbe(kind="could_not_check", reason="timeout", status_code=None)
        return RawLinkProbe(kind="could_not_check", reason="other", status_code=None)


def evaluate_observation(
    *,
    material_id: str,
    url: str,
    probe: RawLinkProbe,
    checked_at: datetime,
    prior_first_gone_at: datetime | None,
) -> tuple[KbLinkObservation, Literal["link_gone", "link_back"] | None]:
    """Build ``KbLinkObservation`` and decide whether to write/clear a ``link_gone`` mark."""
    if probe.kind == "ok":
        return (
            KbLinkObservation(
                material_id=material_id,
                url=url,
                outcome="ok",
                reason=None,
                status_code=probe.status_code,
                checked_at=checked_at,
                first_gone_at=None,
                confirm_after=None,
            ),
            "link_back",
        )

    if probe.kind == "gone":
        if prior_first_gone_at is None:
            first_gone = checked_at
            confirm_after = first_gone + ONE_DAY
            return (
                KbLinkObservation(
                    material_id=material_id,
                    url=url,
                    outcome="suspected_gone",
                    reason=probe.reason,
                    status_code=probe.status_code,
                    checked_at=checked_at,
                    first_gone_at=first_gone,
                    confirm_after=confirm_after,
                ),
                None,
            )
        first_gone = prior_first_gone_at
        confirm_after = first_gone + ONE_DAY
        if checked_at >= confirm_after:
            return (
                KbLinkObservation(
                    material_id=material_id,
                    url=url,
                    outcome="confirmed_gone",
                    reason=probe.reason,
                    status_code=probe.status_code,
                    checked_at=checked_at,
                    first_gone_at=first_gone,
                    confirm_after=confirm_after,
                ),
                "link_gone",
            )
        return (
            KbLinkObservation(
                material_id=material_id,
                url=url,
                outcome="suspected_gone",
                reason=probe.reason,
                status_code=probe.status_code,
                checked_at=checked_at,
                first_gone_at=first_gone,
                confirm_after=confirm_after,
            ),
            None,
        )

    return (
        KbLinkObservation(
            material_id=material_id,
            url=url,
            outcome="could_not_check",
            reason=probe.reason,
            status_code=probe.status_code,
            checked_at=checked_at,
            first_gone_at=None,
            confirm_after=None,
        ),
        None,
    )
