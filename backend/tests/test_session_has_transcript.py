"""`has_transcript`: the Notes gate reads the same source the notes generator does.

The native summary (`native_window=true`) deliberately omits `segments`, so the
client cannot infer "there is a transcript" from that list; the server says so.
"""
from dataclasses import replace
from typing import Any

import httpx

from skaz.gateways.soniox import SonioxToken, SonioxTokenRef, SonioxTranslationToken
from tests.test_native_event_pages_api import event, recording


async def _summary(client: httpx.AsyncClient, sid: str) -> dict[str, Any]:
    response = await client.get(f"/sessions/{sid}", params={"native_window": True})
    assert response.status_code == 200
    return dict(response.json())


async def test_native_final_speech_counts_although_segments_are_omitted(
    client: httpx.AsyncClient, app: Any,
) -> None:
    sid, cid = await recording(client, app)
    app.state.runtime.live_store.save_event(cid, ordinal=0, event=event("Saved source"))
    summary = await _summary(client, sid)
    assert summary["segments"] == []
    assert summary["has_transcript"] is True


async def test_empty_session_has_no_transcript(client: httpx.AsyncClient, app: Any) -> None:
    sid, _ = await recording(client, app)
    assert (await _summary(client, sid))["has_transcript"] is False
    assert (await client.get(f"/sessions/{sid}")).json()["has_transcript"] is False


async def test_draft_only_speech_is_not_a_transcript(client: httpx.AsyncClient, app: Any) -> None:
    sid, cid = await recording(client, app)
    draft = replace(
        event(""),
        final_tokens=(),
        partial_tokens=(SonioxToken("Maybe", 0, 100, 0.9, False, "en", "1"),),
        token_order=(SonioxTokenRef("none", False, 0),),
    )
    app.state.runtime.live_store.save_event(cid, ordinal=0, event=draft)
    assert (await _summary(client, sid))["has_transcript"] is False


async def test_translation_only_final_is_not_a_transcript(client: httpx.AsyncClient, app: Any) -> None:
    sid, cid = await recording(client, app)
    translated = replace(
        event(""),
        final_tokens=(),
        final_translation_tokens=(SonioxTranslationToken("Привет", 0.9, True, "ru", "en", "1"),),
        token_order=(SonioxTokenRef("translation", True, 0),),
    )
    app.state.runtime.live_store.save_event(cid, ordinal=0, event=translated)
    assert (await _summary(client, sid))["has_transcript"] is False


async def test_whitespace_final_is_not_a_transcript(client: httpx.AsyncClient, app: Any) -> None:
    sid, cid = await recording(client, app)
    app.state.runtime.live_store.save_event(cid, ordinal=0, event=event("   "))
    assert (await _summary(client, sid))["has_transcript"] is False


async def test_tokens_without_segments_still_count(client: httpx.AsyncClient, app: Any) -> None:
    # The generator reads token provenance first; a session whose segment rows are
    # gone but whose final tokens remain can still be summarised.
    sid, cid = await recording(client, app)
    app.state.runtime.live_store.save_event(cid, ordinal=0, event=event("Token source"))
    with app.state.runtime.db.write() as connection:
        connection.execute("DELETE FROM segments_fts WHERE session_id=?", (sid,))
        connection.execute("DELETE FROM segment_sources WHERE session_id=?", (sid,))
        connection.execute("DELETE FROM transcript_revisions")
        connection.execute("DELETE FROM segments WHERE session_id=?", (sid,))
    assert (await _summary(client, sid))["has_transcript"] is True


async def test_legacy_segments_count_without_tokens(client: httpx.AsyncClient, app: Any) -> None:
    sid, cid = await recording(client, app)
    app.state.runtime.live_store.save_event(cid, ordinal=0, event=event("Legacy source"))
    with app.state.runtime.db.write() as connection:
        connection.execute("DELETE FROM native_token_events WHERE connection_id=?", (cid,))
    assert (await client.get(f"/sessions/{sid}")).json()["has_transcript"] is True
    assert (await _summary(client, sid))["has_transcript"] is True
