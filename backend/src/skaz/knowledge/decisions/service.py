"""``runtime.kb_decisions``: which decider answers wiki decisions, its state, consent and journal.

The user picks the provider (``off``, ``openrouter_jev``, ``local``) like the
speech provider. ``layer()`` returns the chosen ``DecisionLayer`` or ``None``
when the layer is off — callers then ask the writing agent directly. Nothing
switches providers on its own: a missing key, a missing download or a failed
start answers ``Undecided`` with the reason, which the caller hands to the
writing agent and the journal counts.

The cloud provider needs the user's consent to send wiki text to OpenRouter
(stored in the knowledge database settings, like the Soniox cloud consent);
without it the cloud decider is never constructed and never called.
"""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import httpx

from ...activity import ActivityLog
from ...native_io import disk_call
from ..agents.prompting import untrusted_block
from ..errors import KnowledgeError
from ..store.database import KnowledgeDatabase
from ..store.repositories import SettingsRepository
from .llama import LlamaClient
from .local import LlamaServerManager, LocalDecider, LocalModel, LocalStatus, ServerBuild
from .policy import Thresholds, top_probability
from .protocol import Answer, ChoiceAnswer, ChoiceQuestion, DeciderId, DecisionLayer, Undecided
from .systemone import JEV_MODEL, OPENROUTER_SECRET, OpenRouterJevDecider

DecisionProvider = Literal["off", "openrouter_jev", "local"]
PROVIDERS: tuple[DecisionProvider, ...] = ("off", "openrouter_jev", "local")
PROVIDER_KEY = "decisions.provider"
CONSENT_KEY = "decisions.cloud_consent"

#: Jev's own calibration is not measured on SKAZ data (no key in development): a conservative cut.
CLOUD_THRESHOLDS = Thresholds(choice=0.8, noul=0.8, score=0.5)

CONSENT_REQUIRED = "Allow sending wiki text to OpenRouter before choosing OpenRouter · Jev."
LAYER_OFF = "The decision layer is off."

#: The «Check» probe: authored text, no user data.
TEST_OPTIONS = (
    "Electrical resistance and Ohm's law — opposition to current; I = U/R",
    "Photosynthesis — light-driven synthesis of sugars in plants",
    "None of these — create a new page",
)
TEST_QUESTION = ChoiceQuestion(
    state=untrusted_block("material", (
        "New concept from the material \"Physics, lecture 3\": \"Ohm's law\" — the current through a "
        "conductor is proportional to the voltage across it.")),
    question="Which existing wiki page should this concept be added to?",
    options=TEST_OPTIONS,
)


class DecisionSettingsConflict(KnowledgeError):
    status_code = 409


@dataclass(frozen=True)
class DecisionStats:
    decided: int
    #: Undecided answers: each one went to the writing model.
    undecided: int


@dataclass(frozen=True)
class DecisionsView:
    provider: DecisionProvider
    cloud_consent: bool
    openrouter_key: bool
    cloud_model: str
    local: LocalStatus
    local_model: LocalModel
    local_server: ServerBuild
    stats: DecisionStats


@dataclass(frozen=True)
class TestResult:
    provider: DecisionProvider
    decided: bool
    answer: str | None
    probability: float | None
    reason: str | None
    elapsed_ms: int


class DecisionJournal:
    """Counts decided/undecided per decider; never stores question or answer text."""

    def __init__(self, db: KnowledgeDatabase, activity: ActivityLog | None) -> None:
        self.db = db
        self.activity = activity

    def record(self, decider: DeciderId, primitive: str, answer: Answer, elapsed_ms: int) -> None:
        undecided = isinstance(answer, Undecided)
        outcome = "undecided" if undecided else "decided"
        reason = answer.reason if isinstance(answer, Undecided) else None
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO decision_events(at, decider, primitive, outcome, reason, elapsed_ms) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (datetime.now(UTC).isoformat(timespec="milliseconds"), decider, primitive, outcome, reason,
                 max(0, elapsed_ms)),
            )
        if self.activity is not None:
            self.activity.append({
                "operation": f"kb_decision_{primitive}", "provider": decider,
                "model": JEV_MODEL if decider == "openrouter_jev" else "local",
                "attempt": 1, "elapsed_ms": max(0, elapsed_ms),
                "outcome": "ok" if not undecided else "handed_to_writer",
            })

    def stats(self) -> DecisionStats:
        with self.db.read() as connection:
            rows = dict(connection.execute(
                "SELECT outcome, COUNT(*) FROM decision_events GROUP BY outcome").fetchall())
        return DecisionStats(decided=int(rows.get("decided", 0)), undecided=int(rows.get("undecided", 0)))


