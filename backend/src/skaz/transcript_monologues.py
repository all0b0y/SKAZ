"""Reading a session's speech as monologue tokens.

One seam, two sources. Live recordings store per-token provenance with speaker
numbers and sample offsets; recordings made before that existed have only
segments. Both are projected onto :class:`monologues.Token` here so nothing
downstream has to know which era a session comes from — and so a pre-migration
recording is never given invented speakers just to look uniform.
"""

from __future__ import annotations

import sqlite3

from . import monologues as mono
from .native_tokens import read_tokens
from .schemas import Segment


def tokens_for(
    connection: sqlite3.Connection, session_id: str, segments: list[Segment]
) -> list[mono.Token]:
    """The session's speech as tokens, from token provenance when it exists.

    Falls back to one token per segment when the session predates token storage.
    The fallback carries ``speaker=None`` rather than a placeholder number: no
    diarisation ran on that audio, and saying "Speaker 1" would be a claim about
    the recording that nothing supports.
    """
    stored = read_tokens(connection, session_id)
    if stored:
        rate = _sample_rate(connection, session_id)
        projected = [_from_token(item, rate) for item in stored]
        covered = {item.get("segment_id") for item in stored if item.get("segment_id")}
        # Segments no token accounts for (an older connection inside a session that
        # later gained tokens) still have to reach the reader.
        projected.extend(
            _from_segment(segment) for segment in segments if segment.id not in covered
        )
        return [token for token in projected if token.text.strip()]
    return [_from_segment(segment) for segment in segments if segment.text.strip()]


def build_monologues(
    connection: sqlite3.Connection, session_id: str, segments: list[Segment]
) -> list[mono.Monologue]:
    return mono.build(tokens_for(connection, session_id, segments))


def _sample_rate(connection: sqlite3.Connection, session_id: str) -> int:
    row = connection.execute(
        "SELECT sample_rate FROM native_recordings WHERE session_id=?", (session_id,)
    ).fetchone()
    return int(row["sample_rate"]) if row else 16_000


def _from_token(item: dict[str, object], sample_rate: int) -> mono.Token:
    start = _integer(item.get("start_sample"))
    end = max(start, _integer(item.get("end_sample")))
    speaker = item.get("speaker_number")
    segment = item.get("segment_id")
    return mono.Token(
        id=str(item["id"]),
        text=str(item.get("text") or ""),
        start_ms=start * 1000 // sample_rate,
        end_ms=end * 1000 // sample_rate,
        speaker=int(speaker) if isinstance(speaker, int) else None,
        segment_id=str(segment) if isinstance(segment, str) and segment else None,
    )


def _integer(value: object) -> int:
    return value if isinstance(value, int) else 0


def _from_segment(segment: Segment) -> mono.Token:
    # A whole segment becomes one token: its id is already stable, so anchors made
    # this way survive exactly as long as the segment does.
    text = segment.text if segment.text.endswith((" ", "\n")) else segment.text + " "
    return mono.Token(
        id=segment.id,
        text=text,
        start_ms=segment.start_ms,
        end_ms=segment.end_ms,
        speaker=None,
        segment_id=segment.id,
    )
