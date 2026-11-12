"""EX3 S4 (E6): the hidden OpenAlex label of each own topic, across the X1 (mapping) ↔ X2 (science) seam.

On the user's library copy all 39 own topics ended ``no_match``: the mapper joined the topic name and three
concept titles (with their Russian glosses) into one ``/topics`` search, and OpenAlex ANDs the words of a
search, so 38 of 39 searches found nothing and were stored as "no match" without asking the decision model.

The fake OpenAlex below applies OpenAlex's documented search rules (all words must match the topic's
``display_name`` or ``description``), so a joined query finds nothing here exactly as it did live.
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from skaz.knowledge.api.schemas_explore import KbFunnelStart
from skaz.knowledge.areas import prompts
from skaz.knowledge.areas.mapping import search_terms
from skaz.knowledge.areas.service import ExploreAreasService
from skaz.knowledge.areas.topics import TopicStore
from skaz.knowledge.decisions.protocol import Answer, ChoiceAnswer, ChoiceQuestion, DeciderId, Question, Undecided
from skaz.knowledge.science.client import ScienceGateway
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.store.schema import areas
from tests.knowledge.test_b1_science import Bases, enable
from tests.knowledge.test_b1_science import bases as bases
from tests.knowledge.test_b1_science import gateway as gateway
from tests.knowledge.test_b1_science import secrets as secrets
from tests.knowledge.test_b1_science import sleeps as sleeps
from tests.knowledge.test_b2_funnel import parts as parts
from tests.knowledge.test_b2_funnel import run_to_end
from tests.knowledge.test_ex2_topics import wiki_material

# -- a fake OpenAlex /topics with OpenAlex's search rules ---------------------------------------------------

#: A slice of OpenAlex's topic list (ids, names and descriptions in OpenAlex's shape).
TOPICS = [
    ("T11975", "Multi-Agent Systems and Negotiation",
     "This cluster of papers focuses on multi-agent systems, autonomous agents, agent architectures and "
     "negotiation between AI agents."),
    ("T10181", "Natural Language Processing Techniques",
     "Language models, transformers and text processing for natural language understanding."),
    ("T12128", "Reinforcement Learning in Robotics",
     "Reinforcement learning agents for control loops in robotics."),
    ("T10557", "Negotiation and Conflict Resolution",
     "Negotiation, conflict management and communication in organizations."),
    ("T10028", "Topic Modeling", "Probabilistic topic models for text corpora."),
]
_STOP = {"a", "an", "and", "the", "of", "in", "for", "to", "on", "or", "with", "by"}


def _words(text: str) -> set[str]:
    return {word.rstrip("s") for word in re.findall(r"\w+", text.casefold()) if word not in _STOP}


def topics_route(request: httpx.Request) -> httpx.Response:
    """``/topics?search=``: every word of the query must be in the topic's name or description."""
    wanted = _words(request.url.params.get("search", ""))
    results = [
        {"id": f"https://openalex.org/{tid}", "display_name": name, "description": description}
        for tid, name, description in TOPICS
        if wanted and wanted <= _words(f"{name} {description}")
    ]
    return httpx.Response(200, json={"results": results, "meta": {"count": len(results)}})


class Decider:
    """The decision model: answers by the topic name found in the question's state."""

    def __init__(self, picks: dict[str, str] | None = None, *, unsure: Sequence[str] = ()) -> None:
        self.picks = picks or {}
        self.unsure = set(unsure)
        self.asked: list[ChoiceQuestion] = []

    @property
    def id(self) -> DeciderId:
        return "local"

    async def ask(self, question: Question) -> Answer:
        assert isinstance(question, ChoiceQuestion)
        self.asked.append(question)
        for topic, option in self.picks.items():
            if topic in question.state:
                if topic in self.unsure:
                    return Undecided("not sure")
                assert option in question.options
                return ChoiceAnswer(option=option, probabilities={option: 0.9}, confidence=0.9)
        return Undecided("not sure")

    async def ask_many(self, questions: Sequence[Question]) -> Sequence[Answer]:
        return [await self.ask(q) for q in questions]


def own_topic(kb: KnowledgeService, name: str, concepts: Sequence[str]) -> str:
    store = TopicStore(kb)
    area_id, _ = store.ensure_path(name, None)
    store.label(wiki_material(kb, f"Material about {name}", concepts), area_id, "agent")
    return area_id


def sent_searches(bases: Bases, path: str = "/topics") -> list[str]:
    return [r.url.params.get("search", "") for r in bases.requests if r.url.path == path]


# -- the producer's terms ---------------------------------------------------------------------------------


