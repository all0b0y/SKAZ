"""P3-d: one pass through a deck — the binary scheme of decisions 13–15.

«I know this» = Good: the card leaves the pile. Skipped without knowing it (→, a swipe) = Again,
recorded once per pass at the first skip; the card goes under the pile and comes back this pass. ←
brings back the card skipped last. The pass ends when no card is left; «Go through again» starts a
new one. Pure state over card ids; the service records the grades and keeps it in the block.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

PassAction = Literal["know", "skip", "back", "restart"]


@dataclass
class Pass:
    #: The pile, top first.
    queue: list[str] = field(default_factory=list)
    #: Cards graded Again in this pass (once each).
    again: list[str] = field(default_factory=list)
    #: Cards the user knew in this pass (they left the pile).
    known: list[str] = field(default_factory=list)
    #: Skipped cards, the last one last (← brings it back).
    thrown: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {"queue": self.queue, "again": self.again, "known": self.known, "thrown": self.thrown}


def read_pass(state: Mapping[str, Any], ids: Sequence[str], position: int) -> Pass:
    """The block's pass, its ids checked against the cards now there; a card new in the block goes under
    the pile; a block from before P3-d starts with the cards from its position on."""
    stored = state.get("pass")
    alive = set(ids)
    if not isinstance(stored, Mapping):
        return Pass(queue=list(ids[position:]))

    def kept(key: str) -> list[str]:
        return [str(i) for i in stored.get(key) or [] if str(i) in alive]

    queue, known = kept("queue"), kept("known")
    seen = {*queue, *known}
    queue += [i for i in ids if i not in seen]  # cards added to the deck meanwhile join the pile (L6)
    return Pass(queue, kept("again"), known, kept("thrown"))


def fresh_pass(ids: Sequence[str]) -> Pass:
    return Pass(queue=list(ids))


def apply(current: Pass, action: PassAction, card_id: str | None, ids: Sequence[str]) -> tuple[Pass, bool]:
    """The pass after ``action``, and whether the card gets Again now (the first skip in this pass)."""
    queue, again = list(current.queue), list(current.again)
    known, thrown = list(current.known), list(current.thrown)
    if action == "restart":
        return fresh_pass(ids), False
    if action == "back":
        if thrown:
            last = thrown.pop()
            queue = [last, *(i for i in queue if i != last)]
        return Pass(queue, again, known, thrown), False
    if card_id is None or card_id not in queue:
        raise ValueError("This card is not on the pile.")
    queue.remove(card_id)
    if action == "know":
        known.append(card_id)
        thrown = [i for i in thrown if i != card_id]
        return Pass(queue, again, known, thrown), False
    first = card_id not in again
    if first:
        again.append(card_id)
    queue.append(card_id)  # under the pile: it comes back in this pass
    thrown.append(card_id)
    return Pass(queue, again, known, thrown), first
