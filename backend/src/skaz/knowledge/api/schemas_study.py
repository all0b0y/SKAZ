"""Pydantic models of the study block (``KbStudyPart``) and ``/kb/study`` (0.3.1 S).

No defaults on responses.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .schemas import KbCitation

KbStudyGrade = Literal["again", "hard", "good", "easy"]
KbStudyGroup = Literal["new", "learning", "known", "hard"]
KbStudyMode = Literal["due", "new", "hard", "quick10", "all"]
KbStudyPlace = Literal["chat", "panel", "window"]
KbStudySide = Literal["question", "answer"]
KbStudyMark = Literal["hard", "known", "hide", "unhide", "unhard"]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KbStudyIntervals(BaseModel):
    """What each grade schedules ("10m", "3d"); ``null`` where a practice mode leaves the schedule alone."""

    again: str | None
    hard: str | None
    good: str | None
    easy: str | None


class KbStudyCard(BaseModel):
    id: str
    #: The deck page the card is on; ``null`` while the deck is not saved.
    page_id: str | None
    question: str
    #: The answer from the source; its citations hold the checked quotes.
    answer: str
    citations: list[KbCitation]
    #: The agent's own explanation (example, mnemonic), shown as "Agent explanation".
    explanation: str | None
    group: KbStudyGroup
    state: Literal["new", "learning", "review", "relearning"]
    #: "I know this — don't show": left out of every review.
    suspended: bool
    marked_hard: bool
    intervals: KbStudyIntervals
    #: The grade given in this block.
    graded: KbStudyGrade | None
    due: str | None


class KbStudyOption(BaseModel):
    id: str
    text: str
    #: ``source``: a right answer from the source; ``agent``: made up by the agent (said after checking).
    origin: Literal["source", "agent"]


class KbStudyResponse(BaseModel):
    """The user's answer to one question in the current attempt."""

    choices: list[str]
    text: str | None
    checked: bool
    #: 1 right, 0.5 partly (open answers, the agent's opinion), 0 wrong; ``null`` before checking.
    score: float | None
    #: Open answers: "right" / "partly" / "wrong" — the agent's opinion, not a fact.
    verdict: str | None
    missing: str | None
    comment: str | None
    #: The agent is checking it now.
    checking: bool
    error: str | None


class KbStudyQuestion(BaseModel):
    id: str
    type: Literal["choice", "multi", "short", "open"]
    question: str
    #: choice / multi: right and made-up options in a fixed order (the origin is shown after checking).
    options: list[KbStudyOption]
    #: The right answer(s) from the source (shown after checking).
    answers: list[str]
    citations: list[KbCitation]
    explanation: str | None
    response: KbStudyResponse | None


class KbStudySave(BaseModel):
    """The block's last row (S6): "<Agent> wants to create <path> · Deny · Save to wiki" and what happened."""

    status: Literal["none", "pending", "saved", "denied"]
    path: str
    page_id: str | None


class KbStudyResultRow(BaseModel):
    id: str
    score: float | None


class KbStudyResult(BaseModel):
    correct: float
    total: int
    mistakes: int
    #: Open answers the agent judged partly right.
    partly: int
    rows: list[KbStudyResultRow]


class KbStudyGroups(BaseModel):
    new: int
    learning: int
    known: int
    hard: int


class KbStudyPart(BaseModel):
    """A deck or test block in a chat (S5, W2): lives in one place — the chat, beside it, or its window."""

    type: Literal["study"]
    id: str
    kind: Literal["deck", "test"]
    title: str
    engine: str | None
    #: ``agent``: made in this answer (with "Save to wiki"); ``show``: saved decks/test shown again.
    origin: Literal["agent", "show"]
    mode: KbStudyMode
    place: KbStudyPlace
    #: Index of the current card / question; equal to ``total`` past the last one.
    position: int
    side: KbStudySide
    total: int
    cards: list[KbStudyCard]
    questions: list[KbStudyQuestion]
    groups: KbStudyGroups
    #: New cards left out today by the folder's limit (S8).
    held_back: int
    save: KbStudySave
    result: KbStudyResult | None
    chat_id: str
    message_id: str


class KbStudyMove(_Request):
    place: KbStudyPlace | None = None
    position: int | None = Field(default=None, ge=0, le=10_000)
    side: KbStudySide | None = None


class KbStudyGradeIn(_Request):
    item_id: str = Field(min_length=1, max_length=120)
    grade: KbStudyGrade


class KbStudyMarkIn(_Request):
    item_ids: list[str] = Field(min_length=1, max_length=500)
    mark: KbStudyMark


class KbStudyAnswerIn(_Request):
    item_id: str = Field(min_length=1, max_length=120)
    choices: list[str] | None = Field(default=None, max_length=12)
    text: str | None = Field(default=None, max_length=5_000)


class KbStudyRetake(_Request):
    mistakes_only: bool = False


class KbStudySaveIn(_Request):
    decision: Literal["allow", "deny"]


class KbDeckView(BaseModel):
    page_id: str
    title: str
    cards: list[KbStudyCard]
    groups: KbStudyGroups
    #: Cards whose review date has come.
    due: int


class KbDeckStudy(_Request):
    mode: KbStudyMode = "due"
    card_ids: list[str] | None = Field(default=None, max_length=500)
    #: The chat to study in; ``null`` = a new chat "Study · <deck>".
    chat_id: str | None = Field(default=None, max_length=200)


class KbDeckStudyResult(BaseModel):
    chat_id: str
    study: KbStudyPart


class KbStudySettings(BaseModel):
    #: New cards per day, per folder (S8, Q14); 20 by default.
    new_per_day: int


class KbStudySettingsPatch(_Request):
    new_per_day: int = Field(ge=0, le=9999)
