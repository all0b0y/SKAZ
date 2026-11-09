"""``/kb/study-library`` (N4-7, N4-8): the saved decks and tests, kept apart from the wiki's page list."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class KbStudyShelfEntry(BaseModel):
    page_id: str
    kind: Literal["deck", "test"]
    title: str
    folders: list[str]
    #: When the user last opened it (or when SKAZ first saw it).
    opened_at: str
    archived_at: str | None
    archived_by: Literal["auto", "user"] | None
    #: A learned deck not opened for long: SKAZ only suggests archiving it.
    suggest_archive: bool


class KbStudyLibrary(BaseModel):
    decks: list[KbStudyShelfEntry]
    tests: list[KbStudyShelfEntry]
    #: Hidden from the lists above; their questions and mistakes stay available to the agent's tools.
    archived: list[KbStudyShelfEntry]


class KbStudyDeleteWarning(BaseModel):
    """What the manual delete's confirmation says goes along with the page."""

    text: str
    attempts: int
    reviews: int
