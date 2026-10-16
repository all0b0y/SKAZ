"""Library on disk: root choice, layout, human names, collisions, atomic writes."""
from __future__ import annotations

import json
import threading
import unicodedata
from pathlib import Path

import pytest

from skaz.knowledge.errors import (
    FolderNotEmpty,
    LibraryConflict,
    LibraryUnavailable,
    NameRejected,
    NameTaken,
    ProtectedItem,
)
from skaz.knowledge.library.layout import LEGACY_STAGING_PATH, MARKER_PATH, STAGING_PATH, resolve_library_root
from skaz.knowledge.library.library import INBOX_ID, Library
from skaz.knowledge.library.names import validate_name
from skaz.knowledge.markdown.page import PageDocument, PageMeta, RawText, parse_page
from skaz.knowledge.markdown.source import FragmentInput

COLLISION = "An item with this name already exists. Choose another name."


@pytest.fixture
def library(tmp_path: Path) -> Library:
    return Library.create(tmp_path / "Documents" / "SKAZ")


def tree(root: Path) -> set[str]:
    return {str(path.relative_to(root)) for path in root.rglob("*")}


@pytest.mark.parametrize("name", ["", "   ", "a/b", "a:b", "x|y", "note#1", "a^b", "[x]", ".hidden", "..",
                                  "tab\tname", "я" * 120, "Inbox"])
def test_invalid_names_are_rejected_with_a_reason(name: str) -> None:
    with pytest.raises(NameRejected) as error:
        validate_name(name, reserved=("inbox",))
    assert error.value.message.endswith("Choose another name.")


def test_valid_name_is_trimmed_and_nfc() -> None:
    raw = "  " + unicodedata.normalize("NFD", "Лекция 8 — энтропия") + " "
    assert validate_name(raw) == "Лекция 8 — энтропия"


def test_root_is_skaz_unless_an_old_non_library_folder_is_there(tmp_path: Path) -> None:
    documents = tmp_path / "Documents"
    documents.mkdir()
    assert resolve_library_root(documents) == documents / "SKAZ"
    (documents / "SKAZ").mkdir()
    (documents / "SKAZ" / ".DS_Store").write_bytes(b"")
    assert resolve_library_root(documents) == documents / "SKAZ"
    (documents / "SKAZ" / "Ungrouped").mkdir()
    assert resolve_library_root(documents) == documents / "SKAZ Library"
    Library.create(documents / "SKAZ Library")
    assert resolve_library_root(documents) == documents / "SKAZ Library"
    assert resolve_library_root(documents / "SKAZ Library") == documents / "SKAZ Library"
    assert tree(documents / "SKAZ") == {".DS_Store", "Ungrouped"}


def test_new_library_layout(library: Library) -> None:
    root = library.root
    for folder in ("Materials/Inbox", "Wiki/Concepts", "Wiki/Notes", "Wiki/Folders", "Wiki/Analyses"):
        assert (root / folder).is_dir(), folder
    assert (root / "Wiki/index.md").is_file() and (root / "Wiki/log.md").is_file()
    marker = json.loads((root / MARKER_PATH).read_text())
    assert marker["format"] == "skaz-library" and marker["version"] == 1
    assert marker["library_id"] == library.library_id
    assert [(f.id, f.name, f.system) for f in library.folders()] == [(INBOX_ID, "Inbox", True)]
    assert not list(root.parent.glob(".*creating*"))


def test_existing_foreign_content_is_never_turned_into_a_library(tmp_path: Path) -> None:
    root = tmp_path / "SKAZ"
    (root / "Ungrouped").mkdir(parents=True)
    with pytest.raises(LibraryConflict) as refused:
        Library.create(root)
    assert tree(root) == {"Ungrouped"}
    # The refusal names the busy SKAZ folder: the folder the user chose may be fine (QA A9).
    assert refused.value.message == "The “SKAZ” folder here already has other files. Choose another folder."


def test_staging_is_a_place_icloud_syncs(library: Library) -> None:
    """A library in ~/Documents is in iCloud Drive; it never syncs "tmp" or "*.nosync" folders and
    macOS refuses to move a folder between a synced and a never-synced place ("Resource deadlock
    avoided"): with staging in such a folder every import and delete failed."""
    name = STAGING_PATH.name.lower()
    assert name != "tmp" and not name.endswith((".nosync", ".tmp")) and not name.startswith(".")
    assert (library.root / STAGING_PATH).is_dir()


def test_open_removes_the_staging_folder_of_earlier_builds(library: Library) -> None:
    legacy = library.root / LEGACY_STAGING_PATH
    (legacy / "delete-1" / "material").mkdir(parents=True)
    (legacy / "delete-1" / "material" / "a.md").write_text("x", encoding="utf-8")
    Library.open(library.root, library.library_id)
    assert not legacy.exists()


def test_open_reports_missing_marker_and_other_library(library: Library, tmp_path: Path) -> None:
    assert Library.open(library.root, library.library_id).library_id == library.library_id
    with pytest.raises(LibraryUnavailable, match="different SKAZ library"):
        Library.open(library.root, "lib-other")
    with pytest.raises(LibraryUnavailable, match="missing"):
        Library.open(tmp_path / "nowhere", None)
    (library.root / MARKER_PATH).unlink()
    with pytest.raises(LibraryUnavailable, match="marker"):
        Library.open(library.root, library.library_id)


