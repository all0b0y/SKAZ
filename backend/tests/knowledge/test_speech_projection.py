"""Speech → material fragments: closed monologues only, stable ``seg``, idempotent, crash safe.

The legacy store is driven through ``LiveStore`` (the seam ``NativeStream``
uses); the words are scripted. This proves the projection, not ASR quality.
"""
from __future__ import annotations

import statistics
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from skaz import repository as repo
from skaz import transcript_monologues as tmono
from skaz.db import Database
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.markdown.source import render_source, source_paragraphs
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.speech.projector import SpeechProjector
from skaz.knowledge.speech.translation import TRANSLATION_FILE

from .speech_support import Recorder, sentence


@pytest.fixture
def legacy(tmp_path: Path) -> Iterator[Database]:
    db = Database(tmp_path / "legacy.sqlite3")
    yield db
    db.close()


def recording(kb: KnowledgeService, legacy: Database, title: str = "Lecture") -> tuple[str, str]:
    session = repo.create_session(legacy, title)
    files = kb.create_material(INBOX_ID, title, "recording", [], status="recording")
    return files.manifest.id, session.id


def texts(kb: KnowledgeService, material_id: str) -> list[tuple[int, str, str | None]]:
    return [(item.seg, item.text, item.speaker) for item in kb.material(material_id).fragments]


def source_text(kb: KnowledgeService, material_id: str) -> str:
    record = kb.material_repo.get(material_id)
    assert record is not None
    return (kb.library_root / record.source_file).read_text(encoding="utf-8")


def legacy_monologues(legacy: Database, session_id: str) -> list[str]:
    with legacy.read() as connection:
        built = tmono.build_monologues(connection, session_id, repo.list_segments(legacy, session_id))
    return [item.text for item in built]


def test_only_closed_monologues_are_written_and_seg_ids_stay(
    ready: KnowledgeService, legacy: Database,
) -> None:
    material_id, session_id = recording(ready, legacy)
    projector = SpeechProjector(ready, legacy.read)
    mic = Recorder.open(legacy, session_id)

    mic.say(sentence("Today we talk about entropy", 0, "1"))
    assert projector.project(material_id, session_id, final=False) == []  # one open monologue
    mic.say(sentence("Is it disorder", 2_000, "2"))
    added = projector.project(material_id, session_id, final=False)
    assert [(item.seg, item.text) for item in added] == [(1, "Today we talk about entropy")]
    mic.say(sentence("Not exactly", 3_500, "1"))
    projector.project(material_id, session_id, final=False)
    assert texts(ready, material_id) == [(1, "Today we talk about entropy", "1"), (2, "Is it disorder", "2")]

    # Stop: the tail closes; existing ids never move.
    projector.project(material_id, session_id, final=True)
    assert texts(ready, material_id) == [
        (1, "Today we talk about entropy", "1"), (2, "Is it disorder", "2"), (3, "Not exactly", "1"),
    ]
    # Re-projection is a no-op: no duplicates.
    assert projector.project(material_id, session_id, final=True) == []
    assert projector.project(material_id, session_id, final=False) == []
    markdown = source_text(ready, material_id)
    assert "**Speaker 2** · 00:02\nIs it disorder ^seg-2" in markdown
    assert sorted(source_paragraphs(markdown)) == [1, 2, 3]
    # The appended file is byte-identical to a full render of the same fragments.
    files = ready.require().read_material(material_id)
    assert markdown == render_source(material_id, "recording", files.fragments)
    # Same text as the legacy reader's monologues for the whole session.
    written = [text for _seg, text, _speaker in texts(ready, material_id)]
    assert written == legacy_monologues(legacy, session_id)


def test_a_monologue_spanning_events_is_written_once_closed(
    ready: KnowledgeService, legacy: Database,
) -> None:
    material_id, session_id = recording(ready, legacy)
    projector = SpeechProjector(ready, legacy.read)
    mic = Recorder.open(legacy, session_id)
    mic.say(sentence("The first law", 0, "1"))
    mic.say(sentence("of thermodynamics", 900, "1"))
    assert projector.project(material_id, session_id, final=False) == []
    mic.say(sentence("states", 1_500, "1"))
    mic.say(sentence("Question", 5_000, "1"))  # a pause longer than the monologue gap
    projector.project(material_id, session_id, final=False)
    assert texts(ready, material_id) == [(1, "The first law of thermodynamics states", "1")]


def test_restart_mid_recording_neither_duplicates_nor_loses(
    ready: KnowledgeService, legacy: Database, kb_config: object, tmp_path: Path,
) -> None:
    material_id, session_id = recording(ready, legacy)
    mic = Recorder.open(legacy, session_id)
    for index in range(6):
        mic.say(sentence(f"Part {index} of the talk", index * 2_000, str(index % 2 + 1)))
    SpeechProjector(ready, legacy.read).project(material_id, session_id, final=False)
    before = texts(ready, material_id)
    assert len(before) == 5

    # The backend goes away; the recording continues in the legacy store meanwhile.
    ready.close()
    mic.say(sentence("After the restart", 12_000, "1"))
    reopened = KnowledgeService(ready.data_dir, documents_dir=ready.documents_dir,
                                documents_sandbox=ready.documents_sandbox)
    try:
        reopened.start()
        projector = SpeechProjector(reopened, legacy.read)
        projector.project(material_id, session_id, final=False)
        projector.project(material_id, session_id, final=True)
        after = texts(reopened, material_id)
        assert after[:5] == before
        assert [text for _seg, text, _speaker in after] == legacy_monologues(legacy, session_id)
        assert [seg for seg, _text, _speaker in after] == list(range(1, 8))
    finally:
        reopened.close()


