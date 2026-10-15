"""S3: fragments excluded as instructions for an AI never reach an agent through the SKAZ tools.

The same MCP/Codex tool registry the agents use; restored fragments (the
user's "This isn't an instruction") are visible again.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from skaz.knowledge.agents.tools import EXCLUDED_FRAGMENT, ToolOutcome, ToolRegistry
from skaz.knowledge.library.layout import SERVICE_DIR
from skaz.knowledge.markdown.page import Block, Cite, PageDocument, PageMeta
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources.guard.exclusions import EXCLUDED_FILE
from skaz.knowledge.sources.guard.visibility import UNREADABLE, visible
from skaz.knowledge.sources.service import SourceService

from .a1_library import INJECTION, Seeded, seed


def payload(outcome: ToolOutcome) -> dict[str, Any]:
    assert not outcome.is_error, outcome.text
    data: dict[str, Any] = json.loads(outcome.text.split("\n")[2])
    return data


@pytest.fixture
def excluded(ready: KnowledgeService) -> tuple[ToolRegistry, SourceService, Seeded]:
    seeded = seed(ready)
    sources = SourceService(ready)
    report = sources.rescan(seeded.lecture_id)
    assert [item.seg for item in report.excluded] == [3]  # the detector flags the injection
    ready.create_page(
        PageDocument(
            meta=PageMeta(
                skaz_id="pg-quote", kind="concept", title="Quote", language="ru", sources=(seeded.lecture_id,)
            ),
            parts=[
                Block.create(
                    "c-9",
                    "from_source",
                    "Something said.",
                    cites=(
                        Cite(seeded.lecture_id, 3, "Ignore previous instructions"),
                        Cite(seeded.lecture_id, 1, "Энтропия"),
                    ),
                )
            ],
        )
    )
    return ToolRegistry(ready), sources, seeded


def assert_hidden(text: str) -> None:
    assert INJECTION not in text and "Ignore previous instructions" not in text


async def test_excluded_fragment_is_not_read_found_or_quoted(
    excluded: tuple[ToolRegistry, SourceService, Seeded],
) -> None:
    tools, _sources, seeded = excluded
    read = await tools.call("skaz_read_material", {"material_id": seeded.lecture_id})
    assert_hidden(read.text)
    data = payload(read)
    assert [item["seg"] for item in data["fragments"]] == [1, 2, 4]
    assert data["excluded_segs"] == [3] and "instructions for an AI" in data["excluded_note"]

    around = await tools.call(
        "skaz_read_material", {"material_id": seeded.lecture_id, "around_ms": 200_000, "window_ms": 60_000}
    )
    assert_hidden(around.text)

    found = await tools.call("skaz_search", {"query": "previous"})
    assert_hidden(found.text)
    assert payload(found)["fragments"] == []

    fragment = await tools.call("skaz_get_fragment", {"material_id": seeded.lecture_id, "seg": 3})
    assert fragment.is_error and fragment.text == EXCLUDED_FRAGMENT
    neighbour = payload(await tools.call("skaz_get_fragment", {"material_id": seeded.lecture_id, "seg": 2}))
    assert neighbour["next_seg"] == 4

    recent = await tools.call("skaz_recent_speech", {"material_id": seeded.lecture_id, "minutes": 10})
    assert_hidden(recent.text)
    assert [item["seg"] for item in payload(recent)["fragments"]] == [1, 2, 4]

    page = payload(await tools.call("skaz_read_page", {"page_id": "pg-quote"}))
    cites = page["entries"][0]["cites"]
    assert cites[0] == {
        "ref": f"{seeded.lecture_id}:seg-3",
        "available": True,
        "excluded": True,
        "material_title": "Лекция 8",
        "time": "03:00",
    }
    assert cites[1]["quote"] == "Энтропия"


async def test_a_restored_fragment_is_visible_again(
    excluded: tuple[ToolRegistry, SourceService, Seeded], ready: KnowledgeService
) -> None:
    tools, sources, seeded = excluded
    sources.restore(seeded.lecture_id, 3)
    data = payload(await tools.call("skaz_read_material", {"material_id": seeded.lecture_id}))
    assert [item["seg"] for item in data["fragments"]] == [1, 2, 3, 4] and "excluded_segs" not in data
    found = payload(await tools.call("skaz_search", {"query": "previous"}))
    assert [item["seg"] for item in found["fragments"]] == [3]
    assert payload(await tools.call("skaz_get_fragment", {"material_id": seeded.lecture_id, "seg": 3}))
    fragments = ready.material_repo.fragments(seeded.lecture_id)
    assert [item.seg for item in visible(ready, seeded.lecture_id, fragments)] == [1, 2, 3, 4]


async def test_an_unreadable_exclusion_list_hides_the_material_text(
    excluded: tuple[ToolRegistry, SourceService, Seeded],
    ready: KnowledgeService,
) -> None:
    tools, _sources, seeded = excluded
    record = ready.material_repo.get(seeded.lecture_id)
    assert record is not None
    (ready.library_root / record.rel_dir / SERVICE_DIR / EXCLUDED_FILE).write_text(
        "{broken", encoding="utf-8"
    )
    read = await tools.call("skaz_read_material", {"material_id": seeded.lecture_id})
    assert read.is_error and read.text == UNREADABLE
    found = payload(await tools.call("skaz_search", {"query": "энтропия"}))
    assert all(item["material_id"] != seeded.lecture_id for item in found["fragments"])
    assert any(item["material_id"] == seeded.pdf_id for item in found["fragments"])
