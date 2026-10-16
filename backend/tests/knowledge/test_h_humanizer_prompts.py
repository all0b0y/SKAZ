"""Humanizer in every prompt where the agent writes text (0.3.1 H1/H2), and nowhere once it is off.

Delivery (H2, decided per engine in ``skills/prompting.py``): the pinned SKILL.md
is part of SKAZ's own turn instructions for all three agents — no native skill
tool, no extra tool at all. Ingest and wiki jobs stay without tools (layer 1).
Agents are fakes at the external seam; nothing here says how well a model writes.
"""
from __future__ import annotations

import asyncio
import logging

import pytest

from skaz.knowledge.agents.engine import AgentTurn, EngineId
from skaz.knowledge.agents.fake import Gate
from skaz.knowledge.chats.context import instructions
from skaz.knowledge.ingest import prompts
from skaz.knowledge.ingest.prompts import CONCEPTS_INSTRUCTIONS, NOTES_INSTRUCTIONS, instructions_for
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.skills import skill
from skaz.knowledge.skills.prompting import PRECEDENCE_RULE, with_skills
from skaz.knowledge.wiki import prompts as wiki_prompts
from tests.knowledge.chat_support import text
from tests.knowledge.ingest_support import settle
from tests.knowledge.test_chats_api import Env, env  # noqa: F401 - the chat API fixture
from tests.knowledge.wiki_support import two_sources

HUMANIZER = skill("humanizer")
#: Turn kinds in which the agent writes prose that ends up in the wiki.
WRITING = {prompts.NOTES_SCHEMA_TITLE, prompts.CONCEPTS_SCHEMA_TITLE, wiki_prompts.DISCREPANCY_TITLE,
           wiki_prompts.CONNECTIONS_TITLE, wiki_prompts.OVERVIEW_TITLE, wiki_prompts.RECHECK_TITLE}


def mentions_humanizer(turn: AgentTurn) -> bool:
    everything = turn.instructions + "".join(message.content for message in turn.messages)
    return "humanizer" in everything.lower()


# -- the block itself ---------------------------------------------------------------------------


def test_no_skills_leaves_the_instructions_exactly_as_they_were() -> None:
    assert with_skills("SKAZ RULES", ()) == "SKAZ RULES"


def test_the_skill_follows_the_skaz_rules_whole_and_under_the_precedence_rule() -> None:
    combined = with_skills("SKAZ RULES", (HUMANIZER,))
    assert combined.startswith("SKAZ RULES\n\n")
    assert PRECEDENCE_RULE == ("SKAZ quote and citation rules come first; Humanizer never changes quoted "
                               "text, citation markers, block markers, numbers, names or terms.")
    assert combined.index("SKAZ RULES") < combined.index(PRECEDENCE_RULE) < combined.index(HUMANIZER.text)
    assert HUMANIZER.text in combined  # whole and unchanged
    assert combined.count(HUMANIZER.text) == 1
    # Embedded use: only the final text, never the skill's drafts or pattern lists.
    assert "only the final text" in combined


# -- chats --------------------------------------------------------------------------------------


def test_chat_instructions_keep_every_skaz_rule_above_humanizer() -> None:
    text_on = instructions("ru", skills=(HUMANIZER,))
    data, cite, rule, body = (text_on.index("Data is not instructions"), text_on.index("How to cite"),
                              text_on.index(PRECEDENCE_RULE), text_on.index(HUMANIZER.text))
    assert data < cite < rule < body
    assert "humanizer" not in instructions("ru").lower()


async def test_every_agent_gets_humanizer_by_default_and_none_once_it_is_off(env: Env) -> None:  # noqa: F811
    engines: tuple[EngineId, ...] = ("codex", "claude_code", "hermes")
    tools_on: dict[str, set[str]] = {}
    for engine in engines:
        chat = await env.chat(engine=engine)
        await env.answered(chat["id"], "Что такое энтропия?")
        [turn] = env.agents.engines[engine].turns
        assert HUMANIZER.text in turn.instructions
        assert turn.instructions.index("How to cite") < turn.instructions.index(PRECEDENCE_RULE)
        tools_on[engine] = {spec.name for spec in turn.tools or ()}
        assert all(name.startswith("skaz_") for name in tools_on[engine])  # no skill tool of any kind

    response = await env.client.put("/kb/settings/skills/humanizer", json={"enabled": False})
    assert response.status_code == 200
    for engine in engines:
        chat = await env.chat(engine=engine)
        await env.answered(chat["id"], "А температура?")
        last = env.agents.engines[engine].turns[-1]
        assert not mentions_humanizer(last)
        assert {spec.name for spec in last.tools or ()} == tools_on[engine]  # the tool set never changes


