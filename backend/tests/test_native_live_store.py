"""Public persistence seam for native live recording; no provider calls."""
from __future__ import annotations

import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from audiohelper import repository as repo
from audiohelper.audio import WavAudio
from audiohelper.db import Database
from audiohelper.gateways.soniox import SonioxEvent, SonioxToken, SonioxTranslationToken
from audiohelper.live_store import LiveConflict, LiveStore


def test_old_database_without_mode_or_migration_table_keeps_segment_identity(tmp_path: Path) -> None:
    path = tmp_path / "old.sqlite"
    with sqlite3.connect(path) as original:
        original.executescript("""
            CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,created_at TEXT,
                status TEXT,duration_ms INTEGER);
            CREATE TABLE segments(id TEXT PRIMARY KEY,session_id TEXT,sequence INTEGER,start_ms INTEGER,
                end_ms INTEGER,text TEXT,language TEXT,created_at TEXT);
            INSERT INTO sessions VALUES ('old','Old recording','2026-01-01','stopped',100);
            INSERT INTO segments VALUES ('source-id','old',0,0,100,'Original text','en','2026-01-01');
        """)
    for _ in range(2):
        db = Database(path)
        try:
            session = repo.get_session(db, "old")
            assert session is not None and session.title == "Old recording"
            segment = repo.list_segments(db, "old")[0]
            assert segment.id == "source-id"
            assert segment.text == "Original text"
        finally:
            db.close()


def test_audio_and_cross_block_final_survive_reopen_without_changing_ids(tmp_path: Path) -> None:
    path = tmp_path / "recording.sqlite"
    db = Database(path)
    session = repo.create_session(db, "Native")
    store = LiveStore(db, tmp_path / "audio")
    connection = store.open(session.id, sample_rate=16000, model="stt-rt-v5")
    first = bytes([1, 0]) * 1600
    second = bytes([2, 0]) * 1600
    store.append_audio(connection.id, sequence=0, start_sample=0, pcm=first)
    store.append_audio(connection.id, sequence=1, start_sample=1600, pcm=second)
    event = SonioxEvent(
        final_tokens=(SonioxToken("Hello", 50, 150, 0.9, True, "en", speaker="1"),),
        partial_tokens=(), markers=(), final_audio_proc_ms=200,
        total_audio_proc_ms=200, finished=False,
    )
    ids = store.save_event(connection.id, ordinal=0, event=event)
    assert store.save_event(connection.id, ordinal=0, event=event) == ids
    token_snapshot = store.snapshot(session.id)["final_tokens"]
    assert len(token_snapshot) == 1
    assert token_snapshot[0]["speaker_number"] == 1
    assert token_snapshot[0]["start_sample"] == 800
    assert token_snapshot[0]["end_sample"] == 2400
    segments = repo.list_segments(db, session.id)
    assert len(segments) == 1
    assert segments[0].id == ids[0]
    assert segments[0].text == "Hello"
    assert [source.sequence for source in segments[0].sources] == [0, 1]
    store.close(connection.id, finished=True)
    db.close()

    db = Database(path)
    try:
        store = LiveStore(db, tmp_path / "audio")
        assert store.snapshot(session.id)["saved_samples"] == 3200
        assert store.snapshot(session.id)["final_tokens"] == token_snapshot
        assert store.snapshot(session.id)["speakers"] == [
            {"connection_id": connection.id, "provider_id": "1", "number": 1},
        ]
        assert repo.list_segments(db, session.id)[0].id == ids[0]
        chunk = repo.get_chunk(db, session.id, 0)
        assert chunk is not None
        assert Path(chunk.path).read_bytes() == WavAudio(16000, first).to_wav_bytes()
    finally:
        db.close()


