"""Rewriting one passage of a note: what is replaced, what is kept, what is refused."""

from __future__ import annotations

import json

import httpx
import pytest

from tests.conftest import FakeHttp
from tests.test_notes_api import CATALOG, add_at, add_contiguous, session, stub_notes  # noqa: F401

#: The point the tests rewrite, and the speech it rests on. They share their words
#: on purpose: a passage is sourced by the same text match the panel uses to decide
#: whether to offer "Показать в транскрипции" at all, so a point worded nothing like
#: its monologue has no source in the UI either and must not gain one here.
FIRST_SPEECH = "Определение термина звучит так."
FIRST_POINT = "Определение термина звучит так"
SECOND_SPEECH = "Экзамен назначен на пятницу."
SECOND_POINT = "Экзамен назначен на пятницу"


@pytest.fixture(autouse=True)
def _catalog(outbound: FakeHttp) -> None:
    """The provider catalog the session fixture's uploads go through.

    ``test_notes_api`` declares the same autouse fixture, but autouse applies only
    inside the module that defines it: importing the session fixture alone leaves
    uploads failing on an unavailable catalog.
    """
    outbound.json_route("GET", "openrouter.ai/api/v1/models", CATALOG)


async def _far(
    client: httpx.AsyncClient, outbound: FakeHttp, session: str, sequence: int, text: str
) -> None:
    """Upload a chunk far past the monologue break, so it is its own monologue."""
    await add_at(client, outbound, session, sequence, 60_000 * sequence, text)


async def _note_over_two_monologues(
    client: httpx.AsyncClient, outbound: FakeHttp, session: str,
) -> dict:
    """A session of two separated monologues, with a note carrying a point on each."""
    await add_contiguous(client, outbound, session, 0, FIRST_SPEECH)
    await _far(client, outbound, session, 1, SECOND_SPEECH)
    stub_notes(outbound, f"- {FIRST_POINT} [P1]\n- {SECOND_POINT} [P2]")
    created = await client.post(f"/sessions/{session}/notes", json={})
    assert created.status_code == 200, created.text
    return dict(created.json())


def _span(content: str, passage: str) -> tuple[int, int]:
    start = content.index(passage)
    return start, start + len(passage)