def test_folder_create_rename_delete(library: Library) -> None:
    physics = library.create_folder("Физика")
    assert (library.root / "Materials" / "Физика" / ".skaz" / "folder.json").is_file()
    renamed = library.rename_folder(physics.id, "Физика 2")
    assert renamed.id == physics.id and renamed.name == "Физика 2"
    assert not (library.root / "Materials" / "Физика").exists()
    case_only = library.rename_folder(physics.id, "физика 2")
    assert case_only.name == "физика 2"
    library.delete_folder(physics.id)
    assert [f.name for f in library.folders()] == ["Inbox"]


@pytest.mark.parametrize("second", ["лекция", "ЛЕКЦИЯ", unicodedata.normalize("NFD", "Лекция")])
def test_folder_collision_is_refused_without_partial_writes(library: Library, second: str) -> None:
    library.create_folder("Лекция")
    before = tree(library.root)
    with pytest.raises(NameTaken) as error:
        library.create_folder(second)
    assert error.value.message == COLLISION
    other = library.create_folder("Другая")
    with pytest.raises(NameTaken):
        library.rename_folder(other.id, second)
    assert tree(library.root) - before == {
        "Materials/Другая", "Materials/Другая/.skaz", "Materials/Другая/.skaz/folder.json",
    }


def test_unknown_entries_also_block_a_name(library: Library) -> None:
    (library.root / "Materials" / "notes.txt").write_text("mine")
    with pytest.raises(NameTaken):
        library.create_folder("NOTES.TXT")


def test_inbox_is_protected_and_nonempty_folders_stay(library: Library) -> None:
    with pytest.raises(ProtectedItem):
        library.rename_folder(INBOX_ID, "Incoming")
    with pytest.raises(ProtectedItem):
        library.delete_folder(INBOX_ID)
    folder = library.create_folder("Курс")
    library.create_material(folder.id, "Лекция 1", "text", [FragmentInput(text="Привет", index=0)])
    with pytest.raises(FolderNotEmpty):
        library.delete_folder(folder.id)
    assert (library.root / "Materials" / "Курс" / "Лекция 1" / "Лекция 1.md").is_file()


def test_concurrent_creation_of_one_name_lets_exactly_one_win(library: Library) -> None:
    results: list[str] = []
    barrier = threading.Barrier(8)

    def attempt(name: str) -> None:
        barrier.wait()
        try:
            library.create_folder(name)
            results.append("ok")
        except NameTaken:
            results.append("taken")

    names = ["Гонка", "гонка", "ГОНКА", unicodedata.normalize("NFD", "Гонка")] * 2
    threads = [threading.Thread(target=attempt, args=(name,)) for name in names]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == ["ok"] + ["taken"] * 7
    assert len([f for f in library.folders() if f.name.casefold() == "гонка"]) == 1


def test_material_files_and_stable_append(library: Library) -> None:
    created = library.create_material(
        INBOX_ID, "Лекция 8", "recording",
        [FragmentInput(text="Начало лекции.", start_ms=0, end_ms=4_000, speaker="1")],
        status="recording", languages=("ru",),
    )
    directory = library.root / "Materials" / "Inbox" / "Лекция 8"
    assert created.source_path == directory / "Лекция 8.md"
    manifest = json.loads((directory / ".skaz" / "material.json").read_text())
    assert manifest["id"] == created.manifest.id and manifest["kind"] == "recording"
    assert manifest["fragments"] == [{"id": "seg-1", "start_ms": 0, "end_ms": 4_000, "speaker": "1",
                                      "page": None, "index": None}]
    first_text = created.source_path.read_text()
    added = library.append_fragments(created.manifest.id, [
        FragmentInput(text="Продолжение.", start_ms=4_000, end_ms=8_000, speaker="2"),
    ])
    assert [f.seg for f in added] == [2]
    again = library.read_material(created.manifest.id)
    assert [(f.seg, f.text) for f in again.fragments] == [(1, "Начало лекции."), (2, "Продолжение.")]
    assert created.source_path.read_text().startswith(first_text.rstrip("\n"))


def test_material_title_collision_leaves_nothing_behind(library: Library) -> None:
    library.create_material(INBOX_ID, "Статья", "web", [FragmentInput(text="a", index=0)])
    before = tree(library.root)
    with pytest.raises(NameTaken):
        library.create_material(INBOX_ID, "статья", "web", [FragmentInput(text="b", index=0)])
    assert tree(library.root) == before


def test_nfd_named_material_reads_back(library: Library) -> None:
    title = unicodedata.normalize("NFD", "Йога и ёж")
    created = library.create_material(INBOX_ID, title, "text", [FragmentInput(text="Ёж.", index=0)])
    loaded = library.read_material(created.manifest.id)
    assert unicodedata.normalize("NFC", loaded.title) == "Йога и ёж"
    assert [f.text for f in loaded.fragments] == ["Ёж."]


def test_page_creation_is_exclusive(library: Library) -> None:
    document = PageDocument(meta=PageMeta(skaz_id="pg-1", kind="concept", title="Энтропия"),
                            parts=[RawText("Текст.\n")])
    path = library.create_page(document)
    assert path == library.root / "Wiki" / "Concepts" / "Энтропия.md"
    assert parse_page(path.read_text()).meta.skaz_id == "pg-1"
    clash = PageDocument(meta=PageMeta(skaz_id="pg-2", kind="concept", title="энтропия"), parts=[])
    with pytest.raises(NameTaken):
        library.create_page(clash)
