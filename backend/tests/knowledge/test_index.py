"""Index rebuilt from the library: scan, external edits, unavailable roots, FTS5, sandbox."""
from __future__ import annotations

import json
import os
import unicodedata
from pathlib import Path

import pytest

from skaz.knowledge.errors import LibraryConflict, LibraryUnavailable
from skaz.knowledge.ids import new_id
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.markdown.page import Block, Cite, Heading, PageDocument, PageMeta, section_title
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService


def add_lecture(kb: KnowledgeService) -> str:
    folder = kb.create_folder("Физика")
    created = kb.create_material(folder.id, "Лекция 8", "recording", [
        FragmentInput(text="Энтропия — мера беспорядка системы.", start_ms=0, end_ms=5_000, speaker="1"),
        FragmentInput(text="Entropy never decreases in an isolated system.", start_ms=492_000,
                      end_ms=500_000, speaker="2"),
    ], languages=("ru", "en"))
    return created.manifest.id


def add_page(kb: KnowledgeService, material_id: str) -> Path:
    body = "Энтропия растёт [[Materials/Физика/Лекция 8/Лекция 8#^seg-2|Лекция 8 · 08:12]]"
    document = PageDocument(
        meta=PageMeta(skaz_id="pg-entropy", kind="concept", title="Энтропия", original="entropy",
                      aliases=("entropy",), language="ru", sources=(material_id,)),
        parts=[Heading(2, section_title("from_source", "ru")),
               Block.create("c-1", "from_source", body, cites=(Cite(material_id, 2),))],
    )
    return kb.create_page(document)


def test_not_configured_until_connected_and_nothing_is_created(service: KnowledgeService,
                                                               documents: Path) -> None:
    service.start()
    view = service.view()
    assert view.state == "not_configured"
    assert view.suggested_root == str(documents / "SKAZ")
    assert list(documents.iterdir()) == []


def test_connect_creates_library_and_survives_restart(service: KnowledgeService, kb_config: object,
                                                      documents: Path) -> None:
    view = service.connect(None)
    assert view.state == "ready" and view.root == str(documents / "SKAZ")
    material_id = add_lecture(service)
    service.close()
    again = KnowledgeService(service.data_dir, documents_dir=documents, documents_sandbox=documents)
    try:
        again.start()
        assert again.view().state == "ready"
        assert [m.id for m in again.materials()] == [material_id]
    finally:
        again.close()


def test_sandbox_rejects_roots_outside_it_before_writing(service: KnowledgeService, tmp_path: Path) -> None:
    outside = tmp_path / "Real Documents" / "SKAZ"
    with pytest.raises(LibraryConflict):
        service.connect(str(outside))
    assert not (tmp_path / "Real Documents").exists()


def test_rebuild_from_files_alone(ready: KnowledgeService, tmp_path: Path) -> None:
    material_id = add_lecture(ready)
    add_page(ready, material_id)
    (ready.library_root / "Materials" / "Физика" / "stray folder").mkdir()
    (ready.library_root / "Wiki" / "Concepts" / "Чужая заметка.md").write_text("# not ours\n")
    os.remove(ready.data_dir / "knowledge.sqlite3")
    for suffix in ("-wal", "-shm"):
        (ready.data_dir / f"knowledge.sqlite3{suffix}").unlink(missing_ok=True)
    root = ready.library_root
    ready.close()
    fresh = KnowledgeService(tmp_path / "other-data", documents_dir=root.parent,
                             documents_sandbox=root.parent)
    try:
        assert fresh.connect(str(root)).state == "ready"
        assert [f.name for f in fresh.folders()] == ["Inbox", "Физика"]
        material = fresh.material(material_id)
        assert material.fragments[0].text == "Энтропия — мера беспорядка системы."
        page = fresh.page("pg-entropy")
        assert page.title == "Энтропия"
        assert page.entries[0].citations[0].material_id == material_id
        assert page.entries[0].citations[0].start_ms == 492_000
        assert [p.title for p in fresh.pages()] == ["Энтропия"]
        assert (root / "Wiki" / "Concepts" / "Чужая заметка.md").read_text() == "# not ours\n"
        assert (root / "Materials" / "Физика" / "stray folder").is_dir()
    finally:
        fresh.close()


def test_external_edit_becomes_user_edited_and_keeps_user_bytes(ready: KnowledgeService) -> None:
    material_id = add_lecture(ready)
    path = add_page(ready, material_id)
    original = path.read_text()
    edited = original.replace("Энтропия растёт", "Энтропия  растёт (я уточнил)") + "\nМоя строка.\n"
    path.write_text(edited)
    ready.rescan()
    after = path.read_text()
    marker_before = next(line for line in edited.splitlines() if "skaz:block" in line)
    marker_after = next(line for line in after.splitlines() if "skaz:block" in line)
    assert "owner=user_edited" in marker_after
    assert after.replace(marker_after, marker_before) == edited
    page = ready.page("pg-entropy")
    owners = [(entry.kind, entry.owner, entry.marked) for entry in page.entries]
    assert owners == [("from_source", "user_edited", True), ("user_note", "user", False)]
    # A second scan changes nothing.
    ready.rescan()
    assert path.read_text() == after


def test_edit_seen_on_page_open_without_restart(ready: KnowledgeService) -> None:
    material_id = add_lecture(ready)
    path = add_page(ready, material_id)
    path.write_text(path.read_text().replace("растёт", "увеличивается"))
    assert ready.page("pg-entropy").entries[0].owner == "user_edited"
    assert "owner=user_edited" in path.read_text()


