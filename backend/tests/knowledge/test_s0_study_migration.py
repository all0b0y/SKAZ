"""0.4.0 S0 (N4-7, plan decision 3a+): saved decks and tests leave ``Wiki/`` once, with a backup.

All on a temporary library: the failure of a move is injected at the migration's own seam, a crash is a
``BaseException`` the migration may not catch (nothing after it runs, like a killed process).
"""

from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge.index import indexer
from skaz.knowledge.index.scanner import read_page, scan_library
from skaz.knowledge.ingest.pages import spaced
from skaz.knowledge.library.fsio import rename_exclusive
from skaz.knowledge.library.library import Library
from skaz.knowledge.markdown.page import Block, Heading, PageDocument, PageMeta, render_page
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.study.format import DraftCard, DraftQuestion, deck_parts
from skaz.knowledge.study.format import test_parts as questions_parts
from skaz.knowledge.study.migration import MARKER, migrate_study
from skaz.knowledge.wiki.graph import GraphIndex
from skaz.knowledge.wiki.links import LinkResolver

CONCEPT_LINK = "[[Wiki/Concepts/Entropy|Entropy]]"
STUDY_OLD = ("Wiki/Decks", "Wiki/Tests")


def _deck_file(root: Path, title: str, page_id: str, *, directory: str = "Wiki/Decks") -> Path:
    cards = [("c-1" + page_id, DraftCard("What is entropy?", "Disorder.", (), (CONCEPT_LINK,)))]
    meta = PageMeta(skaz_id=page_id, kind="deck", title=title, language="en")
    document = PageDocument(meta, spaced(deck_parts(cards, "en", _ids())))
    return _write(root / directory / f"{title}.md", document)


def _test_file(root: Path, title: str, page_id: str) -> Path:
    questions = [("c-2" + page_id, DraftQuestion("short", "What grows?", ("Entropy",), ()))]
    meta = PageMeta(skaz_id=page_id, kind="test", title=title, language="en")
    return _write(root / "Wiki/Tests" / f"{title}.md",
                  PageDocument(meta, spaced(questions_parts(questions, "en", _ids()))))


def _ids() -> Callable[[str], str]:
    counter = iter(range(1000))
    return lambda prefix: f"{prefix}-x{next(counter)}"


def _write(path: Path, document: PageDocument) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_page(document), encoding="utf-8")
    return path


def _rel_path(kb: KnowledgeService, page_id: str) -> str:
    record = kb.page_repo.get(page_id)
    assert record is not None, page_id
    return record.rel_path


def _concept(root: Path) -> Path:
    meta = PageMeta(skaz_id="pg-concept", kind="concept", title="Entropy", language="en")
    parts: list[Heading | Block] = [
        Heading(2, "About"), Block.create("c-about", "explanation", "A measure of disorder.")
    ]
    return _write(root / "Wiki/Concepts/Entropy.md", PageDocument(meta, spaced(parts)))


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _tree(root: Path) -> dict[str, bytes]:
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob("*"))
            if path.is_file() and ".skaz" not in path.relative_to(root).parts}


def _backups(root: Path) -> list[Path]:
    folder = root / ".skaz/backups"
    return sorted(folder.iterdir()) if folder.is_dir() else []


@pytest.fixture
def kb(tmp_path: Path) -> Iterator[KnowledgeService]:
    service = KnowledgeService(tmp_path / "data", documents_dir=tmp_path / "docs")
    yield service
    service.close()


@pytest.fixture
def old_library(kb: KnowledgeService) -> Library:
    """A library as 0.3.x left it: decks and tests under ``Wiki/``, the index pointing there."""
    kb.connect(None)
    library = kb.require()
    for name in ("Decks", "Tests"):
        (library.root / "Wiki" / name).mkdir(parents=True, exist_ok=True)
    shutil.rmtree(library.root / "Study", ignore_errors=True)  # a 0.3.x library has no such folder
    _concept(library.root)
    _deck_file(library.root, "Thermodynamics", "pg-deck1")
    _deck_file(library.root, "Kinetics", "pg-deck2")
    _test_file(library.root, "Second law", "pg-test1")
    indexer.replace_index(kb.db, scan_library(library))
    assert {page.rel_path for page in kb.page_repo.list_all()} == {
        "Wiki/Concepts/Entropy.md", "Wiki/Decks/Thermodynamics.md", "Wiki/Decks/Kinetics.md",
        "Wiki/Tests/Second law.md"}
    return library


