"""What is on the study shelf (0.4.0 N4-8): archive rules for saved decks and tests.

* A test not opened for 60 days is archived by itself: hidden from lists; its questions and mistakes
  stay with the agent's study tools and its file stays in the library.
* A deck is never archived by itself: FSRS still schedules it. When every card is learned and it has not
  been opened for as long, SKAZ only suggests archiving.
* Deletion is manual only (``WikiService.delete_page``) and its confirmation says the mistake history
  goes too (``delete_warning``); ``StudyStore.forget_page_history`` carries that out.

"Opened" is the user's action: the deck or test page shown, or a saved one shown again in a chat. An
agent reading it (``skaz_study_read``, the history tools) is not. Opening an archived one brings it back,
with its days starting again. The sweep runs after a scan and whenever the shelf is read, so a test
archives on its day even in a session that never rescans.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal, cast

from ..errors import KnowledgeError, NotFound
from ..library.layout import STUDY_KINDS
from ..store.records import PageRecord
from .format import read_cards
from .scheduling import CardState, group_of

if TYPE_CHECKING:  # the service imports this module
    from .service import StudyService

ARCHIVE_TEST_AFTER = timedelta(days=60)
SUGGEST_DECK_AFTER = timedelta(days=60)
NOT_STUDY = "This page is not a deck or a test."
ArchivedBy = Literal["auto", "user"]


def _stamp(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="seconds")


def _when(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp).astimezone(UTC)


def delete_warning(kind: str, *, attempts: int, reviews: int) -> str:
    """The manual delete's confirmation: what goes along with the page (N4-8)."""
    what = "deck" if kind == "deck" else "test"
    history = []
    if attempts:
        history.append(f"{attempts} finished attempt{'' if attempts == 1 else 's'}")
    if reviews:
        history.append(f"{reviews} review{'' if reviews == 1 else 's'}")
    counted = f" ({' and '.join(history)})" if history else ""
    return (f"Its mistake history goes too{counted}: SKAZ can no longer build a test on your mistakes from "
            f"this {what}. This can't be undone.")


@dataclass(frozen=True)
class ShelfEntry:
    page_id: str
    kind: str
    title: str
    folders: tuple[str, ...]
    opened_at: str
    archived_at: str | None
    archived_by: ArchivedBy | None
    #: A learned deck not opened for long: SKAZ suggests archiving it, nothing more.
    suggest_archive: bool


@dataclass(frozen=True)
class DeleteWarning:
    text: str
    attempts: int
    reviews: int


