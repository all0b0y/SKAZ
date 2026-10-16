"""QA 16.10 C21: a material folder removed outside SKAZ is noticed on the next scan; the user is
told and can clean the wiki up exactly as Delete would."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

import httpx

from skaz.knowledge.service import KnowledgeService

from .ingest_support import ScriptedWiki
from .test_wiki_edits import lecture_and_textbook, page_file
from .wiki_support import ENTROPY_TITLE, wired


def _gone_notices(kb: KnowledgeService) -> list[Any]:
    return [item for item in kb.notifications() if item.kind == "material_gone"]


async def test_a_material_folder_moved_away_is_noticed_and_can_be_cleaned_up(
    kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path
) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    kb = case.kb
    entropy, temperature = case.concept_id(ENTROPY_TITLE), case.concept_id("Температура")
    record = kb.material_repo.get(case.lecture)
    assert record is not None
    shutil.move(str(kb.library_root / record.rel_dir), str(tmp_path / "moved-away"))

    assert (await kb_client.post("/kb/library/rescan")).status_code == 200
    assert kb.material_repo.get(case.lecture) is None
    [notice] = _gone_notices(kb)
    assert notice.title == "“Лекция 8” was removed outside SKAZ" and notice.requires_action
    assert notice.subject is not None and notice.subject["type"] == "page"
    feed = (await kb_client.get("/kb/notifications")).json()
    item = next(entry for entry in feed["items"] if entry["id"] == notice.id)
    assert [action["id"] for action in item["actions"]] == ["clean_up", "keep"]

    # Until it is cleaned up, footnotes still name the source (not just "Source").
    page = (await kb_client.get(f"/kb/wiki/pages/{entropy}")).json()
    gone = [c for block in page["blocks"] for c in block["citations"] if c["material_id"] == case.lecture]
    assert gone and all(c["available"] is False and c["material_title"] == "Лекция 8" for c in gone)

    # A second scan doesn't raise it again.
    await kb_client.post("/kb/library/rescan")
    assert len(_gone_notices(kb)) == 1

    done = await kb_client.post(f"/kb/notifications/{notice.id}/resolve", json={"action": "clean_up"})
    assert done.status_code == 200, done.text
    assert kb.page_repo.get(temperature) is None  # rested only on the lecture
    text = page_file(kb, entropy).read_text("utf-8")
    assert case.lecture not in text and "изолированной системы убывает" in text
    assert "removed outside SKAZ: Лекция 8" in (kb.library_root / "Wiki" / "log.md").read_text("utf-8")


async def test_keep_leaves_the_pages_and_a_restart_notices_it_too(
    kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path, kb_config: Any
) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    kb = case.kb
    entropy = case.concept_id(ENTROPY_TITLE)
    record = kb.material_repo.get(case.lecture)
    assert record is not None
    before = page_file(kb, entropy).read_text("utf-8")
    shutil.move(str(kb.library_root / record.rel_dir), str(tmp_path / "moved-away"))
    # The next start (a new runtime over the same index) scans the same library: it notices.
    restarted = KnowledgeService(kb.data_dir, documents_dir=kb.documents_dir)
    try:
        wired(restarted, ScriptedWiki())
        restarted.start()
        assert [item.id for item in restarted.vanished] == [case.lecture]
    finally:
        restarted.close()
    [notice] = _gone_notices(kb)
    kept = await kb_client.post(f"/kb/notifications/{notice.id}/resolve", json={"action": "keep"})
    assert kept.status_code == 200
    assert page_file(kb, entropy).read_text("utf-8") == before


async def test_an_unreadable_material_folder_is_not_taken_for_removed(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    kb = case.kb
    record = kb.material_repo.get(case.lecture)
    assert record is not None
    manifest = kb.library_root / record.rel_dir / ".skaz" / "material.json"
    manifest.write_text("{ not json", "utf-8")  # the scan can't read it; the folder is still there
    await kb_client.post("/kb/library/rescan")
    assert _gone_notices(kb) == []


async def test_notices_about_a_deleted_or_removed_material_are_dismissed(
    kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path
) -> None:
    """QA C19: "Review" of a material that is gone leads nowhere — its notices go with it."""
    case = await lecture_and_textbook(kb_app, kb_client)
    kb = case.kb
    title = "Instructions for AI excluded"
    lecture = kb.notify("excluded_instruction", title, payload={"material_id": case.lecture})
    textbook = kb.notify("excluded_instruction", title, payload={"material_id": case.textbook})
    assert (await kb_client.delete(f"/kb/materials/{case.lecture}")).status_code == 200
    by_id = {item.id: item for item in kb.notifications(include_dismissed=True)}
    assert by_id[lecture.id].dismissed_at and not by_id[textbook.id].dismissed_at
    record = kb.material_repo.get(case.textbook)
    assert record is not None
    shutil.move(str(kb.library_root / record.rel_dir), str(tmp_path / "away"))
    await kb_client.post("/kb/library/rescan")
    assert {item.id: item for item in kb.notifications(include_dismissed=True)}[textbook.id].dismissed_at
