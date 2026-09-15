"""Token provenance; all writes share the owning LiveStore event transaction."""
from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict
from typing import Any

from .gateways.soniox import SonioxEvent, SonioxToken, SonioxTranslationToken


def persist_tokens(
    db: sqlite3.Connection, row: sqlite3.Row, ordinal: int, event: SonioxEvent,
    segment_id: str | None,
) -> None:
    speakers: dict[str, int] = {}
    speaker_tokens: tuple[SonioxToken | SonioxTranslationToken, ...] = (
        *event.final_tokens, *event.partial_tokens,
        *event.final_translation_tokens, *event.partial_translation_tokens,
    )
    if event.token_order is not None:
        groups: dict[tuple[bool, bool], tuple[SonioxToken | SonioxTranslationToken, ...]] = {
            (False, True): event.final_tokens, (False, False): event.partial_tokens,
            (True, True): event.final_translation_tokens, (True, False): event.partial_translation_tokens,
        }
        speaker_tokens = tuple(
            groups[(ref.translation_status == "translation", ref.is_final)][ref.position]
            for ref in event.token_order
        )
    for speaker_token in speaker_tokens:
        if speaker_token.speaker is None or speaker_token.speaker in speakers:
            continue
        existing = db.execute(
            "SELECT number FROM native_speakers WHERE connection_id=? AND provider_id=?",
            (row["id"], speaker_token.speaker),
        ).fetchone()
        if existing:
            speakers[speaker_token.speaker] = existing["number"]
        else:
            number = db.execute(
                "SELECT COALESCE(MAX(number),0)+1 FROM native_speakers WHERE session_id=?",
                (row["session_id"],),
            ).fetchone()[0]
            db.execute("INSERT INTO native_speakers VALUES (?,?,?,?)",
                       (row["id"], speaker_token.speaker, row["session_id"], number))
            speakers[speaker_token.speaker] = number
    tokens = []
    for position, token in enumerate(event.final_tokens):
        tokens.append({
            **asdict(token), "id": f"{row['id']}:{ordinal}:{position}",
            "connection_id": row["id"], "segment_id": segment_id,
            "speaker_number": speakers.get(token.speaker) if token.speaker is not None else None,
            "start_sample": row["start_sample"] + token.start_ms * row["sample_rate"] // 1000,
            "end_sample": row["start_sample"] + (token.end_ms * row["sample_rate"] + 999) // 1000,
        })
    db.execute("INSERT INTO native_token_events VALUES (?,?,?)",
               (row["id"], ordinal, json.dumps(tokens, ensure_ascii=False)))
    translated = [{
        **asdict(token), "id": f"{row['id']}:{ordinal}:translation:{position}",
        "connection_id": row["id"],
        "speaker_number": speakers.get(token.speaker) if token.speaker is not None else None,
    } for position, token in enumerate(event.final_translation_tokens)]
    if translated:
        db.execute("INSERT INTO native_translation_events VALUES (?,?,?)",
                   (row["id"], ordinal, json.dumps(translated, ensure_ascii=False)))
    draft = [{
        **asdict(token), "connection_id": row["id"],
        "speaker_number": speakers.get(token.speaker) if token.speaker is not None else None,
    } for token in event.partial_translation_tokens]
    db.execute("UPDATE asr_connections SET translation_draft_json=? WHERE id=?",
               (json.dumps(draft, ensure_ascii=False), row["id"]))
    # Older events have no recoverable mixed ordering; never zip their arrays.
    if event.token_order is not None:
        original_draft = [{
            **asdict(token), "connection_id": row["id"],
            "speaker_number": speakers.get(token.speaker) if token.speaker is not None else None,
        } for token in event.partial_tokens]
        final_stream: list[dict[str, Any]] = []
        partial_stream: list[dict[str, Any]] = []
        for ref in event.token_order:
            if ref.translation_status == "translation":
                source = translated if ref.is_final else draft
            else:
                source = tokens if ref.is_final else original_draft
            item = {**source[ref.position], "translation_status": ref.translation_status}
            (final_stream if ref.is_final else partial_stream).append(item)
        db.execute("INSERT INTO native_stream_events VALUES (?,?,?)",
                   (row["id"], ordinal, json.dumps(final_stream, ensure_ascii=False)))
        db.execute("UPDATE asr_connections SET stream_draft_json=? WHERE id=?",
                   (json.dumps(partial_stream, ensure_ascii=False), row["id"]))
    else:
        db.execute("UPDATE asr_connections SET stream_draft_json='[]' WHERE id=?", (row["id"],))


def read_tokens(
    db: sqlite3.Connection, session_id: str, *, translation: bool = False, stream: bool = False,
) -> list[dict[str, Any]]:
    table = "native_translation_events" if translation else "native_token_events"
    if stream:
        table = "native_stream_events"
    events = db.execute(
        f"SELECT e.tokens_json FROM {table} e JOIN asr_connections c ON c.id=e.connection_id "
        "WHERE c.session_id=? ORDER BY c.rowid,e.ordinal", (session_id,),
    ).fetchall()
    return [token for event in events for token in json.loads(event["tokens_json"])]