def test_every_deck_and_test_moves_byte_for_byte_and_a_backup_stays(kb: KnowledgeService,
                                                                    old_library: Library) -> None:
    root = old_library.root
    before = {name: data for name, data in _tree(root).items() if name.startswith(STUDY_OLD)}
    assert len(before) == 3

    outcome = migrate_study(old_library, kb.db)

    assert outcome.status == "moved" and outcome.moved == 3
    after = _tree(root)
    for name, data in before.items():
        assert name not in after
        assert after[name.replace("Wiki/", "Study/", 1)] == data
    # The index follows at once (the scan comes later): same ids at the new paths.
    assert _rel_path(kb, "pg-deck1") == "Study/Decks/Thermodynamics.md"
    assert _rel_path(kb, "pg-test1") == "Study/Tests/Second law.md"
    # The empty old folders go; the concept stays where it is.
    assert not (root / "Wiki/Decks").exists() and not (root / "Wiki/Tests").exists()
    assert (root / "Wiki/Concepts/Entropy.md").is_file()
    # The backup holds every file as it was, says what moved and how to restore by hand.
    [backup] = _backups(root)
    assert outcome.backup == backup.relative_to(root).as_posix()
    for name, data in before.items():
        assert (backup / name).read_bytes() == data
    manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
    assert {item["from"] for item in manifest["moves"]} == set(before)
    assert {item["to"] for item in manifest["moves"]} == {n.replace("Wiki/", "Study/", 1) for n in before}
    restore = (backup / "RESTORE.txt").read_text(encoding="utf-8")
    assert "Quit SKAZ" in restore and "Wiki/Decks" in restore and "Study/Decks" in restore


def test_files_that_are_not_saved_decks_or_tests_are_not_touched(kb: KnowledgeService,
                                                                 old_library: Library) -> None:
    root = old_library.root
    stray = root / "Wiki/Decks/my own notes.md"
    stray.write_text("Just a note, no frontmatter.\n", encoding="utf-8")
    other = root / "Wiki/Decks/data.csv"
    other.write_text("a,b\n", encoding="utf-8")
    hidden = root / "Wiki/Tests/.hidden.md"
    hidden.write_text("x", encoding="utf-8")
    meta = PageMeta(skaz_id="pg-odd", kind="concept", title="Odd", language="en")
    odd = _write(root / "Wiki/Tests/Odd.md", PageDocument(meta, spaced(
        [Block.create("c-odd", "explanation", "A concept someone put here.")])))

    outcome = migrate_study(old_library, kb.db)

    assert outcome.moved == 3
    for path in (stray, other, hidden, odd):
        assert path.is_file()
    assert not (root / "Study/Decks/my own notes.md").exists()
    assert not (root / "Study/Tests/Odd.md").exists()


def test_links_from_cards_to_concept_pages_still_work(kb: KnowledgeService, old_library: Library) -> None:
    migrate_study(old_library, kb.db)
    indexer.replace_index(kb.db, scan_library(old_library))

    deck = kb.page_repo.blocks("pg-deck1")[0]
    assert CONCEPT_LINK in deck.text
    [link] = LinkResolver(kb.db).links(deck.text)
    assert (link.page_id, link.page_kind) == ("pg-concept", "concept")
    edges = GraphIndex(kb.db).edges()
    assert any(edge.source == "pg-deck1" and edge.target == "pg-concept" for edge in edges)


def test_a_second_run_changes_nothing(kb: KnowledgeService, old_library: Library) -> None:
    root = old_library.root
    assert migrate_study(old_library, kb.db).status == "moved"
    tree, backups = _tree(root), _backups(root)
    stamp = (root / MARKER).read_bytes()

    again = migrate_study(old_library, kb.db)

    assert again.status == "already" and again.moved == 0
    assert _tree(root) == tree and _backups(root) == backups
    assert (root / MARKER).read_bytes() == stamp


def test_a_library_without_decks_or_tests_writes_nothing(kb: KnowledgeService) -> None:
    kb.connect(None)
    library = kb.require()
    outcome = migrate_study(library, kb.db)
    assert outcome.status == "nothing"
    assert not (library.root / MARKER).exists() and _backups(library.root) == []


def _failing_move(after: int, error: BaseException) -> Callable[[Path, Path], None]:
    done = {"count": 0}

    def move(source: Path, target: Path) -> None:
        if done["count"] == after:
            raise error
        done["count"] += 1
        rename_exclusive(source, target)

    return move


