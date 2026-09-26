"""Connection-scoped immutable event pages, independent of full UI projections."""
from __future__ import annotations

import json
from typing import Any

from .db import Database
from .live_store import LiveConflict

MAX_PAGE_BYTES = 256 * 1024
MAX_STORED_FIELD_CHARS = 1024 * 1024


class EventPageTooLarge(ValueError):
    """An indivisible event/tail exceeds the bounded transport envelope."""


def _size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


class EventCursorConflict(ValueError):
    """The cursor cannot describe the committed prefix of this connection."""


def read_event_page(
    db: Database, session_id: str, *, connection_id: str | None = None,
    after: int | None = None, before: int | None = None, limit: int = 64,
) -> dict[str, Any]:
    # Same lock as save_event: final tokens, ordinal and draft are one read.
    with db.read() as connection:
        recording = connection.execute(
            "SELECT session_id,sample_rate,saved_samples,recording_mode,translation_target_language "
            "FROM native_recordings WHERE session_id=?", (session_id,),
        ).fetchone()
        if recording is None:
            raise LiveConflict("Native recording does not exist.")
        row = connection.execute(
            "SELECT rowid AS position,* FROM asr_connections WHERE session_id=? "
            + ("AND id=?" if connection_id else "ORDER BY rowid DESC LIMIT 1"),
            (session_id, connection_id) if connection_id else (session_id,),
        ).fetchone()
        if row is None and connection_id is not None:
            raise LiveConflict("Connection does not exist in this session.")
        through = row["next_event"] - 1 if row else -1
        if after is not None and after > through:
            raise EventCursorConflict("Cursor is ahead of the committed event prefix.")
        if before is not None and before > through + 1:
            raise EventCursorConflict("Cursor is ahead of the committed event prefix.")
        reverse = after is None
        boundary = before if before is not None else through + 1
        start = after if after is not None else -1
        previous_id = next_id = None
        if row:
            previous = connection.execute(
                "SELECT id FROM asr_connections WHERE session_id=? AND rowid<? ORDER BY rowid DESC LIMIT 1",
                (session_id, row["position"]),
            ).fetchone()
            following = connection.execute(
                "SELECT id FROM asr_connections WHERE session_id=? AND rowid>? ORDER BY rowid LIMIT 1",
                (session_id, row["position"]),
            ).fetchone()
            previous_id = previous["id"] if previous else None
            next_id = following["id"] if following else None
        tail = ({"originals": json.loads(row["draft_json"]),
                 "translations": json.loads(row["translation_draft_json"]),
                 "stream": json.loads(row["stream_draft_json"])} if row else None)
        if tail and row:
            numbers: dict[str, int | None] = {}
            for token in tail["originals"]:
                speaker = token.get("speaker")
                if speaker is not None and speaker not in numbers:
                    number = connection.execute(
                        "SELECT number FROM native_speakers WHERE connection_id=? AND provider_id=?",
                        (row["id"], speaker),
                    ).fetchone()
                    numbers[speaker] = number["number"] if number else None
                token["speaker_number"] = numbers.get(speaker) if speaker is not None else None
        # Reserve the tail and fixed metadata before accepting any event. A
        # lagging page withholds the tail, but must leave room to catch up.
        used_bytes = 8192 + _size(tail)
        if used_bytes > MAX_PAGE_BYTES:
            raise EventPageTooLarge("Live tail exceeds the event-page byte limit.")
        events: list[dict[str, Any]] = []
        if row:
            rows = connection.execute(
                "SELECT e.ordinal,substr(e.segment_ids,1,1048577) AS segment_ids,"
                "substr(o.tokens_json,1,1048577) AS originals,"
                "substr(t.tokens_json,1,1048577) AS translations,"
                "substr(s.tokens_json,1,1048577) AS stream "
                "FROM native_asr_events e "
                "LEFT JOIN native_token_events o USING(connection_id,ordinal) "
                "LEFT JOIN native_translation_events t USING(connection_id,ordinal) "
                "LEFT JOIN native_stream_events s USING(connection_id,ordinal) "
                "WHERE e.connection_id=? AND "
                + ("e.ordinal<? ORDER BY e.ordinal DESC LIMIT ?" if reverse
                   else "e.ordinal>? ORDER BY e.ordinal LIMIT ?"),
                (row["id"], boundary if reverse else start, limit),
            )
            for item in rows:
                if any(len(item[key] or "") > MAX_STORED_FIELD_CHARS
                       for key in ("segment_ids", "originals", "translations", "stream")):
                    if events:
                        break
                    raise EventPageTooLarge("Stored event exceeds the event-page read limit.")
                stream = json.loads(item["stream"]) if item["stream"] is not None else None
                payload = {
                    "ordinal": item["ordinal"], "segment_ids": json.loads(item["segment_ids"]),
                    "originals": json.loads(item["originals"] or "[]"),
                    "originals_available": item["originals"] is not None,
                    "translations": json.loads(item["translations"] or "[]"),
                    "order": ([{"id": token["id"], "translation_status": token["translation_status"]}
                               for token in stream] if stream is not None else None),
                }
                size = _size(payload) + 1
                if used_bytes + size > MAX_PAGE_BYTES:
                    if events:
                        break
                    raise EventPageTooLarge("Stored event exceeds the event-page byte limit.")
                events.append(payload)
                used_bytes += size
        if reverse:
            events.reverse()
        last = events[-1]["ordinal"] if events else start
        first = events[0]["ordinal"] if events else (boundary if reverse else last + 1)
        has_newer = last < through
        return {
            "protocol": 1, **dict(recording),
            "connection": ({key: row[key] for key in (
                "id", "start_sample", "end_sample", "status", "final_sample", "processed_sample",
            )} if row else None),
            "through": through, "events": events, "next_after": last,
            "has_newer": has_newer, "has_older": first > 0,
            "next_before": first,
            "previous_connection_id": previous_id, "next_connection_id": next_id,
            "tail": tail if not has_newer else None,
        }
