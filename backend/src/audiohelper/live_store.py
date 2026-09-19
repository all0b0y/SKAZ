"""Durable native audio, ASR connections and append-only transcript identities.

All changes for one packet/event share a SQLite transaction. Provider I/O belongs
outside this module and never holds the database lock.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .audio import WavAudio
from .audio_storage import write_audio_file
from .db import Database
from .gateways.soniox import SonioxConfig, SonioxEvent
from .native_tokens import persist_tokens, read_tokens
from .native_translation import project_final_translation, project_live_translation
from .schemas import NativeRecordingMode


class LiveConflict(ValueError):
    """Invalid order, stale connection or conflicting replay; no data applied."""


@dataclass(frozen=True)
class LiveConnection:
    id: str
    session_id: str
    start_sample: int
    sample_rate: int
    next_sequence: int
    recording_mode: NativeRecordingMode = "transcription"
    translation_target_language: str = "ru"
    used_languages: tuple[str, ...] | None = None


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


class LiveStore:
    def __init__(
        self, db: Database, audio_dir: Path, *, storage: Any = None, retain_audio: bool = True,
    ) -> None:
        self.db = db
        self.audio_dir = audio_dir
        self.storage = storage
        self.retain_audio = retain_audio
        # One receipt per session supports uncertain-ACK reconciliation without PCM.
        with self.db.write() as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS native_transport_receipts ("
                               "session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,"
                               "sequence INTEGER,start_sample INTEGER,end_sample INTEGER,digest TEXT)")

    def open(
        self, session_id: str, *, sample_rate: int, model: str,
        recording_mode: NativeRecordingMode = "transcription", translation_target_language: str = "ru",
        used_languages: tuple[str, ...] | None = None,
    ) -> LiveConnection:
        SonioxConfig(sample_rate=sample_rate, model=model,
                     translation_target_language=translation_target_language, used_languages=used_languages)
        if recording_mode not in ("transcription", "translation", "audio_only"):
            raise LiveConflict("Invalid recording mode.")
        with self.db.write() as connection:
            if self.retain_audio and self.storage is not None:
                self.storage.guard()
            if connection.execute("SELECT 1 FROM sessions WHERE id=?", (session_id,)).fetchone() is None:
                raise LiveConflict("Session does not exist.")
            recording = connection.execute(
                "SELECT * FROM native_recordings WHERE session_id=?", (session_id,)
            ).fetchone()
            if recording is None:
                # Migration preserves old sessions, but never guesses their sample clock.
                if connection.execute(
                    "SELECT 1 FROM chunks WHERE session_id=? LIMIT 1", (session_id,)
                ).fetchone():
                    raise LiveConflict("An existing file recording cannot become a native stream.")
                connection.execute(
                    "INSERT INTO native_recordings(session_id,sample_rate,recording_mode,"
                    "translation_target_language,used_languages_json) VALUES (?,?,?,?,?)",
                    (session_id, sample_rate, recording_mode, translation_target_language,
                     json.dumps(used_languages) if used_languages is not None else None),
                )
                start_sample, next_sequence = 0, 0
            else:
                if recording["origin"] == "import":
                    # An imported file and a microphone share no time axis, and the
                    # provider numbers speakers independently per job: appending live
                    # speech here would produce timestamps and speaker labels that
                    # point at nothing. A new session is the honest answer.
                    raise LiveConflict("An imported recording cannot be continued with a microphone.")
                if recording["sample_rate"] != sample_rate:
                    raise LiveConflict("Sample rate cannot change within a recording.")
                start_sample = recording["saved_samples"]
                next_sequence = recording["next_sequence"]
                recording_mode = recording["recording_mode"]
                translation_target_language = recording["translation_target_language"]
                used_languages = (tuple(json.loads(recording["used_languages_json"]))
                                  if recording["used_languages_json"] is not None else None)
            if not self.retain_audio and recording_mode == "audio_only":
                raise LiveConflict("Audio-only recording is disabled while audio retention is disabled.")
            if connection.execute(
                "SELECT 1 FROM asr_connections WHERE session_id=? AND status='active'", (session_id,)
            ).fetchone():
                raise LiveConflict("Recording already has an active connection.")
            identity = uuid.uuid4().hex
            connection.execute(
                "INSERT INTO asr_connections(id,session_id,start_sample,model,status,final_sample,"
                "processed_sample) VALUES (?,?,?,?,'active',?,?)",
                (identity, session_id, start_sample, model, start_sample, start_sample),
            )
            return LiveConnection(identity, session_id, start_sample, sample_rate, next_sequence,
                                  recording_mode, translation_target_language, used_languages)

    @staticmethod
    def _active(connection: sqlite3.Connection, identity: str) -> sqlite3.Row:
        row = connection.execute(
            "SELECT a.*,r.sample_rate,r.saved_samples,r.next_sequence FROM asr_connections a "
            "JOIN native_recordings r ON r.session_id=a.session_id WHERE a.id=?", (identity,)
        ).fetchone()
        if not isinstance(row, sqlite3.Row) or row["status"] != "active":
            raise LiveConflict("Connection is absent or no longer active.")
        return row

    def append_audio(
        self, identity: str, *, sequence: int, start_sample: int, pcm: bytes,
        replay_start_sample: int | None = None,
    ) -> bool:
        """Persist a bounded PCM block; return False for an identical replay."""
        if (type(sequence) is not int or type(start_sample) is not int
                or sequence < 0 or start_sample < 0 or not isinstance(pcm, bytes)
                or not pcm or len(pcm) % 2):
            raise LiveConflict("Invalid PCM metadata.")
        with self.db.write() as connection:
            row = self._active(connection, identity)
            rate = row["sample_rate"]
            if self.retain_audio and self.storage is not None:
                self.storage.guard()
            replay_floor = row["start_sample"] if replay_start_sample is None else replay_start_sample
            if type(replay_floor) is not int or not 0 <= replay_floor <= row["start_sample"]:
                raise LiveConflict("Invalid local transport replay boundary.")
            count = len(pcm) // 2
            if count > rate // 2:
                raise LiveConflict("An audio block must not exceed 500 milliseconds.")
            if not self.retain_audio:
                return self._accept_transient(connection, row, sequence, start_sample, pcm, replay_floor)
            body = WavAudio(rate, pcm).to_wav_bytes()
            digest = hashlib.sha256(body).hexdigest()
            previous = connection.execute(
                "SELECT b.start_sample,b.end_sample,c.sha256,c.path FROM native_audio_blocks b "
                "JOIN chunks c USING(session_id,sequence) WHERE b.session_id=? AND b.sequence=?",
                (row["session_id"], sequence),
            ).fetchone()
            if previous is not None:
                if (previous["start_sample"] != start_sample or previous["end_sample"] != start_sample + count
                        or previous["sha256"] != digest or start_sample < replay_floor):
                    raise LiveConflict("Conflicting audio replay.")
                path = Path(previous["path"])
                if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                    raise LiveConflict("Previously saved audio is missing or corrupt.")
                return False
            if sequence != row["next_sequence"] or start_sample != row["saved_samples"]:
                raise LiveConflict("Audio must be contiguous and ordered.")
            session_id = row["session_id"]
            path = (self.storage.audio_path(session_id, sequence) if self.storage is not None
                    else self.audio_dir / session_id / f"{sequence:06d}.wav")
            write_audio_file(path, body)
            end_sample = start_sample + count
            start_ms, end_ms = start_sample * 1000 // rate, end_sample * 1000 // rate
            # Integer millisecond display ranges may collapse for a tiny tail.
            # The native sample clock and PCM payload remain exact; never pad or drop it.
            connection.execute(
                "INSERT INTO chunks(session_id,sequence,start_ms,end_ms,sha256,path,status,created_at) "
                "VALUES (?,?,?,?,?,?,'pending',?)",
                (session_id, sequence, start_ms, end_ms, digest, str(path), _now()),
            )
            connection.execute("INSERT INTO native_audio_blocks VALUES (?,?,?,?)",
                               (session_id, sequence, start_sample, end_sample))
            connection.execute(
                "UPDATE native_recordings SET saved_samples=?,next_sequence=? WHERE session_id=?",
                (end_sample, sequence + 1, session_id),
            )
            connection.execute("UPDATE sessions SET duration_ms=? WHERE id=?", (end_ms, session_id))
            return True

    @staticmethod
    def _accept_transient(
        connection: sqlite3.Connection, row: sqlite3.Row, sequence: int,
        start_sample: int, pcm: bytes, replay_floor: int,
    ) -> bool:
        end_sample = start_sample + len(pcm) // 2
        digest = hashlib.sha256(pcm).hexdigest()
        previous = connection.execute(
            "SELECT * FROM native_transport_receipts WHERE session_id=?", (row["session_id"],)
        ).fetchone()
        if previous is not None and previous["sequence"] == sequence:
            if (previous["start_sample"] != start_sample or previous["end_sample"] != end_sample
                    or previous["digest"] != digest or start_sample < replay_floor):
                raise LiveConflict("Conflicting transport replay.")
            return False
        if sequence != row["next_sequence"] or start_sample != row["saved_samples"]:
            raise LiveConflict("Audio must be contiguous and ordered.")
        connection.execute(
            "INSERT OR REPLACE INTO native_transport_receipts VALUES (?,?,?,?,?)",
            (row["session_id"], sequence, start_sample, end_sample, digest),
        )
        # saved_samples is the legacy protocol name for the accepted transport clock.
        # No audio file, chunk, or audio source claim is created in this mode.
        connection.execute(
            "UPDATE native_recordings SET saved_samples=?,next_sequence=? WHERE session_id=?",
            (end_sample, sequence + 1, row["session_id"]),
        )
        connection.execute("UPDATE sessions SET duration_ms=? WHERE id=?",
                           (end_sample * 1000 // row["sample_rate"], row["session_id"]))
        return True

    def save_event(self, identity: str, *, ordinal: int, event: SonioxEvent) -> list[str]:
        if type(ordinal) is not int or ordinal < 0:
            raise LiveConflict("Invalid event ordinal.")
        payload = asdict(event)
        # Untagged original-only events retain their pre-v5 replay identity.
        if event.token_order is None or all(
            ref.translation_status == "none" for ref in event.token_order
        ):
            del payload["token_order"]
        # Preserve replay digests for original-only events saved before translation support.
        for field in ("final_translation_tokens", "partial_translation_tokens"):
            if not payload[field]:
                del payload[field]
        encoded = json.dumps(payload, sort_keys=True, allow_nan=False)
        if len(encoded.encode()) > 1_048_576:
            raise LiveConflict("ASR event exceeds the storage bound.")
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        with self.db.write() as connection:
            row = self._active(connection, identity)
            previous = connection.execute(
                "SELECT * FROM native_asr_events WHERE connection_id=? AND ordinal=?", (identity, ordinal)
            ).fetchone()
            if previous:
                if previous["digest"] != digest:
                    raise LiveConflict("Conflicting event replay.")
                return list(json.loads(previous["segment_ids"]))
            if ordinal != row["next_event"]:
                raise LiveConflict("ASR events must be ordered.")
            rate, anchor = row["sample_rate"], row["start_sample"]
            final_sample = anchor + event.final_audio_proc_ms * rate // 1000
            processed_sample = anchor + event.total_audio_proc_ms * rate // 1000
            if (final_sample < row["final_sample"] or processed_sample < row["processed_sample"]
                    or final_sample > processed_sample or processed_sample > row["saved_samples"]):
                raise LiveConflict("ASR progress is outside the saved audio range.")
            ids: list[str] = []
            for token in (*event.final_tokens, *event.partial_tokens):
                if not 0 <= token.start_ms <= token.end_ms <= event.total_audio_proc_ms:
                    raise LiveConflict("Transcript timestamps are outside processed audio.")
            text = "".join(token.text for token in event.final_tokens)
            if text.strip():
                start_ms = min(token.start_ms for token in event.final_tokens)
                end_ms = max(token.end_ms for token in event.final_tokens)
                if start_ms < 0 or end_ms <= start_ms or end_ms > event.total_audio_proc_ms:
                    raise LiveConflict("Transcript timestamps are outside processed audio.")
                absolute_start = anchor + start_ms * rate // 1000
                absolute_end = anchor + (end_ms * rate + 999) // 1000
                blocks = connection.execute(
                    "SELECT b.*,c.sha256 FROM native_audio_blocks b JOIN chunks c USING(session_id,sequence) "
                    "WHERE b.session_id=? AND b.end_sample>? AND b.start_sample<? ORDER BY b.sequence",
                    (row["session_id"], absolute_start, absolute_end),
                ).fetchall() if self.retain_audio else []
                covered = sum(min(absolute_end, b["end_sample"]) - max(absolute_start, b["start_sample"])
                              for b in blocks)
                if self.retain_audio and covered != absolute_end - absolute_start:
                    raise LiveConflict("Transcript source audio is incomplete.")
                segment_id = uuid.uuid5(uuid.UUID(identity), str(ordinal)).hex
                languages = {token.language for token in event.final_tokens if token.language}
                language = next(iter(languages)) if len(languages) == 1 else None
                connection.execute(
                    "INSERT INTO segments(id,session_id,sequence,start_ms,end_ms,text,language,created_at) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    (segment_id, row["session_id"], (blocks[0]["sequence"] if blocks else -1),
                     absolute_start * 1000 // rate,
                     absolute_end * 1000 // rate, text, language, _now()),
                )
                for block in blocks:
                    connection.execute(
                        "INSERT INTO segment_sources VALUES (?,?,?,?,?,?)",
                        (segment_id, row["session_id"], block["sequence"],
                         max(absolute_start, block["start_sample"]) - block["start_sample"],
                         min(absolute_end, block["end_sample"]) - block["start_sample"], block["sha256"]),
                    )
                connection.execute("INSERT INTO segments_fts(segment_id,session_id,text) VALUES (?,?,?)",
                                   (segment_id, row["session_id"], text))
                connection.execute("INSERT INTO transcript_revisions VALUES (?,1,?,'soniox')",
                                   (segment_id, text))
                ids.append(segment_id)
            draft = json.dumps([asdict(token) for token in event.partial_tokens], ensure_ascii=False)
            if len(draft) > 64_000:
                raise LiveConflict("Draft exceeds the storage bound.")
            if len(json.dumps([asdict(token) for token in event.partial_translation_tokens])) > 64_000:
                raise LiveConflict("Translation draft exceeds the storage bound.")
            connection.execute(
                "UPDATE asr_connections SET final_sample=?,processed_sample=?,next_event=?,draft_json=? "
                "WHERE id=?",
                (final_sample, processed_sample, ordinal + 1, draft, identity),
            )
            connection.execute("INSERT INTO native_asr_events VALUES (?,?,?,?)",
                               (identity, ordinal, digest, json.dumps(ids)))
            persist_tokens(connection, row, ordinal, event, ids[0] if ids else None)
            return ids

    def close(self, identity: str, *, finished: bool) -> None:
        with self.db.write() as connection:
            row = connection.execute(
                "SELECT a.*,r.saved_samples FROM asr_connections a JOIN native_recordings r "
                "ON r.session_id=a.session_id WHERE a.id=?", (identity,)
            ).fetchone()
            if not isinstance(row, sqlite3.Row) or row["status"] != "active":
                return
            connection.execute(
                "UPDATE asr_connections SET status=?,end_sample=? WHERE id=?",
                ("finished" if finished else "incomplete", row["saved_samples"], identity),
            )

    def recover_interrupted(self) -> None:
        """Called once at process startup, before any live tasks are created."""
        with self.db.write() as connection:
            connection.execute(
                "UPDATE asr_connections SET status='incomplete',end_sample=("
                "SELECT saved_samples FROM native_recordings r WHERE r.session_id=asr_connections.session_id"
                ") WHERE status='active'"
            )

    def snapshot(self, session_id: str) -> dict[str, Any]:
        with self.db.read() as connection:
            row = connection.execute(
                "SELECT * FROM native_recordings WHERE session_id=?", (session_id,)
            ).fetchone()
            if row is None:
                raise LiveConflict("Native recording does not exist.")
            connections = connection.execute(
                "SELECT * FROM asr_connections WHERE session_id=? ORDER BY rowid", (session_id,)
            ).fetchall()
            gaps = [
                {"start_sample": item["final_sample"], "end_sample": item["end_sample"]}
                for item in connections
                if item["status"] != "active" and item["final_sample"] < item["end_sample"]
            ]
            speakers = connection.execute(
                "SELECT connection_id,provider_id,number FROM native_speakers "
                "WHERE session_id=? ORDER BY number",
                (session_id,),
            ).fetchall()
            recording = dict(row)
            languages_json = recording.pop("used_languages_json")
            originals = read_tokens(connection, session_id)
            translations = read_tokens(connection, session_id, translation=True)
            stream = read_tokens(connection, session_id, stream=True)
            return {**recording, "audio_retained": self.retain_audio,
                    "used_languages": json.loads(languages_json) if languages_json else None,
                    "connections": [dict(item) for item in connections], "gaps": gaps,
                    "final_tokens": originals,
                    "final_stream_tokens": stream,
                    "final_translation_projection": project_final_translation(
                        originals, translations, stream),
                    "live_translation_projection": project_live_translation(
                        originals, translations, stream, [dict(item) for item in connections],
                        [dict(speaker) for speaker in speakers], row["sample_rate"]),
                    "partial_stream_tokens": [
                        token for item in connections for token in json.loads(item["stream_draft_json"])
                    ],
                    "final_translation_tokens": translations,
                    "partial_translation_tokens": [
                        token for item in connections
                        for token in json.loads(item["translation_draft_json"])
                    ],
                    "speakers": [dict(speaker) for speaker in speakers]}
