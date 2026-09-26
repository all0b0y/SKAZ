"""Translation ownership at both edges of a bounded native transcript page."""
from dataclasses import replace
from typing import Any, Literal

import httpx

from audiohelper.gateways.soniox import SonioxToken, SonioxTokenRef, SonioxTranslationToken
from tests.test_native_event_pages_api import event, recording


async def test_translation_uses_original_before_page_and_later_group_invalidation(
    client: httpx.AsyncClient,
    app: Any,
) -> None:
    sid, cid = await recording(client, app)
    store = app.state.runtime.live_store
    original = replace(event("Hello"), token_order=(SonioxTokenRef("original", True, 0),))
    store.save_event(cid, ordinal=0, event=original)
    translated = replace(
        original,
        final_tokens=(),
        final_translation_tokens=(SonioxTranslationToken("Привет", 0.9, True, "ru", "en", "1"),),
        token_order=(SonioxTokenRef("translation", True, 0),),
    )
    store.save_event(cid, ordinal=1, event=translated)
    url = f"/sessions/{sid}/live/events"
    page = (await client.get(url, params={"project": True, "limit": 1})).json()
    assert [e["ordinal"] for e in page["events"]] == [1]
    item = page["events"][0]
    tid = item["translations"][0]["id"]
    group = item["projection"]["translations"][tid]
    assert page["projection"]["groups"][group]["id"] == f"{cid}:0:0"
    assert page["projection"]["groups"][group]["speaker_number"] == 1
    store.save_event(
        cid,
        ordinal=2,
        event=replace(
            translated,
            final_translation_tokens=(SonioxTranslationToken("Другой", 0.9, True, "ru", "en", "2"),),
        ),
    )
    older = (
        await client.get(url, params={"project": True, "connection_id": cid, "before": 2, "limit": 1})
    ).json()
    assert older["events"][0]["ordinal"] == 1
    # The second translation token is outside this page but invalidates the
    # WHOLE contiguous translation group, as the full projection requires.
    assert older["projection"]["groups"][group] is None


async def test_draft_outside_history_page_can_invalidate_translation_ownership(
    client: httpx.AsyncClient, app: Any,
) -> None:
    sid, cid = await recording(client, app)
    store = app.state.runtime.live_store
    store.save_event(cid, ordinal=0, event=replace(event("Hello"),
                     token_order=(SonioxTokenRef("original", True, 0),)))
    translated = replace(event(""), final_tokens=(),
        final_translation_tokens=(SonioxTranslationToken("Привет", .9, True, "ru", "en", "1"),),
        token_order=(SonioxTokenRef("translation", True, 0),))
    store.save_event(cid, ordinal=1, event=translated)
    store.save_event(cid, ordinal=2, event=replace(translated, final_translation_tokens=(),
        partial_translation_tokens=(SonioxTranslationToken("Другой", .9, False, "ru", "en", "2"),),
        token_order=(SonioxTokenRef("translation", False, 0),)))
    page = (await client.get(f"/sessions/{sid}/live/events", params={
        "project": True, "connection_id": cid, "before": 2, "limit": 1,
    })).json()
    tid = page["events"][0]["translations"][0]["id"]
    group = page["events"][0]["projection"]["translations"][tid]
    assert page["projection"]["tail_groups"][group] is None
    assert page["projection"]["groups"][group] is not None
    assert page["projection"]["tail"] is None


async def test_native_summary_does_not_load_the_full_transcript(
    client: httpx.AsyncClient, app: Any,
) -> None:
    sid, cid = await recording(client, app)
    app.state.runtime.live_store.save_event(cid, ordinal=0, event=event("Saved source"))
    summary = (await client.get(f"/sessions/{sid}", params={"native_window": True})).json()
    assert summary["segments"] == []
    assert (await client.get(f"/sessions/{sid}")).json()["segments"][0]["text"] == "Saved source"