class StudyShelf:
    def __init__(self, study: StudyService, clock: Callable[[], datetime]) -> None:
        self.study = study
        self.db = study.kb.db
        self._clock = clock

    # -- what it holds ----------------------------------------------------------------------------

    def _pages(self) -> list[PageRecord]:
        return [page for page in self.study.kb.page_repo.list_all() if page.kind in STUDY_KINDS]

    def _page(self, page_id: str) -> PageRecord:
        record = self.study.kb.page_repo.get(page_id)
        if record is None or record.kind not in STUDY_KINDS:
            raise NotFound(NOT_STUDY)
        return record

    def _rows(self) -> dict[str, Any]:
        with self.db.read() as connection:
            return {row["page_id"]: row for row in connection.execute("SELECT * FROM study_shelf")}

    def sweep(self) -> None:
        """A row for every page (its days start now) and every test unopened for 60 days archived."""
        pages = self._pages()
        now = self._clock()
        limit = _stamp(now - ARCHIVE_TEST_AFTER)
        tests = [page.id for page in pages if page.kind == "test"]
        with self.db.write() as connection:
            connection.executemany("INSERT OR IGNORE INTO study_shelf(page_id, opened_at) VALUES (?, ?)",
                                   [(page.id, _stamp(now)) for page in pages])
            for start in range(0, len(tests), 500):
                chunk = tests[start: start + 500]
                marks = ",".join("?" for _ in chunk)
                connection.execute(
                    "UPDATE study_shelf SET archived_at = ?, archived_by = 'auto' WHERE archived_at IS NULL "
                    f"AND opened_at <= ? AND page_id IN ({marks})", (_stamp(now), limit, *chunk))

    def _learned(self, page_id: str) -> bool:
        """Every card of the deck is learned; a deck that can't be read now is not said to be."""
        try:
            cards = read_cards(self.study._document(page_id))
        except (KnowledgeError, OSError, ValueError, UnicodeDecodeError):
            return False
        states = self.study.store.cards([card.id for card in cards])
        return bool(cards) and all(
            group_of(states.get(card.id) or CardState(card.id, page_id)) == "known" for card in cards)

    def _suggests(self, page: PageRecord, row: Any, now: datetime) -> bool:
        if page.kind != "deck" or row["archived_at"] is not None:
            return False
        opened = _when(row["opened_at"])
        kept = row["suggestion_kept_at"]
        quiet_since = max(opened, _when(kept)) if kept else opened
        return now - quiet_since >= SUGGEST_DECK_AFTER and self._learned(page.id)

    def listing(self) -> list[ShelfEntry]:
        """Every saved deck and test with where it stands now, by title."""
        self.sweep()
        rows = self._rows()
        now = self._clock()
        return [
            ShelfEntry(page.id, page.kind, page.title, tuple(page.folders), row["opened_at"],
                       row["archived_at"], cast("ArchivedBy | None", row["archived_by"]),
                       self._suggests(page, row, now))
            for page in self._pages()
            if (row := rows.get(page.id)) is not None
        ]

    def entry(self, page_id: str) -> ShelfEntry:
        self._page(page_id)
        return next(item for item in self.listing() if item.page_id == page_id)

    def stored_archived_ids(self) -> set[str]:
        """Archived as last swept (reading it changes nothing)."""
        with self.db.read() as connection:
            return {row[0] for row in connection.execute(
                "SELECT page_id FROM study_shelf WHERE archived_at IS NOT NULL")}

    def archived_ids(self) -> set[str]:
        self.sweep()
        return self.stored_archived_ids()

    def visible_ids(self) -> set[str]:
        hidden = self.archived_ids()
        return {page.id for page in self._pages() if page.id not in hidden}

    # -- the user's actions -----------------------------------------------------------------------

    def opened(self, page_id: str) -> ShelfEntry:
        """The user opened it: the days start again, and an archived one is back in the lists."""
        self._page(page_id)
        self._set(page_id, opened_at=_stamp(self._clock()), archived_at=None, archived_by=None)
        return self.entry(page_id)

    def archive(self, page_id: str) -> ShelfEntry:
        self._page(page_id)
        self.sweep()
        self._set(page_id, archived_at=_stamp(self._clock()), archived_by="user")
        return self.entry(page_id)

    def unarchive(self, page_id: str) -> ShelfEntry:
        return self.opened(page_id)  # or a test unopened for long would go straight back

    def keep(self, page_id: str) -> ShelfEntry:
        """"Not now" to the suggestion: it stays quiet until the deck has been left that long again."""
        self._page(page_id)
        self.sweep()
        self._set(page_id, suggestion_kept_at=_stamp(self._clock()))
        return self.entry(page_id)

    def _set(self, page_id: str, **fields: str | None) -> None:
        sets = ", ".join(f"{key} = ?" for key in fields)
        with self.db.write() as connection:
            connection.execute("INSERT OR IGNORE INTO study_shelf(page_id, opened_at) VALUES (?, ?)",
                               (page_id, _stamp(self._clock())))
            connection.execute(f"UPDATE study_shelf SET {sets} WHERE page_id = ?",
                               (*fields.values(), page_id))

    def delete_warning_of(self, page_id: str) -> DeleteWarning:
        record = self._page(page_id)
        attempts, reviews = self.study.store.history_counts(page_id)
        text = delete_warning(record.kind, attempts=attempts, reviews=reviews)
        return DeleteWarning(text, attempts, reviews)
