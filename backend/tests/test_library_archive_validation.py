"""Untrusted session files must not partially populate an index."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from audiohelper import repository as repo
from audiohelper.db import Database
from audiohelper.gateways.soniox import SonioxEvent, SonioxToken, SonioxTokenRef
from audiohelper.library_archive import ArchiveRefused, SessionArchive
from audiohelper.live_store import LiveStore


def native_document(db: Database, tmp_path: Path) -> dict[str, Any]:
    session = repo.create_session(db, "Native")
    store = LiveStore(db)
    conn = store.open(session.id, sample_rate=16000, model="stt-rt-v5")
    store.append_audio(conn.id, sequence=0, start_sample=0, pcm=b"\x01\x00" * 1600)
    store.save_event(conn.id, ordinal=0, event=SonioxEvent(
        (SonioxToken("Recognized speech.", 0, 100, .9, True, "en", "1"),), (), (), 100, 100, False,
        token_order=(SonioxTokenRef("original", True, 0),),
    ))
    store.close(conn.id, finished=True)
    return dict(json.loads(SessionArchive.capture(db, session.id, note_paths={}).marker))


@pytest.mark.parametrize("corruption", [
    "unknown", "version-bool", "foreign-token", "foreign-segment", "foreign-event-segment",
    "duplicate-token", "missing-token-time", "negative-range", "clock", "ordinal", "next-event",
    "stream-mismatch", "partial-in-final", "speaker", "duplicate-connection", "receipt", "end-sample",
    "segment-range", "duplicate-segment", "missing-native",
])
def test_rejects_invalid_native_document_without_partial_index(tmp_path: Path, corruption: str) -> None:
    source, target = Database(":memory:"), Database(":memory:")
    try:
        doc = native_document(source, tmp_path)
        native = doc["native"]
        conn = native["connections"][0]
        event = conn["events"][0]
        token = event["originals"][0]
        if corruption == "unknown":
            doc["app_settings"] = {"secret": "not imported"}
        elif corruption == "version-bool":
            doc["version"] = True
        elif corruption == "foreign-token":
            token["connection_id"] = "a" * 32
        elif corruption == "foreign-segment":
            token["segment_id"] = "a" * 32
        elif corruption == "foreign-event-segment":
            event["segment_ids"] = ["a" * 32]
        elif corruption == "duplicate-token":
            event["originals"].append(dict(token))
        elif corruption == "missing-token-time":
            token.pop("start_sample")
        elif corruption == "negative-range":
            token["end_ms"] = 0
            token["start_ms"] = 100
        elif corruption == "clock":
            conn["processed_sample"] = 1601
        elif corruption == "ordinal":
            event["ordinal"] = 1
        elif corruption == "next-event":
            conn["next_event"] = 2
        elif corruption == "stream-mismatch":
            event["stream"][0]["text"] = "invented"
        elif corruption == "partial-in-final":
            token["is_final"] = False
        elif corruption == "speaker":
            token["speaker_number"] = 99
        elif corruption == "duplicate-connection":
            native["connections"].append(dict(conn))
        elif corruption == "receipt":
            native["receipt"]["end_sample"] = 999999
        elif corruption == "end-sample":
            conn["end_sample"] = None
        elif corruption == "segment-range":
            doc["segments"][0]["start_ms"] = 101
        elif corruption == "duplicate-segment":
            doc["segments"].append(dict(doc["segments"][0]))
        elif corruption == "missing-native":
            doc["native"] = None
        folder = tmp_path / "Recovery"
        folder.mkdir()
        (folder / "session.json").write_text(json.dumps(doc), encoding="utf-8")
        existing = repo.create_session(target, "Untouched")
        with pytest.raises(ArchiveRefused):
            SessionArchive.restore_new(target, folder)
        assert repo.list_sessions(target) == [existing]
        assert repo.list_segments(target, doc["session"]["id"]) == []
    finally:
        source.close()
        target.close()
