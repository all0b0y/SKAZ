"""A long paste sent with a chat message (brief X4): a pasted-text material the agent can read in
full, whose quotes are checked like those of any source. Verification of the existing path — the
composer reuses ``POST /kb/materials/text`` and ``attachments``; nothing here is new backend code.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import AgentTurn
from skaz.knowledge.agents.fake import ScriptItem
from skaz.knowledge.agents.tools import ToolRegistry
from skaz.knowledge.chats.context import ITEM_CHARS
from skaz.knowledge.library.library import INBOX_ID
from tests.knowledge.chat_support import Agents, chips, connect, finished, install, text

FILLER = " ".join(["Подробности повторяются, чтобы абзац был длинным и текст занимал несколько страниц."] * 3)
PARAGRAPHS = [
    f"Абзац {index}: энтропия связана с числом микросостояний, заметка номер {index}. {FILLER}"
    for index in range(1, 40)
]
PARAGRAPHS.append("Последний абзац: энтропия Шеннона измеряется в битах, когда логарифм по основанию два.")
PASTED = "\n\n".join(PARAGRAPHS)


@pytest.fixture
async def env(kb_app: Any, kb_client: httpx.AsyncClient,
              ) -> AsyncIterator[tuple[httpx.AsyncClient, Any, Agents]]:
    runtime = kb_app.state.runtime
    agents = Agents()
    install(runtime, agents)
    await connect(kb_client, runtime)
    yield kb_client, runtime, agents
    await runtime.kb_chats.close()


async def test_a_long_paste_is_a_text_material_read_in_full_with_checked_quotes(
    env: tuple[httpx.AsyncClient, Any, Agents],
) -> None:
    client, runtime, agents = env
    assert len(PASTED) > ITEM_CHARS  # longer than one context item: the rest is read through the tool
    added = await client.post("/kb/materials/text", json={"text": PASTED, "folder_id": INBOX_ID})
    assert added.status_code == 201, added.text
    material = (await client.get(f"/kb/materials/{added.json()['material']['id']}")).json()
    assert material["kind"] == "text" and material["wiki"]["state"] == "not_in_wiki"  # wiki off unless asked
    last = material["fragments"][-1]
    assert last["text"] == PARAGRAPHS[-1]

    def answer(_turn: AgentTurn) -> list[ScriptItem]:
        return text(f"В битах ⟦m:{material['id']}:{last['seg']}|энтропия Шеннона измеряется в битах⟧",
                    f" и ⟦m:{material['id']}:1|энтропия равна нулю всегда⟧.")

    agents.scripts["codex"] = answer
    chat = (await client.post("/kb/chats", json={})).json()
    sent = await client.post(f"/kb/chats/{chat['id']}/messages",
                             json={"text": "Summarise it", "attachments": [material["id"]]})
    assert sent.status_code == 202, sent.text
    await finished(runtime.kb_chats)

    request = agents.engines["codex"].turns[-1].messages[-1].content
    assert "The user attached this material to the question:" in request
    assert PARAGRAPHS[0] in request and "read them with skaz_read_material" in request

    # The rest is one tool call away: paging skaz_read_material yields every paragraph verbatim.
    tools, read, start = ToolRegistry(runtime.kb), [], 1
    while True:
        outcome = await tools.call("skaz_read_material", {"material_id": material["id"], "from_seg": start})
        assert not outcome.is_error, outcome.text
        page = json.loads(outcome.text.split("\n")[2])
        read += [fragment["text"] for fragment in page["fragments"]]
        if not page["has_more"]:
            break
        start = page["next_from_seg"]
    assert read == PARAGRAPHS

    chat_view = (await client.get(f"/kb/chats/{chat['id']}")).json()
    message = chat_view["messages"][-1]
    cites = [part["citation"] for part in chips(message, "cite")]
    assert [(cite["seg"], cite["quote"]) for cite in cites] == [
        (last["seg"], "энтропия Шеннона измеряется в битах"),
        (1, None),  # not verbatim in the pasted text: not shown as an exact quote
    ]
