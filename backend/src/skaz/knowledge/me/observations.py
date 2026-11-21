"""Versioned events and derived evidence for the two offline Me Graph families."""
from __future__ import annotations

import hashlib
from datetime import timedelta
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from . import MAX_VERSIONS, MeConflict

Surface = Literal["study", "chat"]
Family = Literal["study_revision", "chat_return"]
Action = Literal["allow_attempt", "show_walkthrough", "return_to_goal", "continue_branch"]
Signal = Literal["opportunity", "choice", "close", "branch", "attempt", "skip", "repeat"]
Receipt = Literal["accepted", "duplicate", "ignored"]
Opaque = Annotated[str, Field(pattern=r"^[A-Za-z0-9_:-]{1,180}$")]
SHARED_CHAT = "profile:chat-return"
FAMILIES: dict[Family, tuple[Surface, Action, Action]] = {
    "study_revision": ("study", "allow_attempt", "show_walkthrough"),
    "chat_return": ("chat", "return_to_goal", "continue_branch"),
}


class _Evidence(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Offer(_Evidence):
    action: Action
    position: int | None = Field(default=None, ge=0, le=8)
    available: bool = True
    default: bool = False


class TrustedEvent(_Evidence):
    schema_version: Literal[1] = 1
    producer: Surface
    event_id: Opaque
    source_ref: Opaque
    episode_id: Opaque
    scope: Opaque
    session_id: Opaque
    context_key: Opaque
    family: Family
    epoch: Opaque
    sequence: int = Field(ge=0)
    occurred_at: AwareDatetime
    deadline_at: AwareDatetime | None = None
    actor: Literal["user", "agent", "system"]
    kind: Signal
    offered_set: tuple[Offer, ...] = ()
    selected: Action | None = None
    # Source-confirmed evidence that the forecast target was observed without a preceding recap.
    uncued: bool = False


class Forecast(_Evidence):
    version: Literal[1] = 1
    long: float
    recent: float
    base: float
    graph: float


class Episode(_Evidence):
    id: str
    scope: str
    session_id: str
    family: Family
    context_key: str
    epoch: str
    sources: frozenset[str]
    sequence: int
    recorded_at: AwareDatetime
    started_at: AwareDatetime
    deadline_at: AwareDatetime | None = None
    kind: Signal
    offered: tuple[Offer, ...] = ()
    forecast: Forecast | None = None
    eligible: bool = False
    outcome: bool | None = None
    observed_at: AwareDatetime | None = None


class RetainedChat(_Evidence):
    """Counts for deleted chats and one cutoff to prevent looking ahead in historical forecasts."""
    positive: int = 0
    negative: int = 0
    unknown: int = 0
    sessions: int = 0
    latest_outcome: AwareDatetime | None = None


class Hypothesis(_Evidence):
    id: str
    family: Family
    scope: str
    context_key: str
    revision: int
    positive: int
    negative: int
    unknown: int
    sessions: int
    forecast: Forecast
    supports: tuple[str, ...]
    counters: tuple[str, ...]

    @property
    def eligible_to_apply(self) -> bool:
        return self.positive + self.negative >= 5 and self.sessions >= 3 and self.forecast.graph >= 0.70


class Ledger(_Evidence):
    retained_chat: RetainedChat | None = None
    episodes: dict[str, Episode] = Field(default_factory=dict)
    receipts: dict[str, str] = Field(default_factory=dict)
    patterns: dict[str, Hypothesis] = Field(default_factory=dict)
    history: dict[str, tuple[Hypothesis, ...]] = Field(default_factory=dict)
    suppressed: frozenset[str] = frozenset()
    forgotten: frozenset[str] = frozenset()


def forecast(episodes: list[Episode], context: str, retained: RetainedChat | None = None) -> Forecast:
    known = sorted((episode for episode in episodes if episode.outcome is not None),
                   key=lambda x: (x.observed_at or x.recorded_at, x.id))
    here = [item for item in known if item.context_key == context]
    positive = sum(item.outcome is True for item in known)
    n = len(known)
    context_positive = sum(item.outcome is True for item in here)
    context_n = len(here)
    recent = known[-7:]
    recent_n = len(recent)
    recent_positive = float(sum(item.outcome is True for item in recent))
    if retained is not None:
        archived_n = retained.positive + retained.negative
        positive += retained.positive
        n += archived_n
        if context == "branching":
            context_positive += retained.positive
            context_n += archived_n
        # Deletion keeps counts only. Fill missing recent evidence with the archived rate.
        fill = min(7 - recent_n, archived_n)
        if fill:
            recent_positive += fill * retained.positive / archived_n
            recent_n += fill
    long_rate = (positive + 1) / (n + 2)
    recent_rate = (recent_positive + 1) / (recent_n + 2)
    edge = (context_positive + 8 * long_rate) / (context_n + 8)
    return Forecast(long=long_rate, recent=recent_rate, base=(long_rate + recent_rate) / 2,
                    graph=(recent_rate + edge) / 2)


def revocation_key(identity: str) -> str:
    # The prefix is outside the allowed event ID alphabet, including for legacy tombstones.
    return "#" + hashlib.sha256(identity.encode()).hexdigest()


def revoked(identity: str, tombstones: frozenset[str]) -> bool:
    return identity in tombstones or revocation_key(identity) in tombstones


def pattern_id(family: Family, scope: str, context: str) -> str:
    return "pattern-" + hashlib.sha256(f"{family}\0{scope}\0{context}".encode()).hexdigest()[:32]


def _rebuild(ledger: Ledger, family: Family, scope: str, revision: int, *, redact: bool = False) -> Ledger:
    related = [episode for episode in ledger.episodes.values()
               if episode.eligible and episode.family == family and episode.scope == scope]
    patterns = {key: value for key, value in ledger.patterns.items()
                if (value.family, value.scope) != (family, scope)}
    history = {
        key: values for key, values in ledger.history.items()
        if not redact or (values[-1].family, values[-1].scope) != (family, scope)
    }
    contexts = {episode.context_key for episode in related}
    retained = ledger.retained_chat if scope == SHARED_CHAT and family == "chat_return" else None
    if retained:
        contexts.add("branching")
    for context in sorted(contexts):
        here = [episode for episode in related if episode.context_key == context]
        supports = tuple(item.id for item in here if item.outcome is True)
        counters = tuple(item.id for item in here if item.outcome is False)
        key = pattern_id(family, scope, context)
        sessions = len({item.session_id for item in here if item.outcome is not None})
        pattern = Hypothesis(
            id=key, family=family, scope=scope, context_key=context, revision=revision,
            positive=len(supports) + (retained.positive if retained else 0),
            negative=len(counters) + (retained.negative if retained else 0),
            unknown=len(here) - len(supports) - len(counters) + (retained.unknown if retained else 0),
            sessions=sessions + (retained.sessions if retained else 0),
            forecast=forecast(related, context, retained),
            supports=supports, counters=counters,
        )
        patterns[key] = pattern
        history[key] = (*history.get(key, ()), pattern)[-MAX_VERSIONS:]
    return ledger.model_copy(update={"patterns": patterns, "history": history})


def _prune(ledger: Ledger, recorded_at: AwareDatetime, revision: int) -> Ledger:
    # Compact known contributions keep their revocable links. Unresolved events use the initial
    # synthetic retention window in the specification.
    expired = {key for key, item in ledger.episodes.items()
               if item.outcome is None and recorded_at - item.recorded_at > timedelta(days=30)}
    if not expired:
        return ledger
    return _remove(ledger, expired, revision)


def reduce_event(ledger: Ledger, event: TrustedEvent, recorded_at: AwareDatetime,
                 revision: int) -> tuple[Receipt, Ledger]:
    if revoked(event.episode_id, ledger.forgotten):
        return "ignored", ledger
    surface, positive, negative = FAMILIES[event.family]
    if event.scope == SHARED_CHAT and (event.family != "chat_return" or event.context_key != "branching"):
        return "ignored", ledger
    if event.producer != surface:
        return "ignored", ledger
    key = f"{event.producer}:{event.event_id}"
    digest = hashlib.sha256(event.model_dump_json().encode()).hexdigest()
    # Older snapshots used the readable event ID as the receipt key.
    opaque_key = hashlib.sha256(key.encode()).hexdigest()
    old_digest = ledger.receipts.get(opaque_key) or ledger.receipts.get(key)
    if old_digest is not None:
        if old_digest != digest:
            raise MeConflict("A Me event was delivered with different contents.", "event_conflict")
        return "duplicate", ledger
    ledger = _prune(ledger, recorded_at, revision)
    previous = ledger.episodes.get(event.episode_id)
    if previous is None:
        if event.kind in ("choice", "close"):
            return "ignored", ledger
        offered = {item.action for item in event.offered_set if item.available}
        eligible = event.kind == "opportunity" and offered == {positive, negative} and event.actor == "system"
        earlier = [
            item for item in ledger.episodes.values()
            if item.family == event.family and item.scope == event.scope and item.eligible
            and item.observed_at is not None and item.observed_at <= event.occurred_at
        ]
        retained = ledger.retained_chat if event.scope == SHARED_CHAT else None
        if retained and retained.latest_outcome and retained.latest_outcome > event.occurred_at:
            retained = None
        episode = Episode(
            id=event.episode_id, scope=event.scope, session_id=event.session_id, family=event.family,
            context_key=event.context_key, epoch=event.epoch, sources=frozenset({event.source_ref}),
            sequence=event.sequence, recorded_at=recorded_at, started_at=event.occurred_at,
            deadline_at=event.deadline_at, kind=event.kind, offered=event.offered_set,
            eligible=eligible, forecast=forecast(earlier, event.context_key, retained) if eligible else None,
        )
    else:
        if (previous.family, previous.scope, previous.epoch, previous.session_id, previous.context_key) != (
            event.family, event.scope, event.epoch, event.session_id, event.context_key
        ):
            return "ignored", ledger
        if (not previous.eligible or previous.sequence >= event.sequence
                or previous.outcome is not None or event.kind not in ("choice", "close")):
            return "ignored", ledger
        outcome = None
        observed_at = None
        if event.kind == "choice":
            if (event.actor != "user" or event.selected not in (positive, negative)
                    or event.occurred_at < previous.started_at
                    or (previous.deadline_at is not None and event.occurred_at > previous.deadline_at)
                    or (surface == "chat" and not event.uncued)):
                return "ignored", ledger
            outcome = event.selected == positive
            observed_at = event.occurred_at
        episode = previous.model_copy(update={
            "sources": previous.sources | {event.source_ref}, "sequence": event.sequence,
            "recorded_at": recorded_at, "kind": event.kind, "outcome": outcome, "observed_at": observed_at,
        })
    changed = ledger.model_copy(update={
        "episodes": {**ledger.episodes, episode.id: episode},
        "receipts": {**ledger.receipts, opaque_key: digest},
    })
    if episode.eligible:
        changed = _rebuild(changed, episode.family, episode.scope, revision)
    return "accepted", changed


def _remove(ledger: Ledger, removed: set[str], revision: int) -> Ledger:
    touched: set[tuple[Family, str]] = set()
    cutoffs: dict[tuple[Family, str], AwareDatetime] = {}
    for key in removed:
        item = ledger.episodes[key]
        if item.eligible:
            group = item.family, item.scope
            touched.add(group)
            if item.observed_at is not None:
                cutoffs[group] = min(cutoffs.get(group, item.observed_at), item.observed_at)
    episodes = {}
    for key, item in ledger.episodes.items():
        if key in removed:
            continue
        cutoff = cutoffs.get((item.family, item.scope))
        if item.forecast is not None and cutoff is not None and cutoff <= item.started_at:
            # This historical forecast may depend on withdrawn evidence. Recomputing it would
            # misrepresent what was actually predicted before the decision.
            item = item.model_copy(update={"forecast": None})
        episodes[key] = item
    changed = ledger.model_copy(update={
        "episodes": episodes,
        "forgotten": ledger.forgotten.union(map(revocation_key, removed)),
    })
    for family, scope in touched:
        changed = _rebuild(changed, family, scope, revision, redact=True)
    return changed


def retract(ledger: Ledger, sources: frozenset[str], scopes: frozenset[str], revision: int,
            *, preserve: frozenset[str] = frozenset(),
            discard_sources: frozenset[str] = frozenset()) -> Ledger:
    removed = {key for key, item in ledger.episodes.items()
               if item.sources.intersection(sources) or item.scope in scopes
               or (item.scope == SHARED_CHAT and item.session_id in scopes)}
    if not removed:
        return ledger
    if any(":" in key for key in ledger.receipts):
        receipts = {hashlib.sha256(key.encode()).hexdigest() if ":" in key else key: value
                    for key, value in ledger.receipts.items()}
        ledger = ledger.model_copy(update={"receipts": receipts})
    saved = []
    for key in removed:
        item = ledger.episodes[key]
        if (not item.eligible or item.family != "chat_return" or item.context_key != "branching"
                or item.session_id not in preserve or item.sources.intersection(discard_sources)):
            continue
        # A local pre-upgrade pattern may contribute only on the owner's retention choice.
        if item.scope == SHARED_CHAT or (item.scope == item.session_id and
                pattern_id(item.family, item.scope, item.context_key) not in ledger.suppressed):
            saved.append(item)
    if saved:
        old = ledger.retained_chat or RetainedChat()
        known = [item for item in saved if item.outcome is not None]
        positive = sum(item.outcome is True for item in known)
        times = [item.observed_at for item in known if item.observed_at is not None]
        if old.latest_outcome is not None:
            times.append(old.latest_outcome)
        retained = RetainedChat(
            positive=old.positive + positive, negative=old.negative + len(known) - positive,
            unknown=old.unknown + len(saved) - len(known),
            sessions=old.sessions + len({item.session_id for item in known}),
            latest_outcome=max(times, default=None),
        )
        ledger = ledger.model_copy(update={"retained_chat": retained})
    changed = _remove(ledger, removed, revision)
    if saved and not any(ledger.episodes[key].scope == SHARED_CHAT for key in removed):
        changed = _rebuild(changed, "chat_return", SHARED_CHAT, revision, redact=True)
    return changed


def forget(ledger: Ledger, pattern: Hypothesis, revision: int) -> Ledger:
    context = pattern.family, pattern.scope, pattern.context_key
    removed = {key for key, item in ledger.episodes.items()
               if (item.family, item.scope, item.context_key) == context}
    if pattern.scope == SHARED_CHAT:
        ledger = ledger.model_copy(update={"retained_chat": None})
    changed = _remove(ledger, removed, revision)
    if not removed:
        changed = _rebuild(changed, pattern.family, pattern.scope, revision, redact=True)
    return changed
