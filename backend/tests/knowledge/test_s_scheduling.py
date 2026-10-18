"""FSRS scheduling, groups and modes of cards (0.3.1 S1, S8, S9)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from skaz.knowledge.study.scheduling import (
    CardState,
    NewBudget,
    group_of,
    interval_label,
    pick,
    preview,
    review,
)

T0 = datetime(2026, 10, 18, 9, 0, tzinfo=UTC)


def test_a_new_card_learns_then_reviews_with_growing_intervals() -> None:
    card = CardState("c-1", "pg-1")
    assert card.is_new and group_of(card) == "new"
    shown = preview(card, mode="due", at=T0)
    assert shown["again"] == "1m" and shown["good"] == "10m"
    card, scheduled = review(card, "good", mode="due", at=T0)
    assert scheduled and card.state == "learning" and group_of(card) == "learning"
    card, _ = review(card, "good", mode="due", at=T0 + timedelta(minutes=10))
    assert card.state == "review" and group_of(card) == "known"
    first = card.due
    assert first is not None and first - (T0 + timedelta(minutes=10)) >= timedelta(days=1)
    card, _ = review(card, "good", mode="due", at=first)
    assert card.due is not None and card.due - first > first - (T0 + timedelta(minutes=10))


def test_practice_modes_keep_the_schedule_except_again() -> None:
    card, _ = review(CardState("c-2", "pg-1"), "easy", mode="due", at=T0)
    before = card
    for mode in ("hard", "quick10", "all"):
        same, scheduled = review(card, "good", mode=mode, at=T0 + timedelta(days=1))
        assert same == before and not scheduled
        assert preview(card, mode=mode, at=T0)["good"] is None
    again, scheduled = review(card, "again", mode="all", at=T0 + timedelta(days=2))
    assert scheduled and again.state == "relearning" and again.lapses == 1


def test_hard_known_and_suspended_groups() -> None:
    card = CardState("c-3", "pg-1", marked_hard=True)
    assert group_of(card) == "hard"
    assert group_of(CardState("c-4", "pg-1", suspended=True)) == "known"
    lapsed = CardState("c-5", "pg-1", lapses=2)
    assert group_of(lapsed) == "hard"


def test_modes_pick_due_new_within_folder_limits_hard_and_quick() -> None:
    new = [CardState(f"n-{i}", "pg-1") for i in range(4)]
    known, _ = review(CardState("k-1", "pg-1"), "easy", mode="due", at=T0)
    hard = CardState("h-1", "pg-1", marked_hard=True)
    hidden = CardState("s-1", "pg-1", suspended=True)
    pairs = [(state, "fold-a") for state in [*new, known, hard, hidden]]
    later = (known.due or T0) + timedelta(seconds=1)
    due = pick(pairs, "due", NewBudget(per_day=2), at=later)
    # A new card marked hard is still new: it waits for the limit like the others.
    assert due.card_ids == ("k-1", "n-0", "n-1") and due.held_back == 3
    # Another folder has its own limit.
    other = pick([(CardState("x-1", "pg-2"), "fold-b")], "new", NewBudget(per_day=2, used={"fold-a": 2}))
    assert other.card_ids == ("x-1",)
    assert pick(pairs, "hard", NewBudget(20)).card_ids == ("h-1",)
    assert "s-1" not in pick(pairs, "all", NewBudget(20)).card_ids
    assert pick(pairs, "quick10", NewBudget(20)).card_ids == ("k-1",)


def test_interval_labels() -> None:
    assert [
        interval_label(timedelta(seconds=s)) for s in (30, 600, 7200, 3 * 86400, 70 * 86400, 800 * 86400)
    ] == ["1m", "10m", "2h", "3d", "2mo", "2.2y"]
