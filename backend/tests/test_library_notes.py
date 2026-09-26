"""Registered Markdown discovery on an isolated real filesystem."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest

from audiohelper.library_discovery import LibraryUnavailable
from audiohelper.library_notes import NoteRegistration, RegisteredNotes

NOTE_ID = "11111111111141118111111111111111"
OTHER_ID = "22222222222242228222222222222222"


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def markdown(identity: str, content: str) -> bytes:
    header = json.dumps({"format": "skaz.note", "version": 1, "id": identity})
    return f"---\n{header}\n---\n{content}".encode()


def test_registered_note_uses_external_name_and_exact_body_without_writing(tmp_path: Path) -> None:
    body = "# Изменённый конспект\n\nБез [P1] и без догадок.\n"
    raw = markdown(NOTE_ID, body)
    (tmp_path / "Новое имя.md").write_bytes(raw)
    (tmp_path / "Личное.md").write_bytes(markdown(OTHER_ID, "Do not import"))
    (tmp_path / "Transcript.md").write_bytes(markdown(NOTE_ID, "Not a note"))
    registration = NoteRegistration(NOTE_ID, "Старое имя.md", digest("Old body"))

    result = RegisteredNotes().scan(tmp_path, (registration,))

    assert len(result.notes) == 1
    note = result.notes[0]
    assert (note.id, note.relative_path, note.title) == (NOTE_ID, "Новое имя.md", "Новое имя")
    assert note.content == body
    assert note.content_changed is True
    assert note.content_sha256 == digest(body)
    assert note.file_sha256 == hashlib.sha256(raw).hexdigest()
    assert result.unconnected_ids == ()
    assert RegisteredNotes().scan(tmp_path, (registration,)) == result
    assert (tmp_path / "Новое имя.md").read_bytes() == raw
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Transcript.md", "Личное.md", "Новое имя.md"]


@pytest.mark.parametrize("existing,expected", [
    (("Old.md", "Copy.md"), "Old.md"),
    (("Moved.md",), "Moved.md"),
    (("One.md", "Two.md"), None),
    ((), None),
])
def test_duplicate_resolution_and_missing_notes(
    tmp_path: Path, existing: tuple[str, ...], expected: str | None,
) -> None:
    for name in existing:
        (tmp_path / name).write_bytes(markdown(NOTE_ID, name))
    registration = NoteRegistration(NOTE_ID, "Old.md", digest("original"))
    result = RegisteredNotes().scan(tmp_path, (registration,))
    assert [n.relative_path for n in result.notes] == ([] if expected is None else [expected])
    assert result.unconnected_ids == ((NOTE_ID,) if expected is None else ())
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(existing)


def test_preferred_path_must_have_matching_id(tmp_path: Path) -> None:
    (tmp_path / "Old.md").write_bytes(markdown(OTHER_ID, "Unrelated"))
    (tmp_path / "Moved.md").write_bytes(markdown(NOTE_ID, "Same"))
    result = RegisteredNotes().scan(tmp_path, (NoteRegistration(NOTE_ID, "Old.md", digest("Same")),))
    assert result.notes[0].relative_path == "Moved.md"
    assert result.notes[0].content_changed is False


@pytest.mark.parametrize("body", ["", "\n", "---\nbody\n---\n", "Русский 😀\r\nlast\r\n"])
def test_body_is_not_trimmed_normalized_or_interpreted(tmp_path: Path, body: str) -> None:
    raw = markdown(NOTE_ID, body)
    # Frontmatter CRLF is accepted without changing newlines in the body.
    header, content = raw.split(b"\n---\n", 1)
    raw = header.replace(b"\n", b"\r\n") + b"\r\n---\r\n" + content
    (tmp_path / "N.MD").write_bytes(raw)
    result = RegisteredNotes().scan(tmp_path, (NoteRegistration(NOTE_ID, "N.MD", digest(body)),))
    assert result.notes[0].content == body
    assert result.notes[0].content_changed is False


@pytest.mark.parametrize("raw", [
    b"plain markdown", b"---\n{}\n---\nbody", b"---\n[]\n---\nbody",
    b"---\n!!python/object/apply:os.system []\n---\nbody",
    b"---\n{\"format\":\"skaz.note\",\"version\":true,\"id\":\"" + NOTE_ID.encode() + b"\"}\n---\n",
    b"---\n{\"format\":\"skaz.note\",\"version\":2,\"id\":\"" + NOTE_ID.encode() + b"\"}\n---\n",
    b"---\n{\"format\":\"skaz.note\",\"version\":1,\"id\":\"" + NOTE_ID.encode()
    + b"\",\"id\":\"" + NOTE_ID.encode() + b"\"}\n---\n",
    b"---\n" + b" " * 16385 + b"\n---\nbody",
    b"---\n{\"id\":\"" + NOTE_ID.encode() + b"\"}",
    b"---\n\xff\n---\nbody",
])
def test_unrecognized_frontmatter_is_left_untouched(tmp_path: Path, raw: bytes) -> None:
    (tmp_path / "Note.md").write_bytes(raw)
    result = RegisteredNotes().scan(tmp_path, (NoteRegistration(NOTE_ID, "Note.md", digest("old")),))
    assert result.notes == ()
    assert result.unconnected_ids == (NOTE_ID,)
    assert (tmp_path / "Note.md").read_bytes() == raw


@pytest.mark.parametrize("name", ["../N.md", "/N.md", "sub/N.md", "sub\\N.md", "N\0.md",
                                  "Transcript.md", "TRANSCRIPT.MD", ".md", "N.txt"])
def test_registry_cannot_authorize_paths_or_derived_transcript(name: str) -> None:
    with pytest.raises(ValueError):
        NoteRegistration(NOTE_ID, name, digest(""))


@pytest.mark.parametrize("identity", ["invalid", "ABCDEFAB111141118111111111111111", " " + NOTE_ID])
def test_identity_is_not_silently_normalized(identity: str) -> None:
    with pytest.raises(ValueError):
        NoteRegistration(identity, "N.md", digest(""))


@pytest.mark.parametrize("kind", ["symlink", "hardlink", "fifo", "directory"])
def test_links_special_files_and_nested_notes_are_not_followed(tmp_path: Path, kind: str) -> None:
    session = tmp_path / "session"
    session.mkdir()
    external = tmp_path / "External.md"
    external.write_bytes(markdown(NOTE_ID, "Private"))
    target = session / "N.md"
    if kind == "symlink":
        target.symlink_to(external)
    elif kind == "hardlink":
        os.link(external, target)
    elif kind == "fifo":
        os.mkfifo(target)
    else:
        target.mkdir()
        (target / "nested.md").write_bytes(markdown(NOTE_ID, "Private"))
    result = RegisteredNotes().scan(session, (NoteRegistration(NOTE_ID, "N.md", digest("Private")),))
    assert result.notes == ()
    assert external.read_bytes() == markdown(NOTE_ID, "Private")


@pytest.mark.parametrize("failure", ["permission", "disappear", "earlier_edit", "replace_session"])
def test_incomplete_or_changing_scan_never_returns_a_partial_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str,
) -> None:
    session = tmp_path / "session"
    session.mkdir()
    for name, identity in (("A.md", NOTE_ID), ("B.md", OTHER_ID)):
        (session / name).write_bytes(markdown(identity, "Original"))
    real_open = os.open
    triggered = False

    def change(path: str, flags: int, mode: int = 0o777, *, dir_fd: int | None = None) -> int:
        nonlocal triggered
        if path == "B.md" and not triggered:
            triggered = True
            if failure == "permission":
                raise PermissionError("private path must not appear in the public error")
            if failure == "disappear":
                (session / "B.md").unlink()
            if failure == "earlier_edit":
                (session / "A.md").write_bytes(markdown(NOTE_ID, "External replacement"))
            if failure == "replace_session":
                session.rename(tmp_path / "previous")
                session.mkdir()
        return real_open(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "open", change)
    with pytest.raises(LibraryUnavailable):
        RegisteredNotes().scan(session, (
            NoteRegistration(NOTE_ID, "A.md", digest("Original")),
            NoteRegistration(OTHER_ID, "B.md", digest("Original")),
        ))
    assert triggered


def test_invalid_utf8_in_registered_body_refuses_instead_of_losing_note(tmp_path: Path) -> None:
    raw = markdown(NOTE_ID, "") + b"\xff"
    (tmp_path / "N.md").write_bytes(raw)
    with pytest.raises(LibraryUnavailable):
        RegisteredNotes().scan(tmp_path, (NoteRegistration(NOTE_ID, "N.md", digest("")),))
    assert (tmp_path / "N.md").read_bytes() == raw


@pytest.mark.parametrize("identity", [NOTE_ID, "abcdefab-1111-4111-8111-111111111111"])
def test_existing_and_canonical_uuid_id_forms_are_preserved(tmp_path: Path, identity: str) -> None:
    (tmp_path / "N.md").write_bytes(markdown(identity, "unchanged"))
    result = RegisteredNotes().scan(tmp_path, (NoteRegistration(identity, "N.md", digest("unchanged")),))
    assert result.notes[0].id == identity
    assert result.notes[0].content_changed is False


@pytest.mark.parametrize("duplicate", ["id", "path"])
def test_ambiguous_registry_is_refused(tmp_path: Path, duplicate: str) -> None:
    with pytest.raises(ValueError):
        RegisteredNotes().scan(tmp_path, (
            NoteRegistration(NOTE_ID, "A.md", digest("")),
            NoteRegistration(NOTE_ID if duplicate == "id" else OTHER_ID,
                             "B.md" if duplicate == "id" else "A.md", digest("")),
        ))


@pytest.mark.parametrize("value", ["", "a" * 63, "A" * 64, "g" * 64])
def test_registry_digest_is_strict(value: str) -> None:
    with pytest.raises(ValueError):
        NoteRegistration(NOTE_ID, "N.md", value)


@pytest.mark.parametrize("kind", ["missing", "linked", "ancestor_link"])
def test_unavailable_or_linked_directory_never_returns_empty_snapshot(tmp_path: Path, kind: str) -> None:
    target = tmp_path / "session"
    if kind != "missing":
        real = tmp_path / "real"
        real.mkdir()
        (real / "nested").mkdir()
        target.symlink_to(real, target_is_directory=True)
        if kind == "ancestor_link":
            target = target / "nested"
    with pytest.raises(LibraryUnavailable):
        RegisteredNotes().scan(target, ())


def test_file_replaced_between_stat_and_open_refuses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "N.md"
    target.write_bytes(markdown(NOTE_ID, "Before"))
    replacement = tmp_path / "replacement"
    replacement.write_bytes(markdown(NOTE_ID, "After"))
    real_open = os.open

    def replace(path: str, flags: int, mode: int = 0o777, *, dir_fd: int | None = None) -> int:
        if path == "N.md":
            replacement.replace(target)
        return real_open(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "open", replace)
    with pytest.raises(LibraryUnavailable):
        RegisteredNotes().scan(tmp_path, (NoteRegistration(NOTE_ID, "N.md", digest("Before")),))
    assert target.read_bytes() == markdown(NOTE_ID, "After")


def test_oversized_markdown_refuses_instead_of_truncating_or_removing_note(tmp_path: Path) -> None:
    target = tmp_path / "N.md"
    with target.open("wb") as stream:
        stream.write(markdown(NOTE_ID, ""))
        stream.truncate(32 * 1024 * 1024 + 1)
    with pytest.raises(LibraryUnavailable):
        RegisteredNotes().scan(tmp_path, (NoteRegistration(NOTE_ID, "N.md", digest("")),))
    assert target.stat().st_size == 33554433
