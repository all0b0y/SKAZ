"""Loopback-only access control: per-run bearer token, Origin and Host checks."""

from __future__ import annotations

import hmac
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

from .config import AppConfig

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "[::1]"})
#: Origins a packaged Electron renderer or a local dev server can legitimately send.
BROWSERLESS_ORIGINS = frozenset({"", "null", "file://"})


def require_token(request: Request) -> None:
    """FastAPI dependency guarding every route except /health."""
    config: AppConfig = request.app.state.runtime.config
    header = request.headers.get("authorization", "")
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(value.strip(), config.token):
        raise HTTPException(status_code=401, detail="Missing or invalid bearer token.")


def local_access_error(request: Request, config: AppConfig) -> str | None:
    """Return a rejection reason for non-local callers, or None when the request is local."""
    host_header = request.headers.get("host")
    if host_header is not None and _hostname(host_header) not in LOOPBACK_HOSTS:
        return "Backend accepts loopback requests only."
    origin = request.headers.get("origin")
    if origin is None:
        return None
    if not _origin_allowed(origin, config):
        return "Origin is not allowed for the local backend."
    return None


def _origin_allowed(origin: str, config: AppConfig) -> bool:
    normalised = origin.strip()
    if normalised in BROWSERLESS_ORIGINS or normalised in config.extra_allowed_origins:
        return True
    parts = urlsplit(normalised)
    if parts.scheme == "file":
        return True
    if parts.scheme not in ("http", "https"):
        return False
    return (parts.hostname or "") in LOOPBACK_HOSTS


def _hostname(host_header: str) -> str:
    host = host_header.strip()
    if host.startswith("["):  # IPv6 literal
        return host.split("]")[0] + "]"
    return host.rsplit(":", 1)[0] if ":" in host else host
