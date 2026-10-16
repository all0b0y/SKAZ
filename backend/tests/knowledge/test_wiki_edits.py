"""Editing pages, recheck, outside edits, deleting and moving a material (decisions 6, 7, 21, 22)."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.markdown.page import Block, Cite, parse_page, render_page
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources.guard.exclusions import ExcludedFragment, ExclusionFile, FragmentLocation
from skaz.knowledge.wiki.delete import StillRecording

from .ingest_support import wait_finished
from .wiki_support import (
    ENTROPY_TITLE,
    LECTURE_CONCEPTS,
    LECTURE_NOTES,
    RECHECK,
    TwoSources,
    two_sources,
)

#: A citation link ``[[Materials/…#^seg-N|…]]`` in a block body.
CITE_LINK = re.compile(r"\[\[Materials/[^\]]+\]\]")


def page_file(kb: KnowledgeService, page_id: str) -> Path:
    record = kb.page_repo.get(page_id)
    assert record is not None
    return kb.library_root / record.rel_path


def blocks(kb: KnowledgeService, page_id: str) -> dict[str, Any]:
    return {block.id: block for block in parse_page(page_file(kb, page_id).read_text("utf-8")).blocks()}


def statement(kb: KnowledgeService, page_id: str, needle: str) -> Any:
    return next(block for block in blocks(kb, page_id).values() if needle in block.body)


async def lecture_and_textbook(
    kb_app: Any, kb_client: httpx.AsyncClient, *, conflict: bool = False
) -> TwoSources:
    assert (await kb_client.post("/kb/library", json={})).json()["state"] == "ready"
    return await two_sources(kb_app.state.runtime.kb, conflict=conflict, runtime=kb_app.state.runtime)


# -- editing ------------------------------------------------------------------------------


async def test_editing_an_agent_block_makes_it_the_users(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    page_id = case.concept_id(ENTROPY_TITLE)
    target = statement(case.kb, page_id, "газа растёт")
    response = await kb_client.put(
        f"/kb/wiki/pages/{page_id}/blocks/{target.id}",
        json={"text": "Энтропия газа растёт при нагреве (моя формулировка)."},
    )
    assert response.status_code == 200
    edited = next(block for block in response.json()["blocks"] if block["id"] == target.id)
    assert edited["owner"] == "user_edited" and edited["kind"] == "from_source"
    assert edited["text"].startswith("Энтропия газа растёт при нагреве (моя формулировка).")
    # The sources stay attached: the citation links are kept with the user's text.
    assert edited["citations"] and edited["citations"][0]["material_id"] == case.lecture
    on_disk = blocks(case.kb, page_id)[target.id]
    assert on_disk.owner == "user_edited"

    # Refreshing the source never rewrites it.
    case.wiki.queues["skaz_ingest_notes"].append(LECTURE_NOTES)
    case.wiki.queues["skaz_ingest_concepts"].append(LECTURE_CONCEPTS)
    refresh = await case.ingest.request_ingest(case.lecture, kind="refresh")
    assert (await wait_finished(case.ingest, refresh.id)).state == "done"
    after = blocks(case.kb, page_id)[target.id]
    assert after.owner == "user_edited" and "моя формулировка" in after.body


async def test_notes_add_and_delete_and_protected_blocks(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    page_id = case.concept_id(ENTROPY_TITLE)
    target = statement(case.kb, page_id, "газа растёт")
    after = await kb_client.post(
        f"/kb/wiki/pages/{page_id}/blocks",
        json={"text": "Проверить на семинаре.", "after_block_id": target.id},
    )
    assert after.status_code == 201
    ids = [block["id"] for block in after.json()["blocks"]]
    note_id = ids[ids.index(target.id) + 1]
    note = after.json()["blocks"][ids.index(note_id)]
    assert (
        note["kind"] == "user_note" and note["owner"] == "user" and note["text"] == "Проверить на семинаре."
    )

    mine = await kb_client.post(f"/kb/wiki/pages/{page_id}/blocks", json={"text": "Вопрос к лектору."})
    assert mine.status_code == 201
    text = page_file(case.kb, page_id).read_text("utf-8")
    assert "Вопрос к лектору." in text.split("## My notes", 1)[1]

    invalid = await kb_client.post(f"/kb/wiki/pages/{page_id}/blocks", json={"text": "## Заголовок"})
    assert invalid.status_code == 422
    # Two paragraphs make two notes (QA C15); one block still holds one paragraph (test_f3_wiki_low).
    two_paragraphs = await kb_client.post(f"/kb/wiki/pages/{page_id}/blocks", json={"text": "Раз.\n\nДва."})
    assert two_paragraphs.status_code == 201
    missing = await kb_client.post(
        f"/kb/wiki/pages/{page_id}/blocks", json={"text": "Текст.", "after_block_id": "c-nope"}
    )
    assert missing.status_code == 404

    # The agent's statements can't be deleted; the user's own note can.
    protected = await kb_client.delete(f"/kb/wiki/pages/{page_id}/blocks/{target.id}")
    assert protected.status_code == 409
    deleted = await kb_client.delete(f"/kb/wiki/pages/{page_id}/blocks/{note_id}")
    assert deleted.status_code == 200 and note_id not in [block["id"] for block in deleted.json()["blocks"]]
    assert (await kb_client.delete(f"/kb/wiki/pages/{page_id}/blocks/{note_id}")).status_code == 404
    assert (
        await kb_client.put("/kb/wiki/pages/pg-missing/blocks/c-x", json={"text": "x"})
    ).status_code == 404


async def test_an_unmarked_paragraph_written_outside_skaz_is_the_users(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    page_id = case.concept_id(ENTROPY_TITLE)
    path = page_file(case.kb, page_id)
    path.write_text(path.read_text("utf-8").rstrip("\n") + "\n\nАбзац, написанный в Obsidian.\n", "utf-8")
    page = (await kb_client.get(f"/kb/wiki/pages/{page_id}")).json()  # re-read on open
    [unmarked] = [block for block in page["blocks"] if not block["marked"]]
    assert unmarked["id"].startswith("u-") and unmarked["owner"] == "user"
    updated = await kb_client.put(
        f"/kb/wiki/pages/{page_id}/blocks/{unmarked['id']}", json={"text": "Абзац, поправленный в SKAZ."}
    )
    assert updated.status_code == 200
    assert "Абзац, поправленный в SKAZ." in path.read_text("utf-8")
    assert "Абзац, написанный в Obsidian." not in path.read_text("utf-8")


# -- recheck ---------------------------------------------------------------------------------


async def test_recheck_rewrites_from_the_sources_and_returns_the_block_to_the_agent(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    page_id = case.concept_id(ENTROPY_TITLE)
    target = statement(case.kb, page_id, "газа растёт")
    await kb_client.put(f"/kb/wiki/pages/{page_id}/blocks/{target.id}", json={"text": "Моя версия."})

    case.wiki.queues.setdefault(RECHECK, []).append(
        json.dumps(
            {
                "text": "С ростом температуры энтропия газа растёт.",
                "cites": [{"source": 1, "seg": 3, "quote": "энтропия газа тоже растёт"}],
            },
            ensure_ascii=False,
        )
    )
    started = await kb_client.post(f"/kb/wiki/pages/{page_id}/blocks/{target.id}/recheck")
    assert started.status_code == 202 and started.json()["kind"] == "recheck"
    job_id = started.json()["id"]
    await case.service.jobs.wait(job_id)
    finished = (await kb_client.get(f"/kb/jobs/{job_id}")).json()
    assert finished["state"] == "done", finished
    after = blocks(case.kb, page_id)[target.id]
    assert after.owner == "agent" and after.kind == "from_source"
    assert after.body.startswith("С ростом температуры энтропия газа растёт.")
    assert [(cite.material_id, cite.seg) for cite in after.cites] == [(case.lecture, 3)]
    [turn] = case.wiki.turns(RECHECK)
    assert turn.tools is None and "Моя версия." in turn.messages[0].content


async def test_a_recheck_that_fails_the_source_check_leaves_the_block(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    page_id = case.concept_id(ENTROPY_TITLE)
    target = statement(case.kb, page_id, "газа растёт")
    before = page_file(case.kb, page_id).read_text("utf-8")
    case.wiki.queues.setdefault(RECHECK, []).append(
        json.dumps(
            {
                "text": "Выдуманное утверждение.",
                "cites": [{"source": 1, "seg": 3, "quote": "такого нет в источнике"}],
            },
            ensure_ascii=False,
        )
    )
    job = (await kb_client.post(f"/kb/wiki/pages/{page_id}/blocks/{target.id}/recheck")).json()
    await case.service.jobs.wait(job["id"])
    failed = (await kb_client.get(f"/kb/jobs/{job['id']}")).json()
    assert failed["state"] == "failed" and "left as it was" in failed["error"]
    assert page_file(case.kb, page_id).read_text("utf-8") == before

    note = (await kb_client.post(f"/kb/wiki/pages/{page_id}/blocks", json={"text": "Моё."})).json()
    note_id = next(block["id"] for block in note["blocks"] if block["kind"] == "user_note")
    refused = await kb_client.post(f"/kb/wiki/pages/{page_id}/blocks/{note_id}/recheck")
    assert refused.status_code == 409


def exclude(kb: KnowledgeService, material_id: str, seg: int) -> None:
    """Mark ``seg`` as an instruction kept out of processing (S1's ``excluded.json``)."""
    record = kb.material_repo.get(material_id)
    assert record is not None
    item = ExcludedFragment(seg=seg, text_hash="h", reason="Instruction for an AI", rules=["ignore"],
                            score=1.0, found="…", location=FragmentLocation(start_ms=0),
                            detected_at="2026-10-15T00:00:00Z")
    path = kb.library_root / record.rel_dir / ".skaz" / "excluded.json"
    path.write_text(ExclusionFile(excluded=[item]).model_dump_json(), encoding="utf-8")


async def test_a_recheck_never_sends_or_accepts_an_excluded_fragment(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    """Poisoning layer 3: a fragment excluded as an instruction is not a source for the recheck either."""
    case = await lecture_and_textbook(kb_app, kb_client)
    page_id = case.concept_id(ENTROPY_TITLE)
    target = statement(case.kb, page_id, "газа растёт")
    path = page_file(case.kb, page_id)
    document = parse_page(path.read_text("utf-8"))
    wider = Block.create(target.id, target.kind, target.body, owner=target.owner,
                         cites=(*target.cites, Cite(case.lecture, 1, "мера беспорядка системы")))
    path.write_text(render_page(document.with_block(wider)), encoding="utf-8")
    exclude(case.kb, case.lecture, 3)
    before = path.read_text("utf-8")

    case.wiki.queues.setdefault(RECHECK, []).append(json.dumps(
        {"text": "Энтропия газа растёт.",
         "cites": [{"source": 1, "seg": 3, "quote": "энтропия газа тоже растёт"}]},
        ensure_ascii=False,
    ))
    job = (await kb_client.post(f"/kb/wiki/pages/{page_id}/blocks/{target.id}/recheck")).json()
    await case.service.jobs.wait(job["id"])
    failed = (await kb_client.get(f"/kb/jobs/{job['id']}")).json()
    [turn] = case.wiki.turns(RECHECK)
    sent = " ".join(message.content for message in turn.messages)
    assert "Если температура растёт" not in sent and "[seg-3]" not in sent
    assert "мера беспорядка системы" in sent
    # A quote from the excluded fragment is not accepted: nothing else was cited, so nothing is written.
    assert failed["state"] == "failed" and "left as it was" in failed["error"]
    assert path.read_text("utf-8") == before


async def test_a_recheck_whose_only_source_is_excluded_is_refused(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    page_id = case.concept_id(ENTROPY_TITLE)
    target = statement(case.kb, page_id, "газа растёт")
    assert {cite.seg for cite in target.cites} == {3}
    exclude(case.kb, case.lecture, 3)
    job = (await kb_client.post(f"/kb/wiki/pages/{page_id}/blocks/{target.id}/recheck")).json()
    await case.service.jobs.wait(job["id"])
    failed = (await kb_client.get(f"/kb/jobs/{job['id']}")).json()
    assert failed["state"] == "failed" and "excluded" in failed["error"]
    assert case.wiki.turns(RECHECK) == []


# -- outside edits ------------------------------------------------------------------------------


async def test_the_watcher_reindexes_outside_edits(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    watcher = case.service.watcher
    assert watcher.poll() == 0  # the first tick only takes a snapshot
    page_id = case.concept_id(ENTROPY_TITLE)
    path = page_file(case.kb, page_id)
    path.write_text(path.read_text("utf-8").rstrip("\n") + "\n\nСтранный факт из Obsidian.\n", "utf-8")
    assert watcher.poll() == 1
    hits = case.kb.search("Странный факт из Obsidian", limit=5).blocks
    assert [hit.page_id for hit in hits] == [page_id]
    note = page_file(case.kb, case.note_id(case.textbook))
    note.unlink()
    assert watcher.poll() == 1 and case.kb.page_repo.get(case.note_id(case.lecture)) is not None
    assert all(page.rel_path != "Wiki/Notes/Учебник.md" for page in case.kb.pages())

    rescanned = await kb_client.post("/kb/library/rescan")
    assert rescanned.status_code == 200 and rescanned.json() == {"pages_changed": 0}


# -- deleting a material ---------------------------------------------------------------------------


async def test_delete_preview_matches_what_delete_does(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    entropy, temperature = case.concept_id(ENTROPY_TITLE), case.concept_id("Температура")
    # A user note on the concept page: never touched.
    await kb_client.post(f"/kb/wiki/pages/{entropy}/blocks", json={"text": "Моя заметка про энтропию."})
    note_before = case.note_id(case.lecture)

    preview = (await kb_client.get(f"/kb/materials/{case.lecture}/delete-preview")).json()
    assert preview["material_id"] == case.lecture and preview["title"] == "Лекция 8"
    removed = {ref["id"] for ref in preview["pages_removed"]}
    changed = {ref["id"] for ref in preview["pages_changed"]}
    # Notes of the lecture and "Температура" rest only on it: removed. "Энтропия" keeps the textbook.
    assert removed == {note_before, temperature} and changed == {entropy}
    assert preview["user_notes_kept"] == 1 and preview["claims_kept"] == 0
    assert preview["claims_removed"] >= 3
    # Nothing changed yet.
    assert case.kb.material_repo.get(case.lecture) is not None

    deleted = await kb_client.delete(f"/kb/materials/{case.lecture}")
    assert deleted.status_code == 200 and deleted.json() == preview
    assert case.kb.material_repo.get(case.lecture) is None
    assert not (case.kb.library_root / "Materials" / "Физика" / "Лекция 8").exists()
    assert case.kb.page_repo.get(temperature) is None and case.kb.page_repo.get(note_before) is None
    text = page_file(case.kb, entropy).read_text("utf-8")
    assert "Моя заметка про энтропию." in text
    assert "изолированной системы убывает" in text and "газа растёт" not in text
    assert case.lecture not in text  # no citation markers of the deleted source left
    assert "Лекция 8" in (case.kb.library_root / "Wiki" / "log.md").read_text("utf-8")
    assert (await kb_client.get(f"/kb/materials/{case.lecture}/delete-preview")).status_code == 404


async def test_a_statement_confirmed_by_another_source_only_loses_the_citation(
    ready: KnowledgeService,
) -> None:
    case = await two_sources(ready, conflict=False)
    entropy = case.concept_id(ENTROPY_TITLE)
    # One statement cites both sources (as a merge of two sources writes it): it rests on the textbook too.
    path = page_file(ready, entropy)
    document = parse_page(path.read_text("utf-8"))
    target = next(block for block in document.blocks() if "Мера беспорядка системы." in block.body)
    other = next(block for block in document.blocks() if "джоуль на кельвин" in block.body)
    links = CITE_LINK.findall(other.body)
    merged = replace(
        target, cites=(*target.cites, *other.cites), raw=None, body=" ".join([target.body, *links])
    )
    path.write_text(render_page(document.with_block(merged.remarked())), "utf-8")
    case.service.rescan()

    plan = case.service.delete_preview(case.lecture)
    assert plan.claims_kept == 1
    case.service.delete_material(case.lecture)
    kept = blocks(ready, entropy)[target.id]
    assert kept.owner == "agent" and {cite.material_id for cite in kept.cites} == {case.textbook}
    assert "Лекция 8" not in kept.body and "Учебник" in kept.body


async def test_delete_is_refused_while_the_material_is_recording(ready: KnowledgeService) -> None:
    case = await two_sources(ready, conflict=False)
    with ready.db.write() as connection:
        connection.execute("UPDATE materials SET status = 'recording' WHERE id = ?", (case.lecture,))
    with pytest.raises(StillRecording):
        case.service.delete_material(case.lecture)
    assert ready.material_repo.get(case.lecture) is not None


# -- rename and move ---------------------------------------------------------------------------------


async def test_rename_and_move_keep_every_link(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    entropy = case.concept_id(ENTROPY_TITLE)
    chemistry = next(folder.id for folder in case.kb.folders() if folder.name == "Химия")

    renamed = await kb_client.patch(f"/kb/materials/{case.lecture}", json={"title": "Лекция 8 — энтропия"})
    assert renamed.status_code == 200 and renamed.json()["title"] == "Лекция 8 — энтропия"
    root = case.kb.library_root
    assert (root / "Materials" / "Физика" / "Лекция 8 — энтропия" / "Лекция 8 — энтропия.md").exists()
    assert not (root / "Materials" / "Физика" / "Лекция 8").exists()
    text = page_file(case.kb, entropy).read_text("utf-8")
    assert "Materials/Физика/Лекция 8 — энтропия/Лекция 8 — энтропия" in text
    assert "Materials/Физика/Лекция 8/" not in text
    # The Notes page follows the title.
    assert page_file(case.kb, case.note_id(case.lecture)).name == "Лекция 8 — энтропия.md"

    moved = await kb_client.patch(f"/kb/materials/{case.lecture}", json={"folder_id": chemistry})
    assert moved.status_code == 200 and moved.json()["folder_id"] == chemistry
    text = page_file(case.kb, entropy).read_text("utf-8")
    assert "Materials/Химия/Лекция 8 — энтропия/Лекция 8 — энтропия" in text
    citations = [
        cite
        for block in (await kb_client.get(f"/kb/wiki/pages/{entropy}")).json()["blocks"]
        for cite in block["citations"]
        if cite["material_id"] == case.lecture
    ]
    assert citations and all(cite["available"] for cite in citations)

    taken = await kb_client.patch(f"/kb/materials/{case.lecture}", json={"title": "Учебник"})
    assert taken.status_code == 409
    assert (root / "Materials" / "Химия" / "Лекция 8 — энтропия").exists()  # nothing half-done
    assert (
        await kb_client.patch(f"/kb/materials/{case.lecture}", json={"folder_id": "fld-x"})
    ).status_code == 404
    assert (await kb_client.patch(f"/kb/materials/{case.lecture}", json={"oops": 1})).status_code == 422
