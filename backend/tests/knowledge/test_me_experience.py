"""Frozen synthetic journeys. The optional export holds only the probe turn sent by SKAZ."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

from skaz.knowledge.agents.engine import Failed
from skaz.knowledge.chats.model import MessageInput
from skaz.knowledge.me.adapters import accept_chat
from skaz.knowledge.me.graph import MeGraphStore
from tests.knowledge.chat_support import text
from tests.knowledge.test_chats_api import Env, env

__all__ = ["env"]  # Re-export the shared pytest fixture.

PROMPT = "Сравни медиану и среднее арифметическое."
TRANSFER = "Чем отличаются среднее арифметическое и медиана?"
TABLE = "| Мера | Для 1, 2, 9 |\n|---|---|\n| Среднее | 4 |\n| Медиана | 2 |"
STEPS = "1. Упорядочиваем ряд.\n2. Берём центральное число.\n3. Для среднего делим сумму на длину."
CODE = "```python\nfrom statistics import mean, median\nprint(mean([1, 2, 9]), median([1, 2, 9]))\n```"
PRIVATE = "PERSONAL-CANARY-68114"
EXPLICIT = "Именно такой формат мне помог."
WEAK = "А если в этом ряду заменить 9 на 120?"
REJECT = "Нет, я хотел другое объяснение."
OVERRIDE = TRANSFER + " Сегодня ответь ровно одним предложением без таблиц и списков."
UNRELATED = "Как хранить свежий базилик?"

def memory(block: str) -> str:
    match = re.search(r"<skaz_me_turn>.*?</skaz_me_turn>", block, re.S)
    return match[0] if match else ""

async def history(
    e: Env, delivered: str, reaction: str = EXPLICIT, *, prompt: str = PROMPT,
) -> tuple[str, str]:
    chat = (await e.chat())["id"]
    e.agents.scripts["codex"] = lambda _: text(delivered + "\n" + PRIVATE)
    answer = await e.answered(chat, prompt)
    assert answer["state"] == "done"
    if reaction:
        e.agents.scripts["codex"] = lambda _: text("Хорошо.")
        await e.answered(chat, reaction)
    return chat, answer["id"]

async def probe(e: Env, prompt: str, *, case: str = "", chat: str | None = None) -> str:
    if chat is None:
        chat = (await e.chat())["id"]
    await e.answered(chat, prompt)
    turn = next(turn for turn in reversed(e.agents.engines["codex"].turns) if turn.tools is not None)
    payload = turn.messages[-1].content
    block = memory(payload)
    folder = os.environ.get("SKAZ_ME_TEST_EXPORT")
    if folder and case:
        path = Path(folder) / f"{case}.json"
        path.write_text(json.dumps({"case": case, "prompt": prompt, "memory": block,
                                    "instructions": turn.instructions, "message": payload},
                                   ensure_ascii=False, indent=2))
    assert PRIVATE not in payload
    return block

@pytest.mark.parametrize(("case", "answer", "label"), [
    ("table", TABLE, "table"), ("steps", STEPS, "numbered"), ("code", CODE, "code"),
])
async def test_held_out_profile_response(env: Env, case: str, answer: str, label: str) -> None:
    for _ in range(3):
        await history(env, answer)
    block = await probe(env, TRANSFER, case=case)
    assert label in block.lower()
    assert "confirmed=3" in block and "continued=0" in block
    entries = (await env.client.get("/kb/me/entries")).json()["entries"]
    assert all(item["kind"] == "observed" for item in entries)

@pytest.mark.parametrize(("case", "reaction", "expected"), [
    ("weak", WEAK, "continued=1"), ("reject", REJECT, "corrected=1"),
    ("silence", "", ""), ("topic", UNRELATED, ""),
])
async def test_feedback_semantics(env: Env, case: str, reaction: str, expected: str) -> None:
    await history(env, TABLE, reaction)
    block = await probe(env, TRANSFER)
    if expected:
        assert expected in block and "confirmed=0" in block
    else:
        assert not block

@pytest.mark.parametrize(("case", "prompt"), [("override", OVERRIDE), ("unrelated", UNRELATED)])
async def test_controls_for_transfer(env: Env, case: str, prompt: str) -> None:
    for _ in range(3):
        await history(env, TABLE)
    block = await probe(env, prompt, case=case)
    if case == "unrelated":
        assert not block
    else:
        assert "follow the user's current request" in block.lower() or not block

async def test_cold_profile(env: Env) -> None:
    assert not await probe(env, TRANSFER, case="cold")

async def test_counterevidence_updates_only_the_target_once(env: Env) -> None:
    chat, answer_id = await history(env, TABLE, WEAK)
    graph = env.runtime.kb_me_graph
    prior = env.chats.repo.messages(chat)
    weak = prior[-2]
    epoch = graph.source_epoch("chat")
    accept_chat(graph, weak, prior[:-2], epoch)
    assert "continued=1" in await probe(env, TRANSFER)
    # A later explicit response to the original explanation revises its outcome.
    from dataclasses import replace

    from skaz.knowledge.chats.model import Selection
    correction = replace(weak, id="later", seq=99, input=MessageInput(
        "Нет, таблица мне не помогла.", selection=Selection(answer_id, "b", "block", None, ())))
    accept_chat(graph, correction, prior, epoch)
    accept_chat(graph, correction, prior, epoch)
    block = await probe(env, TRANSFER)
    assert "continued=0" in block and "corrected=1" in block

@pytest.mark.parametrize("keep", [False, True])
async def test_delete_purges_searchable_source_even_after_restart(env: Env, keep: bool) -> None:
    chat, _ = await history(env, CODE)
    assert "code" in await probe(env, TRANSFER)
    deleted = await env.client.delete(f"/kb/chats/{chat}", params={"keep_experience": str(keep).lower()})
    assert deleted.is_success
    assert not await probe(env, TRANSFER)
    graph = env.runtime.kb_me_graph
    data = MeGraphStore(graph.directory).open().model_dump_json()
    assert PRIVATE not in data
    assert chat not in data

async def test_failed_or_attached_attempt_is_never_learned(env: Env) -> None:
    chat = (await env.chat())["id"]
    env.agents.scripts["codex"] = lambda _: [*text(CODE), Failed("", "other", "test")]
    assert (await env.answered(chat, PROMPT))["state"] == "failed"
    env.agents.scripts["codex"] = lambda _: text(TABLE)
    await env.answered(chat, EXPLICIT)
    await env.answered(chat, PROMPT, attachments=[env.library.textbook])
    await env.answered(chat, EXPLICIT)
    assert not await probe(env, TRANSFER)

async def test_original_is_resolved_in_current_chat_only(env: Env) -> None:
    chat = (await env.chat())["id"]
    original = "Расчёт тарифа Кедр: (100 − 80) / 80 = 25%. Метка KEDR-411."
    env.agents.scripts["codex"] = lambda _: text(original)
    await env.answered(chat, "Посчитай изменение тарифа Кедр с 80 до 100.")
    query = "Верни тот сохранённый расчёт тарифа Кедр с 80 до 100."
    assert original in await probe(env, query, chat=chat)
    assert original not in await probe(env, query)

async def test_read_only_rephrasing_tool_is_bound_to_chat(env: Env) -> None:
    from skaz.knowledge.agents.tools import ToolContext

    await history(env, STEPS)
    tool = "skaz_me_search"
    registry = env.runtime.kb_tools
    assert registry.get(tool) is not None
    assert (await registry.call(tool, {"query": PROMPT}, ToolContext("stale", "codex"))).is_error

async def test_disabled_chat_does_not_project_or_collect(env: Env) -> None:
    await history(env, TABLE)
    graph = env.runtime.kb_me_graph
    assert "table" in await probe(env, TRANSFER)
    graph.set_controls(graph.open().revision, chat=False)
    await history(env, CODE)
    assert not await probe(env, TRANSFER)
    graph.set_controls(graph.open().revision, chat=True)
    assert "code" not in await probe(env, TRANSFER)


def test_shipped_cpu_vectors_can_run_offline_and_fail_over(tmp_path: Path) -> None:
    from skaz.knowledge.me.semantic import LocalEncoder
    encoder = LocalEncoder()
    first = encoder.vector("Я хочу решить задачу самостоятельно")
    assert len(first) == 312
    assert sum(value * value for value in first) == pytest.approx(1, abs=0.02)
    nearby = encoder.vector("Хочу сначала попробовать сам")
    distant = encoder.vector("Пересадка комнатных растений")
    assert sum(a * b for a, b in zip(first, nearby, strict=True)) > sum(
        a * b for a, b in zip(first, distant, strict=True))
    assert not LocalEncoder(tmp_path).vector("нет файлов модели")

async def test_search_works_when_weights_are_unavailable(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    from skaz.knowledge.me.semantic import LocalEncoder
    monkeypatch.setattr(LocalEncoder, "vector", lambda *_: ())
    await history(env, STEPS)
    assert "numbered" in await probe(env, TRANSFER)

async def test_distinguishes_helpful_and_unwanted_parts_of_one_answer(env: Env) -> None:
    await history(env, TABLE + "\n" + CODE, "Таблица помогла, а код лишний.")
    block = await probe(env, TRANSFER)
    assert re.search(r"table[^\n]*confirmed=1", block)
    assert re.search(r"code[^\n]*corrected=1", block)

async def test_a_late_unanchored_clarification_is_attributed_conservatively(env: Env) -> None:
    chat, _ = await history(env, TABLE, WEAK)
    await env.answered(chat, "Я спрашивал, зачем в таблице нужен исходный ряд.")
    block = await probe(env, TRANSFER)
    assert "corrected=1" in block and "continued=0" in block

async def test_search_does_not_spoil_a_self_test(env: Env) -> None:
    await history(env, CODE)
    block = await probe(env, "Медиана и среднее. Дай условие, решение я пришлю сам.")
    assert "code" not in block

async def test_similar_topic_and_feedback_only_cannot_create_a_match(env: Env) -> None:
    chat = (await env.chat())["id"]
    env.agents.scripts["codex"] = lambda _: text(TABLE)
    await env.answered(chat, "Сколько воды нужно фикусу?")
    await env.answered(chat, "Да, помогло. В другой раз поговорим про медиану и среднее арифметическое.")
    assert not await probe(env, TRANSFER)

async def test_user_can_inspect_disable_and_forget_observed_formats(env: Env) -> None:
    await history(env, TABLE)
    base = "/kb/me/entries"
    entries = (await env.client.get(base)).json()["entries"]
    [table] = [item for item in entries if item["kind"] == "observed" and "table" in item["text"].lower()]
    url = f"{base}/{table['id']}"
    off = await env.client.patch(url, json={"expected_revision": table["revision"], "enabled": False})
    assert off.is_success and not await probe(env, TRANSFER)
    current = (await env.client.get(url)).json()
    assert (await env.client.delete(url, params={"expected_revision": current["revision"]})).is_success
    assert (await env.client.get(url)).status_code == 404
