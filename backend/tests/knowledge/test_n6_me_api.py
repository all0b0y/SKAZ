"""N6 «Я» routes exactly as ``N6-ME-API.md`` says (names, shapes, status codes, error codes)."""
from __future__ import annotations

from typing import Any

import httpx

from skaz.knowledge.me import HOW_TO_WORK_LIMIT, PROFILE_LIMIT

SKILL_KEYS = {"id", "kind", "builtin", "title", "description", "enabled", "always_on", "chars", "limit",
              "version", "updated_at"}


async def test_me_routes_require_the_token(kb_app: Any) -> None:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=kb_app),
                                 base_url="http://127.0.0.1:8765") as anonymous:
        assert (await anonymous.get("/kb/me")).status_code == 401
        assert (await anonymous.put("/kb/me/skills/profile", json={"text": "x"})).status_code == 401


async def test_read_me_lists_builtins_first_with_the_contract_fields(kb_client: httpx.AsyncClient) -> None:
    response = await kb_client.get("/kb/me")
    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is True
    assert [skill["id"] for skill in body["skills"]] == ["profile", "how-to-work", "search"]
    profile, how, search = body["skills"]
    assert set(profile) == SKILL_KEYS
    assert (profile["kind"], profile["title"], profile["limit"], profile["always_on"],
            profile["builtin"]) == ("profile", "Profile", PROFILE_LIMIT, True, True)
    assert (how["kind"], how["title"], how["limit"], how["always_on"]) == (
        "how_to_work", "How to work with me", HOW_TO_WORK_LIMIT, True)
    assert (search["kind"], search["title"], search["limit"], search["always_on"]) == (
        "search", "Search", None, False)
    assert (profile["version"], profile["chars"], profile["updated_at"]) == (0, 0, None)


async def test_master_switch(kb_client: httpx.AsyncClient) -> None:
    off = await kb_client.put("/kb/me", json={"enabled": False})
    assert off.status_code == 200 and off.json()["enabled"] is False
    assert (await kb_client.get("/kb/me")).json()["enabled"] is False
    assert (await kb_client.put("/kb/me", json={})).status_code == 422


async def test_edit_text_versions_restore_and_errors(kb_client: httpx.AsyncClient) -> None:
    first = await kb_client.put("/kb/me/skills/how-to-work", json={"text": "Explain with an example first"})
    assert first.status_code == 200
    detail = first.json()
    assert set(detail) == SKILL_KEYS | {"text"}
    assert (detail["text"], detail["version"], detail["chars"]) == ("Explain with an example first", 1, 29)
    assert detail["updated_at"]
    await kb_client.put("/kb/me/skills/how-to-work", json={"text": "Short answers"})
    versions = (await kb_client.get("/kb/me/skills/how-to-work/versions")).json()["versions"]
    assert [(item["version"], item["source"], item["chat_id"]) for item in versions] == [
        (2, "user", None), (1, "user", None)]
    assert set(versions[0]) == {"version", "created_at", "source", "chat_id", "summary", "chars"}
    restored = await kb_client.post("/kb/me/skills/how-to-work/versions/1/restore")
    assert restored.status_code == 200
    assert (restored.json()["text"], restored.json()["version"]) == ("Explain with an example first", 3)
    newest = (await kb_client.get("/kb/me/skills/how-to-work/versions")).json()["versions"][0]
    assert newest["source"] == "restore"

    too_long = await kb_client.put("/kb/me/skills/profile", json={"text": "x" * (PROFILE_LIMIT + 1)})
    assert too_long.status_code == 422 and too_long.json()["code"] == "limit_exceeded"
    assert "detail" in too_long.json()
    renamed = await kb_client.put("/kb/me/skills/profile", json={"title": "Me"})
    assert renamed.status_code == 409
    assert (await kb_client.get("/kb/me/skills/nope")).status_code == 404
    assert (await kb_client.put("/kb/me/skills/nope", json={"text": "x"})).status_code == 404
    assert (await kb_client.get("/kb/me/skills/nope/versions")).status_code == 404
    assert (await kb_client.post("/kb/me/skills/how-to-work/versions/99/restore")).status_code == 404
    assert (await kb_client.put("/kb/me/skills/search", json={"colour": "red"})).status_code == 422
    disabled = await kb_client.put("/kb/me/skills/search", json={"enabled": False})
    assert disabled.status_code == 200 and disabled.json()["enabled"] is False


async def test_create_and_delete_own_skills(kb_client: httpx.AsyncClient) -> None:
    made = await kb_client.post("/kb/me/skills", json={"title": "Exam drill", "description": "Before exams",
                                                       "text": "Ten questions, then review"})
    assert made.status_code == 201
    skill = made.json()
    assert (skill["id"], skill["kind"], skill["builtin"], skill["limit"], skill["version"]) == (
        "exam-drill", "skill", False, None, 1)
    renamed = await kb_client.put("/kb/me/skills/exam-drill", json={"title": "Exam practice"})
    assert renamed.status_code == 200 and renamed.json()["title"] == "Exam practice"
    listed = [item["id"] for item in (await kb_client.get("/kb/me")).json()["skills"]]
    assert listed == ["profile", "how-to-work", "search", "exam-drill"]
    assert (await kb_client.post("/kb/me/skills", json={"title": "", "description": "", "text": ""})
            ).status_code == 422
    assert (await kb_client.delete("/kb/me/skills/search")).status_code == 409
    gone = await kb_client.delete("/kb/me/skills/exam-drill")
    assert gone.status_code == 204
    assert (await kb_client.get("/kb/me/skills/exam-drill")).status_code == 404
    assert (await kb_client.delete("/kb/me/skills/exam-drill")).status_code == 404


async def test_undo_of_an_unknown_edit_is_404(kb_client: httpx.AsyncClient) -> None:
    response = await kb_client.post("/kb/me/edits/me-000000000000/undo")
    assert response.status_code == 404 and response.json()["code"] == "not_found"
