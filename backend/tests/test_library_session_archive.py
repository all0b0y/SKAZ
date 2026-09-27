"""Portable session recovery through session/query interfaces, without old SQLite."""
from __future__ import annotations

import json
from pathlib import Path

from skaz import note_store
from skaz import repository as repo
from skaz.db import Database
from skaz.gateways.soniox import SonioxEvent, SonioxToken, SonioxTokenRef, SonioxTranslationToken
from skaz.library_archive import SessionArchive
from skaz.live_store import LiveStore
from skaz.schemas import Citation


def test_native_translation_clock_sources_and_replay_survive_new_database(tmp_path: Path) -> None:
    source = Database(tmp_path / "source.sqlite")
    target = Database(tmp_path / "target.sqlite")
    try:
        session = repo.create_session(source, "Native")
        live = LiveStore(source)
        conn = live.open(session.id, sample_rate=16000, model="stt-rt-v5",
                         recording_mode="translation", translation_target_language="de",
                         used_languages=("en",))
        live.append_audio(conn.id, sequence=0, start_sample=0, pcm=b"\x01\x00" * 1600)
        event = SonioxEvent(
            (SonioxToken("Hello.", 0, 100, .9, True, "en", "1"),), (), (), 100, 100, False,
            final_translation_tokens=(SonioxTranslationToken("Hallo.", .9, True, "de", "en", "1"),),
            token_order=(SonioxTokenRef("original", True, 0), SonioxTokenRef("translation", True, 0)),
        )
        ids = live.save_event(conn.id, ordinal=0, event=event)
        live.close(conn.id, finished=True)
        archive = SessionArchive.capture(source, session.id, note_paths={})
        directory = tmp_path / "Native recovered"
        directory.mkdir()
        (directory / "session.json").write_bytes(archive.marker)
        SessionArchive.restore_new(target, directory)
        reopened = LiveStore(target)
        assert reopened.snapshot(session.id) == live.snapshot(session.id)
        assert repo.list_segments(target, session.id) == repo.list_segments(source, session.id)
        assert [segment.id for segment in repo.list_segments(target, session.id)] == ids
        resumed = reopened.open(session.id, sample_rate=16000, model="stt-rt-v5")
        assert reopened.append_audio(resumed.id, sequence=0, start_sample=0,
                                     pcm=b"\x01\x00" * 1600, replay_start_sample=0) is False
        assert resumed.start_sample == 1600
        assert resumed.next_sequence == 1
        assert resumed.recording_mode == "translation"
    finally:
        source.close()
        target.close()


def test_legacy_text_messages_and_registered_note_round_trip(tmp_path: Path) -> None:
    source = Database(tmp_path / "source.sqlite")
    target = Database(tmp_path / "target.sqlite")
    try:
        session = repo.create_session(source, "Lecture")
        repo.add_message(source, session.id, "user", "Question?", [])
        note = repo.add_note(source, session.id, "Original note\n", "manual", [
            Citation(segment_id="historic", start_ms=0, end_ms=100, text="Historical quote"),
        ])
        archive = SessionArchive.capture(source, session.id, note_paths={note.id: "Summary.md"})
        directory = tmp_path / "Renamed in Finder"
        directory.mkdir()
        (directory / "session.json").write_bytes(archive.marker)
        for name, raw in archive.notes.items():
            (directory / name).write_bytes(raw)
        # SQLite/JSON must not override an external editor's accepted body.
        path = directory / "Summary.md"
        path.write_bytes(path.read_bytes().replace(b"Original note\n", b"External text\r\n"))
        path.rename(directory / "Renamed.md")
        SessionArchive.restore_new(target, directory)
        restored = repo.get_session(target, session.id)
        assert restored is not None and restored.title == "Renamed in Finder"
        assert repo.list_messages(target, session.id)[0].content == "Question?"
        notes = note_store.list_notes(target, session.id)
        assert len(notes) == 1
        assert notes[0].id == note.id
        assert notes[0].title == "Renamed"
        assert notes[0].content == "External text\r\n"
        assert notes[0].citations == []
        assert notes[0].revision == note.revision + 1
        assert json.loads(archive.marker)["format"] == "skaz.session"
    finally:
        source.close()
        target.close()
