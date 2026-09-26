from pathlib import Path

from audiohelper import repository as repo
from audiohelper.db import Database
from audiohelper.import_store import ImportSource, ImportStore
from audiohelper.library_archive import SessionArchive


def test_youtube_provenance_survives_library_recovery(tmp_path: Path) -> None:
    source = Database(tmp_path / "source.sqlite")
    target = Database(tmp_path / "target.sqlite")
    try:
        store = ImportStore(source)
        session = repo.create_session(source, "Lecture")
        record = store.create(session.id, source=ImportSource(
            path=str(tmp_path / "temporary.flac"), name="Lecture", size_bytes=0, mtime_ns=0,
            sha256="", kind="youtube", url="https://www.youtube.com/watch?v=abcdefghijk",
            video_id="abcdefghijk",
        ), model="stt-async-v4", translate=False, used_languages=(),
            translation_target_language="en", declared_duration_ms=1000)
        store.mark_processing(record.session_id, transcription_id="offline-job")
        store.apply_transcript(record.session_id, tokens=(), audio_duration_ms=1000)
        archive = SessionArchive.capture(source, record.session_id, note_paths={})
        directory = tmp_path / "Recovered"
        directory.mkdir()
        (directory / "session.json").write_bytes(archive.marker)
        SessionArchive.restore_new(target, directory)
        restored = ImportStore(target).get(record.session_id)
        assert restored is not None and restored.status == "completed"
        assert restored.source.video_id == "abcdefghijk"
        assert restored.source.url == "https://www.youtube.com/watch?v=abcdefghijk"
        assert repo.get_session(target, record.session_id).origin == "import"
        # Archives must not leak local paths, staged files or provider job IDs.
        assert b"temporary.flac" not in archive.marker
    finally:
        source.close()
        target.close()
