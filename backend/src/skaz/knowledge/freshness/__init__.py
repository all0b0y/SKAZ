"""0.4.0 source publication dates and link checks (owner: B5)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .protocols import PublicationDates
    from .service import FreshnessService, build_freshness_service

__all__ = ["FreshnessService", "PublicationDates", "build_freshness_service"]


def __getattr__(name: str) -> Any:
    if name == "PublicationDates":
        from .protocols import PublicationDates

        return PublicationDates
    if name in ("FreshnessService", "build_freshness_service"):
        from . import service

        return getattr(service, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
