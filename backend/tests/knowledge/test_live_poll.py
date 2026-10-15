"""The live panel's poll: never queued behind a writer, and only the tail of the material (review M3).

``projector.live`` took the material's lock while ``project`` held that lock waiting for
``kb.writing()`` (a scan, another area's write): every 1.5 s poll took a worker thread and
waited too, and each poll re-read the whole material besides.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from skaz import repository as repo
from skaz.db import Database
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.speech.projector import SpeechProjector

from .speech_support import Recorder, sentence


@pytest.fixture
def legacy(tmp_path: Path) -> Iterator[Database]:
    db = Database(tmp_path / "legacy.sqlite3")
    yield db
    db.close()


def _recording(kb: KnowledgeService, legacy: Database) -> tuple[str, str]:
    session = repo.create_session(legacy, "Lecture")
    files = kb.create_material(INBOX_ID, "Lecture", "recording", [], status="recording")
    return files.manifest.id, session.id


def test_the_live_read_never_waits_for_a_writer_elsewhere(ready: KnowledgeService, legacy: Database) -> None:
    material_id, session_id = _recording(ready, legacy)
    projector = SpeechProjector(ready, legacy.read)
    mic = Recorder.open(legacy, session_id)
    mic.say(sentence("Today we talk about entropy", 0, "1"))
    mic.say(sentence("Is it disorder", 2_000, "2"))  # the first monologue closed: a projection will write

    writer_holds = threading.Event()
    release = threading.Event()

    def writer() -> None:  # a scan or another area's library write
        with ready.writing():
            writer_holds.set()
            release.wait(5)

    threads = [threading.Thread(target=writer),
               threading.Thread(target=projector.project, args=(material_id, session_id),
                                kwargs={"final": False})]
    threads[0].start()
    assert writer_holds.wait(2)
    threads[1].start()
    time.sleep(0.3)  # the projection is waiting for the writer now
    try:
        started = time.monotonic()
        tail = projector.live(material_id, session_id)
        waited = time.monotonic() - started
    finally:
        release.set()
        for thread in threads:
            thread.join(5)
    assert waited < 1.0, f"the live read waited {waited:.2f} s behind the writer"
    # Not projected yet: both monologues are still live, the text continues after fragment 0.
    assert (tail.after_seg, [m.text for m in tail.monologues]) == (0, ["Today we talk about entropy",
                                                                       "Is it disorder"])
    assert [f.seg for f in ready.material(material_id).fragments] == [1]  # the projection went on after


def test_the_live_read_brings_only_the_fragments_after_since_seg(ready: KnowledgeService,
                                                                 legacy: Database) -> None:
    material_id, session_id = _recording(ready, legacy)
    projector = SpeechProjector(ready, legacy.read)
    mic = Recorder.open(legacy, session_id)
    for index, text in enumerate(("One", "Two", "Three", "Four")):
        mic.say(sentence(text, index * 2_000, str(index % 2 + 1)))
    projector.project(material_id, session_id, final=False)  # One, Two, Three closed; Four open

    assert projector.live(material_id, session_id).fragments == ()  # no since_seg: no fragments
    tail = projector.live(material_id, session_id, since_seg=1)
    assert tail.after_seg == 3
    assert [(f.seg, f.text) for f in tail.fragments] == [(2, "Two"), (3, "Three")]
    assert [m.text for m in tail.monologues] == ["Four"]
    assert projector.live(material_id, session_id, since_seg=3).fragments == ()