class DecisionService:
    def __init__(
        self,
        db: KnowledgeDatabase,
        settings: SettingsRepository,
        *,
        data_dir: Path,
        http: httpx.AsyncClient,
        api_key: Callable[[], str | None],
        activity: ActivityLog | None = None,
        manager: LlamaServerManager | None = None,
    ) -> None:
        self.settings = settings
        self.http = http
        self._api_key = api_key
        self.journal = DecisionJournal(db, activity)
        self.manager = manager or LlamaServerManager(data_dir / "decisions", http)
        self.llama = LlamaClient(http)

    # -- settings -----------------------------------------------------------

    def provider(self) -> DecisionProvider:
        value = self.settings.get(PROVIDER_KEY, "off")
        return value if value in PROVIDERS else "off"

    def cloud_consent(self) -> bool:
        return self.settings.get(CONSENT_KEY, False) is True

    def configure(self, provider: DecisionProvider, cloud_consent: bool | None = None) -> None:
        consent = self.cloud_consent() if cloud_consent is None else cloud_consent
        if provider == "openrouter_jev" and not consent:
            raise DecisionSettingsConflict(CONSENT_REQUIRED)
        if cloud_consent is not None:
            self.settings.set(CONSENT_KEY, cloud_consent)
        self.settings.set(PROVIDER_KEY, provider)

    # -- layer --------------------------------------------------------------

    def layer(self) -> DecisionLayer | None:
        """The decider the user chose, or ``None`` when decisions are off."""
        provider = self.provider()
        if provider == "local":
            return LocalDecider(self.manager, self.llama, observer=self.journal.record)
        if provider == "openrouter_jev" and self.cloud_consent():
            return OpenRouterJevDecider(self.http, api_key=self._api_key, consent=self.cloud_consent,
                                        thresholds=CLOUD_THRESHOLDS, observer=self.journal.record)
        return None

    async def test(self) -> TestResult:
        """One authored probe question for «Check»; not counted in the journal."""
        provider = self.provider()
        started = time.monotonic()
        if provider == "local":
            layer: DecisionLayer = LocalDecider(self.manager, self.llama)
        elif provider == "openrouter_jev":
            layer = OpenRouterJevDecider(self.http, api_key=self._api_key, consent=self.cloud_consent,
                                         thresholds=CLOUD_THRESHOLDS)
        else:
            raise DecisionSettingsConflict(LAYER_OFF)
        answer = await layer.ask(TEST_QUESTION)
        elapsed = int((time.monotonic() - started) * 1000)
        if isinstance(answer, Undecided):
            return TestResult(provider, False, None, None, answer.reason, elapsed)
        option = answer.option if isinstance(answer, ChoiceAnswer) else None
        return TestResult(provider, True, option, top_probability(answer), None, elapsed)

    # -- view and lifecycle -------------------------------------------------

    async def view(self) -> DecisionsView:
        provider, consent = await disk_call(lambda: (self.provider(), self.cloud_consent()))
        stats = await disk_call(self.journal.stats)
        local = await disk_call(self.manager.status)
        return DecisionsView(
            provider=provider, cloud_consent=consent, openrouter_key=bool(self._api_key()),
            cloud_model=JEV_MODEL, local=local, local_model=self.manager.model,
            local_server=self.manager.server, stats=stats,
        )

    async def aclose(self) -> None:
        await self.manager.aclose()

    def kill_now(self) -> None:
        """Synchronous last resort at runtime close (the lifespan normally stopped the server already)."""
        self.manager.kill_now()


__all__ = ["OPENROUTER_SECRET", "DecisionService", "DecisionsView", "TestResult"]
