"""Imported files land in the live transcript tables, not a parallel world.

These tests pin the promise the feature rests on: after an import, monologues,
speakers and translation projection are built by exactly the same code that
serves a microphone recording.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from audiohelper.db import Database
from audiohelper.gateways.soniox_async import ASYNC_MODEL, AsyncToken
from audiohelper.import_store import (
    IMPORT_SAMPLE_RATE,
    ImportConflict,
    ImportSource,
    ImportStore,
    digest_file,
    segment_tokens,
)
from audiohelper.repository import create_session
from audiohelper.transcript_monologues import build_monologues


@pytest.fixture
def db(tmp_path: Path) -> Database:
    return Database(tmp_path / "test.db")


@pytest.fixture
def store(db: Database) -> ImportStore:
    return ImportStore(db)


def source(tmp_path: Path, name: str = "lecture.m4a") -> ImportSource:
    path = tmp_path / name
    path.write_bytes(b"not really audio, never decoded here")
    stat = path.stat()
    return ImportSource(path=str(path), name=name, size_bytes=stat.st_size,
                        mtime_ns=stat.st_mtime_ns, sha256=digest_file(path))


def start(store: ImportStore, db: Database, tmp_path: Path, *, translate: bool = False) -> str:
    session = create_session(db, "Lecture")
    store.create(
        session.id, source=source(tmp_path), model=ASYNC_MODEL, translate=translate,
        translation_target_language="ru", used_languages=("ru", "en"), declared_duration_ms=60_000,
    )
    store.mark_uploaded(session.id, provider_file_id="f" * 32)
    store.mark_processing(session.id, transcription_id="a" * 32)
    return session.id


def token(text: str, start_ms: int, end_ms: int, *, speaker: str | None = "1",
          language: str | None = "ru", status: str = "original") -> AsyncToken:
    return AsyncToken(text=text, start_ms=start_ms, end_ms=end_ms, confidence=0.9,
                      speaker=speaker, language=language, translation_status=status)  # type: ignore[arg-type]


def test_import_uses_a_time_unit_not_a_guessed_sample_rate(
    store: ImportStore, db: Database, tmp_path: Path,
) -> None:
    session_id = start(store, db, tmp_path)
    store.apply_transcript(session_id, tokens=[token("Привет", 0, 500)], audio_duration_ms=1_000)

    with db.read() as connection:
        row = connection.execute(
            "SELECT * FROM native_recordings WHERE session_id=?", (session_id,)
        ).fetchone()
    assert row["origin"] == "import"
    assert row["sample_rate"] == IMPORT_SAMPLE_RATE
    # 16 samples per millisecond keeps the conversion exact in both directions.
    assert row["saved_samples"] == 1_000 * 16


def test_transcript_becomes_monologues_through_the_live_pipeline(
    store: ImportStore, db: Database, tmp_path: Path,
) -> None:
    session_id = start(store, db, tmp_path)
    store.apply_transcript(session_id, tokens=[
        token("Добрый ", 0, 400, speaker="1"),
        token("день", 400, 900, speaker="1"),
        token("Отвечаю", 1_200, 2_000, speaker="2"),
    ], audio_duration_ms=2_500)

    with db.read() as connection:
        segments = connection.execute(
            "SELECT * FROM segments WHERE session_id=? ORDER BY start_ms", (session_id,)
        ).fetchall()
        monologues = build_monologues(connection, session_id, [])
        speakers = connection.execute(
            "SELECT number FROM native_speakers WHERE session_id=? ORDER BY number", (session_id,)
        ).fetchall()

    assert [segment["text"] for segment in segments] == ["Добрый день", "Отвечаю"]
    assert [m.speaker for m in monologues] == [1, 2]
    assert monologues[0].text == "Добрый день"
    # Speakers are numbered within this one recording, as diarisation reported them.
    assert [row["number"] for row in speakers] == [1, 2]


def test_monologue_timestamps_round_trip_through_samples(
    store: ImportStore, db: Database, tmp_path: Path,
) -> None:
    session_id = start(store, db, tmp_path)
    # A long file is where any per-token rounding error would accumulate.
    store.apply_transcript(session_id, tokens=[
        token("начало", 1, 999),
        token("конец", 7_199_001, 7_199_999),
    ], audio_duration_ms=7_200_000)

    with db.read() as connection:
        monologues = build_monologues(connection, session_id, [])

    assert monologues[0].start_ms == 1
    assert monologues[-1].end_ms == 7_199_999


def test_translated_tokens_are_stored_and_projected_against_their_speech(
    store: ImportStore, db: Database, tmp_path: Path,
) -> None:
    from audiohelper.live_store import LiveStore

    session_id = start(store, db, tmp_path, translate=True)
    store.apply_transcript(session_id, tokens=[
        token("Hello", 0, 500, speaker="1", language="en"),
        token("Привет", 0, 0, speaker="1", language="ru", status="translation"),
    ], audio_duration_ms=600)

    snapshot = LiveStore(db, tmp_path / "audio").snapshot(session_id)
    assert [t["text"] for t in snapshot["final_tokens"]] == ["Hello"]
    assert [t["text"] for t in snapshot["final_translation_tokens"]] == ["Привет"]
    projection = snapshot["final_translation_projection"]
    assert projection["unassigned_translation_token_ids"] == []
    assert projection["monologues"][0]["translation_token_ids"]


def test_completion_is_idempotent(store: ImportStore, db: Database, tmp_path: Path) -> None:
    session_id = start(store, db, tmp_path)
    store.apply_transcript(session_id, tokens=[token("раз", 0, 500)], audio_duration_ms=1_000)
    store.apply_transcript(session_id, tokens=[token("раз", 0, 500)], audio_duration_ms=1_000)

    with db.read() as connection:
        count = connection.execute(
            "SELECT COUNT(*) AS n FROM segments WHERE session_id=?", (session_id,)
        ).fetchone()["n"]
    assert count == 1


def test_a_session_with_a_live_recording_cannot_be_imported_into(
    store: ImportStore, db: Database, tmp_path: Path,
) -> None:
    from audiohelper.live_store import LiveStore

    session = create_session(db, "Live")
    LiveStore(db, tmp_path / "audio").open(session.id, sample_rate=48_000, model="stt-rt-v5")
    with pytest.raises(ImportConflict, match="already holds a recording"):
        store.create(session.id, source=source(tmp_path), model=ASYNC_MODEL, translate=False,
                     translation_target_language="ru", used_languages=None, declared_duration_ms=None)


def test_a_microphone_cannot_continue_an_imported_session(
    store: ImportStore, db: Database, tmp_path: Path,
) -> None:
    from audiohelper.live_store import LiveConflict, LiveStore

    session_id = start(store, db, tmp_path)
    store.apply_transcript(session_id, tokens=[token("раз", 0, 500)], audio_duration_ms=1_000)

    with pytest.raises(LiveConflict, match="imported"):
        LiveStore(db, tmp_path / "audio").open(session_id, sample_rate=48_000, model="stt-rt-v5")


def test_unsettled_imports_are_listed_for_restart_recovery(
    store: ImportStore, db: Database, tmp_path: Path,
) -> None:
    processing = start(store, db, tmp_path)
    done = start(store, db, tmp_path)
    store.apply_transcript(done, tokens=[token("готово", 0, 100)], audio_duration_ms=200)

    pending = store.unsettled()
    assert [record.session_id for record in pending] == [processing]
    assert pending[0].transcription_id == "a" * 32


def test_failure_records_the_provider_reason_and_settles(
    store: ImportStore, db: Database, tmp_path: Path,
) -> None:
    session_id = start(store, db, tmp_path)
    record = store.mark_failed(session_id, error="Soniox request failed (HTTP 400, audio_decode).")

    assert record.status == "failed"
    assert "audio_decode" in (record.error or "")
    assert record.settled_at is not None
    assert store.unsettled() == []


def test_a_settled_import_cannot_silently_resume(
    store: ImportStore, db: Database, tmp_path: Path,
) -> None:
    session_id = start(store, db, tmp_path)
    store.mark_cancelled(session_id)
    with pytest.raises(ImportConflict):
        store.apply_transcript(session_id, tokens=[token("поздно", 0, 10)], audio_duration_ms=20)


def test_transcript_may_not_claim_speech_past_the_billed_audio(
    store: ImportStore, db: Database, tmp_path: Path,
) -> None:
    session_id = start(store, db, tmp_path)
    # A provider that reports a shorter duration than its own tokens must not
    # truncate the transcript; the recording grows to hold every token instead.
    store.apply_transcript(session_id, tokens=[token("слово", 0, 9_000)], audio_duration_ms=1_000)

    with db.read() as connection:
        duration = connection.execute(
            "SELECT duration_ms FROM sessions WHERE id=?", (session_id,)
        ).fetchone()["duration_ms"]
    assert duration == 9_000


class TestSegmentation:
    def test_speaker_change_starts_a_new_segment(self) -> None:
        groups = segment_tokens([
            token("а", 0, 100, speaker="1"), token("б", 100, 200, speaker="2"),
        ])
        assert [len(group) for group in groups] == [1, 1]

    def test_a_long_pause_starts_a_new_segment(self) -> None:
        groups = segment_tokens([
            token("а", 0, 100, speaker="1"), token("б", 5_000, 5_100, speaker="1"),
        ])
        assert len(groups) == 2

    def test_a_translation_never_opens_a_segment(self) -> None:
        groups = segment_tokens([
            token("Hello", 0, 100, speaker="1"),
            token("Привет", 0, 0, speaker="1", status="translation"),
            token("world", 100, 200, speaker="1"),
        ])
        assert len(groups) == 1
        assert [t.text for t in groups[0]] == ["Hello", "Привет", "world"]

    def test_a_leading_translation_without_speech_is_dropped(self) -> None:
        # Nothing to attach it to: a translation is not speech in time.
        assert segment_tokens([token("Привет", 0, 0, status="translation")]) == []

    def test_tokens_without_a_speaker_are_not_merged_into_one(self) -> None:
        groups = segment_tokens([
            token("а", 0, 100, speaker=None), token("б", 4_000, 4_100, speaker=None),
        ])
        assert len(groups) == 2
