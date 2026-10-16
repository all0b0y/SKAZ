"""QA 16.10 C7: a concept page that lost every source in a rewrite goes; one the user wrote on stays."""

from __future__ import annotations

from pathlib import Path

from skaz.knowledge.service import KnowledgeService

from .ingest_support import block, cite, concept, concepts, wait_finished
from .test_wiki_edits import page_file
from .wiki_support import ENTROPY_TITLE, LECTURE_NOTES, TwoSources, two_sources

ONLY_ENTROPY = concepts(
    concept(
        "Энтропия",
        "entropy",
        [block("from_source", "Мера беспорядка системы.",
               cite(1, "Энтропия — это мера беспорядка системы."))],
    )
)


async def _without_temperature(ready: KnowledgeService) -> tuple[TwoSources, str, Path]:
    """The lecture is read again and this time names no "Температура" — its only source."""
    case = await two_sources(ready, conflict=False)
    temperature = case.concept_id("Температура")
    path = page_file(ready, temperature)
    case.wiki.queues["skaz_ingest_notes"].append(LECTURE_NOTES)
    case.wiki.queues["skaz_ingest_concepts"].append(ONLY_ENTROPY)
    return case, temperature, path


async def _refresh(case: TwoSources) -> None:
    job = await case.ingest.request_ingest(case.lecture, kind="refresh")
    record = await wait_finished(case.ingest, job.id)
    assert record.state == "done", record.error


async def test_a_concept_left_without_any_source_is_removed_by_the_rewrite(ready: KnowledgeService) -> None:
    case, temperature, path = await _without_temperature(ready)
    await _refresh(case)
    assert ready.page_repo.get(temperature) is None and not path.exists()
    assert ready.page_repo.get(case.concept_id(ENTROPY_TITLE)) is not None
    log = (ready.library_root / "Wiki" / "log.md").read_text("utf-8")
    assert "concepts left without a source removed: Температура" in log


async def test_a_concept_the_user_wrote_on_stays(ready: KnowledgeService) -> None:
    case, temperature, path = await _without_temperature(ready)
    case.service.add_note(temperature, "Моя заметка о температуре.", after_block_id=None, section=None)
    await _refresh(case)
    assert ready.page_repo.get(temperature) is not None and path.exists()