def test_terms_are_the_name_and_main_concepts_without_their_glosses() -> None:
    terms = search_terms(
        "AI agents",
        ["Subagents (Сабагенты)", "Agent loop (Цикл)", "Command-hook protocol (Протокол (command-хуки))", "x"],
    )
    assert terms == ["AI agents", "Subagents", "Agent loop", "Command-hook protocol"]
    assert search_terms("Data", ["Data", "Backup (бэкапы)", "  "]) == ["Data", "Backup"]
    long = "word " * 40
    assert all(0 < len(t) <= 72 for t in search_terms(long, [long]))  # search_topics' per-term limit


# -- the seam: the real science client under the mapper ---------------------------------------------------


async def test_topic_with_russian_glossed_concepts_gets_its_openalex_label(
    ready: KnowledgeService, gateway: ScienceGateway, bases: Bases
) -> None:
    """The library copy's "AI agents": the joined search found nothing; per-term searches find the topic."""
    await enable(gateway)
    bases.on("api.openalex.org", "/topics", topics_route)
    agents = own_topic(ready, "AI agents", ["Subagents (Сабагенты)", "Agent loop (Цикл)", "Skills"])
    decider = Decider({"AI agents": "Multi-Agent Systems and Negotiation"})
    service = ExploreAreasService(ready, decisions=decider, topic_search=lambda: gateway.search_topics)

    assert await service.map_topics() == 1
    assert list(service.topics(agents)) == ["T11975"]
    store = TopicStore(ready)
    assert store.topic(agents).mapping_state == "mapped" and store.topic(agents).mapping_reason is None
    searches = sent_searches(bases)
    assert searches[0] == "AI agents" and "AI agents Subagents Agent loop Skills" not in searches
    assert all(not re.search("[а-яё]", s, re.IGNORECASE) for s in searches)  # glosses never leave
    # The name's own finds come first, then the concepts' (here: "Agent loop" found the robotics topic).
    (question,) = decider.asked
    assert question.options == [
        "Multi-Agent Systems and Negotiation", "Reinforcement Learning in Robotics", prompts.NO_MATCH_OPTION
    ]
    records = (await gateway.journal()).records
    assert {r.operation for r in records} == {"taxonomy"} and all(r.outcome == "succeeded" for r in records)
    assert gateway.kb.settings.get("science.openalex.ledger")["usd"] == 0  # free


async def test_why_a_topic_has_no_label_is_kept_for_the_system(
    ready: KnowledgeService, gateway: ScienceGateway, bases: Bases
) -> None:
    bases.on("api.openalex.org", "/topics", topics_route)
    cooking = own_topic(ready, "Cooking", ["Sourdough"])
    comms = own_topic(ready, "Business communication", ["Negotiation"])
    exams = own_topic(ready, "Exam preparation", ["Topic models"])
    store = TopicStore(ready)

    # No consent: nothing is sent, every topic waits with the reason.
    decider = Decider(
        {"Business communication": prompts.NO_MATCH_OPTION, "Exam preparation": "Topic Modeling"},
        unsure=["Exam preparation"],
    )
    service = ExploreAreasService(ready, decisions=decider, topic_search=lambda: gateway.search_topics)
    assert await service.map_topics() == 0
    assert bases.requests == []
    assert {store.topic(t).mapping_reason for t in (cooking, comms, exams)} == {"science_consent_required"}
    assert {store.topic(t).mapping_state for t in (cooking, comms, exams)} == {"pending"}

    # No decision model: nothing is sent either.
    await enable(gateway)
    off = ExploreAreasService(ready, decisions=None, topic_search=lambda: gateway.search_topics)
    assert await off.map_topics() == 0
    assert bases.requests == [] and store.topic(cooking).mapping_reason == "no_decision_model"

    assert await service.map_topics() == 2
    assert (store.topic(cooking).mapping_state, store.topic(cooking).mapping_reason) == ("no_match", "no_candidates")
    assert (store.topic(comms).mapping_state, store.topic(comms).mapping_reason) == ("no_match", "none_fit")
    assert (store.topic(exams).mapping_state, store.topic(exams).mapping_reason) == ("pending", "undecided")
    assert list(service.topics(comms)) == [] and list(service.topics(cooking)) == []
    assert not any("Cooking" in q.state for q in decider.asked)  # nothing found: the model is not asked


# -- existing topics get their label once, without the user ------------------------------------------------


