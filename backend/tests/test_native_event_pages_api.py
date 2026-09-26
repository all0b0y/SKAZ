"""Bounded, replayable native event reads at the authenticated session seam."""
from __future__ import annotations

from dataclasses import replace
from typing import Any

import httpx

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.gateways.soniox import SonioxEvent, SonioxToken, SonioxTokenRef, SonioxTranslationToken
from audiohelper.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp


def event(text: str) -> SonioxEvent:
    return SonioxEvent(
        (SonioxToken(text, 0, 100, .9, True, "en", "1"),), (), (), 100, 100, False,
        token_order=(SonioxTokenRef("none", True, 0),),
    )


async def recording(client: httpx.AsyncClient, app: Any) -> tuple[str, str]:
    sid = (await client.post("/sessions", json={"title": "Pages"})).json()["id"]
    store = app.state.runtime.live_store
    connection = store.open(sid, sample_rate=16000, model="stt-rt-v5")
    store.append_audio(connection.id, sequence=0, start_sample=0, pcm=b"\x00\x00" * 1600)
    return sid, connection.id


async def test_delta_returns_only_unseen_events_and_retry_is_idempotent(
    client: httpx.AsyncClient, app: Any,
) -> None:
    sid, cid = await recording(client, app)
    store = app.state.runtime.live_store
    for ordinal, text in enumerate(("One", "Two", "Three")):
        store.save_event(cid, ordinal=ordinal, event=event(text))
    url = f"/sessions/{sid}/live/events"
    response = await client.get(url, params={"connection_id": cid, "after": -1, "limit": 2})
    assert response.status_code == 200
    page = response.json()
    assert page["protocol"] == 1
    assert page["session_id"] == sid
    assert page["connection"]["id"] == cid
    assert [row["ordinal"] for row in page["events"]] == [0, 1]
    assert [row["originals"][0]["text"] for row in page["events"]] == ["One", "Two"]
    assert page["next_after"] == 1
    assert page["has_newer"] is True
    assert page["tail"] is None
    params = {"connection_id": cid, "after": page["next_after"], "limit": 2}
    last = (await client.get(url, params=params)).json()
    assert [row["ordinal"] for row in last["events"]] == [2]
    assert last["has_newer"] is False
    assert last["through"] == 2
    assert last["tail"]["originals"] == []
    assert (await client.get(url, params=params)).json() == last
    unchanged = (await client.get(url, params={"connection_id": cid, "after": 2})).json()
    assert unchanged["events"] == []
    assert unchanged["next_after"] == 2
    assert "digest" not in response.text and "path" not in response.text


async def test_history_pages_and_connection_rotation_keep_order(
    client: httpx.AsyncClient, app: Any,
) -> None:
    sid, cid = await recording(client, app)
    store = app.state.runtime.live_store
    for ordinal in range(5):
        store.save_event(cid, ordinal=ordinal, event=event(str(ordinal)))
    store.close(cid, finished=True)
    second = store.open(sid, sample_rate=16000, model="stt-rt-v5")
    url = f"/sessions/{sid}/live/events"
    current = (await client.get(url)).json()
    assert current["connection"]["id"] == second.id
    assert current["previous_connection_id"] == cid
    assert current["events"] == [] and current["through"] == -1
    params: dict[str, str | int | float] = {"connection_id": cid, "limit": 2}
    latest = (await client.get(url, params=params)).json()
    assert [row["ordinal"] for row in latest["events"]] == [3, 4]
    assert latest["has_older"] is True
    assert latest["next_connection_id"] == second.id
    middle = (await client.get(url, params={**params, "before": latest["next_before"]})).json()
    assert [row["ordinal"] for row in middle["events"]] == [1, 2]
    assert middle["tail"] is None
    first = (await client.get(url, params={**params, "before": middle["next_before"]})).json()
    assert [row["ordinal"] for row in first["events"]] == [0]
    assert first["has_older"] is False
    assert first["previous_connection_id"] is None


async def test_invalid_foreign_and_future_cursors_never_become_latest_page(
    client: httpx.AsyncClient, app: Any,
) -> None:
    sid, cid = await recording(client, app)
    other_sid, other_cid = await recording(client, app)
    url = f"/sessions/{sid}/live/events"
    invalid_queries: list[dict[str, str | int | float]] = [
        {"after": -1, "before": 0}, {"limit": 0}, {"limit": 129},
        {"after": -2}, {"before": -1}, {"after": 1.5}, {"connection_id": ""},
        {"after": -1}, {"before": 0},
    ]
    for params in invalid_queries:
        assert (await client.get(url, params=params)).status_code == 422
    stale_queries: list[dict[str, str | int | float]] = [
        {"connection_id": cid, "after": 0}, {"connection_id": cid, "before": 1},
    ]
    for params in stale_queries:
        assert (await client.get(url, params=params)).status_code == 409
    assert (await client.get(url, params={"connection_id": other_cid})).status_code == 404
    foreign = await client.get(f"/sessions/{other_sid}/live/events", params={"connection_id": cid})
    assert foreign.status_code == 404
    assert (await client.get("/sessions/missing/live/events")).status_code == 404
    assert (await client.get(url, headers={"Authorization": ""})).status_code == 401


