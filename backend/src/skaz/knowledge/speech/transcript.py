"""Reading finished speech from the legacy recording database, incrementally.

Live recordings and imports store final tokens per provider event
(``native_token_events``, one row per connection/ordinal). Re-reading a
three-hour recording on every event would cost the whole transcript each
time, so the reader resumes from the event that holds the last token already
written to the material and converts tokens exactly as
``transcript_monologues.tokens_for`` does (sample clock → milliseconds,
``speaker_number``). Grouping into monologues stays ``monologues.build``.

Only final original-language tokens are read here; drafts never reach a
material. Translation is read separately and as a whole (it has no timing).
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Any

from ...monologues import Token

#: Mirrors the legacy reader's default when a session has no native recording row.
_DEFAULT_SAMPLE_RATE = 16_000


@dataclass(frozen=True)
class TokenCursor:
    """The last token written to the material, and the event that holds it.

    Tokens sort as ``monologues.build`` sorts them: ``(start_ms, id)``.
    Everything at or before ``(start_ms, token_id)`` is in the material.
    """

    connection_id: str
    ordinal: int
    start_ms: int
    token_id: str

    def to_json(self) -> dict[str, Any]:
        return {"connection_id": self.connection_id, "ordinal": self.ordinal,
                "start_ms": self.start_ms, "token_id": self.token_id}

    @classmethod
    def from_json(cls, value: object) -> TokenCursor | None:
        if not isinstance(value, dict):
            return None
        try:
            return cls(str(value["connection_id"]), int(value["ordinal"]), int(value["start_ms"]),
                       str(value["token_id"]))
        except (KeyError, TypeError, ValueError):
            return None


@dataclass(frozen=True)
class TokenAt:
    token: Token
    connection_id: str
    ordinal: int

    def cursor(self) -> TokenCursor:
        return TokenCursor(self.connection_id, self.ordinal, self.token.start_ms, self.token.id)


def _sample_rate(connection: sqlite3.Connection, session_id: str) -> int:
    row = connection.execute("SELECT sample_rate FROM native_recordings WHERE session_id=?",
                             (session_id,)).fetchone()
    return int(row[0]) if row else _DEFAULT_SAMPLE_RATE


def _integer(value: object) -> int:
    return value if isinstance(value, int) else 0


def _token(item: dict[str, Any], rate: int) -> Token:
    start = _integer(item.get("start_sample"))
    end = max(start, _integer(item.get("end_sample")))
    speaker = item.get("speaker_number")
    segment = item.get("segment_id")
    return Token(
        id=str(item["id"]), text=str(item.get("text") or ""),
        start_ms=start * 1000 // rate, end_ms=end * 1000 // rate,
        speaker=speaker if isinstance(speaker, int) else None,
        segment_id=segment if isinstance(segment, str) and segment else None,
    )


def read_new_tokens(connection: sqlite3.Connection, session_id: str,
                    after: TokenCursor | None) -> list[TokenAt]:
    """Final tokens not yet in the material, in storage order.

    Reads from the event holding ``after`` onwards. Inside that event only
    tokens sorting after the cursor are new; every token of a later event is
    new, even one that sorts earlier (it is never silently dropped).
    """
    rate = _sample_rate(connection, session_id)
    query = ("SELECT c.id AS connection_id, e.ordinal AS ordinal, e.tokens_json AS tokens_json "
             "FROM native_token_events e JOIN asr_connections c ON c.id = e.connection_id "
             "WHERE c.session_id = ?")
    params: list[object] = [session_id]
    anchor_row = None
    if after is not None:
        anchor_row = connection.execute("SELECT rowid FROM asr_connections WHERE id = ? AND session_id = ?",
                                        (after.connection_id, session_id)).fetchone()
        if anchor_row is not None:
            query += " AND (c.rowid > ? OR (c.rowid = ? AND e.ordinal >= ?))"
            params += [anchor_row[0], anchor_row[0], after.ordinal]
    rows = connection.execute(query + " ORDER BY c.rowid, e.ordinal", params).fetchall()
    found: list[TokenAt] = []
    for row in rows:
        same_event = (after is not None and row["connection_id"] == after.connection_id
                      and row["ordinal"] == after.ordinal)
        for item in json.loads(row["tokens_json"]):
            token = _token(item, rate)
            if not token.text.strip():
                continue
            if after is not None and (same_event or anchor_row is None) and (
                    (token.start_ms, token.id) <= (after.start_ms, after.token_id)):
                continue
            found.append(TokenAt(token, row["connection_id"], row["ordinal"]))
    return found


@dataclass(frozen=True)
class TranslationToken:
    text: str
    connection_id: str
    speaker: int | None


def read_translation(connection: sqlite3.Connection, session_id: str) -> list[TranslationToken]:
    """Final translated tokens in provider order (connection, event, position). No timing exists."""
    rows = connection.execute(
        "SELECT e.tokens_json FROM native_translation_events e JOIN asr_connections c "
        "ON c.id = e.connection_id WHERE c.session_id = ? ORDER BY c.rowid, e.ordinal", (session_id,),
    ).fetchall()
    tokens = []
    for row in rows:
        for item in json.loads(row["tokens_json"]):
            speaker = item.get("speaker_number")
            tokens.append(TranslationToken(str(item.get("text") or ""), str(item.get("connection_id") or ""),
                                           speaker if isinstance(speaker, int) else None))
    return tokens


def translation_language(connection: sqlite3.Connection, session_id: str) -> str | None:
    """The target language of a recording made with translation, else ``None``."""
    row = connection.execute(
        "SELECT recording_mode, translation_target_language FROM native_recordings WHERE session_id = ?",
        (session_id,),
    ).fetchone()
    if row is None or row["recording_mode"] != "translation":
        return None
    return str(row["translation_target_language"])
