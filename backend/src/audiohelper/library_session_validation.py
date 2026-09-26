"""Cross-reference checks before any untrusted session document reaches SQLite."""
from __future__ import annotations

from .library_session_schema import NativeConnection, NativeToken, SessionDocument
from .media_source import youtube_source


def _require(condition: bool) -> None:
    if not condition:
        raise ValueError("Inconsistent session document")


def _speaker(token: NativeToken, connection: NativeConnection) -> None:
    speakers = {speaker.provider_id: speaker.number for speaker in connection.speakers}
    _require(token.speaker_number == speakers.get(token.speaker) if token.speaker is not None
             else token.speaker_number is None)


def _original_time(token: NativeToken, connection: NativeConnection, sample_rate: int) -> None:
    if token.start_ms is None or token.end_ms is None:
        raise ValueError("Original token has no timing")
    _require(0 <= token.start_ms <= token.end_ms)
    _require(connection.start_sample + token.end_ms * sample_rate // 1000 <= connection.processed_sample)


def validate_document(document: SessionDocument) -> None:
    segments = {segment.id: segment for segment in document.segments}
    _require(len(segments) == len(document.segments))
    _require(len({m.id for m in document.messages}) == len(document.messages))
    for segment in document.segments:
        _require(segment.start_ms <= segment.end_ms <= document.session.duration_ms)
        _require(len({r.revision for r in segment.revisions}) == len(segment.revisions))
    native = document.native
    if native is None:
        _require(not any(r.origin == "soniox" for s in document.segments for r in s.revisions))
        return
    _require((native.origin == "import") == (native.import_source is not None))
    if native.import_source is not None:
        source = native.import_source
        _require(source.duration_ms == document.session.duration_ms)
        if source.kind == "youtube":
            _require(source.url is not None)
            parsed = youtube_source(source.url or "")
            _require(parsed.video_id == source.video_id and parsed.url == source.url)
        else:
            _require(source.url is None and source.video_id is None)
        _require(native.receipt is None and native.next_sequence == 0)
        _require(all(c.status == "finished" for c in native.connections))
    _require(document.session.mode == "legacy")
    _require(len({c.id for c in native.connections}) == len(native.connections))
    _require(document.session.duration_ms == native.saved_samples * 1000 // native.sample_rate)
    speaker_numbers = [s.number for c in native.connections for s in c.speakers]
    _require(len(set(speaker_numbers)) == len(speaker_numbers))
    token_ids: set[str] = set()
    event_segments: set[str] = set()
    for connection in native.connections:
        _require(connection.start_sample <= connection.final_sample <= connection.processed_sample
                 <= native.saved_samples)
        if connection.status != "active":
            _require(connection.end_sample is not None)
        if connection.end_sample is not None:
            _require(connection.processed_sample <= connection.end_sample <= native.saved_samples)
        _require(len({s.provider_id for s in connection.speakers}) == len(connection.speakers))
        _require(connection.next_event == len(connection.events))
        for ordinal, event in enumerate(connection.events):
            _require(event.ordinal == ordinal)
            _require(len(set(event.segment_ids)) == len(event.segment_ids))
            _require(set(event.segment_ids) <= segments.keys())
            _require(not (event_segments & set(event.segment_ids)))
            event_segments.update(event.segment_ids)
            originals = event.originals or []
            translations = event.translations or []
            for is_translation, tokens in ((False, originals), (True, translations)):
                for position, token in enumerate(tokens):
                    suffix = f"translation:{position}" if is_translation else str(position)
                    _require(token.id == f"{connection.id}:{ordinal}:{suffix}")
                    _require(token.id is not None and token.id not in token_ids)
                    if token.id is not None:
                        token_ids.add(token.id)
                    _require(token.connection_id == connection.id and token.is_final)
                    _speaker(token, connection)
                    if is_translation:
                        _require(token.start_ms is None and token.end_ms is None
                                 and token.start_sample is None and token.end_sample is None
                                 and token.segment_id is None)
                    else:
                        _require(token.segment_id is None or token.segment_id in event.segment_ids)
                        _original_time(token, connection, native.sample_rate)
                        if token.start_ms is None or token.end_ms is None:
                            raise ValueError("Missing original token timing")
                        _require(token.start_sample == connection.start_sample
                                 + token.start_ms * native.sample_rate // 1000)
                        _require(token.end_sample == connection.start_sample
                                 + (token.end_ms * native.sample_rate + 999) // 1000)
            if event.stream is not None:
                by_id = {t.id: t for t in [*originals, *translations]}
                _require(len(event.stream) == len(by_id))
                _require(len({t.id for t in event.stream}) == len(event.stream))
                translation_ids = {t.id for t in translations}
                for token in event.stream:
                    _require(token.id in by_id)
                    kind = token.translation_status
                    _require(kind == "translation" if token.id in translation_ids
                             else kind in ("none", "original"))
                    base = token.model_dump(exclude_unset=True, exclude={"translation_status"})
                    _require(base == by_id[token.id].model_dump(exclude_unset=True))
        for token in connection.draft:
            _require(not token.is_final)
            _original_time(token, connection, native.sample_rate)
        for token in connection.translation_draft:
            _require(not token.is_final and token.connection_id == connection.id)
            _speaker(token, connection)
            _require(token.start_ms is None and token.end_ms is None)
        for token in connection.stream_draft:
            _require(not token.is_final and token.connection_id == connection.id)
            _speaker(token, connection)
            if token.translation_status in ("none", "original"):
                _original_time(token, connection, native.sample_rate)
            else:
                _require(token.translation_status == "translation"
                         and token.start_ms is None and token.end_ms is None)
    if native.receipt is not None:
        receipt = native.receipt
        _require(receipt.sequence + 1 == native.next_sequence)
        _require(receipt.start_sample < receipt.end_sample == native.saved_samples)