@pytest.mark.parametrize("after", [0, 1, 2])
def test_a_move_failing_midway_puts_everything_back(kb: KnowledgeService, old_library: Library,
                                                    after: int) -> None:
    root = old_library.root
    before = _tree(root)
    paths = {page.id: page.rel_path for page in kb.page_repo.list_all()}

    no_space = OSError(28, "No space left on device")
    outcome = migrate_study(old_library, kb.db, move=_failing_move(after, no_space))

    assert outcome.status == "failed" and outcome.moved == 0
    assert outcome.reason == "No space left on device"
    assert _tree(root) == before
    assert not (root / "Study").exists()
    assert {page.id: page.rel_path for page in kb.page_repo.list_all()} == paths
    assert not (root / MARKER).exists()
    assert _backups(root) == []  # every file is verifiably back: this attempt's copy is not kept

    assert migrate_study(old_library, kb.db).status == "moved"  # the next start simply does it
    assert len(_backups(root)) == 1


def test_an_index_failure_after_the_moves_also_puts_everything_back(
    kb: KnowledgeService, old_library: Library, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = old_library.root
    before = _tree(root)
    import skaz.knowledge.study.migration as migration

    def broken(*_args: Any) -> None:
        raise OSError(5, "Input/output error")

    monkeypatch.setattr(migration, "_point_index", broken)
    outcome = migrate_study(old_library, kb.db)
    assert outcome.status == "failed"
    assert _tree(root) == before and not (root / "Study").exists() and not (root / MARKER).exists()


def test_a_crash_midway_is_undone_on_the_next_start_and_then_finished(kb: KnowledgeService,
                                                                      old_library: Library) -> None:
    root = old_library.root
    before = _tree(root)

    class Killed(BaseException):
        pass

    with pytest.raises(Killed):
        migrate_study(old_library, kb.db, move=_failing_move(2, Killed()))
    assert any(name.startswith("Study/") for name in _tree(root))  # halfway, as a killed process leaves it
    assert json.loads((root / MARKER).read_text(encoding="utf-8"))["status"] == "moving"

    # A library read right now (a start before the undo) still has every file exactly once.
    scanned = {page.meta.skaz_id for page in scan_library(old_library).pages}
    assert {"pg-deck1", "pg-deck2", "pg-test1"} <= scanned

    outcome = migrate_study(old_library, kb.db)

    assert outcome.status == "moved" and outcome.moved == 3
    moved = {name.replace("Study/", "Wiki/", 1): data for name, data in _tree(root).items()
             if name.startswith("Study/")}
    assert moved == {name: data for name, data in before.items() if name.startswith(STUDY_OLD)}
    assert len(_backups(root)) == 1


def test_undo_failing_keeps_the_backup_and_the_journal_for_the_next_start(
    kb: KnowledgeService, old_library: Library, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = old_library.root
    import skaz.knowledge.study.migration as migration

    def stuck(*_args: object) -> None:
        raise OSError(30, "Read-only file system")

    real = migration._undo_moves
    monkeypatch.setattr(migration, "_undo_moves", stuck)
    outcome = migrate_study(old_library, kb.db, move=_failing_move(1, OSError(5, "Input/output error")))
    assert outcome.status == "failed" and outcome.stuck
    assert json.loads((root / MARKER).read_text(encoding="utf-8"))["status"] == "moving"
    assert len(_backups(root)) == 1

    monkeypatch.setattr(migration, "_undo_moves", real)
    assert migrate_study(old_library, kb.db).status == "moved"
    assert (root / "Study/Decks/Thermodynamics.md").is_file()
    assert not (root / "Wiki/Decks").exists()


def test_a_backup_that_cannot_be_written_moves_nothing(kb: KnowledgeService, old_library: Library,
                                                       monkeypatch: pytest.MonkeyPatch) -> None:
    root = old_library.root
    before = _tree(root)
    import skaz.knowledge.study.migration as migration

    def full(*_args: object) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(migration, "write_atomic", full)
    outcome = migrate_study(old_library, kb.db)
    assert outcome.status == "failed" and outcome.reason == "No space left on device"
    assert _tree(root) == before and not (root / MARKER).exists() and _backups(root) == []


def test_an_unreadable_page_stops_it_before_anything_moves(kb: KnowledgeService, old_library: Library,
                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    root = old_library.root
    before = _tree(root)
    target = root / "Wiki/Tests/Second law.md"
    real_read = Path.read_bytes

    def read(self: Path) -> bytes:
        if self == target:
            raise OSError(11, "Resource deadlock avoided")  # an iCloud placeholder still downloading
        return real_read(self)

    monkeypatch.setattr(Path, "read_bytes", read)
    outcome = migrate_study(old_library, kb.db)
    monkeypatch.undo()
    assert outcome.status == "failed"
    assert _tree(root) == before and _backups(root) == []


def test_a_name_taken_in_study_is_never_replaced(kb: KnowledgeService, old_library: Library) -> None:
    root = old_library.root
    theirs = _deck_file(root, "Thermodynamics", "pg-theirs", directory="Study/Decks")
    data = theirs.read_bytes()
    moved = (root / "Wiki/Decks/Thermodynamics.md").read_bytes()

    outcome = migrate_study(old_library, kb.db)

    assert outcome.status == "moved"
    assert theirs.read_bytes() == data
    assert (root / "Study/Decks/Thermodynamics (2).md").read_bytes() == moved
    assert _rel_path(kb, "pg-deck1") == "Study/Decks/Thermodynamics (2).md"


def test_service_data_is_keyed_by_page_id_and_survives_the_move(kb: KnowledgeService,
                                                                 old_library: Library) -> None:
    with kb.db.write() as connection:
        connection.execute("INSERT INTO study_cards(card_id, page_id, lapses, reps, updated_at) "
                           "VALUES ('c-1pg-deck1', 'pg-deck1', 2, 5, 'n')")
    migrate_study(old_library, kb.db)
    indexer.replace_index(kb.db, scan_library(old_library))
    with kb.db.read() as connection:
        row = connection.execute("SELECT page_id, lapses, reps FROM study_cards").fetchone()
    assert tuple(row) == ("pg-deck1", 2, 5)
    moved = read_page(old_library, old_library.root / "Study/Decks/Thermodynamics.md")
    assert moved.meta.skaz_id == "pg-deck1"


# -- the first start of 0.4.0 (``KnowledgeService``) ---------------------------------------------------


def test_the_first_start_moves_them_before_the_scan_and_tells_the_user(tmp_path: Path) -> None:
    first = KnowledgeService(tmp_path / "data", documents_dir=tmp_path / "docs")
    first.connect(None)
    root = first.require().root
    _concept(root)
    _deck_file(root, "Thermodynamics", "pg-deck1")
    first.close()
    # The app starts again on the same database and library.
    kb = KnowledgeService(tmp_path / "data", documents_dir=tmp_path / "docs")
    try:
        kb.start()
        assert kb.view().state == "ready"
        assert _rel_path(kb, "pg-deck1") == "Study/Decks/Thermodynamics.md"
        assert (root / "Study/Decks/Thermodynamics.md").is_file()
        [note] = [item for item in kb.notifications() if item.kind == "study_moved"]
        assert ".skaz/backups/study-migration-" in note.body
        kb.rescan()
        assert [item.kind for item in kb.notifications()].count("study_moved") == 1
    finally:
        kb.close()


def test_a_failed_start_leaves_a_working_library_and_tries_again_next_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = KnowledgeService(tmp_path / "data", documents_dir=tmp_path / "docs")
    first.connect(None)
    root = first.require().root
    deck = _deck_file(root, "Thermodynamics", "pg-deck1")
    data = deck.read_bytes()
    first.close()

    import skaz.knowledge.study.migration as migration

    calls = {"count": 0}
    real = rename_exclusive

    def full(_source: Path, _target: Path) -> None:
        calls["count"] += 1
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(migration, "rename_exclusive", full)
    kb = KnowledgeService(tmp_path / "data", documents_dir=tmp_path / "docs")
    try:
        kb.start()
        # Nothing is half-moved, the library opens and the deck is still found where it was.
        assert kb.view().state == "ready"
        assert deck.read_bytes() == data and not (root / "Study/Decks/Thermodynamics.md").exists()
        assert _rel_path(kb, "pg-deck1") == "Wiki/Decks/Thermodynamics.md"
        [note] = [item for item in kb.notifications() if item.kind == "study_move_failed"]
        assert "No space left on device" in note.body and "Thermodynamics" not in note.body
        # Not on every background rescan of this run: at the next start.
        attempts = calls["count"]
        kb.rescan()
        assert calls["count"] == attempts
    finally:
        kb.close()

    monkeypatch.setattr(migration, "rename_exclusive", real)
    kb = KnowledgeService(tmp_path / "data", documents_dir=tmp_path / "docs")
    try:
        kb.start()
        assert _rel_path(kb, "pg-deck1") == "Study/Decks/Thermodynamics.md"
    finally:
        kb.close()
