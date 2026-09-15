"""Public persistence contract for ordered deltas/tails, replay and old data."""
from __future__ import annotations

import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from audiohelper import repository as repo
from audiohelper.db import Database
from audiohelper.gateways.soniox import SonioxEvent, SonioxToken, SonioxTokenRef, SonioxTranslationToken
from audiohelper.live_store import LiveConflict, LiveStore


def test_ordered_tail_replacement_replay_and_reopen(tmp_path: Path) -> None:
    path = tmp_path / "order.sqlite"
    db = Database(path)
    store = LiveStore(db, tmp_path / "audio")
    sid = repo.create_session(db, "Order").id
    connection = store.open(sid, sample_rate=16000, model="stt-rt-v5")
    store.append_audio(connection.id, sequence=0, start_sample=0, pcm=b"\x01\x00" * 1600)
    event = SonioxEvent(
        (), (SonioxToken("Hello", 0, 100, .9, False, "en", "2"),), (), 0, 100, False,
        partial_translation_tokens=(SonioxTranslationToken("Ja", .9, False, "de", "en", "1"),),
        token_order=(SonioxTokenRef("translation", False, 0), SonioxTokenRef("original", False, 0)),
    )
    store.save_event(connection.id, ordinal=0, event=event)
    tail = store.snapshot(sid)["partial_stream_tokens"]
    assert [t["text"] for t in tail] == ["Ja", "Hello"]
    assert [t["speaker_number"] for t in tail] == [1, 2]
    assert repo.list_segments(db, sid) == []
    db.close()
    db = Database(path)
    try:
        store = LiveStore(db, tmp_path / "audio")
        assert store.snapshot(sid)["partial_stream_tokens"] == tail
        replacement = replace(event, partial_tokens=(), partial_translation_tokens=(
            SonioxTranslationToken("Hallo", .9, False, "de", "en", "2"),
        ), token_order=(SonioxTokenRef("translation", False, 0),))
        store.save_event(connection.id, ordinal=1, event=replacement)
        assert [t["text"] for t in store.snapshot(sid)["partial_stream_tokens"]] == ["Hallo"]
        final = replace(replacement, partial_translation_tokens=(), final_translation_tokens=(
            SonioxTranslationToken("Hallo", .9, True, "de", "en", "2"),
        ), token_order=(SonioxTokenRef("translation", True, 0),))
        store.save_event(connection.id, ordinal=2, event=final)
        store.save_event(connection.id, ordinal=2, event=final)
        assert store.snapshot(sid)["partial_stream_tokens"] == []
        assert len(store.snapshot(sid)["final_stream_tokens"]) == 1
        with pytest.raises(LiveConflict, match="Conflicting event replay"):
            store.save_event(connection.id, ordinal=0, event=replace(
                event, token_order=tuple(reversed(event.token_order or ())),
            ))
    finally:
        db.close()


def test_pre_v5_data_remains_readable_without_invented_order(tmp_path: Path) -> None:
    path = tmp_path / "old.sqlite"
    db = Database(path)
    store = LiveStore(db, tmp_path / "audio")
    sid = repo.create_session(db, "Old").id
    connection = store.open(sid, sample_rate=16000, model="stt-rt-v5")
    store.append_audio(connection.id, sequence=0, start_sample=0, pcm=b"\x01\x00" * 1600)
    event = SonioxEvent((SonioxToken("Hello", 0, 100, .9, True, "en"),), (), (), 100, 100, False)
    ids = store.save_event(connection.id, ordinal=0, event=event)
    db.close()
    with sqlite3.connect(path) as old:
        old.execute("DROP TABLE native_stream_events")
        old.execute("ALTER TABLE asr_connections DROP COLUMN stream_draft_json")
        old.execute("DELETE FROM schema_migrations WHERE name='native_stream_order_v5'")
    db = Database(path)
    try:
        store = LiveStore(db, tmp_path / "audio")
        assert store.snapshot(sid)["final_stream_tokens"] == []
        assert [t["text"] for t in store.snapshot(sid)["final_tokens"]] == ["Hello"]
        assert store.save_event(connection.id, ordinal=0, event=replace(
            event, token_order=(SonioxTokenRef("none", True, 0),),
        )) == ids
        assert store.snapshot(sid)["final_stream_tokens"] == []
    finally:
        db.close()
