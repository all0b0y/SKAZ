"""Spaced repetition of cards with FSRS (decisions S1, S8, S9).

``fsrs`` (py-fsrs 6.3.2, MIT, github.com/open-spaced-repetition/py-fsrs) does the maths; this module
keeps what SKAZ adds around it:

* a card's state is stored by its block id (``^c-…``) and never in the Markdown file (S2);
* intervals are not fuzzed, so the interval shown on a grade button is the one that is applied;
* groups for the deck page and the agent: New, Learning, Known, Hard (S8);
* modes: "Due today" and "New only" are ordinary FSRS reviews; "Hard only", "Quick 10" and "Review
  all" are practice — they leave the schedule alone, except Again, which is recorded and sends the
  card back to Learning (S9 variant A);
* "I know this — don't show" suspends a card; it counts as Known and leaves every mode.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from fsrs import Card, Rating, Scheduler, State

Grade = Literal["again", "hard", "good", "easy"]
Group = Literal["new", "learning", "known", "hard"]
Mode = Literal["due", "new", "hard", "quick10", "all"]
GRADES: tuple[Grade, ...] = ("again", "hard", "good", "easy")
RATING: dict[Grade, Rating] = {
    "again": Rating.Again,
    "hard": Rating.Hard,
    "good": Rating.Good,
    "easy": Rating.Easy,
}
#: Modes that are ordinary FSRS reviews; the rest are practice (S9).
SCHEDULED_MODES: frozenset[str] = frozenset({"due", "new"})
MODES: tuple[Mode, ...] = ("due", "new", "hard", "quick10", "all")
#: A card forgotten this many times is "Hard" (S8: "often forgotten").
HARD_LAPSES = 2
QUICK = 10
DEFAULT_NEW_PER_DAY = 20

_SCHEDULER = Scheduler(enable_fuzzing=False)


def now_utc() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class CardState:
    """What SKAZ keeps of one card (``study_cards``); ``fsrs`` is ``None`` while the card is new."""

    card_id: str
    page_id: str
    fsrs: dict[str, Any] | None = None
    lapses: int = 0
    reps: int = 0
    suspended: bool = False
    marked_hard: bool = False

    @property
    def is_new(self) -> bool:
        return self.fsrs is None

    def card(self) -> Card:
        if self.fsrs is None:
            return Card(card_id=_numeric(self.card_id))
        return Card.from_dict(self.fsrs)  # type: ignore[arg-type]

    @property
    def due(self) -> datetime | None:
        return self.card().due if self.fsrs is not None else None

    @property
    def state(self) -> Literal["new", "learning", "review", "relearning"]:
        if self.fsrs is None:
            return "new"
        value = State(self.card().state)
        return (
            "learning" if value == State.Learning else "relearning" if value == State.Relearning else "review"
        )


def _numeric(card_id: str) -> int:
    """py-fsrs wants an int id; it is only an id inside its own dict (SKAZ keys by the block id)."""
    return int.from_bytes(card_id.encode("utf-8")[-6:].rjust(6, b"\0"), "big")


def group_of(state: CardState) -> Group:
    if state.marked_hard or state.lapses >= HARD_LAPSES:
        return "hard"
    if state.suspended:
        return "known"
    if state.is_new:
        return "new"
    return "known" if state.state == "review" else "learning"


def retrievability(state: CardState, at: datetime | None = None) -> float:
    if state.is_new:
        return 0.0
    return float(_SCHEDULER.get_card_retrievability(state.card(), at or now_utc()))


def review(
    state: CardState, grade: Grade, *, mode: Mode, at: datetime | None = None
) -> tuple[CardState, bool]:
    """The card after a grade, and whether FSRS recorded it (``scheduled``).

    Practice modes (hard / quick10 / all) record only Again; every other grade there leaves the card
    as it was (S9 variant A).
    """
    moment = at or now_utc()
    if mode not in SCHEDULED_MODES and grade != "again":
        return state, False
    card, _log = _SCHEDULER.review_card(state.card(), RATING[grade], review_datetime=moment)
    lapsed = grade == "again" and state.state == "review"
    return replace(
        state, fsrs=dict(card.to_dict()), reps=state.reps + 1, lapses=state.lapses + (1 if lapsed else 0)
    ), True


def preview(state: CardState, *, mode: Mode, at: datetime | None = None) -> dict[Grade, str | None]:
    """The interval each grade gives, as a short label ("1m", "10m", "3d", "4mo"); ``None`` where a
    practice mode leaves the schedule alone."""
    moment = at or now_utc()
    out: dict[Grade, str | None] = {}
    for grade in GRADES:
        if mode not in SCHEDULED_MODES and grade != "again":
            out[grade] = None
            continue
        card, _log = _SCHEDULER.review_card(state.card(), RATING[grade], review_datetime=moment)
        out[grade] = interval_label(card.due - moment)
    return out


def interval_label(delta: timedelta) -> str:
    seconds = max(0, int(delta.total_seconds()))
    minutes = round(seconds / 60)
    if minutes < 60:
        return f"{max(minutes, 1)}m"
    hours = round(seconds / 3600)
    if hours < 24:
        return f"{hours}h"
    days = round(seconds / 86400)
    if days < 31:
        return f"{days}d"
    if days < 365:
        return f"{round(days / 30)}mo"
    return f"{round(days / 365, 1):g}y"


@dataclass(frozen=True)
class Pick:
    """The cards a mode shows, in order."""

    card_ids: tuple[str, ...]
    #: New cards left out because the folder's new-card limit for today was reached.
    held_back: int = 0


@dataclass
class NewBudget:
    """New cards each folder may still show today (S8 limit per folder, decision Q14)."""

    per_day: int
    used: dict[str, int] = field(default_factory=dict)

    def take(self, folder: str) -> bool:
        if self.used.get(folder, 0) >= self.per_day:
            return False
        self.used[folder] = self.used.get(folder, 0) + 1
        return True


def pick(
    states: list[tuple[CardState, str]], mode: Mode, budget: NewBudget, at: datetime | None = None
) -> Pick:
    """Cards of a mode from ``(state, folder)`` pairs in deck order; suspended cards never show."""
    moment = at or now_utc()
    live = [(state, folder) for state, folder in states if not state.suspended]
    held = 0
    chosen: list[str] = []
    if mode in ("due", "new"):
        if mode == "due":
            due = [(s, f) for s, f in live if not s.is_new and s.due is not None and s.due <= moment]
            due.sort(key=lambda item: item[0].due or moment)
            chosen += [s.card_id for s, _f in due]
        for state, folder in live:
            if state.is_new:
                if budget.take(folder):
                    chosen.append(state.card_id)
                else:
                    held += 1
    elif mode == "hard":
        chosen = [s.card_id for s, _f in live if group_of(s) == "hard"]
    elif mode == "quick10":
        seen = [s for s, _f in live if not s.is_new]
        seen.sort(key=lambda s: retrievability(s, moment))
        chosen = [s.card_id for s in seen[:QUICK]]
    else:
        chosen = [s.card_id for s, _f in live]
    return Pick(tuple(chosen), held)


def dump(state: CardState) -> str:
    return json.dumps(state.fsrs, separators=(",", ":")) if state.fsrs is not None else ""


def load_fsrs(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    value = json.loads(raw)
    return value if isinstance(value, dict) else None
