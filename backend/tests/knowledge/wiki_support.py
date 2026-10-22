"""Test helpers for area W2: ingest + the wiki service wired as the runtime does, on ``FakeEngine``.

Fakes only at the model seam (``ScriptedWiki``) and the decision layer; never evidence of quality.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from skaz.knowledge.agents.engine import AgentTurn
from skaz.knowledge.decisions.protocol import Answer, Question
from skaz.knowledge.ingest.service import IngestService
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.service import WikiService

from .ingest_support import (
    FakeDecisions,
    PatternDetector,
    ScriptedWiki,
    add_material,
    block,
    cite,
    concept,
    concepts,
    notes,
    wait_finished,
)

RECOGNITION = "skaz_recognition_check"
DISCREPANCIES = "skaz_discrepancies"
CONNECTIONS = "skaz_connections"
OVERVIEW = "skaz_folder_overview"
RECHECK = "skaz_recheck"
ENTROPY_TITLE = "Энтропия (entropy)"


# -- connection batches (C1-a): read the prompt the way an authored agent does -----------------


@dataclass
class Batch:
    prompt: str
    pages: dict[int, str] = field(default_factory=dict)
    #: pair number → (first page title, second page title)
    pairs: dict[int, tuple[str, str]] = field(default_factory=dict)
    #: statement number → (page title, statement line)
    statements: dict[int, tuple[str, str]] = field(default_factory=dict)

    @classmethod
    def read(cls, prompt: str) -> Batch:
        batch = cls(prompt)
        page: str | None = None
        for line in prompt.splitlines():
            if header := re.match(r"^Page (\d+): (.+)$", line):
                batch.pages[int(header[1])] = header[2]
                page = header[2]
            elif pair := re.match(r"^Pair (\d+): page (\d+) — page (\d+)$", line):
                batch.pairs[int(pair[1])] = (batch.pages[int(pair[2])], batch.pages[int(pair[3])])
            elif (statement := re.match(r"^\[(\d+)\] (.*)$", line)) and page is not None:
                batch.statements[int(statement[1])] = (page, statement[2])
        return batch

    def unordered(self) -> set[frozenset[str]]:
        return {frozenset(pair) for pair in self.pairs.values()}

    def number(self, title: str, words: str) -> int:
        return next(n for n, (page, line) in self.statements.items() if page == title and words in line)

    def connect(self, a: str, b: str, words_a: str, words_b: str, text: str) -> dict[str, Any] | None:
        for number, (first, second) in self.pairs.items():
            if {first, second} == {a, b}:
                ours = {a: words_a, b: words_b}
                return {"pair": number, "text": text,
                        "first_side": [self.number(first, ours[first])],
                        "second_side": [self.number(second, ours[second])]}
        return None


def forget_connection_checks(kb: KnowledgeService) -> None:
    """As in a library from before C1-a: no pair remembered as checked, so the next run asks again.

    The connection run after ingest already checked every pair (its answer was the scripted empty
    list); a test of what one explicit run writes starts from here.
    """
    with kb.db.write() as connection:
        connection.execute("DELETE FROM wiki_connection_checks")


def connecting(*wanted: tuple[str, str, str, str, str]) -> Callable[[AgentTurn], str]:
    """A queued connection answer authored from the batch it gets: ``(page a, page b, words of a's
    statement, words of b's statement, text)`` for every pair of the batch it should connect."""

    def answer(turn: AgentTurn) -> str:
        batch = Batch.read(turn.messages[0].content)
        found = [item for args in wanted if (item := batch.connect(*args)) is not None]
        return json.dumps({"connections": found}, ensure_ascii=False)

    return answer


def wired(
    kb: KnowledgeService,
    wiki: ScriptedWiki,
    answer: Callable[[Question], Answer] | None = None,
    runtime: Any = None,
) -> tuple[IngestService, WikiService]:
    """Fresh services on ``kb``, or (``runtime``) the app's own, with the fakes put in their seams."""
    decisions = FakeDecisions(answer) if answer is not None else None
    if runtime is not None:
        runtime.kb_ingest.engines = lambda _engine_id: wiki.engine
        runtime.kb_ingest.detector = PatternDetector()
        runtime.kb_ingest.decisions = decisions
        return runtime.kb_ingest, runtime.kb_wiki
    ingest = IngestService(
        kb, engines=lambda _engine_id: wiki.engine, detector=PatternDetector(),
        decisions=decisions,  # type: ignore[arg-type]
    )
    service = WikiService(kb, ingest)
    service.connect()
    return ingest, service


def correction(seg: int, before: str, after: str, reason: str = "misheard") -> dict[str, Any]:
    return {"seg": seg, "before": before, "after": after, "reason": reason}


def corrections(*items: dict[str, Any]) -> str:
    return json.dumps({"corrections": list(items)}, ensure_ascii=False)


async def ingest_done(ingest: IngestService, material_id: str) -> str:
    job = await ingest.request_ingest(material_id)
    record = await wait_finished(ingest, job.id)
    assert record.state == "done", (record.state, record.error, record.journal)
    return job.id


async def settle_wiki(service: WikiService, ingest: IngestService) -> None:
    """Wait for the jobs ingest started around the new source (overview, connections)."""
    for _ in range(500):
        if not service.busy and not ingest.active_jobs():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("wiki jobs did not finish")


# -- two sources on one concept page ---------------------------------------------------

TEXTBOOK = [
    FragmentInput(text="Энтропия изолированной системы со временем убывает."),
    FragmentInput(text="Энтропия измеряется в джоулях на кельвин."),
]
LECTURE_NOTES = notes(
    (
        "Энтропия",
        [
            block("from_source", "Энтропия — мера беспорядка.", cite(1, "мера беспорядка системы")),
            block(
                "from_source",
                "При росте температуры энтропия газа растёт.",
                cite(3, "энтропия газа тоже растёт"),
            ),
        ],
    )
)
LECTURE_CONCEPTS = concepts(
    concept(
        "Энтропия",
        "entropy",
        [
            block(
                "from_source", "Мера беспорядка системы.", cite(1, "Энтропия — это мера беспорядка системы.")
            ),
            block(
                "from_source", "Энтропия газа растёт с температурой.", cite(3, "энтропия газа тоже растёт")
            ),
        ],
        related=["Температура"],
    ),
    concept(
        "Температура",
        None,
        [
            block(
                "from_source", "Показывает энергию частиц.", cite(2, "среднюю кинетическую энергию частиц")
            ),
        ],
    ),
)
TEXTBOOK_NOTES = notes(
    (
        "Энтропия",
        [
            block(
                "from_source",
                "Энтропия изолированной системы убывает.",
                cite(1, "Энтропия изолированной системы со временем убывает."),
            ),
        ],
    )
)
TEXTBOOK_CONCEPTS = concepts(
    concept(
        "Энтропия",
        "entropy",
        [
            block(
                "from_source",
                "Энтропия изолированной системы убывает.",
                cite(1, "Энтропия изолированной системы со временем убывает."),
            ),
            block(
                "from_source",
                "Единица измерения — джоуль на кельвин.",
                cite(2, "измеряется в джоулях на кельвин"),
            ),
        ],
    )
)
#: New statements are numbered first (the textbook's two), then the lecture's existing ones (3, 4).
CONFLICT = json.dumps(
    {"conflicts": [{"new": 1, "existing": 4, "explanation": "Одна говорит о росте, другая об убывании."}]},
    ensure_ascii=False,
)


@dataclass
class TwoSources:
    ingest: IngestService
    service: WikiService
    wiki: ScriptedWiki
    lecture: str
    textbook: str

    @property
    def kb(self) -> KnowledgeService:
        return self.service.kb

    def concept_id(self, title: str) -> str:
        return next(page.id for page in self.kb.pages(kind="concept") if page.title == title)

    def note_id(self, material_id: str) -> str:
        return next(page.id for page in self.kb.pages(kind="note") if page.sources == (material_id,))


async def two_sources(
    kb: KnowledgeService,
    *,
    conflict: bool = True,
    answer: Callable[[Question], Answer] | None = None,
    runtime: Any = None,
) -> TwoSources:
    """A lecture (Physics) and a textbook (Chemistry) both on "Энтропия (entropy)"; optionally disagreeing."""
    wiki = ScriptedWiki(
        notes=[LECTURE_NOTES, TEXTBOOK_NOTES], concepts=[LECTURE_CONCEPTS, TEXTBOOK_CONCEPTS], matches=[1]
    )
    ingest, service = wired(kb, wiki, answer, runtime)
    lecture = add_material(kb, "Физика", "Лекция 8")
    await ingest_done(ingest, lecture)
    await settle_wiki(service, ingest)
    textbook = add_material(kb, "Химия", "Учебник", TEXTBOOK, kind="book")
    if conflict:
        wiki.queues.setdefault(DISCREPANCIES, []).append(CONFLICT)
    await ingest_done(ingest, textbook)
    await settle_wiki(service, ingest)
    return TwoSources(ingest, service, wiki, lecture, textbook)
