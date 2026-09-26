"""Native archive adapter. Connection/event order is data, never reconstructed."""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from .library_session_schema import NativeRecording


def capture_native(db: sqlite3.Connection, session_id: str) -> dict[str, Any] | None:
    row = db.execute("SELECT * FROM native_recordings WHERE session_id=?", (session_id,)).fetchone()
    if row is None:
        return None
    recording = dict(row)
    recording.pop("session_id")
    languages = recording.pop("used_languages_json")
    recording["used_languages"] = json.loads(languages) if languages is not None else None
    recording["connections"] = []
    for row in db.execute("SELECT * FROM asr_connections WHERE session_id=? ORDER BY rowid", (session_id,)):
        item = dict(row)
        item.pop("session_id")
        for key in ("draft", "translation_draft", "stream_draft"):
            item[key] = json.loads(item.pop(key + "_json"))
        item["speakers"] = [dict(s) for s in db.execute(
            "SELECT provider_id,number FROM native_speakers WHERE connection_id=? ORDER BY number",
            (row["id"],),
        )]
        item["events"] = []
        for event in db.execute(
            "SELECT ordinal,digest,segment_ids FROM native_asr_events WHERE connection_id=? ORDER BY ordinal",
            (row["id"],),
        ):
            event_doc = dict(event)
            event_doc["segment_ids"] = json.loads(event_doc["segment_ids"])
            for key, table in (("originals", "native_token_events"),
                               ("translations", "native_translation_events"),
                               ("stream", "native_stream_events")):
                tokens = db.execute(f"SELECT tokens_json FROM {table} WHERE connection_id=? AND ordinal=?",
                                    (row["id"], event["ordinal"])).fetchone()
                event_doc[key] = json.loads(tokens["tokens_json"]) if tokens is not None else None
            item["events"].append(event_doc)
        recording["connections"].append(item)
    receipt = db.execute(
        "SELECT sequence,start_sample,end_sample,digest FROM native_transport_receipts WHERE session_id=?",
        (session_id,),
    ).fetchone()
    recording["receipt"] = dict(receipt) if receipt is not None else None
    return recording


def restore_native(db: sqlite3.Connection, session_id: str, native: NativeRecording) -> None:
    def encode(value: object) -> str:
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))

    db.execute(
        "INSERT INTO native_recordings(session_id,sample_rate,saved_samples,next_sequence,recording_mode,"
        "translation_target_language,used_languages_json,origin) VALUES (?,?,?,?,?,?,?,?)",
        (session_id, native.sample_rate, native.saved_samples, native.next_sequence, native.recording_mode,
         native.translation_target_language,
         encode(native.used_languages) if native.used_languages is not None else None, native.origin),
    )
    for connection in native.connections:
        body = connection.model_dump(exclude_unset=True)
        db.execute(
            "INSERT INTO asr_connections(id,session_id,start_sample,end_sample,model,status,final_sample,"
            "processed_sample,next_event,draft_json,translation_draft_json,stream_draft_json) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (connection.id, session_id, connection.start_sample,
             native.saved_samples if connection.status == "active" else connection.end_sample,
             connection.model, "incomplete" if connection.status == "active" else connection.status,
             connection.final_sample, connection.processed_sample, connection.next_event,
             encode(body["draft"]), encode(body["translation_draft"]), encode(body["stream_draft"])),
        )
        for speaker in connection.speakers:
            db.execute("INSERT INTO native_speakers(connection_id,provider_id,session_id,number) "
                       "VALUES (?,?,?,?)",
                       (connection.id, speaker.provider_id, session_id, speaker.number))
        for event in connection.events:
            db.execute("INSERT INTO native_asr_events(connection_id,ordinal,digest,segment_ids) "
                       "VALUES (?,?,?,?)",
                       (connection.id, event.ordinal, event.digest, encode(event.segment_ids)))
            event_doc = event.model_dump(exclude_unset=True)
            for key, table in (("originals", "native_token_events"),
                               ("translations", "native_translation_events"),
                               ("stream", "native_stream_events")):
                if event_doc[key] is not None:
                    db.execute(f"INSERT INTO {table}(connection_id,ordinal,tokens_json) VALUES (?,?,?)",
                               (connection.id, event.ordinal, encode(event_doc[key])))
    if native.receipt is not None:
        receipt = native.receipt
        db.execute("INSERT INTO native_transport_receipts("
                   "session_id,sequence,start_sample,end_sample,digest) "
                   "VALUES (?,?,?,?,?)", (session_id, receipt.sequence, receipt.start_sample,
                                          receipt.end_sample, receipt.digest))