async def test_rewrite_replaces_only_the_selected_span(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp,
) -> None:
    note = await _note_over_two_monologues(client, outbound, session)
    content = note["content"]
    start, end = _span(content, FIRST_POINT)
    untouched = content[end:]

    stub_notes(outbound, f"{FIRST_POINT}, и это важно [P1]")
    preview = await client.post(
        f"/sessions/{session}/notes/{note['id']}/rewrite",
        json={"expected_revision": note["revision"], "start": start, "end": end},
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["original"] == FIRST_POINT
    assert body["replacement"] == f"{FIRST_POINT}, и это важно"
    # A preview stores nothing: the note is still exactly as it was.
    assert (await client.get(f"/sessions/{session}/notes")).json()["notes"][0]["content"] == content

    applied = await client.post(
        f"/sessions/{session}/notes/{note['id']}/rewrite/apply", json={"preview_id": body["id"]},
    )
    assert applied.status_code == 200, applied.text
    updated = applied.json()
    assert updated["content"] == content[:start] + f"{FIRST_POINT}, и это важно" + untouched
    # Everything outside the selection survives, including the other point.
    assert SECOND_POINT in updated["content"]
    assert updated["revision"] == note["revision"] + 1


async def test_applying_keeps_the_note_stale(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp,
) -> None:
    """One refreshed passage does not make the rest of the note current."""
    note = await _note_over_two_monologues(client, outbound, session)
    # The recording moves on, which is what marks the note stale.
    await _far(client, outbound, session, 2, "Позже добавленная реплика.")
    listed = (await client.get(f"/sessions/{session}/notes")).json()["notes"][0]
    assert listed["stale"] is True
    before = listed["source_revision"]

    start, end = _span(listed["content"], FIRST_POINT)
    stub_notes(outbound, f"{FIRST_POINT}, иначе [P1]")
    preview = (await client.post(
        f"/sessions/{session}/notes/{note['id']}/rewrite",
        json={"expected_revision": listed["revision"], "start": start, "end": end},
    )).json()
    applied = await client.post(
        f"/sessions/{session}/notes/{note['id']}/rewrite/apply", json={"preview_id": preview["id"]},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["stale"] is True
    assert applied.json()["source_revision"] == before


async def test_text_with_no_stored_speech_behind_it_is_refused(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp,
) -> None:
    """A sentence the user typed themselves has no source and gains none here."""
    note = await _note_over_two_monologues(client, outbound, session)
    mine = "Моя собственная мысль про погоду."
    edited = await client.patch(
        f"/sessions/{session}/notes/{note['id']}",
        json={"content": note["content"] + "\n\n" + mine, "expected_revision": note["revision"]},
    )
    assert edited.status_code == 200, edited.text
    content = edited.json()["content"]
    start, end = _span(content, mine)

    refused = await client.post(
        f"/sessions/{session}/notes/{note['id']}/rewrite",
        json={"expected_revision": edited.json()["revision"], "start": start, "end": end},
    )
    assert refused.status_code == 400
    assert "stored speech" in refused.json()["detail"]


async def test_a_preview_cannot_be_applied_twice(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp,
) -> None:
    note = await _note_over_two_monologues(client, outbound, session)
    start, end = _span(note["content"], FIRST_POINT)
    stub_notes(outbound, f"{FIRST_POINT}, иначе [P1]")
    preview = (await client.post(
        f"/sessions/{session}/notes/{note['id']}/rewrite",
        json={"expected_revision": note["revision"], "start": start, "end": end},
    )).json()
    first = await client.post(
        f"/sessions/{session}/notes/{note['id']}/rewrite/apply", json={"preview_id": preview["id"]},
    )
    assert first.status_code == 200, first.text
    again = await client.post(
        f"/sessions/{session}/notes/{note['id']}/rewrite/apply", json={"preview_id": preview["id"]},
    )
    assert again.status_code == 404


async def test_an_edit_made_while_comparing_blocks_the_apply(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp,
) -> None:
    """Offsets into a document the user has since changed point at different text."""
    note = await _note_over_two_monologues(client, outbound, session)
    start, end = _span(note["content"], FIRST_POINT)
    stub_notes(outbound, f"{FIRST_POINT}, иначе [P1]")
    preview = (await client.post(
        f"/sessions/{session}/notes/{note['id']}/rewrite",
        json={"expected_revision": note["revision"], "start": start, "end": end},
    )).json()
    assert "id" in preview, preview

    edited = await client.patch(
        f"/sessions/{session}/notes/{note['id']}",
        json={"content": "Совсем другой текст.", "expected_revision": note["revision"]},
    )
    assert edited.status_code == 200, edited.text

    conflict = await client.post(
        f"/sessions/{session}/notes/{note['id']}/rewrite/apply", json={"preview_id": preview["id"]},
    )
    assert conflict.status_code == 409
    assert (await client.get(f"/sessions/{session}/notes")).json()["notes"][0]["content"] \
        == "Совсем другой текст."


async def test_a_model_citing_speech_outside_the_passage_is_rejected(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp,
) -> None:
    note = await _note_over_two_monologues(client, outbound, session)
    start, end = _span(note["content"], FIRST_POINT)
    # Only [P1] is behind this passage; P7 names nothing in the block it was shown.
    stub_notes(outbound, "Что-то неподтверждённое [P7]")
    rejected = await client.post(
        f"/sessions/{session}/notes/{note['id']}/rewrite",
        json={"expected_revision": note["revision"], "start": start, "end": end},
    )
    assert rejected.status_code == 502
    assert (await client.get(f"/sessions/{session}/notes")).json()["notes"][0]["content"] \
        == note["content"]


async def test_only_the_passage_s_own_monologues_are_shown_to_the_model(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp,
) -> None:
    """The other point's speech is not in the prompt, so it cannot be restated."""
    note = await _note_over_two_monologues(client, outbound, session)
    start, end = _span(note["content"], FIRST_POINT)
    stub_notes(outbound, f"{FIRST_POINT}, иначе [P1]")
    sent_before = len(outbound.bodies)
    accepted = await client.post(
        f"/sessions/{session}/notes/{note['id']}/rewrite",
        json={"expected_revision": note["revision"], "start": start, "end": end},
    )
    assert accepted.status_code == 200, accepted.text
    prompts = json.dumps(outbound.bodies[sent_before:], ensure_ascii=False)
    assert FIRST_SPEECH in prompts
    assert SECOND_SPEECH not in prompts
