"""N6 «Я» stays in chats (decision 15): ingest (Notes, Concepts), wiki processing, the open-answer judge
and the W-3b search run never carry it, and no module outside the chat path reads it."""
from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from skaz.knowledge.agents.engine import AgentTurn, Completed, EngineId, TextDelta
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.registry import EngineRegistry
from skaz.knowledge.agents.web_runner import EngineSearch
from skaz.knowledge.me import HOW_TO_WORK, PROFILE, SEARCH
from skaz.knowledge.me.access import me_store
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.study.format import Question
from skaz.knowledge.study.judge import make_judge
from tests.knowledge.ingest_support import ScriptedWiki, add_material
from tests.knowledge.test_ingest_pipeline import CONCEPTS_OK, NOTES_OK, run_ingest, service_for

MARKERS = ("Aglaya Sekretova", "example first, then theory", "Google Scholar only")
SRC = Path(__file__).resolve().parents[2] / "src" / "skaz"
#: The only modules that may read «Я»: the package itself, its router, and the chat path.
#: ``runtime.py`` only wires the chat tools (``me.tools.attach`` on the chat service, N6 batch B5) — it
#: reads no «Я» text; the tools themselves refuse outside a chat answer.
READERS = {"knowledge/me", "knowledge/api/me.py", "knowledge/api/__init__.py", "knowledge/chats/service.py",
           "knowledge/chats/live.py", "runtime.py"}
ME = "skaz.knowledge.me"


def fill(kb: KnowledgeService) -> None:
    store = me_store(kb)
    store.update(PROFILE, text=f"Name: {MARKERS[0]}")
    store.update(HOW_TO_WORK, text=f"Give an {MARKERS[1]}")
    store.update(SEARCH, text=MARKERS[2])


def carries_me(turn: AgentTurn) -> bool:
    sent = turn.instructions + "\n".join(message.content for message in turn.messages)
    return any(marker in sent for marker in MARKERS) or "Writing to Me" in sent


async def test_ingest_turns_never_carry_me(ready: KnowledgeService) -> None:
    fill(ready)
    wiki = ScriptedWiki(notes=[NOTES_OK], concepts=[CONCEPTS_OK])
    await run_ingest(service_for(ready, wiki), add_material(ready, "Физика", "Лекция 8"))
    assert wiki.engine.turns and not any(carries_me(turn) for turn in wiki.engine.turns)


async def test_the_judge_and_the_w3b_search_run_never_carry_me(ready: KnowledgeService) -> None:
    fill(ready)
    engine = FakeEngine("claude_code", script=lambda turn: [
        TextDelta(turn.run_id, '{"verdict": "right", "score": 1, "feedback": "ok"}'), Completed(turn.run_id)])
    engines: dict[EngineId, Any] = {"codex": FakeEngine("codex"), "hermes": FakeEngine("hermes"),
                                    "claude_code": engine}
    registry = EngineRegistry(engines, ready.settings, cache_s=0.0)
    judge = make_judge(ready, lambda: registry)
    block = SimpleNamespace(payload={"agent": {"engine": "claude_code"}}, chat_id="chat-x")
    verdict = await judge(block, Question("q1", "open", "What is entropy?", ("Disorder",), ()), "Chaos")
    assert verdict["verdict"] == "right"
    await EngineSearch().search(engine, "entropy lecture notes")
    assert len(engine.turns) == 2 and not any(carries_me(turn) for turn in engine.turns)


def _imported(relative: str, node: ast.AST) -> list[str]:
    """Absolute module names an import statement names (``from . import me`` → ``…api.me``)."""
    if isinstance(node, ast.Import):
        return [alias.name for alias in node.names]
    if not isinstance(node, ast.ImportFrom):
        return []
    package = ["skaz", *relative.removesuffix(".py").split("/")][:-1]
    if node.level:
        package = package[: len(package) - (node.level - 1)]
        base = ".".join([*package, *([node.module] if node.module else [])])
    else:
        base = node.module or ""
    return [base, *(f"{base}.{alias.name}" for alias in node.names)]


def test_only_the_chat_path_imports_me() -> None:
    readers: set[str] = set()
    for path in SRC.rglob("*.py"):
        relative = path.relative_to(SRC).as_posix()
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if any(name == ME or name.startswith(ME + ".") for name in _imported(relative, node)):
                readers.add(relative)
    outside = {path for path in readers
               if not any(path == allowed or path.startswith(allowed + "/") for allowed in READERS)}
    assert outside == set()
    assert {"knowledge/chats/service.py", "knowledge/chats/live.py"} <= readers
