"""QA E9: one unreadable entry (an iCloud placeholder still syncing) never takes the library down.

iCloud Drive can bring a just-deleted folder back as a dataless placeholder whose ``.skaz``
answers every read with ``EDEADLK``. The scan and every write used to read all folder markers
and let that error through: the whole library became unavailable / write-blocked. Now such an
entry is left out (the index keeps what it had there), the user is told once, and the scan
runs again later.
"""
from __future__ import annotations

import errno
import time
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge import service as service_module
from skaz.knowledge.library import fsio
from skaz.knowledge.library import library as library_module
from skaz.knowledge.library.fsio import os_error_reason
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import UNREADABLE_KIND, KnowledgeService


class Placeholders:
    """Paths that answer reads like an iCloud placeholder still downloading (``EDEADLK``)."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.paths: set[Path] = set()
        real = fsio.read_json

        def read_json(path: Path) -> Any:
            if any(path == ghost or ghost in path.parents for ghost in self.paths):
                raise OSError(errno.EDEADLK, "Resource deadlock avoided", str(path))
            return real(path)

        monkeypatch.setattr(library_module, "read_json", read_json)


@pytest.fixture
def placeholders(monkeypatch: pytest.MonkeyPatch) -> Placeholders:
    return Placeholders(monkeypatch)


def ghost_folder(kb: KnowledgeService, name: str = "Eps1") -> Path:
    """``Materials/<name>/.skaz/folder.json`` exists but can't be read (a resurrected placeholder)."""
    path = kb.library_root / "Materials" / name / ".skaz"
    path.mkdir(parents=True)
    (path / "folder.json").write_text('{"id": "fld-ghost", "system": false, "created_at": "x"}')
    return path.parent


def text(kb: KnowledgeService, folder_id: str, title: str) -> str:
    return kb.create_material(folder_id, title, "text", [FragmentInput(text=f"{title} body.")]).manifest.id


def notices(kb: KnowledgeService) -> list[Any]:
    return [item for item in kb.notifications() if item.kind == UNREADABLE_KIND]


def test_placeholder_folder_is_skipped_library_stays_ready_and_writable(
        ready: KnowledgeService, placeholders: Placeholders) -> None:
    keep = text(ready, INBOX_ID, "Keep")
    placeholders.paths.add(ghost_folder(ready))
    ready.rescan()
    view = ready.view()
    assert view.state == "ready", view.reason
    assert [m.id for m in ready.materials()] == [keep]
    assert ready.unreadable == ("Materials/Eps1",)
    # Every kind of write that used to answer 503 "Resource deadlock avoided" works.
    folder = ready.create_folder("Eps 2")
    moved = text(ready, folder.id, "Second")
    ready.rename_folder(folder.id, "Eps 3")
    assert {m.id for m in ready.materials()} == {keep, moved}
    # The user is told what was left out, once, naming the folder.
    [notice] = notices(ready)
    assert "iCloud is still syncing" in notice.title and "Materials/Eps1" in notice.body
    ready.rescan()
    assert len(notices(ready)) == 1


def test_real_permission_denied_folder_is_skipped_too(ready: KnowledgeService) -> None:
    keep = text(ready, INBOX_ID, "Keep")
    marker_dir = ghost_folder(ready, "Locked") / ".skaz"
    marker_dir.chmod(0)
    try:
        ready.rescan()
        assert ready.view().state == "ready"
        assert [m.id for m in ready.materials()] == [keep]
        assert ready.unreadable == ("Materials/Locked",)
        assert ready.create_folder("Another").name == "Another"
    finally:
        marker_dir.chmod(0o755)


def test_reopen_with_a_placeholder_is_ready_not_unavailable(
        ready: KnowledgeService, placeholders: Placeholders, kb_config: Any) -> None:
    keep = text(ready, INBOX_ID, "Keep")
    placeholders.paths.add(ghost_folder(ready))
    ready.close()
    again = KnowledgeService(kb_config.data_dir, documents_dir=kb_config.documents_dir,
                             documents_sandbox=kb_config.documents_sandbox)
    try:
        again.start()
        assert again.view().state == "ready", again.view().reason
        assert [m.id for m in again.materials()] == [keep]
    finally:
        again.close()


def test_indexed_folder_that_turns_unreadable_keeps_its_materials_then_returns(
        ready: KnowledgeService, placeholders: Placeholders) -> None:
    folder = ready.create_folder("Lectures")
    first = text(ready, folder.id, "One")
    other = text(ready, INBOX_ID, "Other")
    hits_before = [hit.material_id for hit in ready.search("One").fragments]
    path = ready.library_root / "Materials" / "Lectures"
    placeholders.paths.add(path)
    ready.rescan()
    # Nothing indexed under the unreadable folder is dropped (an incomplete walk never shrinks).
    assert {m.id for m in ready.materials()} == {first, other}
    assert ready.folder_repo.get(folder.id) is not None
    assert [hit.material_id for hit in ready.search("One").fragments] == hits_before == [first]
    # Too early: no retry. After the interval the scan runs again and the folder is back.
    assert not ready.retry_unreadable()
    placeholders.paths.clear()
    later = time.monotonic() + service_module.UNREADABLE_RETRY_S + 1
    ready.clock = lambda: later
    assert ready.retry_unreadable()
    assert ready.unreadable == ()
    assert not ready.retry_unreadable()  # nothing left out: no more scans
    assert {m.id for m in ready.materials()} == {first, other}


def test_unreadable_material_manifest_keeps_the_material(
        ready: KnowledgeService, placeholders: Placeholders) -> None:
    folder = ready.create_folder("Lectures")
    stuck = text(ready, folder.id, "Stuck")
    fine = text(ready, folder.id, "Fine")
    placeholders.paths.add(ready.library_root / "Materials" / "Lectures" / "Stuck" / ".skaz")
    ready.rescan()
    assert ready.view().state == "ready"
    assert {m.id for m in ready.materials()} == {stuck, fine}
    assert ready.unreadable == ("Materials/Lectures/Stuck",)


def test_materials_root_unreadable_is_still_unavailable(ready: KnowledgeService) -> None:
    keep = text(ready, INBOX_ID, "Keep")
    materials = ready.library_root / "Materials"
    materials.chmod(0)
    try:
        ready.rescan()
        assert ready.view().state == "unavailable"
        assert [m.id for m in ready.materials()] == [keep]
    finally:
        materials.chmod(0o755)


def test_edeadlk_reason_names_the_entry_and_says_icloud(tmp_path: Path) -> None:
    root = tmp_path
    error = OSError(errno.EDEADLK, "Resource deadlock avoided", str(root / "Materials" / "Eps1" / ".skaz"))
    assert os_error_reason(error, root) == "iCloud is still syncing “Materials/Eps1”. Try again in a moment."
    assert os_error_reason(error) == "iCloud is still syncing “Eps1”. Try again in a moment."
    other = OSError(errno.EACCES, "Permission denied", str(root / "Materials"))
    expected = "SKAZ couldn't use the library folder (Materials): Permission denied."
    assert os_error_reason(other, root) == expected
