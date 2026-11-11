"""C1-f over HTTP and the model seam, with authored model events only (no real model).

The Notes answer is read while it streams: finished sections are kept at once, a broken answer
continues from them with a new short request (WR2), a model that goes round in circles is cut and
continued once, then stopped (WR3), and the job shows how many sections are written. Decided
2026-10-20 after a real 12-minute Notes answer was lost; continuation and loop rules 2026-11-10.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx

from skaz.knowledge.agents.engine import AgentTurn, Completed, Failed, ModelOption, TextDelta
from skaz.knowledge.agents.fake import FakeEngine, ScriptItem
from skaz.knowledge.ingest import prompts
from tests.knowledge.ingest_support import (
    W2_EMPTY_ANSWERS,
    PatternDetector,
    add_material,
    block,
    cite,
    settle,
)
from tests.knowledge.test_ingest_pipeline import CONCEPTS_OK, wiki_dir

ONE = ("Энтропия", [block("from_source", "Энтропия определяется как мера беспорядка системы.",
                          cite(1, "мера беспорядка системы"))])
TWO = ("Температура", [block("from_source", "Температура связана со средней кинетической энергией частиц.",
                             cite(2, "среднюю кинетическую энергию частиц"))])
THREE = ("Рост энтропии", [block("from_source", "Если температура растёт, энтропия газа тоже растёт.",
                                 cite(3, "энтропия газа тоже растёт"))])


def section(item: tuple[str, list[dict[str, Any]]]) -> str:
    return json.dumps({"title": item[0], "blocks": item[1]}, ensure_ascii=False)


def chunks(text: str, size: int = 7) -> list[ScriptItem]:
    return [TextDelta("", text[i:i + size]) for i in range(0, len(text), size)]


@dataclass
class World:
    runtime: Any
    engine: FakeEngine
    material_id: str

    def notes_turns(self) -> list[AgentTurn]:
        return [turn for turn in self.engine.turns if turn.response_schema is not None
                and turn.response_schema["title"] == prompts.NOTES_SCHEMA_TITLE]


async def _world(kb_app: Any, kb_client: httpx.AsyncClient, notes_answers: list[list[ScriptItem]],
                 models: list[ModelOption] | None = None) -> World:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    queue = list(notes_answers)

    def answer(turn: AgentTurn) -> list[ScriptItem]:
        assert turn.response_schema is not None
        title = turn.response_schema["title"]
        if title == prompts.NOTES_SCHEMA_TITLE:
            return queue.pop(0)
        result = (CONCEPTS_OK if title == prompts.CONCEPTS_SCHEMA_TITLE
                  else W2_EMPTY_ANSWERS.get(str(title), '{"choice":0}'))
        return [TextDelta("", result), Completed("")]

    engine = FakeEngine("codex", script=answer,
                        models=models or [ModelOption("stream-model", "Stream", ("low",), "low")])
    runtime.kb_ingest.engines = lambda _engine: engine
    runtime.kb_ingest.detector = PatternDetector()
    profile = {"wiki_engine": "codex", "wiki_model": "stream-model", "wiki_effort": "low"}
    saved = await kb_client.put("/kb/settings/wiki", json=profile)
    assert saved.status_code == 200, saved.text
    material_id = add_material(runtime.kb, "Physics", "Лекция 8", kind="pdf")
    return World(runtime, engine, material_id)


async def _ingest(world: World, kb_client: httpx.AsyncClient) -> dict[str, Any]:
    job = (await kb_client.post(f"/kb/materials/{world.material_id}/ingest")).json()
    await settle(lambda: not world.runtime.kb_ingest.active_jobs())
    done: dict[str, Any] = (await kb_client.get(f"/kb/jobs/{job['id']}")).json()
    return done


def _headings(world: World) -> list[str]:
    note = (wiki_dir(world.runtime.kb) / "Notes" / "Лекция 8.md").read_text(encoding="utf-8")
    # The page ends with its own "## Concepts" list; the sections come before it.
    return [line[3:] for line in note.splitlines() if line.startswith("## ") and line != "## Concepts"]


def _continues_after(turn: AgentTurn, *titles: str) -> None:
    """WR2: a continuation is one new user request naming what is written — never the old JSON."""
    assert [m.role for m in turn.messages] == ["user"]
    content = turn.messages[0].content
    assert content.startswith("Continue the Notes for part 1 of 1")
    written = content.split("Sections already written for this part")[1].split("The last section")[0]
    assert all(title in written for title in titles)
    assert '"sections"' not in content and '"more": true' not in content


async def test_a_broken_answer_keeps_its_finished_sections_and_continues_from_them(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    broken = '{"sections": [' + section(ONE) + ", " + section(TWO) + ', {"title": "Рост'
    world = await _world(kb_app, kb_client, [
        [*chunks(broken), Failed("", "other", "Codex stopped unexpectedly.")],
        [*chunks(json.dumps({"sections": [json.loads(section(THREE))], "more": False}, ensure_ascii=False)),
         Completed("")],
    ])
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    first, second = world.notes_turns()
    # The second call continues after the two finished sections instead of starting over.
    _continues_after(second, "Энтропия", "Температура")
    assert "Write the Notes for part 1 of 1" in first.messages[0].content
    assert _headings(world) == ["Энтропия", "Температура", "Рост энтропии"]
    assert done["progress"]["notes_sections"] == 3
    journal = " ".join(entry["message"] for entry in done["journal"])
    assert "continuing from the 2 finished sections" in journal


LOOP = '{"sections": [' + ", ".join(section(item) for item in (ONE, TWO, ONE, TWO, ONE)) + "]}"
LOOP_AGAIN = '{"sections": [' + ", ".join([section(TWO), section(ONE), section(TWO)]) + "]}"
REST = json.dumps({"sections": [json.loads(section(THREE))], "more": False}, ensure_ascii=False)


async def test_a_model_going_round_in_circles_is_cut_and_continued_once(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    world = await _world(kb_app, kb_client, [[*chunks(LOOP), Completed("")], [*chunks(REST), Completed("")]])
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    assert len(world.notes_turns()) == 2
    _continues_after(world.notes_turns()[1], "Энтропия", "Температура")
    assert _headings(world) == ["Энтропия", "Температура", "Рост энтропии"]
    journal = " ".join(entry["message"] for entry in done["journal"])
    assert ("3 sections in a row added nothing new (“Энтропия”, “Температура”, “Энтропия”)" in journal)
    assert "мера беспорядка" not in journal  # titles and counts only, never source text


async def test_a_second_loop_right_away_fails_and_retry_continues_from_kept_sections(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    world = await _world(kb_app, kb_client, [
        [*chunks(LOOP), Completed("")], [*chunks(LOOP_AGAIN), Completed("")], [*chunks(REST), Completed("")],
    ])
    failed = await _ingest(world, kb_client)
    assert failed["state"] == "failed"
    assert failed["error"].startswith("The model kept repeating itself while writing the notes")
    assert "2 sections before that are kept" in failed["error"]
    assert "paragraphs" not in failed["error"]
    assert failed["can_retry"] is True
    # Retry: the kept sections come from the checkpoint; only the rest is asked for.
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    assert len(world.notes_turns()) == 3
    _continues_after(world.notes_turns()[-1], "Энтропия", "Температура")
    assert _headings(world) == ["Энтропия", "Температура", "Рост энтропии"]


async def test_after_the_model_repeated_itself_another_model_continues_from_the_kept_sections(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    world = await _world(kb_app, kb_client, [
        [*chunks(LOOP), Completed("")], [*chunks(LOOP_AGAIN), Completed("")], [*chunks(REST), Completed("")],
    ], models=[ModelOption("stream-model", "Stream", ("low",), "low"),
               ModelOption("other-model", "Other", ("low",), "low")])
    failed = await _ingest(world, kb_client)
    assert failed["state"] == "failed"
    assert "starts this material over" not in failed["error"]
    assert "Retry or another model in Settings → Models continues from them" in failed["error"]
    chosen = await kb_client.put("/kb/settings/wiki",
                                 json={"wiki_model": "other-model", "wiki_effort": "low"})
    assert chosen.status_code == 200, chosen.text
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    retry = world.notes_turns()[-1]
    assert retry.model == "other-model"
    # The other model never sees the first model's text as its own turn: one new request.
    _continues_after(retry, "Энтропия", "Температура")
    assert _headings(world) == ["Энтропия", "Температура", "Рост энтропии"]
    journal = " ".join(entry["message"] for entry in done["journal"])
    assert "2 sections written by Codex · stream-model · low" in journal
    assert "continues with Codex · other-model · low" in journal


async def test_a_limit_mid_answer_fails_the_job_but_keeps_the_sections_for_retry(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    broken = '{"sections": [' + section(ONE) + ', {"title": "Темп'
    world = await _world(kb_app, kb_client, [
        [*chunks(broken), Failed("", "limit", "Your Codex usage limit is reached.")],
        [*chunks(json.dumps({"sections": [json.loads(section(TWO)), json.loads(section(THREE))],
                             "more": False}, ensure_ascii=False)), Completed("")],
    ])
    failed = await _ingest(world, kb_client)
    assert failed["state"] == "failed" and "usage limit" in failed["error"]
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    _continues_after(world.notes_turns()[-1], "Энтропия")
    assert _headings(world) == ["Энтропия", "Температура", "Рост энтропии"]


async def test_the_running_job_says_how_many_sections_are_written_and_since_when(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    import asyncio

    from skaz.knowledge.agents.fake import Gate

    gate = asyncio.Event()
    opening = '{"sections": [' + section(ONE) + ", " + section(TWO) + ", "
    world = await _world(kb_app, kb_client, [
        [*chunks(opening), Gate(gate), *chunks(section(THREE) + '], "more": false}'), Completed("")],
    ])
    job = (await kb_client.post(f"/kb/materials/{world.material_id}/ingest")).json()

    async def two_sections() -> bool:
        view = (await kb_client.get(f"/kb/jobs/{job['id']}")).json()
        return bool(view["progress"]["notes_sections"] == 2)

    for _ in range(200):
        if await two_sections():
            break
        await asyncio.sleep(0.02)
    view = (await kb_client.get(f"/kb/jobs/{job['id']}")).json()
    assert view["step"] == "writing_notes" and view["progress"]["notes_sections"] == 2
    assert view["step_started_at"] is not None
    assert view["label"] == "Writing notes · part 1 of 1 · 2 sections"
    gate.set()
    await settle(lambda: not world.runtime.kb_ingest.active_jobs())
