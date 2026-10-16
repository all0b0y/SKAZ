"""Test doubles for ingest. Fakes at the external seams only — never evidence of model quality.

``PatternDetector`` is a stand-in for the S1 instruction detector (a few explicit
patterns); the orchestrator wires the real one.
"""
from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from skaz.knowledge.agents.engine import AgentTurn, Completed, TextDelta
from skaz.knowledge.agents.fake import FakeEngine, Gate, ScriptItem
from skaz.knowledge.decisions.protocol import Answer, Question
from skaz.knowledge.ingest import prompts
from skaz.knowledge.ingest.jobs import JobRecord
from skaz.knowledge.ingest.service import IngestService
from skaz.knowledge.markdown.source import FragmentInput, MaterialKind
from skaz.knowledge.service import KnowledgeService

_PATTERNS = (
    re.compile(r"ignore (all )?previous instructions", re.IGNORECASE),
    re.compile(r"игнорируй (все )?предыдущие указания", re.IGNORECASE),
    re.compile(r"(^|\s)system:", re.IGNORECASE),
    re.compile(r"you are now", re.IGNORECASE),
)


class PatternDetector:
    def __init__(self) -> None:
        self.seen: list[str] = []

    def detect(self, text: str) -> list[str]:
        self.seen.append(text)
        return [pattern.pattern for pattern in _PATTERNS if pattern.search(text)]


class FakeDecisions:
    def __init__(self, answer: Callable[[Question], Answer]) -> None:
        self._answer = answer
        self.questions: list[Question] = []

    @property
    def id(self) -> str:
        return "local"

    async def ask(self, question: Question) -> Answer:
        self.questions.append(question)
        return self._answer(question)

    async def ask_many(self, questions: Sequence[Question]) -> Sequence[Answer]:
        return [await self.ask(question) for question in questions]


def cite(seg: int, quote: str) -> dict[str, Any]:
    return {"seg": seg, "quote": quote}


def block(kind: str, text: str, *cites: dict[str, Any], links: Sequence[str] = ()) -> dict[str, Any]:
    return {"kind": kind, "text": text, "cites": list(cites), "links": list(links)}


def notes(*sections: tuple[str, list[dict[str, Any]]], more: bool = False) -> str:
    return json.dumps({"sections": [{"title": title, "blocks": blocks} for title, blocks in sections],
                       "more": more}, ensure_ascii=False)


def concept(title: str, original: str | None, blocks: list[dict[str, Any]], *, aliases: Sequence[str] = (),
            related: Sequence[str] = ()) -> dict[str, Any]:
    return {"title_in_wiki_language": title, "original": original, "aliases": list(aliases),
            "definition_blocks": blocks, "related": list(related)}


def concepts(*items: dict[str, Any], more: bool = False) -> str:
    return json.dumps({"concepts": list(items), "more": more}, ensure_ascii=False)


#: "Nothing found" for the W2 calls, so ingest tests of speech run unchanged past the recognition check.
W2_EMPTY_ANSWERS: dict[str, str] = {
    "skaz_recognition_check": json.dumps({"corrections": []}),
    "skaz_discrepancies": json.dumps({"conflicts": []}),
    "skaz_connections": json.dumps({"connections": []}),
    "skaz_folder_overview": json.dumps({"blocks": []}),
}


class ScriptedWiki:
    """Answers by schema: queued JSON strings per kind; optional gate before every answer."""

    def __init__(self, *, notes: Sequence[str] = (), concepts: Sequence[str] = (),
                 matches: Sequence[int] = (), gate: asyncio.Event | None = None,
                 answers: Mapping[str, Sequence[str]] | None = None) -> None:
        self.queues: dict[str, list[str]] = {
            prompts.NOTES_SCHEMA_TITLE: list(notes),
            prompts.CONCEPTS_SCHEMA_TITLE: list(concepts),
            prompts.MATCH_SCHEMA_TITLE: [json.dumps({"choice": choice}) for choice in matches],
        }
        # W2 answers (recognition check, disagreements, connections, overviews, recheck) by schema title.
        for title, queued in (answers or {}).items():
            self.queues[title] = list(queued)
        self.gate = gate
        self.engine = FakeEngine("codex", script=self._answer)

    def _answer(self, turn: AgentTurn) -> list[ScriptItem]:
        assert turn.response_schema is not None
        title = str(turn.response_schema["title"])
        queue = self.queues.setdefault(title, [])
        if queue:
            text = queue.pop(0)
        elif title == prompts.NOTES_SCHEMA_TITLE:
            text = notes()
        elif title == prompts.CONCEPTS_SCHEMA_TITLE:
            text = concepts()
        elif title in W2_EMPTY_ANSWERS:
            text = W2_EMPTY_ANSWERS[title]
        else:
            text = json.dumps({"choice": 0})
        items: list[ScriptItem] = []
        if self.gate is not None:
            items.append(Gate(self.gate))
        items += [TextDelta("", text), Completed("")]
        return items

    def turns(self, title: str) -> list[AgentTurn]:
        return [turn for turn in self.engine.turns
                if turn.response_schema is not None and turn.response_schema["title"] == title]


LECTURE = [
    FragmentInput(text="Энтропия — это мера беспорядка системы.", start_ms=0, end_ms=5_000, speaker="1"),
    FragmentInput(text="Температура показывает среднюю кинетическую энергию частиц.", start_ms=5_000,
                  end_ms=12_000, speaker="1"),
    FragmentInput(text="Если температура растёт, энтропия газа тоже растёт.", start_ms=72_000, end_ms=80_000,
                  speaker="2"),
]


def add_material(kb: KnowledgeService, folder_name: str, title: str,
                 fragments: Sequence[FragmentInput] = LECTURE, kind: MaterialKind = "recording") -> str:
    folder = next((item for item in kb.folders() if item.name == folder_name), None)
    folder_id = folder.id if folder else kb.create_folder(folder_name).id
    return kb.create_material(folder_id, title, kind, fragments, languages=("ru",)).manifest.id


async def wait_finished(ingest: IngestService, job_id: str, timeout: float = 5.0) -> JobRecord:
    async def poll() -> JobRecord:
        while True:
            record = ingest.job(job_id)
            if record.finished and job_id not in ingest.active_jobs():
                return record
            await asyncio.sleep(0.01)

    return await asyncio.wait_for(poll(), timeout)


async def settle(predicate: Callable[[], bool], timeout: float = 5.0) -> None:
    async def poll() -> None:
        while not predicate():
            await asyncio.sleep(0.005)

    await asyncio.wait_for(poll(), timeout)