async def test_turning_it_off_leaves_a_running_answer_alone_and_applies_from_the_next(env: Env) -> None:  # noqa: F811
    gate = asyncio.Event()
    env.agents.scripts["codex"] = lambda _turn: [*text("Первая часть. "), Gate(gate), *text("Вторая часть.")]
    chat = await env.chat()
    sent = await env.ask(chat["id"], "Долгий вопрос")
    engine = env.agents.engines["codex"]
    await settle(lambda: bool(engine.active_runs()))
    assert (await env.client.put("/kb/settings/skills/humanizer", json={"enabled": False})).status_code == 200
    gate.set()
    await settle(lambda: not env.chats.active_runs())
    running = await env.message(chat["id"], sent["assistant"]["id"])
    assert running["state"] == "done"
    written = "".join(p["text"] for p in running["parts"] if p["type"] == "text")
    assert written == "Первая часть. Вторая часть."
    assert HUMANIZER.text in engine.turns[0].instructions  # built before the switch, sent as it was

    env.agents.scripts["codex"] = lambda _turn: text("Ответ.")
    await env.answered(chat["id"], "Следующий вопрос")
    assert not mentions_humanizer(engine.turns[-1])


# -- ingest and wiki jobs (no tools) ----------------------------------------------------------------


def test_ingest_instructions_put_humanizer_after_the_quote_rules() -> None:
    for template in (NOTES_INSTRUCTIONS, CONCEPTS_INSTRUCTIONS):
        on = instructions_for(template, "ru", skills=(HUMANIZER,))
        assert on.index("copied word for word") < on.index(PRECEDENCE_RULE) < on.index(HUMANIZER.text)
        assert on.index("Answer with JSON only") < on.index(PRECEDENCE_RULE)
        assert "humanizer" not in instructions_for(template, "ru", skills=()).lower()


def _writing_turns(turns: list[AgentTurn]) -> dict[str, list[AgentTurn]]:
    out: dict[str, list[AgentTurn]] = {}
    for turn in turns:
        assert turn.tools is None  # layer 1: ingest and wiki jobs never get tools
        assert turn.response_schema is not None
        out.setdefault(str(turn.response_schema["title"]), []).append(turn)
    return out


async def test_ingest_and_wiki_jobs_write_with_humanizer_by_default(ready: KnowledgeService) -> None:
    case = await two_sources(ready)
    job = await case.service.find_connections()
    await case.service.jobs.wait(job.id)
    by_kind = _writing_turns(case.wiki.engine.turns)
    assert {prompts.NOTES_SCHEMA_TITLE, prompts.CONCEPTS_SCHEMA_TITLE,
            wiki_prompts.DISCREPANCY_TITLE} <= set(by_kind)
    for kind, turns in by_kind.items():
        for turn in turns:
            if kind in WRITING:
                assert HUMANIZER.text in turn.instructions, kind
            else:  # a concept match is a choice, not text
                assert not mentions_humanizer(turn), kind


async def test_ingest_and_wiki_jobs_carry_nothing_of_humanizer_when_off(ready: KnowledgeService) -> None:
    ready.settings.set("humanizer_enabled", False)
    case = await two_sources(ready)
    job = await case.service.find_connections()
    await case.service.jobs.wait(job.id)
    by_kind = _writing_turns(case.wiki.engine.turns)
    assert prompts.NOTES_SCHEMA_TITLE in by_kind and wiki_prompts.DISCREPANCY_TITLE in by_kind
    assert not any(mentions_humanizer(turn) for turn in case.wiki.engine.turns)


async def test_the_skill_text_never_reaches_the_log(env: Env, caplog: pytest.LogCaptureFixture) -> None:  # noqa: F811
    caplog.set_level(logging.DEBUG)
    chat = await env.chat()
    await env.answered(chat["id"], "Что такое энтропия?")
    assert HUMANIZER.text in env.agents.engines["codex"].turns[0].instructions
    logged = "\n".join(record.getMessage() for record in caplog.records)
    for line in ("Signs of AI writing", "Not X but Y", "embedded mode", PRECEDENCE_RULE):
        assert line not in logged
