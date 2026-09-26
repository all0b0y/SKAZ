"""Read-only library discovery through real filesystem fixtures (no user data)."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from audiohelper.library_discovery import LibraryDiscovery, LibraryUnavailable

ROOT_ID = "11111111-1111-4111-8111-111111111111"
GROUP_ID = "22222222-2222-4222-8222-222222222222"


def marker(path: Path, kind: str, identity: str) -> None:
    path.write_text(json.dumps({"format": f"skaz.{kind}", "version": 1, "id": identity}), encoding="utf-8")


def library(path: Path) -> Path:
    path.mkdir()
    marker(path / "root.json", "library", ROOT_ID)
    return path


def test_discover_existing_root_and_empty_human_named_groups_without_writing(tmp_path: Path) -> None:
    root = library(tmp_path / "Мои записи")
    group = root / "Лекции"
    group.mkdir()
    marker(group / "group.json", "group", GROUP_ID)
    (root / "Ungrouped").mkdir()
    foreign = root / "Личное"
    foreign.mkdir()
    (foreign / "do-not-read.txt").write_bytes(b"private")

    discovery = LibraryDiscovery()
    result = discovery.scan(root)

    assert result.identity.library_id == ROOT_ID
    assert [(g.id, g.name, g.relative_path) for g in result.groups] == [
        (GROUP_ID, "Лекции", "Лекции"),
    ]
    assert result.ungrouped_path == "Ungrouped"
    assert result.foreign_directories == 1
    assert discovery.scan(root, expected=result.identity) == result
    assert sorted(p.name for p in root.iterdir()) == ["Ungrouped", "root.json", "Лекции", "Личное"]
    assert (foreign / "do-not-read.txt").read_bytes() == b"private"


@pytest.mark.parametrize("name", ["Documents", "SKAZ"])
def test_preview_new_library_does_not_create_anything(tmp_path: Path, name: str) -> None:
    selected = tmp_path / name
    selected.mkdir()
    result = LibraryDiscovery().preview(selected)
    expected = selected if name == "SKAZ" else selected / "SKAZ"
    assert result.root == expected
    assert result.action == "create"
    assert result.topology is None
    assert list(selected.iterdir()) == []


def test_preview_recognizes_named_root_without_double_skaz(tmp_path: Path) -> None:
    root = library(tmp_path / "Архив")
    result = LibraryDiscovery().preview(root)
    assert result.root == root
    assert result.action == "connect"
    assert result.topology is not None
    assert result.topology.identity.library_id == ROOT_ID


def test_preview_parent_finds_existing_skaz(tmp_path: Path) -> None:
    root = library(tmp_path / "SKAZ")
    result = LibraryDiscovery().preview(tmp_path)
    assert result.root == root
    assert result.action == "connect"


@pytest.mark.parametrize("body", [b"{", b"[]", b"\xff", b"x" * 16385,
    b'{"format":"skaz.library","version":true,"id":"11111111-1111-4111-8111-111111111111"}',
    b'{"format":"skaz.library","version":2,"id":"11111111-1111-4111-8111-111111111111"}',
    b'{"format":"skaz.library","version":1,"id":"not-an-id"}',
    b'{"format":"skaz.library","version":1,"version":1,"id":"11111111-1111-4111-8111-111111111111"}',
], ids=["broken-json", "array", "invalid-utf8", "oversized", "boolean-version",
         "future-version", "bad-id", "duplicate-key"])
def test_invalid_root_never_becomes_empty_or_new_library(tmp_path: Path, body: bytes) -> None:
    root = library(tmp_path / "SKAZ")
    (root / "root.json").write_bytes(body)
    discovery = LibraryDiscovery()
    with pytest.raises(LibraryUnavailable):
        discovery.scan(root)
    with pytest.raises(LibraryUnavailable):
        discovery.preview(root)
    assert (root / "root.json").read_bytes() == body


def test_missing_root_or_marker_is_not_automatically_recreated(tmp_path: Path) -> None:
    root = library(tmp_path / "SKAZ")
    discovery = LibraryDiscovery()
    previous = discovery.scan(root)
    (root / "root.json").unlink()
    with pytest.raises(LibraryUnavailable):
        discovery.scan(root, expected=previous.identity)
    assert not (root / "root.json").exists()
    root.rmdir()
    with pytest.raises(LibraryUnavailable):
        discovery.scan(root, expected=previous.identity)
    assert not root.exists()


def test_replaced_root_with_copied_identity_requires_explicit_open(tmp_path: Path) -> None:
    root = library(tmp_path / "SKAZ")
    discovery = LibraryDiscovery()
    previous = discovery.scan(root)
    root.rename(tmp_path / "original")
    library(root)
    with pytest.raises(LibraryUnavailable, match="identity changed"):
        discovery.scan(root, expected=previous.identity)
    assert discovery.scan(root).identity.library_id == ROOT_ID


def test_external_group_rename_retains_identity(tmp_path: Path) -> None:
    root = library(tmp_path / "SKAZ")
    group = root / "Old"
    group.mkdir()
    marker(group / "group.json", "group", GROUP_ID)
    discovery = LibraryDiscovery()
    previous = discovery.scan(root)
    group.rename(root / "Новое имя")
    updated = discovery.scan(root, expected=previous.identity)
    assert [(g.id, g.name) for g in updated.groups] == [(GROUP_ID, "Новое имя")]


def test_invalid_group_is_foreign_and_not_repaired(tmp_path: Path) -> None:
    root = library(tmp_path / "SKAZ")
    group = root / "Broken"
    group.mkdir()
    body = b'{"format":"skaz.group","version":9}'
    (group / "group.json").write_bytes(body)
    result = LibraryDiscovery().scan(root)
    assert result.groups == ()
    assert result.foreign_directories == 1
    assert (group / "group.json").read_bytes() == body


def test_duplicate_group_ids_refuse_partial_result(tmp_path: Path) -> None:
    root = library(tmp_path / "SKAZ")
    for name in ("One", "Two"):
        (root / name).mkdir()
        marker(root / name / "group.json", "group", GROUP_ID)
    with pytest.raises(LibraryUnavailable, match="Duplicate group"):
        LibraryDiscovery().scan(root)


@pytest.mark.parametrize("linked", ["root", "ancestor", "marker"])
def test_links_cannot_escape_library(tmp_path: Path, linked: str) -> None:
    root = library(tmp_path / "real")
    target = root
    if linked == "marker":
        (root / "root.json").rename(tmp_path / "external.json")
        (root / "root.json").symlink_to(tmp_path / "external.json")
    else:
        (tmp_path / "link").symlink_to(root if linked == "root" else tmp_path, target_is_directory=True)
        target = tmp_path / "link" if linked == "root" else tmp_path / "link" / "real"
    with pytest.raises(LibraryUnavailable):
        LibraryDiscovery().scan(target)


def test_linked_group_and_linked_marker_are_not_followed(tmp_path: Path) -> None:
    root = library(tmp_path / "SKAZ")
    outside = tmp_path / "outside"
    outside.mkdir()
    marker(outside / "group.json", "group", GROUP_ID)
    (root / "link").symlink_to(outside, target_is_directory=True)
    (root / "group").mkdir()
    (root / "group" / "group.json").symlink_to(outside / "group.json")
    result = LibraryDiscovery().scan(root)
    assert result.groups == ()
    assert result.foreign_directories == 1


def test_read_error_after_valid_group_aborts_scan(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = library(tmp_path / "SKAZ")
    for name in ("A", "B"):
        (root / name).mkdir()
        marker(root / name / "group.json", "group", GROUP_ID if name == "A" else ROOT_ID)
    original = os.open

    def denied(path: str, flags: int, mode: int = 0o777, *, dir_fd: int | None = None) -> int:
        if path == "B":
            raise PermissionError("unavailable volume")
        return original(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "open", denied)
    with pytest.raises(LibraryUnavailable):
        LibraryDiscovery().scan(root)


def test_root_replaced_during_scan_is_not_accepted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = library(tmp_path / "SKAZ")
    original = os.listdir
    swapped = False

    def replace_on_list(fd: int) -> list[str]:
        nonlocal swapped
        names = original(fd)
        if not swapped:
            swapped = True
            root.rename(tmp_path / "old")
            library(root)
        return names

    monkeypatch.setattr(os, "listdir", replace_on_list)
    with pytest.raises(LibraryUnavailable):
        LibraryDiscovery().scan(root)


def test_earlier_group_marker_change_during_scan_aborts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = library(tmp_path / "SKAZ")
    (root / "A").mkdir()
    marker(root / "A" / "group.json", "group", GROUP_ID)
    (root / "B").mkdir()
    original = os.open

    def change_earlier(path: str, flags: int, mode: int = 0o777, *, dir_fd: int | None = None) -> int:
        if path == "B":
            marker(root / "A" / "group.json", "group", ROOT_ID)
        return original(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "open", change_earlier)
    with pytest.raises(LibraryUnavailable):
        LibraryDiscovery().scan(root)


@pytest.mark.parametrize("kind", ["hardlink", "fifo"])
def test_non_private_regular_root_marker_is_refused(tmp_path: Path, kind: str) -> None:
    root = library(tmp_path / "SKAZ")
    if kind == "hardlink":
        os.link(root / "root.json", tmp_path / "other.json")
    else:
        (root / "root.json").unlink()
        os.mkfifo(root / "root.json")
    with pytest.raises(LibraryUnavailable):
        LibraryDiscovery().scan(root)