def test_areas_v3_retries_the_old_no_match_labels_once(tmp_path: Path) -> None:
    """The library copy: 39 topics ``no_match`` from the joined search → ``pending`` again, once."""
    connection = sqlite3.connect(tmp_path / "knowledge.sqlite3")
    connection.executescript(
        "CREATE TABLE explore_areas (id TEXT PRIMARY KEY, parent_id TEXT, taxonomy_id TEXT, level TEXT NOT NULL,"
        " original_name TEXT NOT NULL, name TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,"
        " pinned INTEGER NOT NULL DEFAULT 0, mapping_state TEXT NOT NULL DEFAULT 'pending'"
        " CHECK(mapping_state IN ('pending','mapped','no_match')), mapped_name TEXT);"
        "CREATE TABLE explore_area_topics (area_id TEXT NOT NULL, topic_id TEXT NOT NULL);"
        "INSERT INTO explore_areas VALUES ('a1',NULL,NULL,'custom','AI agents','AI agents',0,0,'no_match','AI agents');"
        "INSERT INTO explore_areas VALUES ('a2',NULL,NULL,'custom','RAG','RAG',0,0,'mapped','RAG');"
        "INSERT INTO explore_area_topics VALUES ('a2','T1');"
        "INSERT INTO explore_areas VALUES ('d1',NULL,NULL,'domain','S','S',0,0,'pending',NULL);"
    )
    step = areas.UPGRADES[3]
    step(connection)
    connection.execute("UPDATE explore_areas SET mapping_state='no_match', mapping_reason='none_fit' WHERE id='a2'")
    step(connection)  # a start cut before the version row runs it again: a kept reason is not retried
    rows = connection.execute(
        "SELECT id, mapping_state, mapped_name, mapping_reason FROM explore_areas ORDER BY id"
    ).fetchall()
    assert rows == [
        ("a1", "pending", "AI agents", None),
        ("a2", "no_match", "RAG", "none_fit"),
        ("d1", "pending", None, None),
    ]
    connection.close()


async def test_start_maps_waiting_topics_in_the_background_once(
    ready: KnowledgeService, gateway: ScienceGateway, bases: Bases
) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/topics", topics_route)
    agents = own_topic(ready, "AI agents", ["Agent loop"])
    decider = Decider({"AI agents": "Multi-Agent Systems and Negotiation"})
    service = ExploreAreasService(ready, decisions=decider, topic_search=lambda: gateway.search_topics)

    service.on_start()
    await service.mapper.idle()
    assert list(service.topics(agents)) == ["T11975"]
    sent = len(bases.requests)
    service.on_start()  # the next start: nothing waits, nothing is sent
    await service.mapper.idle()
    assert len(bases.requests) == sent and len(decider.asked) == 1


# -- searching inside a topic -----------------------------------------------------------------------------


def _works(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"results": [], "meta": {"count": 0, "next_cursor": None}})


async def test_search_inside_a_labelled_topic_filters_by_its_topic_id_and_unlabelled_by_its_name(
    parts: SimpleNamespace, gateway: ScienceGateway, bases: Bases
) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/topics", topics_route)
    bases.on("api.openalex.org", "/works", _works)
    kb: KnowledgeService = parts.kb
    agents = own_topic(kb, "AI agents", ["Agent loop"])
    cooking = own_topic(kb, "Cooking", ["Sourdough"])
    decider = Decider({"AI agents": "Multi-Agent Systems and Negotiation"})
    service = ExploreAreasService(kb, decisions=decider, topic_search=lambda: gateway.search_topics)
    assert await service.map_topics() == 1
    parts.directory.paths.update({agents: ["AI agents"], cooking: ["Cooking"]})
    parts.science.search = gateway.search  # the real OpenAlex request under the funnel

    def works_requests() -> list[dict[str, Any]]:
        return [dict(r.url.params) for r in bases.requests if r.url.path == "/works"]

    run = await run_to_end(parts, KbFunnelStart(area_id=agents, channels=["search"]))
    assert run.state == "done"
    (labelled,) = works_requests()
    assert "topics.id:T11975" in labelled["filter"].split(",")
    assert "AI agents" in labelled["search"]

    run = await run_to_end(parts, KbFunnelStart(area_id=cooking, channels=["search"]))
    assert run.state == "done"
    unlabelled = works_requests()[-1]
    assert "topics.id" not in unlabelled.get("filter", "")
    assert unlabelled["search"] == "(Cooking) OR (Sourdough)"


@pytest.mark.parametrize("terms", [["x" * 73], [f"t{n}" for n in range(7)]])
async def test_topic_search_keeps_its_contract_limits(
    gateway: ScienceGateway, bases: Bases, terms: list[str]
) -> None:
    from skaz.knowledge.api.contract_routes import ContractFailure

    await enable(gateway)
    with pytest.raises(ContractFailure):
        await gateway.search_topics(terms)
    assert bases.requests == []
