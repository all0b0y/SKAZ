"""Transcript-only capture keeps clocks/text but never writes audio files."""
from pathlib import Path
from typing import Any

import pytest

from skaz import repository as repo
from skaz.config import AppConfig
from skaz.db import Database
from skaz.gateways.soniox import SonioxEvent, SonioxToken
from skaz.live_store import LiveConflict, LiveStore
from skaz.secrets import MemorySecretStore


def test_default_disables_retention(tmp_path: Path) -> None:
    assert not hasattr(AppConfig(token='test', data_dir=tmp_path), 'retain_native_audio')


def test_transcript_survives_restart_without_audio(tmp_path: Path) -> None:
    path = tmp_path / 'db.sqlite'
    audio = tmp_path / 'not-a-directory'
    audio.write_text('audio storage deliberately unavailable')
    db = Database(path)
    sid = repo.create_session(db, 'Transcript').id
    store = LiveStore(db)
    c = store.open(sid, sample_rate=16000, model='stt-rt-v5')
    for i in range(20):
        assert store.append_audio(c.id, sequence=i, start_sample=i*1600, pcm=b'\x01\x00'*1600)
    event = SonioxEvent((SonioxToken('Hello', 0, 1900, .9, True, 'en'),), (), (), 2000, 2000, False)
    ids = store.save_event(c.id, ordinal=0, event=event)
    assert repo.list_segments(db, sid)[0].sources == []
    assert repo.get_chunk(db, sid, 0) is None
    store.close(c.id, finished=True)
    db.close()
    db = Database(path)
    try:
        store = LiveStore(db)
        c = store.open(sid, sample_rate=16000, model='stt-rt-v5')
        assert (c.start_sample, c.next_sequence) == (32000, 20)
        assert repo.list_segments(db, sid)[0].id == ids[0]
        assert repo.list_segments(db, sid)[0].end_ms == 1900
        assert audio.read_text() == 'audio storage deliberately unavailable'
        assert store.append_audio(c.id, sequence=20, start_sample=32000, pcm=b'\x01\x00'*1600)
        assert not store.append_audio(c.id, sequence=20, start_sample=32000, pcm=b'\x01\x00'*1600)
        with pytest.raises(LiveConflict):
            store.append_audio(c.id, sequence=20, start_sample=32000, pcm=b'\x02\x00'*1600)
        with pytest.raises(LiveConflict):
            store.append_audio(c.id, sequence=22, start_sample=35200, pcm=b'\x01\x00'*1600)
    finally:
        db.close()


def test_audio_only_is_rejected_without_retention(tmp_path: Path) -> None:
    db = Database(tmp_path / 'db')
    try:
        store = LiveStore(db)
        sid = repo.create_session(db, 'Audio only').id
        with pytest.raises(LiveConflict, match='Invalid recording mode'):
            # Deliberately invalid external value exercises the runtime guard.
            invalid_mode: Any = 'audio_only'
            store.open(sid, sample_rate=16000, model='stt-rt-v5', recording_mode=invalid_mode)
    finally:
        db.close()


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return AppConfig(token='test-token', data_dir=tmp_path / 'data')


def test_default_websocket_transcribes_without_wav(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tests.test_native_soniox_ws import test_native_ws_forwards_once_and_persists_final_before_stop
    assert not hasattr(app.state.runtime.live_store, 'retain_audio')
    test_native_ws_forwards_once_and_persists_final_before_stop(app, secrets, monkeypatch)
    assert not list(app.state.runtime.config.audio_dir.rglob('*.wav'))


def test_long_transport_keeps_no_audio_and_one_receipt(tmp_path: Path) -> None:
    db = Database(tmp_path / 'db')
    try:
        store = LiveStore(db)
        sid = repo.create_session(db, 'Ten minutes of transport').id
        c = store.open(sid, sample_rate=16000, model='stt-rt-v5')
        for i in range(6000):
            store.append_audio(c.id, sequence=i, start_sample=i*1600, pcm=b'\x01\x00'*1600)
        assert store.snapshot(sid)['saved_samples'] == 9600000
        with db.read() as connection:
            assert connection.execute('SELECT COUNT(*) FROM native_transport_receipts').fetchone()[0] == 1
            assert connection.execute('SELECT COUNT(*) FROM chunks').fetchone()[0] == 0
        assert not (tmp_path / 'audio').exists()
    finally:
        db.close()