async def test_page_byte_limit_never_silently_truncates_an_event(
    client: httpx.AsyncClient, app: Any,
) -> None:
    sid, cid = await recording(client, app)
    store = app.state.runtime.live_store
    # Protocol stress fixture, not a speech-quality or real-data benchmark.
    for ordinal in range(3):
        store.save_event(cid, ordinal=ordinal, event=event("x" * 100_000))
    url = f"/sessions/{sid}/live/events"
    response = await client.get(url, params={"connection_id": cid, "after": -1})
    assert response.status_code == 200
    assert len(response.content) <= 256 * 1024
    page = response.json()
    assert [row["ordinal"] for row in page["events"]] == [0, 1]
    assert [len(row["originals"][0]["text"]) for row in page["events"]] == [100_000, 100_000]
    last = (await client.get(url, params={"connection_id": cid, "after": page["next_after"]})).json()
    assert [row["ordinal"] for row in last["events"]] == [2]
    reverse = (await client.get(url, params={"connection_id": cid})).json()
    assert [row["ordinal"] for row in reverse["events"]] == [1, 2]
    store.save_event(cid, ordinal=3, event=event("x" * 270_000))
    # Above the normal budget but indivisible: served alone, never refused or cut.
    alone = await client.get(url, params={"connection_id": cid, "after": 2})
    assert alone.status_code == 200
    single = alone.json()
    assert [row["ordinal"] for row in single["events"]] == [3]
    assert len(single["events"][0]["originals"][0]["text"]) == 270_000
    assert single["has_newer"] is False
    # The projected path the UI actually reads serves it the same way.
    projected = await client.get(url, params={"connection_id": cid, "after": 2, "project": True})
    assert projected.status_code == 200
    assert [row["ordinal"] for row in projected.json()["events"]] == [3]
    # A following small event is not glued onto the oversized page.
    store.save_event(cid, ordinal=4, event=event("tail"))
    after_big = (await client.get(url, params={"connection_id": cid, "after": 2})).json()
    assert [row["ordinal"] for row in after_big["events"]] == [3]
    assert after_big["has_newer"] is True


async def test_event_above_the_hard_ceiling_is_an_explicit_error(
    client: httpx.AsyncClient, app: Any, monkeypatch: Any,
) -> None:
    from audiohelper import native_event_pages
    monkeypatch.setattr(native_event_pages, "HARD_PAGE_BYTES", 300 * 1024)
    sid, cid = await recording(client, app)
    store = app.state.runtime.live_store
    store.save_event(cid, ordinal=0, event=event("x" * 400_000))
    url = f"/sessions/{sid}/live/events"
    oversized = await client.get(url, params={"connection_id": cid, "after": -1})
    assert oversized.status_code == 413
    assert "x" * 100 not in oversized.text


async def test_mixed_translation_order_and_replaceable_tail_preserve_provenance(
    client: httpx.AsyncClient, app: Any,
) -> None:
    sid, cid = await recording(client, app)
    store = app.state.runtime.live_store
    mixed = replace(event("Hello"),
                    final_translation_tokens=(SonioxTranslationToken("Привет", .9, True, "ru", "en", "1"),),
                    partial_tokens=(SonioxToken(" maybe", 0, 100, .9, False, "en", "1"),),
                    token_order=(SonioxTokenRef("original", True, 0),
                                 SonioxTokenRef("translation", True, 0),
                                 SonioxTokenRef("original", False, 0)))
    ids = store.save_event(cid, ordinal=0, event=mixed)
    url = f"/sessions/{sid}/live/events"
    page = (await client.get(url)).json()
    item = page["events"][0]
    assert item["segment_ids"] == ids
    assert item["originals"][0]["segment_id"] == ids[0]
    assert item["originals"][0]["start_sample"] == 0
    assert item["originals"][0]["end_sample"] == 1600
    assert item["translations"][0]["text"] == "Привет"
    assert item["order"] == [
        {"id": item["originals"][0]["id"], "translation_status": "original"},
        {"id": item["translations"][0]["id"], "translation_status": "translation"},
    ]
    assert page["tail"]["originals"][0]["speaker_number"] == 1
    assert page["tail"]["originals"][0]["text"] == " maybe"
    store.save_event(cid, ordinal=1, event=replace(mixed, final_tokens=(), final_translation_tokens=(),
                     partial_tokens=(SonioxToken(" revised", 0, 100, .9, False, "en", "1"),),
                     token_order=(SonioxTokenRef("original", False, 0),)))
    delta = (await client.get(url, params={"connection_id": cid, "after": 0})).json()
    assert delta["events"][0]["originals"] == []
    assert delta["tail"]["originals"][0]["text"] == " revised"
    assert " maybe" not in str(delta)
    store.save_event(cid, ordinal=2, event=replace(event("Old"), token_order=None))
    historic = (await client.get(url, params={"connection_id": cid, "after": 1})).json()
    assert historic["events"][0]["order"] is None
    assert historic["tail"]["originals"] == []


