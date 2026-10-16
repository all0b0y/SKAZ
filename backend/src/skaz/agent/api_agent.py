"""Which API profile runs the agent loop for a purpose, and whether it can.

Assistant and Notes keep their own API profiles (``settings.agent`` and
``settings.notes``). Agent mode reuses them; it never picks a model of its own.
A profile that cannot run the loop — no tool calling, no key, no consent — is
reported as unavailable with the reason, and nothing is sent: there is no
fallback to the one-pass path or to another model.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx

from ..catalog import CatalogUnavailable, ProviderCatalogs
from ..gateways import CLOUD_PROVIDERS
from ..gateways.tool_chat import (
    TOOL_PROVIDERS,
    ToolChatGateway,
    build_tool_chat,
    step_tokens,
    tool_support_problem,
)
from ..schemas import Task
from ..settings_store import StoredSettings
from .api_session import AgentBudget

PURPOSE_LABEL = {"assistant": "Assistant", "notes": "Notes"}


def task_of(purpose: str) -> Task:
    return "notes" if purpose == "notes" else "agent"


class ApiAgentEngine:
    def __init__(
        self,
        *,
        settings: Callable[[], StoredSettings],
        api_key: Callable[[str], str | None],
        http: httpx.AsyncClient,
        catalogs: ProviderCatalogs,
        timeout: float,
        budget: AgentBudget | None = None,
    ) -> None:
        self._settings = settings
        self._api_key = api_key
        self._http = http
        self._catalogs = catalogs
        self._timeout = timeout
        self.budget = budget or AgentBudget()

    def selection(self, purpose: str) -> tuple[str, str]:
        profile = self._settings().profile(task_of(purpose))
        return profile.provider, profile.model

    def _setup_problem(self, purpose: str) -> str | None:
        settings = self._settings()
        profile = settings.profile(task_of(purpose))
        label = PURPOSE_LABEL.get(purpose, purpose)
        if not profile.model:
            return f"Choose an API model for {label} in settings."
        if profile.provider not in TOOL_PROVIDERS:
            return f"{profile.provider} cannot run agent mode; choose OpenAI, Anthropic or OpenRouter."
        if profile.provider in CLOUD_PROVIDERS and not settings.cloud_consent:
            return (
                f"Sending transcript text to {profile.provider} requires cloud consent; "
                "enable it in settings."
            )
        if not self._api_key(profile.provider):
            return f"No API key stored for {profile.provider}."
        return None

    def problem(self, purpose: str) -> str | None:
        """Why agent mode cannot run now, from stored settings and cached catalogs only."""
        problem = self._setup_problem(purpose)
        if problem is not None:
            return problem
        provider, model = self.selection(purpose)
        entry = self._catalogs.cached_entry(provider, model) if provider == "openrouter" else None
        return tool_support_problem(provider, model, entry)

    async def verify(self, purpose: str) -> tuple[str, str]:
        """Like :meth:`problem`, but may read the provider catalog; raises the reason."""
        problem = self._setup_problem(purpose)
        provider, model = self.selection(purpose)
        if problem is None:
            entry = None
            if provider == "openrouter":
                try:
                    entry = await self._catalogs.find("openrouter", model)
                except CatalogUnavailable:
                    entry = self._catalogs.cached_entry(provider, model)
            problem = tool_support_problem(provider, model, entry)
        if problem is not None:
            raise ValueError(problem + " Nothing was sent; no other model is used instead.")
        return provider, model

    def status(self, purpose: str) -> dict[str, Any]:
        provider, model = self.selection(purpose)
        problem = self.problem(purpose)
        return {"provider": provider, "model": model, "available": problem is None, "reason": problem}

    def gateway(self, purpose: str) -> ToolChatGateway:
        provider, model = self.selection(purpose)
        return build_tool_chat(
            http=self._http, provider=provider, model=model,
            api_key=self._api_key(provider), timeout=self._timeout,
        )

    @staticmethod
    def step_tokens(provider: str, model: str) -> int:
        return step_tokens(provider, model)
