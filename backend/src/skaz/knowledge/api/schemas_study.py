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
#: ``unclear`` / ``clear``: the user's «Unclear» mark (P3-b) — on the item, never FSRS.
KbStudyMark = Literal["hard", "known", "hide", "unhide", "unhard", "unclear", "clear"]


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
    #: P3-b: the user marked it «Unclear» (wants to talk it through); only the user clears it.
    unclear: bool = False


class KbStudyOption(BaseModel):
    id: str
    text: str
    #: ``source``: a right answer from the source; ``agent``: made up by the agent (said after checking).
    origin: Literal["source", "agent"]


class KbStudyIdeaRecheck(BaseModel):
    """«I did say this» (P3-a 6a): the agent's second look at one key idea for the words the user chose."""

    #: ``null`` when the recheck failed (the note says so).
    status: Literal["covered", "partial", "missing"] | None
    note: str | None
    words: str


class KbStudyIdeaReview(BaseModel):
    """One key idea of the question and how the answer covers it (P3-a decision 2) — the agent's opinion."""

    id: str
    text: str
    #: Where the source says it (checked quotes).
    citations: list[KbCitation]
    status: Literal["covered", "partial", "missing"]
    #: Partial: the user's own words that came close (verbatim from the answer).
    yours: str | None
    #: Why it matters (not for a covered idea).
    why: str | None
    #: ``source``: from the user's sources (``why_citations``); ``agent``: the agent's own knowledge.
    why_basis: Literal["source", "agent"] | None
    why_citations: list[KbCitation]
    #: «counted by you»: the user counts the idea as said; the score counts it as covered.
    by_user: bool
    recheck: KbStudyIdeaRecheck | None
    rechecking: bool


class KbStudyModelPiece(BaseModel):
    """A piece of the model answer: the user's own words, or an addition for a key idea (underlined)."""

    text: str
    idea: str | None
    added: bool


class KbStudyAlsoRight(BaseModel):
    """«Also right in your answer» (P3-a 6b): beyond the key ideas; never changes the score."""

    text: str
    basis: Literal["source", "agent"]
    citations: list[KbCitation]


class KbStudyReview(BaseModel):
    """The review of an open answer, kept in the attempt: shown again without asking the agent again."""

    ideas: list[KbStudyIdeaReview]
    model_answer: list[KbStudyModelPiece]
    also_right: list[KbStudyAlsoRight]
    comment: str | None


class KbStudyResponse(BaseModel):
    """The user's answer to one question in the current attempt."""

    choices: list[str]
    text: str | None
    checked: bool
    #: 1 right, 0 not yet; an open answer: the share of its key ideas SKAZ counted from the review
    #: (P3-a decision 5); ``null`` before checking.
    score: float | None
    #: Open answers (P3-a): «Got it» (share ≥ 0.8) / «Almost there» / «Not yet» (0) — from ``score``.
    status: Literal["got", "almost", "not_yet"] | None = None
    #: Open answers: "right" / "partly" / "wrong" — the agent's opinion, not a fact.
    verdict: str | None
    missing: str | None
    comment: str | None
    #: Open answers: who gave the verdict, «Codex · gpt-…» (bug 1, 2026-10-26); ``null`` before.
    checked_by: str | None = None
    #: The agent is checking it now.
    checking: bool
    error: str | None
    #: Open answers checked since P3-a: key ideas, model answer, «Also right»; ``null`` before.
    review: KbStudyReview | None = None


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
    #: P3-b: the user marked it «Unclear»; it survives retakes and right answers.
    unclear: bool = False


class KbStudySave(BaseModel):
    """The block's last row (S6): "<Agent> wants to create <path> · Deny · Save to wiki" and what happened."""

    status: Literal["none", "pending", "saved", "denied"]
    path: str
    page_id: str | None


class KbStudyResultRow(BaseModel):
    id: str
    score: float | None
    #: Open answers reviewed since P3-a (``got`` / ``almost`` / ``not_yet``); ``null`` for the others.
    status: Literal["got", "almost", "not_yet"] | None = None


class KbStudyResult(BaseModel):
    correct: float
    total: int
    mistakes: int
    #: Open answers «almost there» in the agent's opinion.
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


class KbStudyRecheckIn(_Request):
    """«I did say this»: the words of the user's own answer that state the key idea."""

    item_id: str = Field(min_length=1, max_length=120)
    idea_id: str = Field(min_length=1, max_length=40)
    words: str = Field(min_length=1, max_length=5_000)


class KbStudyCountIn(_Request):
    """«Count it»: the user counts a key idea as said («counted by you»), or takes that back."""

    item_id: str = Field(min_length=1, max_length=120)
    idea_id: str = Field(min_length=1, max_length=40)
    counted: bool = True


class KbStudyRetake(_Request):
    mistakes_only: bool = False


class KbStudySaveIn(_Request):
    decision: Literal["allow", "deny"]


class KbStudyRenameIn(_Request):
    title: str = Field(max_length=1000)


class KbDeckView(BaseModel):
    page_id: str
    title: str
    cards: list[KbStudyCard]
    groups: KbStudyGroups
    #: Cards whose review date has come.
    due: int
    #: P3-b: cards marked «Unclear».
    unclear: int = 0


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


class KbStudyUnclearItem(BaseModel):
    """A card or test question marked «Unclear» (P3-b), as the «Clear now» row lists it."""

    item_id: str
    kind: Literal["card", "question"]
    question: str
    #: The deck or test it is in.
    title: str
    page_id: str | None


class KbStudyUnclearList(BaseModel):
    items: list[KbStudyUnclearItem]
    #: ``folders``: the chat's folders; ``library``: the whole library (a chat with none, «All»).
    scope: Literal["folders", "library", "page"]


class KbStudyUnclearClear(_Request):
    """«Clear now»: the user clears these marks (the agent never does)."""

    item_ids: list[str] = Field(min_length=1, max_length=200)
