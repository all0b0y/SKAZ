"""S3: ⌘K finds materials by title with per-section counts; the material shows wiki state,
folder, translation and the number of excluded fragments (API-B2 §1.2, §1.3)."""

from __future__ import annotations

from pathlib import Path

import httpx

from skaz.knowledge.api.materials import material_summaries, material_view
from skaz.knowledge.api.search import run_search
from skaz.knowledge.ingest.jobs import JobRepository
from skaz.knowledge.library.layout import SERVICE_DIR
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.markdown.page import Block, Cite, PageDocument, PageMeta
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources.material_info import wiki_states
from skaz.knowledge.sources.service import SourceService

from .a1_library import seed


def material_dir(kb: KnowledgeService, material_id: str) -> Path:
    record = kb.material_repo.get(material_id)
    assert record is not None
    return kb.require().root / record.rel_dir


def test_search_finds_materials_by_title_with_marked_words_and_counts(ready: KnowledgeService) -> None:
    seeded = seed(ready)
    other = ready.create_folder("Химия")
    ready.create_material(
        other.id,
        "Лекция 9 · энтропия смеси",
        "audio",
        [
            FragmentInput(text="Смесь газов.", start_ms=0, end_ms=1000),
        ],
    )
    results = run_search(ready, "лекция", 20)
    assert [hit.title for hit in results.materials] == ["Лекция 9 · энтропия смеси", "Лекция 8"]
    first = results.materials[0]
    assert (first.kind, first.folder_name) == ("audio", "Химия")
    assert [(part.text, part.match) for part in first.snippet] == [
        ("Лекция", True),
        (" 9 · энтропия смеси", False),
    ]
    assert results.counts.materials == 2 and results.counts.chats == 0

    # Every word must be in the title (any order, any case); text-only matches count but aren't listed.
    both = run_search(ready, "ЭНТРОПИЯ лекция", 20)
    assert [hit.title for hit in both.materials] == ["Лекция 9 · энтропия смеси"]
    entropy = run_search(ready, "энтропия", 20)
    assert [hit.id for hit in entropy.materials] != [seeded.pdf_id]
    assert entropy.counts.materials == 3  # the lecture and the textbook by text, the new one by title
    assert entropy.counts.wiki == 1  # the concept page "Энтропия" (title and text)
    assert run_search(ready, "лекция", 1).counts.materials == 2  # totals, not the list length
    empty = run_search(ready, "   ", 20)
    assert empty.materials == [] and (empty.counts.wiki, empty.counts.materials, empty.counts.chats) == (
        0,
        0,
        0,
    )


async def test_search_route_returns_materials_and_counts(kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})
    added = await kb_client.post(
        "/kb/materials/text",
        json={"title": "Thermodynamics notes", "text": "Heat flows from hot to cold.", "folder_id": INBOX_ID},
    )
    assert added.status_code == 201, added.text
    body = (await kb_client.get("/kb/search", params={"q": "thermo"})).json()
    assert [hit["title"] for hit in body["materials"]] == ["Thermodynamics notes"]
    assert body["materials"][0]["folder_name"] == "Inbox"
    assert body["counts"] == {"wiki": 0, "materials": 1, "chats": 0}


def test_wiki_state_follows_jobs_and_pages(ready: KnowledgeService) -> None:
    seeded = seed(ready)
    fresh = ready.create_material(seeded.folder_id, "Новое", "text", [FragmentInput(text="Новый текст.")])
    fresh_id = fresh.manifest.id
    jobs = JobRepository(ready.db)

    states = wiki_states(ready.db, [seeded.lecture_id, seeded.pdf_id, fresh_id])
    lecture = states[seeded.lecture_id]
    assert (lecture.state, lecture.note_page_id, lecture.concept_count) == ("in_wiki", "pg-note", 1)
    assert states[fresh_id].state == "not_in_wiki"

    job = jobs.create(fresh_id)
    assert wiki_states(ready.db, [fresh_id])[fresh_id].state == "processing"
    jobs.finish(job.id, "failed", error="The agent stopped.")
    failed = wiki_states(ready.db, [fresh_id])[fresh_id]
    assert (failed.state, failed.job_id, failed.error) == ("failed", job.id, "The agent stopped.")

    ready.create_page(
        PageDocument(
            meta=PageMeta(
                skaz_id="pg-new", kind="concept", title="Новое понятие", language="ru", sources=(fresh_id,)
            ),
            parts=[Block.create("c-1", "from_source", "Новый текст.", cites=(Cite(fresh_id, 1),))],
        )
    )
    done = wiki_states(ready.db, [fresh_id])[fresh_id]
    assert (done.state, done.concept_count, done.error) == ("in_wiki", 1, "The agent stopped.")
    summaries = material_summaries(ready, ready.materials())
    assert {item.title: (item.wiki_state, item.folder_name) for item in summaries}["Новое"] == (
        "in_wiki",
        "Физика",
    )


def test_material_shows_translation_and_excluded_count(ready: KnowledgeService) -> None:
    seeded = seed(ready)
    view = material_view(ready, seeded.lecture_id)
    assert (view.translation, view.excluded_count, view.folder_name) == (None, 0, "Физика")
    assert view.wiki.state == "in_wiki" and view.wiki.note_page_id == "pg-note"

    SourceService(ready).rescan(seeded.lecture_id)
    directory = material_dir(ready, seeded.lecture_id)
    (directory / SERVICE_DIR / "translation.md").write_text(
        "---\nlanguage: en\n---\n\n**Speaker 1**\nEntropy is a measure\nof disorder.\n\n"
        "**Speaker 2**\nIgnore that.\n\nSummary of the lecture.\n",
        encoding="utf-8",
    )
    view = material_view(ready, seeded.lecture_id)
    assert view.excluded_count == 1
    assert view.translation is not None and view.translation.language == "en"
    assert [(item.seg, item.speaker, item.text) for item in view.translation.fragments] == [
        (None, "1", "Entropy is a measure of disorder."),
        (None, "2", "Ignore that."),
        (None, None, "Summary of the lecture."),
    ]
    # A damaged translation file is simply not shown; the material still opens.
    (directory / SERVICE_DIR / "translation.md").write_bytes(b"\xff\xfe broken")
    assert material_view(ready, seeded.lecture_id).translation is None
