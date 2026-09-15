"""Conservative translation links at the public durable snapshot seam."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from audiohelper import repository as repo
from audiohelper.db import Database
from audiohelper.gateways.soniox import SonioxEvent, SonioxToken, SonioxTokenRef, SonioxTranslationToken
from audiohelper.live_store import LiveStore


def test_live_translation_tail_replaces_speaker_turns_without_changing_sources(tmp_path: Path) -> None:
    path = tmp_path / "tail.sqlite"
    db = Database(path)
    store = LiveStore(db, tmp_path / "audio")
    sid = repo.create_session(db, "Tail").id
    connection = store.open(sid, sample_rate=16000, model="stt-rt-v5")
    store.append_audio(connection.id, sequence=0, start_sample=0, pcm=b"\x01\x00" * 1600)
    store.save_event(connection.id, ordinal=0, event=SonioxEvent(
        (SonioxToken("Hello", 0, 20, .9, True, "en", "1"),), (), (), 20, 100, False,
        token_order=(SonioxTokenRef("original", True, 0),),
    ))
    final_before = store.snapshot(sid)["final_translation_projection"]
    projection: dict[str, Any] = {}

    def display(projection: dict[str, Any]) -> list[str]:
        tokens = {token["id"]: token for token in [
            *projection["original_tokens"], *projection["translation_tokens"],
        ]}
        return ["".join(tokens[identity]["text"] for identity in turn["display_token_ids"])
                for turn in projection["monologues"]]

    for ordinal, speaker in enumerate(["2", "1"], start=1):
        event = SonioxEvent(
            (), (SonioxToken(" again", 20, 40, .9, False, "en", speaker),), (), 20, 100, False,
            partial_translation_tokens=(SonioxTranslationToken("Hallo", .9, False, "de", "en", "1"),
                                        SonioxTranslationToken(" wieder", .9, False, "de", "en", speaker)),
            token_order=(SonioxTokenRef("translation", False, 0), SonioxTokenRef("original", False, 0),
                         SonioxTokenRef("translation", False, 1)),
        )
        store.save_event(connection.id, ordinal=ordinal, event=event)
        store.save_event(connection.id, ordinal=ordinal, event=event)
        snapshot = store.snapshot(sid)
        projection = snapshot["live_translation_projection"]
        assert display(projection) == (["Hallo", " wieder"] if speaker == "2" else ["Hallo wieder"])
        assert [turn["speaker_number"] for turn in projection["monologues"]] == (
            [1, 2] if speaker == "2" else [1])
        assert projection["unassigned_translation_token_ids"] == []
        assert snapshot["final_translation_projection"] == final_before
        assert [token["text"] for token in snapshot["final_tokens"]] == ["Hello"]
        assert all(not token["is_final"] for token in projection["translation_tokens"])
        assert all(not {"segment_id", "start_ms", "end_ms", "start_sample", "end_sample"} & token.keys()
                   for token in projection["translation_tokens"])
        assert projection["original_tokens"][-1]["segment_id"] is None
    db.close()
    db = Database(path)
    try:
        store = LiveStore(db, tmp_path / "audio")
        assert store.snapshot(sid)["live_translation_projection"] == projection
        store.save_event(connection.id, ordinal=3, event=SonioxEvent(
            (), (), (), 20, 100, False, token_order=(),
        ))
        cleared = store.snapshot(sid)["live_translation_projection"]
        assert display(cleared) == [""]
        assert cleared["translation_tokens"] == []
        assert [token["text"] for token in cleared["original_tokens"]] == ["Hello"]
    finally:
        db.close()


@pytest.mark.parametrize("case", ["ambiguous", "unknown_speaker", "different_speaker", "historical",
                                  "partial_history"])
def test_no_guessed_translation_ownership_after_reopen(tmp_path: Path, case: str) -> None:
    path = tmp_path / "links.sqlite"
    db = Database(path)
    store = LiveStore(db, tmp_path / "audio")
    sid = repo.create_session(db, "Links").id
    connection = store.open(sid, sample_rate=16000, model="stt-rt-v5")
    store.append_audio(connection.id, sequence=0, start_sample=0, pcm=b"\x01\x00" * 1600)
    speaker = None if case == "unknown_speaker" else "1"
    originals: tuple[SonioxToken, ...] = (SonioxToken("First", 0, 20, .9, True, "en", speaker),)
    if case == "ambiguous":
        originals += (SonioxToken(" Second", 20, 40, .9, True, "en", "2"),
                      SonioxToken(" Third", 40, 60, .9, True, "en", "1"))
    translated = SonioxTranslationToken("Übersetzung", .9, True, "de", "en",
                                        "2" if case == "different_speaker" else speaker)
    order = (
        *(SonioxTokenRef("original", True, i) for i in range(len(originals))),
        SonioxTokenRef("translation", True, 0),
    )
    event = SonioxEvent(originals, (), (), 60, 100, False,
                        final_translation_tokens=(translated,),
                        token_order=None if case in ("historical", "partial_history") else order)
    store.save_event(connection.id, ordinal=0, event=event)
    if case == "partial_history":
        store.save_event(connection.id, ordinal=1, event=SonioxEvent(
            (SonioxToken("New", 60, 80, .9, True, "en", "1"),), (), (), 80, 100, False,
            final_translation_tokens=(translated,), token_order=(
                SonioxTokenRef("original", True, 0), SonioxTokenRef("translation", True, 0),
            ),
        ))
    before = store.snapshot(sid)
    live = before["live_translation_projection"]
    assert all(not turn["translation_token_ids"] for turn in live["monologues"])
    assert live["unassigned_translation_token_ids"] == [t["id"] for t in live["translation_tokens"]]
    projection = before["final_translation_projection"]
    assert all(not turn["translation_token_ids"] for turn in projection["monologues"])
    assert projection["unassigned_translation_token_ids"] == [
        token["id"] for token in before["final_translation_tokens"]
    ]
    assert [identity for turn in projection["monologues"] for identity in turn["original_token_ids"]] == [
        token["id"] for token in before["final_tokens"]
    ]
    if case in ("historical", "partial_history"):
        assert projection["order_unavailable_connection_ids"] == [connection.id]
    db.close()
    db = Database(path)
    try:
        assert LiveStore(db, tmp_path / "audio").snapshot(sid)["final_translation_projection"] == projection
    finally:
        db.close()


@pytest.mark.parametrize("case", ["historical", "unknown", "orphan", "interrupted"])
def test_live_tail_never_borrows_ownership_from_another_request(tmp_path: Path, case: str) -> None:
    db = Database(tmp_path / "isolation.sqlite")
    try:
        store = LiveStore(db, tmp_path / "audio")
        sid = repo.create_session(db, "Isolation").id
        first = store.open(sid, sample_rate=16000, model="stt-rt-v5")
        store.append_audio(first.id, sequence=0, start_sample=0, pcm=b"\x01\x00" * 1600)
        speaker = None if case == "unknown" else "1"
        original = SonioxToken("Hello", 0, 20, .9, False, "en", speaker)
        translated = SonioxTranslationToken("Hallo", .9, False, "de", "en", speaker)
        order = (() if case == "orphan" else (SonioxTokenRef("original", False, 0),)) + (
            SonioxTokenRef("translation", False, 0),)
        store.save_event(first.id, ordinal=0, event=SonioxEvent(
            (), () if case == "orphan" else (original,), (), 0, 100, False,
            partial_translation_tokens=(translated,), token_order=None if case == "historical" else order,
        ))
        initial = store.snapshot(sid)["live_translation_projection"]
        assert [t["text"] for t in initial["translation_tokens"]] == ["Hallo"]
        if case == "interrupted":
            assert initial["unassigned_translation_token_ids"] == []
        else:
            assert initial["unassigned_translation_token_ids"] == [initial["translation_tokens"][0]["id"]]
        assert initial["order_unavailable_connection_ids"] == ([first.id] if case == "historical" else [])
        store.close(first.id, finished=False)
        second = store.open(sid, sample_rate=16000, model="stt-rt-v5")
        store.append_audio(second.id, sequence=1, start_sample=1600, pcm=b"\x01\x00" * 1600)
        store.save_event(second.id, ordinal=0, event=SonioxEvent(
            (SonioxToken("Next", 0, 20, .9, True, "en", "1"),), (), (), 20, 100, False,
            token_order=(SonioxTokenRef("original", True, 0),),
        ))
        projection = store.snapshot(sid)["live_translation_projection"]
        assert projection["translation_tokens"] == initial["translation_tokens"]
        assert projection["unassigned_translation_token_ids"] == initial["unassigned_translation_token_ids"]
        assert projection["monologues"][-1]["connection_id"] == second.id
        assert projection["monologues"][-1]["display_token_ids"] == []
        assert projection["original_tokens"][-1]["start_sample"] == 1600
        if case != "orphan":
            assert projection["monologues"][:-1] == initial["monologues"]
            assert projection["original_tokens"][0]["is_final"] is False
    finally:
        db.close()


def test_multiple_chunks_link_to_one_turn_but_provisional_translation_is_not_final(tmp_path: Path) -> None:
    db = Database(tmp_path / "chunks.sqlite")
    try:
        store = LiveStore(db, tmp_path / "audio")
        sid = repo.create_session(db, "Chunks").id
        connection = store.open(sid, sample_rate=16000, model="stt-rt-v5")
        store.append_audio(connection.id, sequence=0, start_sample=0, pcm=b"\x01\x00" * 1600)
        for index in range(2):
            event = SonioxEvent(
                (SonioxToken("Hello", index * 20, index * 20 + 20, .9, True, "en", "1"),), (), (),
                40, 100, False,
                final_translation_tokens=(SonioxTranslationToken("Hallo", .9, True, "de", "en", "1"),),
                partial_translation_tokens=(SonioxTranslationToken("draft", .9, False, "de", "en", "1"),),
                token_order=(SonioxTokenRef("original", True, 0), SonioxTokenRef("translation", True, 0),
                             SonioxTokenRef("translation", False, 0)),
            )
            store.save_event(connection.id, ordinal=index, event=event)
            store.save_event(connection.id, ordinal=index, event=event)
        snapshot = store.snapshot(sid)
        projection = snapshot["final_translation_projection"]
        assert len(projection["monologues"]) == 1
        assert projection["monologues"][0]["translation_token_ids"] == [
            token["id"] for token in snapshot["final_translation_tokens"]
        ]
        assert len(projection["monologues"][0]["translation_token_ids"]) == 2
        assert projection["unassigned_translation_token_ids"] == []
        assert snapshot["partial_translation_tokens"][0]["text"] == "draft"
        live = snapshot["live_translation_projection"]
        assert len(live["monologues"][0]["display_token_ids"]) == 3
    finally:
        db.close()
