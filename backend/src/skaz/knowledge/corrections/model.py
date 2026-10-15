"""``.skaz/corrections.json``: the source of truth of a material's recognition corrections.

The transcript ``<Title>.md`` never changes; a correction says "at ``start``
of fragment ``seg`` the recogniser wrote ``before``, it was ``after``". Only
``applied`` corrections change the text the wiki and the material view use.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

CORRECTIONS_FILE = "corrections.json"
CorrectionState = Literal["applied", "doubtful", "reverted", "kept"]
CORRECTION_STATES: tuple[CorrectionState, ...] = ("applied", "doubtful", "reverted", "kept")


class CorrectionEntry(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str = Field(pattern=r"^cor-[A-Za-z0-9-]+$")
    seg: int = Field(ge=1)
    #: Offset of ``before`` in the fragment text as recognised (never the corrected text).
    start: int = Field(ge=0)
    before: str = Field(min_length=1)
    after: str
    reason: str = ""
    confidence: float | None = None
    state: CorrectionState
    #: Applied by SKAZ because the decision layer was confident (not by the user).
    auto: bool = False
    created_at: str
    decided_at: str | None = None

    @property
    def end(self) -> int:
        return self.start + len(self.before)


class CorrectionsFile(BaseModel):
    model_config = ConfigDict(extra="allow")
    format: Literal[1] = 1
    material_id: str
    #: When the recognition check ran; it runs once per material.
    checked_at: str | None = None
    corrections: list[CorrectionEntry] = Field(default_factory=list)

    def by_id(self, correction_id: str) -> CorrectionEntry | None:
        return next((entry for entry in self.corrections if entry.id == correction_id), None)

    def for_seg(self, seg: int) -> list[CorrectionEntry]:
        return [entry for entry in self.corrections if entry.seg == seg]


def apply_to_text(text: str, corrections: Iterable[CorrectionEntry]) -> str:
    """``text`` with the applied corrections; one that no longer matches its place is skipped."""
    applied = sorted((entry for entry in corrections if entry.state == "applied"), key=lambda e: e.start)
    pieces: list[str] = []
    cursor = 0
    for entry in applied:
        if entry.start < cursor or text[entry.start : entry.end] != entry.before:
            continue  # overlapping or stale: the recognised text is kept rather than guessed at
        pieces.append(text[cursor : entry.start])
        pieces.append(entry.after)
        cursor = entry.end
    pieces.append(text[cursor:])
    return "".join(pieces)


def overlaps(entries: Sequence[CorrectionEntry], seg: int, start: int, end: int) -> bool:
    return any(entry.seg == seg and entry.start < end and start < entry.end for entry in entries)
