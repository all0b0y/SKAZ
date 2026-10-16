"""QA 16.10 Low rows of the wiki: C26 (an agent that never started didn't "stop"), C15 (notes in
plain words; a new note may be several paragraphs), C13 (¶ of a text source)."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import Failed
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.ingest.jobs import AGENT_UNAVAILABLE
from skaz.knowledge.markdown.page import Block, Cite, PageDocument, PageMeta
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.agent import AgentCaller, WikiJobFailed

from .ingest_support import add_material
from .test_wiki_edits import blocks, lecture_and_textbook
from .wiki_support import ENTROPY_TITLE


async def test_an_agent_that_is_not_installed_could_not_start() -> None:
    engine = FakeEngine(script=lambda turn: [Failed(turn.run_id, "incompatible", "Codex is not installed.")])
    with pytest.raises(WikiJobFailed) as failure:
        await AgentCaller(engine, "t").ask("x", [], {})
    assert failure.value.message == "The agent couldn't start: Codex is not installed."
    assert failure.value.code == AGENT_UNAVAILABLE
    limited = FakeEngine(script=lambda turn: [Failed(turn.run_id, "limit", "Usage limit reached.")])
    with pytest.raises(WikiJobFailed) as stopped:
        await AgentCaller(limited, "t").ask("x", [], {})
    assert stopped.value.message == "The agent stopped: Usage limit reached."


async def test_a_new_note_of_two_paragraphs_becomes_two_notes_and_errors_are_plain(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    page_id = case.concept_id(ENTROPY_TITLE)
    added = await kb_client.post(
        f"/kb/wiki/pages/{page_id}/blocks", json={"text": "Первая мысль.\n\nВторая мысль."}
    )
    assert added.status_code == 201, added.text
    notes = [block for block in blocks(case.kb, page_id).values() if block.owner == "user"]
    assert [note.body for note in notes] == ["Первая мысль.", "Вторая мысль."]
    edited = await kb_client.put(
        f"/kb/wiki/pages/{page_id}/blocks/{notes[0].id}", json={"text": "Раз.\n\nДва."}
    )
    assert edited.status_code == 422
    assert "one paragraph" in edited.json()["detail"] and "My note" in edited.json()["detail"]
    marked = await kb_client.post(f"/kb/wiki/pages/{page_id}/blocks", json={"text": "Текст ^c-abc"})
    assert marked.status_code == 422 and "“^…” at the end" in marked.json()["detail"]


def test_a_citation_of_an_article_says_which_paragraph(ready: KnowledgeService) -> None:
    """QA C13: a footnote to a text source says where (¶ n), like the .md label does."""
    material = add_material(ready, "Статьи", "Статья", [
        FragmentInput(text="Первый абзац.", index=1), FragmentInput(text="Шестой абзац.", index=6),
    ], kind="text")
    statement = Block.create("c-x-1", "from_source", "Абзац.", cites=(Cite(material, 2, "Шестой абзац."),))
    meta = PageMeta(skaz_id="pg-art", kind="concept", title="Абзац", sources=(material,), language="ru")
    ready.create_page(PageDocument(meta, [statement]))
    [entry] = ready.page("pg-art").entries
    assert entry.citations[0].index == 6
