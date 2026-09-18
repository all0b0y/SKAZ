"""Note titles, list ordering by edit time, and soft deletion.

Titles are an independent field in the Obsidian sense: renaming never rewrites the
document, and editing the document never renames it. A title that sanitises to
nothing is refused rather than stored, so a user who clears the field gets the
previous name back instead of an unnamed note.
"""
from __future__ import annotations

import httpx

from tests.conftest import FakeHttp


async def create_session(client: httpx.AsyncClient) -> str:
    created = await client.post("/sessions", json={"title": "Лекция"})
    assert created.status_code == 200, created.text
    return str(created.json()["id"])


async def empty_note(client: httpx.AsyncClient, session: str) -> dict:
    response = await client.post(f"/sessions/{session}/notes/empty")
    assert response.status_code == 200, response.text
    return dict(response.json())


async def test_empty_note_starts_untitled(client: httpx.AsyncClient) -> None:
    session = await create_session(client)
    note = await empty_note(client, session)
    assert note["title"] == ""
    assert note["content"] == ""


async def test_rename_leaves_the_document_untouched(client: httpx.AsyncClient) -> None:
    """Obsidian model: the name is not the first line of the text."""
    session = await create_session(client)
    note = await empty_note(client, session)
    path = f"/sessions/{session}/notes/{note['id']}"
    written = await client.patch(path, json={"content": "# Заголовок в тексте\n\nтело", "expected_revision": 1})
    assert written.status_code == 200, written.text

    renamed = await client.patch(path, json={"title": "Моя лекция", "expected_revision": 2})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["title"] == "Моя лекция"
    assert renamed.json()["content"] == "# Заголовок в тексте\n\nтело"

    # And editing the body does not rename the note back.
    edited = await client.patch(path, json={"content": "# Другое\n\nтело", "expected_revision": 3})
    assert edited.status_code == 200, edited.text
    assert edited.json()["title"] == "Моя лекция"


async def test_blank_title_is_refused_and_the_previous_name_survives(
    client: httpx.AsyncClient,
) -> None:
    session = await create_session(client)
    note = await empty_note(client, session)
    path = f"/sessions/{session}/notes/{note['id']}"
    named = await client.patch(path, json={"title": "Первое имя", "expected_revision": 1})
    assert named.status_code == 200, named.text

    for blank in ("", "   ", "\n\t "):
        cleared = await client.patch(path, json={"title": blank, "expected_revision": 2})
        assert cleared.status_code == 400, cleared.text
    survived = (await client.get(f"/sessions/{session}/notes")).json()["notes"]
    assert survived[0]["title"] == "Первое имя"
    assert survived[0]["revision"] == 2


async def test_title_is_sanitised_for_a_filesystem_and_one_line(client: httpx.AsyncClient) -> None:
    session = await create_session(client)
    note = await empty_note(client, session)
    path = f"/sessions/{session}/notes/{note['id']}"
    dirty = await client.patch(
        path,
        json={"title": "  Лекция/1\nвторая строка\u0007.md.md  ", "expected_revision": 1},
    )
    assert dirty.status_code == 200, dirty.text
    assert dirty.json()["title"] == "Лекция 1 вторая строка"

    long = await client.patch(path, json={"title": "я" * 400, "expected_revision": 2})
    assert long.status_code == 200, long.text
    assert long.json()["title"] == "я" * 120


async def test_list_orders_by_last_edit_not_creation(client: httpx.AsyncClient) -> None:
    session = await create_session(client)
    first = await empty_note(client, session)
    second = await empty_note(client, session)
    order = [n["id"] for n in (await client.get(f"/sessions/{session}/notes")).json()["notes"]]
    assert order == [second["id"], first["id"]]

    touched = await client.patch(
        f"/sessions/{session}/notes/{first['id']}",
        json={"content": "правка", "expected_revision": 1},
    )
    assert touched.status_code == 200, touched.text
    assert touched.json()["updated_at"] >= touched.json()["created_at"]
    order = [n["id"] for n in (await client.get(f"/sessions/{session}/notes")).json()["notes"]]
    assert order == [first["id"], second["id"]]


async def test_soft_delete_hides_the_note_but_keeps_the_row(client: httpx.AsyncClient) -> None:
    session = await create_session(client)
    kept = await empty_note(client, session)
    doomed = await empty_note(client, session)
    removed = await client.delete(f"/sessions/{session}/notes/{doomed['id']}")
    assert removed.status_code == 200, removed.text

    listing = (await client.get(f"/sessions/{session}/notes")).json()["notes"]
    assert [n["id"] for n in listing] == [kept["id"]]
    detail = (await client.get(f"/sessions/{session}")).json()
    assert [n["id"] for n in detail["notes_list"]] == [kept["id"]]
    # The row survives for the future trash, so it must not be editable meanwhile.
    stale = await client.patch(
        f"/sessions/{session}/notes/{doomed['id']}", json={"content": "x", "expected_revision": 1},
    )
    assert stale.status_code == 404
    gone = await client.delete(f"/sessions/{session}/notes/{doomed['id']}")
    assert gone.status_code == 404


async def test_deleted_note_disappears_from_the_projected_folder(
    client: httpx.AsyncClient, tmp_path_factory, outbound: FakeHttp,
) -> None:
    session = await create_session(client)
    doomed = await empty_note(client, session)
    status = (await client.get(f"/sessions/{session}/files")).json()
    if status.get("state") in (None, "disabled"):
        return
    published = await client.post(f"/sessions/{session}/files")
    assert published.status_code == 200, published.text
    names = [f["name"] for f in published.json().get("files", [])]
    assert f"Note-{doomed['id']}.md" in names
    await client.delete(f"/sessions/{session}/notes/{doomed['id']}")
    after = await client.post(f"/sessions/{session}/files")
    names = [f["name"] for f in after.json().get("files", [])]
    assert f"Note-{doomed['id']}.md" not in names
