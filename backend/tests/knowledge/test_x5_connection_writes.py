"""X5 (X1 "not done"): one connection update is written whole, even when quitting cuts the job.

"Find connections" for a concept page may state several connections at once. They were
written one ``disk_call`` each, so the shutdown's cancel between two of them left the page
with only part of the update. Now the whole set goes to the page in one ``disk_call``,
which a cancel never interrupts (``native_io.drain_on_cancel``): all of it or none.

The writing agent is ``ScriptedWiki`` (a fake at the model seam); no model runs.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import pytest

from skaz.knowledge.markdown.page import parse_page
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki import connections as connections_module
from skaz.knowledge.wiki import pages_io

from .ingest_support import ScriptedWiki, add_material, block, cite, concept, concepts
from .wiki_support import (
    CONNECTIONS,
    LECTURE_NOTES,
    connecting,
    forget_connection_checks,
    ingest_done,
    settle_wiki,
    wired,
)

ENTROPY = "Энтропия"
#: The lecture's concepts plus a third one, so "Энтропия" has two candidates to connect to.
THREE_CONCEPTS = concepts(
    concept(ENTROPY, None, [
        block("from_source", "Мера беспорядка системы.", cite(1, "Энтропия — это мера беспорядка системы.")),
        block("from_source", "Энтропия газа растёт с температурой.", cite(3, "энтропия газа тоже растёт")),
    ]),
    concept("Температура", None, [
        block("from_source", "Показывает энергию частиц.", cite(2, "среднюю кинетическую энергию частиц")),
    ]),
    concept("Частицы", None, [
        block("from_source", "У частиц есть кинетическая энергия.", cite(2, "кинетическую энергию частиц")),
    ]),
)


def links(kb: KnowledgeService, page_id: str) -> list[str]:
    record = kb.page_repo.get(page_id)
    assert record is not None
    document = parse_page((kb.library_root / record.rel_path).read_text(encoding="utf-8"))
    return [item.body for item in document.blocks() if item.id.startswith("c-link-")]


async def two_connections_queued(ready: KnowledgeService) -> tuple[Any, Any, str, list[str]]:
    wiki = ScriptedWiki(notes=[LECTURE_NOTES], concepts=[THREE_CONCEPTS])
    ingest, service = wired(ready, wiki)
    await ingest_done(ingest, add_material(ready, "Физика", "Лекция 8"))
    await settle_wiki(service, ingest)
    entropy = next(page.id for page in ready.pages(kind="concept") if page.title == ENTROPY)
    record = ready.page_repo.get(entropy)
    assert record is not None and links(ready, entropy) == []
    candidates = service.connections.candidates(record)
    assert len(candidates) == 2, [item.title for item in candidates]
    # The run after ingest checked the pairs already (no connection): as before C1-a, ask again.
    forget_connection_checks(ready)
    first, second = candidates
    words = {"Температура": "энергию частиц", "Частицы": "кинетическая энергия"}
    wiki.queues.setdefault(CONNECTIONS, []).append(connecting(
        (ENTROPY, first.title, "Мера беспорядка", words[first.title], "Первая связь."),
        (ENTROPY, second.title, "газа растёт", words[second.title], "Вторая связь."),
    ))
    return service, wiki, entropy, [item.title for item in candidates]


async def test_a_quit_during_a_connection_update_leaves_it_whole(
        ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch) -> None:
    service, _wiki, entropy, titles = await two_connections_queued(ready)
    real_rewrite = pages_io.rewrite
    writing = threading.Event()

    def slow_rewrite(*args: Any, **kwargs: Any) -> Any:
        writing.set()
        time.sleep(0.3)  # the shutdown's cancel arrives while the page is being written
        return real_rewrite(*args, **kwargs)

    monkeypatch.setattr(connections_module, "rewrite", slow_rewrite)
    job = await service.find_connections([entropy])
    for _ in range(500):
        if writing.is_set():
            break
        await asyncio.sleep(0.01)
    assert writing.is_set(), "the connection was never written"
    await service.close()  # the app's shutdown: cancels the job between its writes

    written = links(ready, entropy)
    assert len(written) == 2, written  # the whole update, never one of its two connections
    assert all(any(f"|{title}]]" in body for body in written) for title in titles)
    targets = {edge.target for edge in service.graph.edges()
               if edge.kind == "connection" and edge.source == entropy}
    ids = {page.title: page.id for page in ready.pages(kind="concept")}
    assert {ids[title] for title in titles} <= targets  # the graph has both edges too
    del job


async def test_a_connection_update_is_one_page_write(
        ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch) -> None:
    service, _wiki, entropy, _titles = await two_connections_queued(ready)
    real_rewrite = pages_io.rewrite
    calls: list[str] = []

    def counting(*args: Any, **kwargs: Any) -> Any:
        calls.append(str(args[1]))
        return real_rewrite(*args, **kwargs)

    monkeypatch.setattr(connections_module, "rewrite", counting)
    job = await service.find_connections([entropy])
    await service.jobs.wait(job.id)
    assert len(links(ready, entropy)) == 2
    assert len(calls) == 1  # both connections in one rewrite of the page
