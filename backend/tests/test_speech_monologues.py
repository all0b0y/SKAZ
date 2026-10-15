"""A live recording's tokens, read by the speech area, group into monologues by speaker."""

from __future__ import annotations

from pathlib import Path

from skaz import monologues as mono
from skaz import repository as repo
from skaz.db import Database
from skaz.gateways.soniox import SonioxEvent, SonioxToken
from skaz.knowledge.speech.transcript import read_new_tokens
from skaz.live_store import LiveStore


def test_live_tokens_group_by_speaker(tmp_path: Path) -> None:
    db = Database(tmp_path / "live.sqlite")
    store = LiveStore(db)
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
        built = mono.build([found.token for found in read_new_tokens(connection, session_id, None)])
    assert [m.speaker for m in built] == [1, 2]
    assert built[0].text == "Вопрос от первого."
    assert built[1].text == "Ответ второго."
