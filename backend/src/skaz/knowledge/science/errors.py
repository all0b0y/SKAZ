"""A science stop as the contract's HTTP answer, for routes and services that answer a request directly."""

from __future__ import annotations

from ..api.contract_routes import ContractFailure
from .protocols import ScienceConsentRequired, ScienceDailyLimit, ScienceStop


def stop_failure(stop: ScienceStop) -> ContractFailure:
    """403 consent, 429 the OpenAlex day limit, else 502 provider unavailable (never another provider)."""
    if isinstance(stop, ScienceConsentRequired):
        return ContractFailure(403, "consent_required")
    if isinstance(stop, ScienceDailyLimit):
        return ContractFailure(429, "openalex_daily_limit")
    return ContractFailure(502, "provider_unavailable")
