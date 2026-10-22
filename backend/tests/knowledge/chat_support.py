"""Test doubles and a small authored library for the chat tests (fakes at the agent seam only)."""
from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx

from skaz.knowledge.agents.engine import AgentTurn, EngineId, EngineStatus, Failed, TextDelta
from skaz.knowledge.agents.fake import FakeEngine, ScriptItem
from skaz.knowledge.agents.registry import EngineRegistry
from skaz.knowledge.chats.service import ChatService
from skaz.knowledge.markdown.page import Block, Cite, PageDocument, PageMeta
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService
from tests.knowledge.ingest_support import settle

Script = Callable[[AgentTurn], Sequence[ScriptItem]]


@dataclass(frozen=True)
class Library:
    physics: str
    chemistry: str
    lecture: str
    textbook: str
    live: str
    concept: str
    analysis: str


LECTURE = [
    "Энтропия — мера беспорядка системы, она растёт в изолированной системе.",
    "Второе начало термодинамики запрещает вечный двигатель второго рода.",
    "Итоги лекции: энтропия и необратимость связаны.",
]
TEXTBOOK = [
    "Энтропия в химии определяет направление самопроизвольных реакций.",
    "Энергия Гиббса учитывает энтальпию и энтропию.",
]
LIVE = ["Сегодня говорим о фазовых переходах.", "Плавление льда поглощает теплоту."]


def seed_library(kb: KnowledgeService) -> Library:
    physics = kb.create_folder("Физика")
    chemistry = kb.create_folder("Химия")
    lecture = kb.create_material(physics.id, "Лекция 8", "recording", [
        FragmentInput(text=text, start_ms=index * 60_000, end_ms=(index + 1) * 60_000, speaker="Speaker 1")
        for index, text in enumerate(LECTURE)
    ], status="ready", languages=("ru",))
    textbook = kb.create_material(chemistry.id, "Учебник химии", "pdf", [
        FragmentInput(text=text, page=10 + index) for index, text in enumerate(TEXTBOOK)
    ])
    live = kb.create_material(physics.id, "Лекция 9", "recording", [
        FragmentInput(text=text, start_ms=index * 30_000, end_ms=(index + 1) * 30_000, speaker="Speaker 1")
        for index, text in enumerate(LIVE)
    ], status="recording", languages=("ru",))
    lecture_id, textbook_id = lecture.manifest.id, textbook.manifest.id
    kb.create_page(PageDocument(
        meta=PageMeta(skaz_id="pg-entropy", kind="concept", title="Энтропия", original="entropy",
                      aliases=("Entropy",), language="ru", folders=(physics.id,), sources=(lecture_id,)),
        parts=[Block.create("c-e1", "from_source", "Энтропия — мера беспорядка системы.",
                            cites=(Cite(lecture_id, 1, "мера беспорядка системы"),))],
    ))
    kb.create_page(PageDocument(
        meta=PageMeta(skaz_id="pg-old-answer", kind="analysis", title="Старый разбор", language="ru"),
        parts=[Block.create("c-a1", "explanation", "Разбор говорит, что энтропия — это хаос во Вселенной.")],
    ))
    return Library(physics.id, chemistry.id, lecture_id, textbook_id, live.manifest.id, "pg-entropy",
                   "pg-old-answer")


def text(*pieces: str) -> list[ScriptItem]:
    return [TextDelta("", piece) for piece in pieces]


def limit_failure(message: str = "You've hit your usage limit.") -> Failed:
    from datetime import UTC, datetime
    return Failed("", "limit", message, retry_at=datetime(2026, 10, 15, 18, 30, tzinfo=UTC))


@dataclass
class Agents:
    """Three fake engines whose scripts tests replace per engine."""

    scripts: dict[EngineId, Script] = field(default_factory=dict)
    engines: dict[EngineId, FakeEngine] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for engine_id in ("codex", "claude_code", "hermes", "opencode"):
            self.scripts[engine_id] = lambda _turn: text("OK.")
            self.engines[engine_id] = self._engine(engine_id)

    def _engine(self, engine_id: EngineId, status: EngineStatus | None = None) -> FakeEngine:
        return FakeEngine(engine_id, script=lambda turn: self.scripts[engine_id](turn), status=status)

    def missing(self, engine_id: EngineId, reason: str) -> None:
        status = EngineStatus(engine_id, installed=False, reason=reason)
        self.engines[engine_id] = self._engine(engine_id, status)


def install(runtime: Any, agents: Agents) -> EngineRegistry:
    registry = EngineRegistry(dict(agents.engines), runtime.kb.settings, cache_s=0.0)
    runtime.kb_agents.registry = registry
    return registry


async def connect(client: httpx.AsyncClient, runtime: Any) -> Library:
    assert (await client.post("/kb/library", json={})).status_code in (200, 201)
    return seed_library(runtime.kb)


async def finished(chats: ChatService, timeout: float = 5.0) -> None:
    await settle(lambda: not chats.active_runs(), timeout)


def chips(message: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    return [part for part in message["parts"] if part["type"] == kind]


def all_text(message: dict[str, Any]) -> str:
    return "".join(part["text"] for part in message["parts"] if part["type"] == "text")