async def test_page_lookup_does_not_scan_unrelated_connection_history(
    client: httpx.AsyncClient, app: Any,
) -> None:
    sid, cid = await recording(client, app)
    db = app.state.runtime.db

    async def read_steps() -> int:
        steps = 0

        def progress() -> int:
            nonlocal steps
            steps += 1
            return 0

        with db.read() as connection:
            connection.set_progress_handler(progress, 1)
        try:
            response = await client.get(f"/sessions/{sid}/live/events", params={"connection_id": cid})
            assert response.status_code == 200
            assert response.json()["next_connection_id"] is None
        finally:
            with db.read() as connection:
                connection.set_progress_handler(None, 0)
        return steps

    baseline = await read_steps()
    other_sid, other_cid = await recording(client, app)
    store = app.state.runtime.live_store
    store.close(other_cid, finished=True)
    for _ in range(128):
        other = store.open(other_sid, sample_rate=16000, model="stt-rt-v5")
        store.close(other.id, finished=True)
    grown = await read_steps()
    assert grown <= baseline + 100, (baseline, grown)


async def test_empty_native_recording_is_distinct_from_missing_recording(
    client: httpx.AsyncClient, app: Any,
) -> None:
    sid = (await client.post("/sessions", json={"title": "Empty"})).json()["id"]
    url = f"/sessions/{sid}/live/events"
    assert (await client.get(url)).status_code == 404
    # Native import rows exist before the provider has created a connection.
    with app.state.runtime.db.write() as connection:
        connection.execute("INSERT INTO native_recordings(session_id,sample_rate) VALUES (?,16000)", (sid,))
    page = (await client.get(url)).json()
    assert page["connection"] is None
    assert page["events"] == [] and page["through"] == -1
    assert page["has_older"] is False and page["has_newer"] is False
    assert page["next_before"] == 0 and page["next_after"] == -1


async def test_saved_cursor_survives_runtime_reopen(
    client: httpx.AsyncClient, app: Any, config: AppConfig, outbound: FakeHttp,
) -> None:
    sid, cid = await recording(client, app)
    store = app.state.runtime.live_store
    store.save_event(cid, ordinal=0, event=event("First"))
    store.save_event(cid, ordinal=1, event=event("Second"))
    url = f"/sessions/{sid}/live/events"
    params: dict[str, str | int | float] = {"connection_id": cid, "after": 0}
    previous = (await client.get(url, params=params)).json()
    reopened = create_app(config, secret_store=MemorySecretStore(), http_client=outbound.client())
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=reopened), base_url="http://127.0.0.1",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as http:
            current = (await http.get(url, params=params)).json()
            assert current["events"] == previous["events"]
            assert current["through"] == previous["through"] == 1
            assert current["next_after"] == previous["next_after"] == 1
            assert current["connection"]["status"] == "incomplete"
    finally:
        await reopened.state.runtime.http.aclose()
        reopened.state.runtime.close()


async def test_archive_without_token_metadata_is_not_reported_as_empty_speech(
    client: httpx.AsyncClient, app: Any,
) -> None:
    sid, cid = await recording(client, app)
    ids = app.state.runtime.live_store.save_event(cid, ordinal=0, event=event("Historic"))
    # Exact pre-v2 shape: the durable segment exists but token metadata does not.
    with app.state.runtime.db.write() as connection:
        connection.execute("DELETE FROM native_token_events WHERE connection_id=?", (cid,))
        connection.execute("DELETE FROM native_stream_events WHERE connection_id=?", (cid,))
    page = (await client.get(f"/sessions/{sid}/live/events")).json()
    assert page["events"][0]["originals_available"] is False
    assert page["events"][0]["segment_ids"] == ids
    assert page["events"][0]["order"] is None