def test_unavailable_root_keeps_the_index(ready: KnowledgeService, documents: Path) -> None:
    material_id = add_lecture(ready)
    root = ready.library_root
    hidden = documents / "moved away"
    root.rename(hidden)
    ready.rescan()
    view = ready.view()
    assert view.state == "unavailable" and "missing" in (view.reason or "")
    assert [m.id for m in ready.materials()] == [material_id]
    with pytest.raises(LibraryUnavailable):
        ready.create_folder("Новая")
    hidden.rename(root)
    assert ready.retry().state == "ready"
    assert [m.id for m in ready.materials()] == [material_id]


def test_unreadable_folder_is_a_failed_scan_not_an_empty_one(ready: KnowledgeService) -> None:
    material_id = add_lecture(ready)
    materials = ready.library_root / "Materials"
    materials.chmod(0)
    try:
        ready.rescan()
        assert ready.view().state == "unavailable"
        assert [m.id for m in ready.materials()] == [material_id]
    finally:
        materials.chmod(0o755)


def test_replaced_root_marker_is_unavailable(ready: KnowledgeService) -> None:
    add_lecture(ready)
    marker = ready.library_root / ".skaz" / "library.json"
    data = json.loads(marker.read_text())
    data["library_id"] = new_id("lib")
    marker.write_text(json.dumps(data))
    ready.rescan()
    assert ready.view().state == "unavailable"
    assert "different" in (ready.view().reason or "")
    assert len(ready.materials()) == 1


def test_finder_renames_are_accepted_and_ids_kept(ready: KnowledgeService) -> None:
    material_id = add_lecture(ready)
    add_page(ready, material_id)
    root = ready.library_root
    (root / "Materials" / "Физика" / "Лекция 8").rename(root / "Materials" / "Физика" / "Лекция восемь")
    (root / "Materials" / "Физика").rename(root / "Materials" / "Термодинамика")
    (root / "Wiki" / "Concepts" / "Энтропия.md").rename(root / "Wiki" / "Concepts" / "Entropy.md")
    ready.rescan()
    material = ready.material(material_id)
    assert material.title == "Лекция восемь"
    assert [f.name for f in ready.folders()] == ["Inbox", "Термодинамика"]
    assert ready.page("pg-entropy").title == "Entropy"
    assert len(material.fragments) == 2


def test_broken_manifest_is_skipped_and_files_untouched(ready: KnowledgeService) -> None:
    material_id = add_lecture(ready)
    manifest = ready.library_root / "Materials" / "Физика" / "Лекция 8" / ".skaz" / "material.json"
    manifest.write_text("{ broken")
    ready.rescan()
    assert ready.view().state == "ready"
    assert ready.materials() == []
    assert manifest.read_text() == "{ broken"
    assert material_id


def test_search_finds_russian_and_english_with_highlights(ready: KnowledgeService) -> None:
    material_id = add_lecture(ready)
    add_page(ready, material_id)
    results = ready.search("энтропия")
    assert {hit.material_id for hit in results.fragments} == {material_id}
    assert any(part.match and part.text.lower().startswith("энтропи")
               for part in results.fragments[0].snippet)
    assert [hit.page_id for hit in results.blocks] == ["pg-entropy"]
    english = ready.search("isolated SYSTEM")
    assert [hit.seg for hit in english.fragments] == [2]
    assert ready.search("entropy").pages[0].id == "pg-entropy"
    assert ready.search("энтроп").fragments  # prefix match
    assert ready.search('"; DROP TABLE x --').fragments == ()
    assert ready.search("   ").fragments == ()
    decomposed = unicodedata.normalize("NFD", "ёж")
    ready.create_material(INBOX_ID, "Ёж", "text", [FragmentInput(text="Ёжик в тумане.", index=0)])
    assert ready.search(decomposed).fragments


def test_live_append_is_indexed_without_full_rescan(ready: KnowledgeService) -> None:
    created = ready.create_material(INBOX_ID, "Запись", "recording",
                                    [FragmentInput(text="Первый.", start_ms=0, end_ms=1_000, speaker="1")],
                                    status="recording")
    ready.append_fragments(created.manifest.id, [
        FragmentInput(text="Второй про квазары.", start_ms=1_000, end_ms=2_000, speaker="1"),
    ])
    detail = ready.material(created.manifest.id)
    assert [f.id for f in detail.fragments] == ["seg-1", "seg-2"]
    assert [hit.seg for hit in ready.search("квазары").fragments] == [2]


def test_notifications_list_and_dismiss(ready: KnowledgeService) -> None:
    note = ready.notify("excluded_fragment", "An instruction for AI was excluded",
                        body="Paragraph 3", payload={"material_id": "mat-1"}, requires_action=True)
    assert [n.id for n in ready.notifications()] == [note.id]
    dismissed = ready.dismiss_notification(note.id)
    assert dismissed.dismissed_at is not None
    assert ready.notifications() == []
    assert [n.id for n in ready.notifications(include_dismissed=True)] == [note.id]


def test_a_failing_text_index_is_degraded_search_not_nothing_found(
    ready: KnowledgeService, caplog: pytest.LogCaptureFixture,
) -> None:
    """L1: an index SQLite can't read used to answer exactly like "no matches", with no log."""
    with ready.db.write() as connection:
        connection.execute("DROP TABLE fragments_fts")
    results = ready.search("энтропия")
    assert results.degraded and results.fragments == ()
    assert "Full-text search failed" in caplog.text
