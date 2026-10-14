"""Units under the speech projection: appendable sources, the event hook, import-shaped speech."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from skaz import repository as repo
from skaz import transcript_monologues as tmono
from skaz.db import Database
from skaz.gateways.soniox import SonioxEvent, SonioxToken
from skaz.gateways.soniox_async import AsyncToken
from skaz.import_store import ImportSource, ImportStore
from skaz.knowledge.index import indexer
from skaz.knowledge.library.fsio import dump_json_rows
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.markdown.source import FragmentInput, MaterialManifest, render_source
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.speech.media import default_recording_titles, file_kind
from skaz.knowledge.speech.projector import SpeechProjector
from skaz.live_store import LiveStore


def source_of(kb: KnowledgeService, material_id: str) -> Path:
    record = kb.material_repo.get(material_id)
    assert record is not None
    return kb.library_root / record.source_file


def test_appending_matches_a_full_render_and_survives_torn_or_external_writes(
    ready: KnowledgeService,
) -> None:
    library = ready.require()
    files = ready.create_material(INBOX_ID, "Talk", "recording", [FragmentInput("One", 0, 100, "1")])
    material_id = files.manifest.id
    path = source_of(ready, material_id)

    library.append_fragments(material_id, [FragmentInput("Two", 100, 200, "2")])
    rendered = render_source(material_id, "recording", library.read_material(material_id).fragments)
    assert path.read_text() == rendered

    # A torn append (crash mid-write) leaves junk after the listed paragraphs.
    with path.open("a", encoding="utf-8") as handle:
        handle.write("\nThree half-wri")
    library.append_fragments(material_id, [FragmentInput("Three", 200, 300, "1")])
    fragments = library.read_material(material_id).fragments
    assert [(item.seg, item.text) for item in fragments] == [(1, "One"), (2, "Two"), (3, "Three")]
    assert path.read_text() == render_source(material_id, "recording", fragments)
    assert "half-wri" not in path.read_text()

    # Appending to a material with no fragments yet.
    empty = ready.create_material(INBOX_ID, "Empty", "recording", []).manifest.id
    library.append_fragments(empty, [FragmentInput("First", 0, 10, None)])
    assert source_of(ready, empty).read_text() == render_source(
        empty, "recording", library.read_material(empty).fragments)


def test_manifest_extras_never_replace_fields_and_rows_json_round_trips(ready: KnowledgeService) -> None:
    library = ready.require()
    material_id = ready.create_material(INBOX_ID, "Talk", "recording", []).manifest.id
    with pytest.raises(ValueError):
        library.append_fragments(material_id, [], manifest_extra={"fragments": []})
    library.append_fragments(material_id, [FragmentInput("One", 0, 10, "1")],
                             manifest_extra={"area": {"x": 1}})
    manifest = library.material_manifest(material_id)
    assert manifest.model_extra is not None and manifest.model_extra["area"] == {"x": 1}
    assert library.manifest_value(material_id, "area") == {"x": 1}
    dumped = manifest.model_dump()
    assert json.loads(dump_json_rows(dumped)) == json.loads(json.dumps(dumped))
    assert MaterialManifest.model_validate(json.loads(dump_json_rows(dumped))) == manifest


def test_incremental_index_needs_an_indexed_material(ready: KnowledgeService) -> None:
    assert indexer.append_fragments(ready.db, "mat-unknown", []) is False


def test_a_failing_event_listener_never_breaks_the_recording(tmp_path: Path) -> None:
    db = Database(tmp_path / "legacy.sqlite3")
    try:
        session = repo.create_session(db, "Talk")
        store = LiveStore(db)
        heard: list[str] = []

        def broken(_session_id: str) -> None:
            raise RuntimeError("listener bug")

        store.add_listener(broken)
        store.add_listener(heard.append)
        connection = store.open(session.id, sample_rate=16_000, model="stt-rt-v5")
        store.append_audio(connection.id, sequence=0, start_sample=0, pcm=b"\x01\x00" * 8_000)
        event = SonioxEvent((SonioxToken("Hi", 0, 100, 0.9, True, "en", "1"),), (), (), 200, 200, False)
        ids = store.save_event(connection.id, ordinal=0, event=event)
        assert ids and heard == [session.id]
        assert store.save_event(connection.id, ordinal=0, event=event) == ids  # a replay adds nothing
        assert heard == [session.id]
    finally:
        db.close()


def test_imported_speech_projects_like_the_legacy_reader(ready: KnowledgeService, tmp_path: Path) -> None:
    db = Database(tmp_path / "legacy.sqlite3")
    try:
        session = repo.create_session(db, "Imported")
        store = ImportStore(db)
        source = ImportSource(str(tmp_path / "a.m4a"), "a.m4a", 10, 1, "0" * 64)
        store.create(session.id, source=source, model="stt-async-v5", translate=False,
                     translation_target_language="en", used_languages=None, declared_duration_ms=None)
        store.mark_uploaded(session.id, provider_file_id="84c32fc6-4fb5-4e7a-b656-b5ec70493753")
        store.mark_submitting(session.id)
        store.mark_processing(session.id, transcription_id="73d4357d-cad2-4338-a60d-ec6f2044f721")
        words = [("Good", 0, 300, "1"), (" morning", 300, 700, "1"), ("Hello", 1_000, 1_300, "2"),
                 (" all", 1_300, 1_600, "2"), ("Again", 6_000, 6_400, "2")]
        store.apply_transcript(session.id, tokens=[AsyncToken(text, start, end, 0.9, speaker, "en", "none")
                                                   for text, start, end, speaker in words],
                               audio_duration_ms=7_000)
        material_id = ready.create_material(INBOX_ID, "Imported", "audio", [],
                                            status="processing").manifest.id
        added = SpeechProjector(ready, db.read).project(material_id, session.id, final=True)
        with db.read() as connection:
            expected = tmono.build_monologues(connection, session.id, repo.list_segments(db, session.id))
        assert [(item.text, item.start_ms, item.end_ms) for item in added] == [
            (item.text, item.start_ms, item.end_ms) for item in expected]
        assert [item.text for item in added] == ["Good morning", "Hello all", "Again"]
    finally:
        db.close()


def test_kinds_and_default_titles() -> None:
    from datetime import datetime

    assert file_kind(Path("/a/b.MP3")) == "audio" and file_kind(Path("/a/b.mov")) == "video"
    with pytest.raises(ValueError):
        file_kind(Path("/a/b.pdf"))
    assert default_recording_titles(datetime(2026, 10, 5, 9, 7, 3)) == (
        "Recording Oct 5, 2026 09.07", "Recording Oct 5, 2026 09.07.03")
