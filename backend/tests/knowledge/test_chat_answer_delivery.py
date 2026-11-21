"""The working rules must reach the model after optional skills and before a varying Me preference."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from skaz.knowledge.agents.engine import EngineId
from skaz.knowledge.chats import context, live
from tests.knowledge.test_chat_prompt_sections import section
from tests.knowledge.test_chats_api import Env, env
from tests.knowledge.test_me_experience import CODE, TRANSFER, history
from tests.knowledge.test_me_prompt_cache import last

__all__ = ["env"]


@pytest.mark.parametrize("engine", ["codex", "hermes", "opencode", "claude_code"])
async def test_final_contract_is_in_the_instruction_role_for_every_chat_engine(
    env: Env,
    engine: EngineId,
) -> None:
    chat = await env.chat(engine=engine)
    await env.answered(chat["id"], "Сократи предоставленную фразу.")
    turn = [t for t in env.agents.engines[engine].turns if t.tools is not None][-1]
    body = section(turn.instructions, "answer_delivery")
    assert "⟦knowledge⟧" in body
    assert turn.instructions.index("</writing_skills>") < turn.instructions.index("<answer_delivery>")
    assert turn.instructions.rstrip().endswith("</answer_delivery>")
    user = turn.messages[-1].content
    assert "<answer_delivery>" not in user
    assert "Optional" in section(user, "recording_status")


async def test_same_contract_precedes_the_trusted_per_turn_preference(env: Env) -> None:
    for _ in range(3):
        await history(env, CODE)
    chat = await env.chat()
    await env.answered(chat["id"], TRANSFER)
    prompt = last(env).instructions
    assert prompt.count("<answer_delivery>") == 1
    assert prompt.index("</answer_delivery>") < prompt.index("<me_reply_format>")
    assert "runnable source code" in section_format(prompt)


def section_format(prompt: str) -> str:
    return prompt.partition("<me_reply_format>")[2].partition("</me_reply_format>")[0]


def test_changed_delivery_rules_invalidate_prior_live_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    original = live.base_instructions()
    monkeypatch.setattr(context, "ANSWER_DELIVERY", "<answer_delivery>changed</answer_delivery>")
    assert live.base_instructions() != original


@pytest.mark.parametrize("source", ["attachment", "recording"])
async def test_a_short_fragment_supplies_a_copyable_grounded_reference(env: Env, source: str) -> None:
    recording = source == "recording"
    material = env.library.live if recording else env.library.lecture
    chat = await env.chat(recording_material_id=material) if recording else await env.chat()
    await env.answered(chat["id"], "Что установлено?", attachments=[] if recording else [material])
    message = last(env).messages[-1].content
    quote = (
        "Плавление льда поглощает теплоту."
        if recording
        else "Второе начало термодинамики запрещает вечный двигатель второго рода."
    )
    assert f"⟦m:{material}:2|{quote}⟧" in message


async def test_delivery_reminder_is_outside_library_data_and_precedes_current_question(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Преобразуй строку.", attachments=[env.library.lecture])
    message = last(env).messages[-1].content
    assert message.rindex("</untrusted-data>") < message.index("<reply_check>")
    assert message.index("</reply_check>") < message.index("The user's message:")
    assert message.endswith("The user's message:\nПреобразуй строку.")


@pytest.mark.parametrize("body", ["Short.", "This passage embeds ⟧ in its source."])
def test_unsafe_or_short_quote_is_preserved_as_data_without_a_suggested_token(body: str) -> None:
    assert context._fragment_line("mat-f01", 3, None, None, None, body) == f"[mat-f01:3] {body}"


def test_reference_example_has_a_bounded_verbatim_quote_and_keeps_full_fragment() -> None:
    body = "Материал описывает результаты наблюдений. " * 14
    line = context._fragment_line("mat-f01", 3, None, None, None, body)
    assert body in line
    quote = line.split("⟦m:mat-f01:3|")[1].split("⟧")[0]
    assert 12 <= len(quote) <= 96 and quote in body


def test_primary_format_and_evidence_rules_agree_with_the_delivery_contract() -> None:
    system = context.instructions(None)
    assert "ordinary prose" in section(system, "formatting")
    assert "single word or symbol" in section(system, "general_knowledge_notice")


async def test_chat_with_no_context_preserves_a_bare_user_message(env: Env) -> None:
    # This library belongs to the pytest fixture. Finish its one recording before opening a new chat.
    with env.runtime.kb.db.write() as connection:
        connection.execute("UPDATE materials SET status='ready' WHERE id=?", (env.library.live,))
    chat = await env.chat()
    question = "Verbatim user input."
    await env.answered(chat["id"], question)
    turn = last(env)
    assert turn.messages[-1].content == question
    if target := os.environ.get("SKAZ_CHAT_PROMPT_EXPORT"):
        (Path(target) / "bare.json").write_text(
            json.dumps(
                {
                    "case": "bare",
                    "instructions": turn.instructions,
                    "message": question,
                    "prompt": question,
                    "memory": "",
                },
                ensure_ascii=False,
            )
        )
