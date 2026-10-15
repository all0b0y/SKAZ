"""Project finished speech of a legacy session into its material's fragments.

Only *closed* monologues are written: one after which the next one began, or
every monologue once the recording is paused/stopped/finished or the import
completed (``final=True``). The open tail stays out of the material — the live
panel reads it through ``live`` (``GET /kb/recordings/{id}/live``) until it closes.

Idempotency and crash safety come from the files, not from the database: the
position of the last written token (``speech.cursor`` in ``material.json``)
is saved in the same manifest write that lists the new fragments. A crash
before that write leaves the fragments unlisted (invisible) and the cursor
where it was, so the next projection writes them again — never twice, never
lost. ``seg`` ids are only ever appended (``Library.append_fragments``).

Poisoning layer 2 applies to speech like to documents: the stored fragment
text is the visible text (invisible characters removed), so what the user
sees, what the agents read and what citations quote is one and the same
text. The untouched recognition stays in the legacy session.
"""
from __future__ import annotations

import contextlib
import threading
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager
from dataclasses import dataclass
from pathlib import Path
from sqlite3 import Connection
from typing import Any

from ... import monologues as mono
from ..index import indexer
from ..index.scanner import ScannedMaterial
from ..library.fsio import write_atomic
from ..library.layout import SERVICE_DIR
from ..library.library import Library
from ..markdown.source import Fragment, FragmentInput
from ..service import KnowledgeService
from ..sources.guard import strip_invisible
from .transcript import TokenCursor, read_draft, read_new_tokens, read_translation, translation_language
from .translation import TRANSLATION_FILE, one_line, render_translation

#: ``material.json`` extra written by this area: ``{"session_id": ..., "cursor": {...} | null}``.
SPEECH_KEY = "speech"

LegacyReader = Callable[[], AbstractContextManager[Connection]]


class CarrierMismatch(RuntimeError):
    """The material's files say another session feeds it; nothing is written."""


@dataclass(frozen=True)
class LiveMonologue:
    """Final speech of one monologue that is not in the material yet (usually the open one)."""

    speaker: str | None
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True)
class LivePartial:
    """The words the provider may still revise (original, and translation when recorded with it)."""

    speaker: str | None
    text: str
    translation: str


@dataclass(frozen=True)
class LiveTail:
    #: The last fragment ``seg`` of the material that this speech follows (0: none yet).
    after_seg: int
    monologues: list[LiveMonologue]
    partial: LivePartial | None


@dataclass(frozen=True)
class SpeechState:
    session_id: str | None
    cursor: TokenCursor | None

    @classmethod
    def of(cls, extra: dict[str, Any] | None) -> SpeechState:
        value = (extra or {}).get(SPEECH_KEY)
        if not isinstance(value, dict):
            return cls(None, None)
        session = value.get("session_id")
        return cls(session if isinstance(session, str) else None, TokenCursor.from_json(value.get("cursor")))


class SpeechProjector:
    def __init__(self, kb: KnowledgeService, legacy_read: LegacyReader) -> None:
        self.kb = kb
        self._legacy_read = legacy_read
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    @contextlib.contextmanager
    def _exclusive(self, material_id: str) -> Iterator[None]:
        with self._guard:
            lock = self._locks.setdefault(material_id, threading.Lock())
        with lock:
            yield

    def _hint(self, material_id: str) -> str | None:
        record = self.kb.material_repo.get(material_id)
        return record.rel_dir if record else None

    def project(self, material_id: str, session_id: str, *, final: bool) -> list[Fragment]:
        """Append the session's newly closed monologues; returns the fragments added."""
        with self._exclusive(material_id):
            library = self.kb.require()
            hint = self._hint(material_id)
            state = SpeechState.of({SPEECH_KEY: library.manifest_value(material_id, SPEECH_KEY, hint=hint)})
            if state.session_id not in (None, session_id):
                raise CarrierMismatch("This material is fed by another recording.")
            with self._legacy_read() as connection:
                tokens = read_new_tokens(connection, session_id, state.cursor)
            if not tokens:
                return []
            located = {item.token.id: item for item in tokens}
            groups = mono.build([item.token for item in tokens])
            closed = groups if final else groups[:-1]
            if not closed:
                return []
            visible = [(group, one_line(strip_invisible(group.text))) for group in closed]
            inputs = [
                FragmentInput(text=text, start_ms=group.start_ms, end_ms=group.end_ms,
                              speaker=str(group.speaker) if group.speaker is not None else None)
                for group, text in visible if text  # nothing visible left: no fragment
            ]
            cursor = located[closed[-1].tokens[-1].id].cursor()
            with self.kb.writing():  # a concurrent scan must not undo this append in the index
                added = library.append_fragments(
                    material_id, inputs, hint=hint,
                    manifest_extra={SPEECH_KEY: {"session_id": session_id, "cursor": cursor.to_json()}},
                )
                self._index(library, material_id, hint, added)
            return added

    def _index(self, library: Library, material_id: str, hint: str | None, added: list[Fragment]) -> None:
        if indexer.append_fragments(self.kb.db, material_id, added):
            return
        files = library.read_material(material_id, hint=hint)
        indexer.put_material(self.kb.db, ScannedMaterial(
            files, library.relative(files.directory), library.relative(files.source_path)))

    def live(self, material_id: str, session_id: str) -> LiveTail:
        """Speech of a running recording that is not in the material yet, for the live panel.

        The open monologue (final words after the last written token) and any closed one the
        next projection has not appended yet, then the replaceable non-final words. Read under
        the same lock as ``project``, so ``after_seg`` and the text never overlap or leave a gap:
        the text continues exactly after fragment ``after_seg``. Nothing is written.
        """
        with self._exclusive(material_id):
            library = self.kb.require()
            manifest = library.material_manifest(material_id, hint=self._hint(material_id))  # one cheap read
            state = SpeechState.of(manifest.model_extra)
            if state.session_id not in (None, session_id):
                raise CarrierMismatch("This material is fed by another recording.")
            after_seg = manifest.next_seg() - 1
            with self._legacy_read() as connection:
                tokens = read_new_tokens(connection, session_id, state.cursor)
                draft = read_draft(connection, session_id)
        monologues = [
            LiveMonologue(str(group.speaker) if group.speaker is not None else None,
                          group.start_ms, group.end_ms, text)
            for group in mono.build([item.token for item in tokens])
            if (text := one_line(strip_invisible(group.text)))
        ]
        partial = None
        if draft is not None:
            text = one_line(strip_invisible(draft.text))
            translation = one_line(strip_invisible(draft.translation))
            if text or translation:
                speaker = str(draft.speaker) if draft.speaker is not None else None
                partial = LivePartial(speaker, text, translation)
        return LiveTail(after_seg, monologues, partial)

    def write_translation(self, material_id: str, session_id: str) -> Path | None:
        """Rewrite ``.skaz/translation.md`` from all final translated tokens; ``None`` if there are none."""
        with self._exclusive(material_id):
            library = self.kb.require()
            with self._legacy_read() as connection:
                language = translation_language(connection, session_id)
                tokens = read_translation(connection, session_id)
            if not tokens:
                return None
            directory = library.locate_material(material_id, hint=self._hint(material_id))
            path = directory / SERVICE_DIR / TRANSLATION_FILE
            write_atomic(path, render_translation(material_id, language, tokens).encode("utf-8"))
            return path