def test_a_crash_between_source_and_manifest_writes_is_repaired_without_duplicates(
    ready: KnowledgeService, legacy: Database, monkeypatch: pytest.MonkeyPatch,
) -> None:
    material_id, session_id = recording(ready, legacy)
    projector = SpeechProjector(ready, legacy.read)
    mic = Recorder.open(legacy, session_id)
    mic.say(sentence("One", 0, "1"))
    mic.say(sentence("Two", 1_000, "2"))
    projector.project(material_id, session_id, final=False)
    mic.say(sentence("Three", 2_000, "1"))

    from skaz.knowledge.library.fsio import write_atomic as original

    def crash_on_manifest(path: Path, data: bytes) -> None:
        if path.name == "material.json":
            raise OSError("power cut")
        original(path, data)

    monkeypatch.setattr("skaz.knowledge.library.library.write_atomic", crash_on_manifest)
    with pytest.raises(OSError):
        projector.project(material_id, session_id, final=False)
    monkeypatch.setattr("skaz.knowledge.library.library.write_atomic", original)
    # The appended paragraph is on disk but unlisted: readers do not see it.
    assert texts(ready, material_id) == [(1, "One", "1")]

    projector.project(material_id, session_id, final=True)
    assert texts(ready, material_id) == [(1, "One", "1"), (2, "Two", "2"), (3, "Three", "1")]
    markdown = source_text(ready, material_id)
    assert markdown.count("Two ^seg-") == 1
    rendered = render_source(material_id, "recording", ready.require().read_material(material_id).fragments)
    assert markdown == rendered


def test_pause_and_continue_write_into_the_same_material(ready: KnowledgeService, legacy: Database) -> None:
    material_id, session_id = recording(ready, legacy)
    projector = SpeechProjector(ready, legacy.read)
    mic = Recorder.open(legacy, session_id)
    mic.say(sentence("Before the break", 0, None))
    mic.close()  # Pause
    projector.project(material_id, session_id, final=True)
    mic = Recorder.open(legacy, session_id)  # Continue: same session, new connection
    # The sample clock does not advance during a pause; undiarised words right
    # after it are still a new fragment, never glued onto the written one.
    mic.say(sentence("After the break", 100, None))
    projector.project(material_id, session_id, final=True)
    assert texts(ready, material_id) == [(1, "Before the break", None), (2, "After the break", None)]
    assert [item.start_ms for item in ready.material(material_id).fragments] == [0, 1_100]


def test_translation_goes_to_translation_md_without_times_or_seg(
    ready: KnowledgeService, legacy: Database,
) -> None:
    material_id, session_id = recording(ready, legacy)
    projector = SpeechProjector(ready, legacy.read)
    mic = Recorder.open(legacy, session_id, mode="translation", target="ru")
    mic.say(sentence("Good morning", 0, "1"), translation=[("Доброе", "1"), (" утро", "1")])
    mic.say(sentence("Hello", 1_000, "2"), translation=[("Привет", "2")])
    projector.project(material_id, session_id, final=True)
    path = projector.write_translation(material_id, session_id)
    assert path is not None and path.name == TRANSLATION_FILE and path.parent.name == ".skaz"
    content = path.read_text(encoding="utf-8")
    assert content.splitlines()[:5] == [
        "---", f'skaz_id: "{material_id}"', 'kind: "translation"', 'language: "ru"', "---",
    ]
    assert "**Speaker 1**\nДоброе утро" in content and "**Speaker 2**\nПривет" in content
    assert "^seg" not in content and "00:0" not in content
    # The original stays original-only.
    assert [text for _seg, text, _speaker in texts(ready, material_id)] == ["Good morning", "Hello"]


def test_no_translation_file_without_translated_speech(ready: KnowledgeService, legacy: Database) -> None:
    material_id, session_id = recording(ready, legacy)
    projector = SpeechProjector(ready, legacy.read)
    Recorder.open(legacy, session_id).say(sentence("Plain", 0, "1"))
    assert projector.write_translation(material_id, session_id) is None


def test_projection_of_three_hours_stays_proportional_to_new_speech(ready: KnowledgeService) -> None:
    """~1000 monologues (3 h, two speakers): one projection of the next closed monologue ≤ 50 ms."""
    legacy = Database(":memory:")
    try:
        material_id, session_id = recording(ready, legacy)
        projector = SpeechProjector(ready, legacy.read)
        mic = Recorder.open(legacy, session_id)
        monologue_ms = 10_800
        words = " ".join(f"word{index}" for index in range(27))

        def speak(index: int) -> None:
            mic.say(sentence(words, index * monologue_ms, str(index % 2 + 1), word_ms=400))

        for index in range(990):
            speak(index)
        projector.project(material_id, session_id, final=False)
        assert len(ready.material(material_id).fragments) == 989
        timings = []
        for index in range(990, 1_010):
            speak(index)
            started = time.perf_counter()
            added = projector.project(material_id, session_id, final=False)
            timings.append((time.perf_counter() - started) * 1000)
            assert len(added) == 1
        fragments = ready.material(material_id).fragments
        assert len(fragments) == 1_009 and fragments[-1].seg == 1_009
        median, worst = statistics.median(timings), max(timings)
        print(f"\nprojection at ~1000 fragments: median {median:.1f} ms, max {worst:.1f} ms")
        assert median <= 50
    finally:
        legacy.close()