def test_translation_is_durable_separate_and_idempotent_without_invented_sources(tmp_path: Path) -> None:
    path = tmp_path / "translation.sqlite"
    db = Database(path)
    session = repo.create_session(db, "Translated")
    store = LiveStore(db, tmp_path / "audio")
    connection = store.open(session.id, sample_rate=16000, model="stt-rt-v5")
    store.append_audio(connection.id, sequence=0, start_sample=0, pcm=b"\x00\x00" * 1600)
    source_event = SonioxEvent(
        (SonioxToken("Hello", 0, 100, .9, True, "en", "1"),), (), (), 100, 100, False,
        partial_translation_tokens=(SonioxTranslationToken("Привет", .8, False, "ru", "en", "1"),),
    )
    source_ids = store.save_event(connection.id, ordinal=0, event=source_event)
    snapshot = store.snapshot(session.id)
    assert snapshot["partial_translation_tokens"][0]["text"] == "Привет"
    replacement = replace(source_event, final_tokens=(), partial_translation_tokens=(
        SonioxTranslationToken("Здравствуй", .8, False, "ru", "en", "1"),
    ))
    store.save_event(connection.id, ordinal=1, event=replacement)
    db.close()
    db = Database(path)
    store = LiveStore(db, tmp_path / "audio")
    reopened_draft = store.snapshot(session.id)["partial_translation_tokens"]
    assert [item["text"] for item in reopened_draft] == ["Здравствуй"]
    event = SonioxEvent((), (), (), 100, 100, True, final_translation_tokens=(
        SonioxTranslationToken("Здравствуйте", .9, True, "ru", "en", "1"),
    ))
    assert store.save_event(connection.id, ordinal=2, event=event) == []
    assert store.save_event(connection.id, ordinal=2, event=event) == []
    with pytest.raises(LiveConflict, match="Conflicting event replay"):
        store.save_event(connection.id, ordinal=2, event=replace(event, final_translation_tokens=(
            SonioxTranslationToken("Другой текст", .9, True, "ru", "en", "1"),
        )))
    snapshot = store.snapshot(session.id)
    translations = snapshot["final_translation_tokens"]
    assert len(translations) == 1
    assert translations[0]["text"] == "Здравствуйте"
    assert translations[0]["speaker_number"] == 1
    assert translations[0]["connection_id"] == connection.id
    assert not {"start_ms", "end_ms", "start_sample", "end_sample", "segment_id"} & translations[0].keys()
    assert snapshot["partial_translation_tokens"] == []
    assert [item.text for item in repo.list_segments(db, session.id)] == ["Hello"]
    assert repo.list_segments(db, session.id)[0].id == source_ids[0]
    store.close(connection.id, finished=True)
    db.close()
    db = Database(path)
    try:
        reopened = LiveStore(db, tmp_path / "audio").snapshot(session.id)
        assert reopened["final_translation_tokens"] == translations
    finally:
        db.close()


def test_native_recording_rejects_old_transcript_writer_before_first_final(tmp_path: Path) -> None:
    db = Database(":memory:")
    try:
        session = repo.create_session(db, "Native")
        store = LiveStore(db, tmp_path / "audio")
        store.open(session.id, sample_rate=16000, model="stt-rt-v5")
        with pytest.raises(repo.FinalWriterConflict):
            repo.replace_chunk_segments(db, session.id, 0, [])
    finally:
        db.close()


def test_restart_preserves_draft_as_unconfirmed_and_marks_connection_incomplete(tmp_path: Path) -> None:
    path = tmp_path / "restart.sqlite"
    db = Database(path)
    session = repo.create_session(db, "Interrupted")
    store = LiveStore(db, tmp_path / "audio")
    first = store.open(session.id, sample_rate=16000, model="stt-rt-v5")
    store.append_audio(first.id, sequence=0, start_sample=0, pcm=b"\x00\x00" * 1600)
    store.save_event(first.id, ordinal=0, event=SonioxEvent(
        (), (SonioxToken("Draft", 0, 100, .8, False, "en"),), (), 0, 100, False,
    ))
    db.close()
    db = Database(path)
    try:
        store = LiveStore(db, tmp_path / "audio")
        store.recover_interrupted()
        snapshot = store.snapshot(session.id)
        assert snapshot["connections"][0]["status"] == "incomplete"
        assert snapshot["connections"][0]["end_sample"] == 1600
        assert "Draft" in snapshot["connections"][0]["draft_json"]
        assert repo.list_segments(db, session.id) == []
        assert store.open(session.id, sample_rate=16000, model="stt-rt-v5").start_sample == 1600
    finally:
        db.close()


def test_packet_replay_order_resume_and_late_event_are_safe(tmp_path: Path) -> None:
    db = Database(":memory:")
    try:
        session = repo.create_session(db, "Native")
        store = LiveStore(db, tmp_path / "audio")
        first = store.open(session.id, sample_rate=16000, model="stt-rt-v5")
        pcm = b"\x01\x00" * 1600
        with pytest.raises(LiveConflict):
            store.append_audio(first.id, sequence=1, start_sample=0, pcm=pcm)
        assert store.append_audio(first.id, sequence=0, start_sample=0, pcm=pcm)
        assert not store.append_audio(first.id, sequence=0, start_sample=0, pcm=pcm)
        with pytest.raises(LiveConflict):
            store.append_audio(first.id, sequence=0, start_sample=0, pcm=b"\x00\x00" * 1600)
        store.close(first.id, finished=False)
        second = store.open(session.id, sample_rate=16000, model="stt-rt-v5")
        assert second.start_sample == 1600
        assert second.next_sequence == 1
        store.append_audio(second.id, sequence=1, start_sample=1600, pcm=pcm)
        event = SonioxEvent((SonioxToken("Resume", 0, 100, .9, True, "en"),), (), (), 100, 100, True)
        with pytest.raises(LiveConflict):
            store.save_event(first.id, ordinal=0, event=event)
        store.save_event(second.id, ordinal=0, event=event)
        segment = repo.list_segments(db, session.id)[0]
        assert (segment.start_ms, segment.end_ms) == (100, 200)
        assert repo.delete_session(db, session.id)
        with pytest.raises(LiveConflict):
            store.append_audio(second.id, sequence=2, start_sample=3200, pcm=pcm)
    finally:
        db.close()
