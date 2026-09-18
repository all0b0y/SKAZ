"""Session speech projected onto monologues, from both storage eras."""

from __future__ import annotations

from pathlib import Path

from audiohelper import repository as repo
from audiohelper import transcript_monologues as tm
from audiohelper.db import Database
from audiohelper.gateways.soniox import SonioxEvent, SonioxToken
from audiohelper.live_store import LiveStore
from audiohelper.schemas import Segment


def test_segment_only_session_yields_monologues_without_invented_speakers(tmp_path: Path) -> None:
    db = Database(tmp_path / "legacy.sqlite")
    session_id = repo.create_session(db, "Лекция").id
    segments = [
        Segment(id="s1", start_ms=0, end_ms=2_000, text="Первая мысль."),
        Segment(id="s2", start_ms=2_200, end_ms=4_000, text="Её продолжение."),
        Segment(id="s3", start_ms=30_000, end_ms=32_000, text="После долгой паузы."),
    ]
    with db.read() as connection:
        built = tm.build_monologues(connection, session_id, segments)
    assert [m.speaker for m in built] == [None, None]
    assert built[0].text == "Первая мысль. Её продолжение."
    assert built[1].text == "После долгой паузы."


def test_live_tokens_group_by_speaker(tmp_path: Path) -> None:
    db = Database(tmp_path / "live.sqlite")
    store = LiveStore(db, tmp_path / "audio")
    session_id = repo.create_session(db, "Встреча").id
    connection_id = store.open(session_id, sample_rate=16_000, model="stt-rt-v5").id
    # Blocks are bounded to 500 ms each, so two seconds of audio is five of them.
    for sequence in range(5):
        store.append_audio(
            connection_id, sequence=sequence, start_sample=sequence * 8_000,
            pcm=b"\x01\x00" * 8_000,
        )
    store.save_event(connection_id, ordinal=0, event=SonioxEvent(
        (
            SonioxToken("Вопрос ", 0, 400, .9, True, "ru", "1"),
            SonioxToken("от первого. ", 400, 800, .9, True, "ru", "1"),
            SonioxToken("Ответ второго. ", 900, 1_400, .9, True, "ru", "2"),
        ),
        (), (), 1_400, 2_000, False,
    ))
    with db.read() as connection:
        segments = repo.list_segments(db, session_id)
        built = tm.build_monologues(connection, session_id, segments)
    assert [m.speaker for m in built] == [1, 2]
    assert built[0].text == "Вопрос от первого."
    assert built[1].text == "Ответ второго."
