"""Monologues: the unit a note or an answer cites.

A monologue is one continuous stretch of one speaker's speech. It replaces the
pause-only "passage" as the citation unit, so the transcript view, the notes and
the assistant all name the same thing.

Nothing here is stored. Monologues are rebuilt from the tokens on every read and
their numbering is display-only; what a citation keeps is the stable id of the
token a monologue starts at, plus the token range inside it. Editing a word, or
splitting one sentence into two, therefore leaves a citation pointing at the same
speech. Only deleting the cited tokens outright breaks it, and that breakage is
reported rather than silently repaired.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: A pause longer than this ends a monologue even when the speaker has not changed.
#: Long enough to survive breathing and the recorder's chunk edges, short enough that
#: a 40-minute lecture does not collapse into a single unreferenceable block.
MONOLOGUE_GAP_MS = 2_500
#: Hard ceilings so an uninterrupted speaker is still cut into citable blocks.
MAX_MONOLOGUE_MS = 120_000
MAX_MONOLOGUE_CHARS = 1_500

#: End of a sentence: terminal punctuation, optionally closing a quote or bracket.
_SENTENCE_END = re.compile(r"[.!?…]['\")\]]*\s*$")


@dataclass(frozen=True)
class Token:
    """One recognised token with a stable id. The unit anchors are expressed in."""

    id: str
    text: str
    start_ms: int
    end_ms: int
    speaker: int | None = None
    #: The stored segment this token was filed under, when there is one. Kept so a
    #: citation can still scroll the transcript and seek the player, which address
    #: speech by segment; it is never what the anchor resolves by.
    segment_id: str | None = None


@dataclass(frozen=True)
class Monologue:
    """Continuous speech by one speaker, addressed by the id of its first token."""

    id: str
    speaker: int | None
    tokens: tuple[Token, ...]

    @property
    def text(self) -> str:
        return "".join(token.text for token in self.tokens).strip()

    @property
    def start_ms(self) -> int:
        return self.tokens[0].start_ms

    @property
    def end_ms(self) -> int:
        return self.tokens[-1].end_ms


@dataclass(frozen=True)
class Anchor:
    """A citation target: a token range inside one monologue.

    ``monologue_id`` and the two token ids are what survives in storage. The
    monologue's number and the speaker's label are worked out when the anchor is
    shown, against the transcript as it is at that moment.
    """

    monologue_id: str
    start_token_id: str
    end_token_id: str
    text: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class ResolvedAnchor:
    """Where an anchor points right now, once the transcript has been rebuilt."""

    anchor: Anchor
    monologue: Monologue
    #: Display-only, 1-based, in recording order. Never stored.
    number: int
    tokens: tuple[Token, ...]


def build(tokens: list[Token]) -> list[Monologue]:
    """Group tokens into monologues in recording order.

    A monologue ends when the speaker changes, when the silence before the next
    token exceeds :data:`MONOLOGUE_GAP_MS`, or when it reaches the duration or
    length ceiling. The speaker rule uses only what diarisation actually reported:
    tokens without a speaker keep ``None`` and are cut by pause and size alone,
    never assigned to a neighbouring speaker.
    """
    ordered = sorted(tokens, key=lambda token: (token.start_ms, token.id))
    monologues: list[list[Token]] = []
    for token in ordered:
        current = monologues[-1] if monologues else None
        if current is not None and _continues(current, token):
            current.append(token)
        else:
            monologues.append([token])
    return [
        Monologue(id=group[0].id, speaker=group[0].speaker, tokens=tuple(group))
        for group in monologues
        if any(token.text.strip() for token in group)
    ]


def _continues(current: list[Token], token: Token) -> bool:
    if token.speaker != current[0].speaker:
        return False
    if token.start_ms - current[-1].end_ms > MONOLOGUE_GAP_MS:
        return False
    if token.end_ms - current[0].start_ms > MAX_MONOLOGUE_MS:
        return False
    return sum(len(item.text) for item in current) <= MAX_MONOLOGUE_CHARS


def sentences(monologue: Monologue) -> list[tuple[Token, ...]]:
    """Split one monologue into sentences by punctuation.

    Automatic transcripts punctuate unevenly, so the last sentence often has no
    terminal mark; it is still returned rather than dropped. A sentence is only
    ever a hint for choosing an anchor — the anchor itself is the token range, so
    a later re-split of the same speech does not move it.
    """
    result: list[tuple[Token, ...]] = []
    current: list[Token] = []
    for token in monologue.tokens:
        current.append(token)
        if _SENTENCE_END.search(token.text):
            result.append(tuple(current))
            current = []
    if current:
        result.append(tuple(current))
    return result


def anchor(monologue: Monologue, tokens: tuple[Token, ...]) -> Anchor:
    """The stored form of "this stretch of this monologue"."""
    if not tokens:
        raise ValueError("An anchor must name at least one token.")
    return Anchor(
        monologue_id=monologue.id,
        start_token_id=tokens[0].id,
        end_token_id=tokens[-1].id,
        text="".join(token.text for token in tokens).strip(),
        start_ms=tokens[0].start_ms,
        end_ms=tokens[-1].end_ms,
    )


def resolve(anchor_: Anchor, monologues: list[Monologue]) -> ResolvedAnchor | None:
    """Where ``anchor_`` points in ``monologues``, or ``None`` when it no longer holds.

    Resolution is by identity only. A monologue that was re-cut — by an edit, a
    manual recheck, or new diarisation — may no longer start at the stored token;
    the anchor is then looked up by the token range it names, which is what the
    citation is actually about. When neither endpoint survives, this returns
    ``None`` so the caller can mark the citation stale. It never falls back to a
    nearby monologue: a citation that silently moves is worse than one that admits
    it is gone.
    """
    for number, monologue in enumerate(monologues, start=1):
        ids = [token.id for token in monologue.tokens]
        if anchor_.start_token_id not in ids:
            continue
        start = ids.index(anchor_.start_token_id)
        end = ids.index(anchor_.end_token_id) if anchor_.end_token_id in ids else len(ids) - 1
        if end < start:
            end = start
        return ResolvedAnchor(
            anchor=anchor_,
            monologue=monologue,
            number=number,
            tokens=monologue.tokens[start : end + 1],
        )
    return None


def speaker_label(monologue: Monologue) -> str:
    """What the reader sees. Undiarised speech says so instead of guessing a number."""
    return "Спикер не определён" if monologue.speaker is None else f"Спикер {monologue.speaker}"