async def test_citation_locator_and_pre_token_archive_preserve_the_saved_source(
    client: httpx.AsyncClient, app: Any,
) -> None:
    sid, cid = await recording(client, app)
    store = app.state.runtime.live_store
    store.save_event(cid, ordinal=0, event=event("Archived original"))
    detail = (await client.get(f"/sessions/{sid}")).json()
    source = detail["segments"][0]["id"]
    with app.state.runtime.db.write() as c:
        c.execute("DELETE FROM native_token_events WHERE connection_id=?", (cid,))
        c.execute("DELETE FROM native_stream_events WHERE connection_id=?", (cid,))
    response = await client.get(
        f"/sessions/{sid}/live/events", params={"project": True, "segment_id": source}
    )
    assert response.status_code == 200
    page = response.json()
    assert page["events"][0]["originals"][0]["text"] == "Archived original"
    assert page["events"][0]["originals"][0]["segment_id"] == source
    assert page["events"][0]["originals"][0]["speaker_number"] is None
    assert page["projection"]["available"] is False
    assert (
        await client.get(f"/sessions/{sid}/live/events", params={"project": True, "segment_id": "missing"})
    ).status_code == 404


async def test_byte_bounded_citation_page_always_contains_the_requested_source(
    client: httpx.AsyncClient,
    app: Any,
) -> None:
    sid, cid = await recording(client, app)
    store = app.state.runtime.live_store
    for ordinal in range(40):
        store.save_event(cid, ordinal=ordinal, event=event("word " * 4000))
    sources = (await client.get(f"/sessions/{sid}")).json()["segments"]
    source = sources[-1]["id"]
    response = await client.get(
        f"/sessions/{sid}/live/events", params={"project": True, "segment_id": source, "limit": 128}
    )
    assert response.status_code == 200
    assert source in [
        token["segment_id"] for item in response.json()["events"] for token in item["originals"]
    ]


async def test_every_page_matches_full_projection_after_mixed_group_changes(
    client: httpx.AsyncClient,
    app: Any,
) -> None:
    sid, cid = await recording(client, app)
    store = app.state.runtime.live_store
    original = event("base").final_tokens[0]
    batches: list[list[tuple[Literal["none", "original", "translation"], str, str]]] = [
        [("original", "1", "One"), ("original", "2", " Two")],
        [("translation", "1", "Один"), ("translation", "2", " Два")],
        [("none", "2", " API")],
        [("original", "1", "Again")],
        [("translation", "1", "Снова")],
        [("translation", "2", " Другой")],
        [("none", "1", " SQL"), ("original", "1", "Done"), ("translation", "1", "Готово")],
    ]
    for ordinal, batch in enumerate(batches):
        originals: list[SonioxToken] = []
        translations: list[SonioxTranslationToken] = []
        order: list[SonioxTokenRef] = []
        for status, speaker, text in batch:
            if status == "translation":
                order.append(SonioxTokenRef(status, True, len(translations)))
                translations.append(SonioxTranslationToken(text, 0.9, True, "ru", "en", speaker))
            else:
                order.append(SonioxTokenRef(status, True, len(originals)))
                originals.append(replace(original, text=text, speaker=speaker))
        store.save_event(
            cid,
            ordinal=ordinal,
            event=replace(
                event(""),
                final_tokens=tuple(originals),
                final_translation_tokens=tuple(translations),
                token_order=tuple(order),
            ),
        )
        full = store.snapshot(sid)["live_translation_projection"]
        expected = {
            identity: turn["id"] for turn in full["monologues"] for identity in turn["display_token_ids"]
        }
        actual = {}
        for position in range(ordinal + 1):
            response = await client.get(
                f"/sessions/{sid}/live/events",
                params={
                    "project": True,
                    "connection_id": cid,
                    "before": position + 1,
                    "limit": 1,
                },
            )
            assert response.status_code == 200
            page = response.json()
            item = page["events"][0]
            for ref in item["order"]:
                if ref["translation_status"] == "none":
                    actual[ref["id"]] = item["projection"]["owners"][ref["id"]]["id"]
                elif ref["translation_status"] == "translation":
                    target = page["projection"]["groups"][item["projection"]["translations"][ref["id"]]]
                    if target:
                        actual[ref["id"]] = target["id"]
        assert actual == expected


