"""D: Mermaid diagrams — in chat answers on the agent's judgement or on request, in the wiki only
through "Save to wiki", as an agent-explanation block with links to the cited passages under it.

The fake engine only scripts what an agent streams; it proves SKAZ's handling of the answer,
never what a real model writes.
"""
from __future__ import annotations

import inspect
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.chats import context as chat_context
from skaz.knowledge.chats.service import ChatService
from skaz.knowledge.ingest import prompts as ingest_prompts
from skaz.knowledge.markdown.page import parse_page, render_page
from skaz.knowledge.wiki import prompts as wiki_prompts
from tests.knowledge.chat_support import Agents, Library, connect, finished, install, text


@dataclass
class Env:
    client: httpx.AsyncClient
    runtime: Any
    chats: ChatService
    agents: Agents
    library: Library

    async def answered(self, question: str) -> tuple[str, dict[str, Any]]:
        chat = (await self.client.post("/kb/chats", json={})).json()
        sent = await self.client.post(f"/kb/chats/{chat['id']}/messages", json={"text": question})
        assert sent.status_code == 202, sent.text
        await finished(self.chats)
        view = (await self.client.get(f"/kb/chats/{chat['id']}")).json()
        answer = next(m for m in view["messages"] if m["id"] == sent.json()["assistant"]["id"])
        return chat["id"], answer

    async def save(self, chat_id: str, message_id: str) -> httpx.Response:
        return await self.client.post(f"/kb/chats/{chat_id}/messages/{message_id}/save")

    def page_text(self, title: str) -> str:
        path = Path(self.runtime.kb.library_root) / "Wiki" / "Analyses" / f"{title}.md"
        return path.read_text(encoding="utf-8")


@pytest.fixture
async def env(kb_app: Any, kb_client: httpx.AsyncClient) -> AsyncIterator[Env]:
    runtime = kb_app.state.runtime
    agents = Agents()
    install(runtime, agents)
    library = await connect(kb_client, runtime)
    yield Env(kb_client, runtime, runtime.kb_chats, agents, library)
    await runtime.kb_chats.close()


FLOW = "flowchart LR\n  A[Беспорядок] --> B[Энтропия]"


async def test_a_cited_diagram_is_saved_as_an_explanation_block_with_its_links_under_it(env: Env) -> None:
    lib = env.library
    env.agents.scripts["codex"] = lambda _turn: text(
        "Схема:\n\n```mermaid\n", FLOW, "\n```\n",
        f"⟦m:{lib.lecture}:1|мера беспорядка системы⟧\n\nГотово.",
    )
    chat_id, answer = await env.answered("Нарисуй схему энтропии")
    saved = await env.save(chat_id, answer["id"])
    assert saved.status_code == 200, saved.text
    written = env.page_text(saved.json()["title"])
    document = parse_page(written)
    diagram = next(block for block in document.blocks() if "```mermaid" in block.body)
    # An agent explanation, even with a checked quote: a diagram is the agent's drawing, not a source.
    assert diagram.kind == "explanation" and diagram.cites == ()
    lines = diagram.body.splitlines()
    assert lines[:4] == ["```mermaid", "flowchart LR", "  A[Беспорядок] --> B[Энтропия]", "```"]
    # The links to the cited passages stand under the diagram, outside the fence.
    assert lines[4].startswith("[[Materials/Физика/Лекция 8/Лекция 8#^seg-1|")
    assert render_page(document) == written


async def test_a_diagram_without_citations_is_left_out_and_the_rest_is_saved_with_a_warning(env: Env) -> None:
    # Decision 9 (2026-10-21): an uncited diagram doesn't block the save — the answer is saved
    # without it, and the user is told what was left out and why.
    lib = env.library
    env.agents.scripts["codex"] = lambda _turn: text(
        f"Энтропия — мера беспорядка ⟦m:{lib.lecture}:1|мера беспорядка системы⟧.\n\n",
        "```mermaid\n", FLOW, "\n```\n",
        # A wiki page is not a cited passage.
        f"⟦p:{lib.concept}⟧\n",
    )
    chat_id, answer = await env.answered("Схема без ссылок")
    saved = await env.save(chat_id, answer["id"])
    assert saved.status_code == 200, saved.text
    assert saved.json()["warning"] == "Saved without 1 diagram: it has no quotes from your materials."
    written = env.page_text(saved.json()["title"])
    assert "мера беспорядка" in written
    assert "mermaid" not in written and "Беспорядок]" not in written
    view = (await env.client.get(f"/kb/chats/{chat_id}")).json()
    assert next(m for m in view["messages"] if m["id"] == answer["id"])["saved_page_id"] == saved.json()["id"]


async def test_a_cited_diagram_saves_without_a_warning_and_two_uncited_ones_are_counted(env: Env) -> None:
    lib = env.library
    env.agents.scripts["codex"] = lambda _turn: text(
        "```mermaid\n", FLOW, "\n```\n", f"⟦m:{lib.lecture}:1|мера беспорядка системы⟧\n\n",
        "```mermaid\nflowchart TD\n  X --> Y\n```\n\n",
        "```mermaid\nflowchart TD\n  P --> Q\n```\n",
    )
    chat_id, answer = await env.answered("Три схемы")
    saved = await env.save(chat_id, answer["id"])
    assert saved.status_code == 200, saved.text
    assert saved.json()["warning"] == "Saved without 2 diagrams: they have no quotes from your materials."
    written = env.page_text(saved.json()["title"])
    assert written.count("```mermaid") == 1 and "X --> Y" not in written and "P --> Q" not in written

    env.agents.scripts["codex"] = lambda _turn: text("```mermaid\n", FLOW, "\n```\n",
                                                     f"⟦m:{lib.lecture}:1|мера беспорядка системы⟧")
    chat_id, answer = await env.answered("Одна схема со ссылкой")
    saved = await env.save(chat_id, answer["id"])
    assert saved.status_code == 200, saved.text
    assert saved.json()["warning"] is None


async def test_an_answer_that_is_only_an_uncited_diagram_is_not_saved_and_says_why(env: Env) -> None:
    env.agents.scripts["codex"] = lambda _turn: text("```mermaid\n", FLOW, "\n```\n")
    before = {page.id for page in env.runtime.kb.pages(kind="analysis")}
    chat_id, answer = await env.answered("Только схема")
    refused = await env.save(chat_id, answer["id"])
    assert refused.status_code == 422, refused.text
    assert refused.json()["detail"] == (
        "Nothing was saved: the diagram has no quotes from your materials. "
        "Ask the agent to cite the sources of the diagram, then save again.")
    assert {page.id for page in env.runtime.kb.pages(kind="analysis")} == before


async def test_saving_the_whole_chat_leaves_out_an_uncited_diagram_with_a_warning(env: Env) -> None:
    lib = env.library
    env.agents.scripts["codex"] = lambda _turn: text(
        f"Энтропия — мера беспорядка ⟦m:{lib.lecture}:1|мера беспорядка системы⟧.\n\n",
        "```mermaid\n", FLOW, "\n```\n",
    )
    chat_id, _answer = await env.answered("Чат со схемой")
    saved = await env.client.post(f"/kb/chats/{chat_id}/save")
    assert saved.status_code == 200, saved.text
    assert saved.json()["warning"] == "Saved without 1 diagram: it has no quotes from your materials."
    assert "mermaid" not in env.page_text(saved.json()["title"])


async def test_a_saved_diagram_stays_valid_mermaid_without_page_syntax(env: Env) -> None:
    lib = env.library
    env.agents.scripts["codex"] = lambda _turn: text(
        "```mermaid\nflowchart LR\n  %% the agent's comment [[x]]\n  A[[Подпрограмма]] --> B\n```\n",
        f"⟦m:{lib.lecture}:1|мера беспорядка системы⟧",
    )
    chat_id, answer = await env.answered("Подпрограмма")
    saved = await env.save(chat_id, answer["id"])
    assert saved.status_code == 200, saved.text
    body = next(block.body for block in parse_page(env.page_text(saved.json()["title"])).blocks()
                if "```mermaid" in block.body)
    # No wikilink or SKAZ-marker syntax inside the page, and nothing that breaks Mermaid's parser
    # ("% %" or "[ [" would): comments go, a subroutine box becomes a plain box.
    fence = body.split("```")[1]
    assert "[[" not in fence and "%%" not in fence and "% %" not in fence and "[ [" not in fence
    assert "A[Подпрограмма] --> B" in fence


def test_the_chat_agent_is_told_when_and_how_to_draw_and_the_wiki_agents_are_not() -> None:
    rules = chat_context.instructions("ru")
    assert "```mermaid" in rules
    assert "citation token inside a diagram" in rules
    # Automatic wiki ingest/maintenance never draws diagrams (decision 9).
    for module in (wiki_prompts, ingest_prompts):
        assert "mermaid" not in inspect.getsource(module).lower()


async def test_editing_a_saved_diagram_keeps_the_fence_and_its_citation_links_under_it(env: Env) -> None:
    lib = env.library
    env.agents.scripts["codex"] = lambda _turn: text(
        "```mermaid\n", FLOW, "\n```\n", f"⟦m:{lib.lecture}:1|мера беспорядка системы⟧",
    )
    chat_id, answer = await env.answered("Схема для правки")
    saved = await env.save(chat_id, answer["id"])
    assert saved.status_code == 200, saved.text
    page_id = saved.json()["id"]
    page = (await env.client.get(f"/kb/wiki/pages/{page_id}")).json()
    block = next(b for b in page["blocks"] if "```mermaid" in b["text"])
    # The editor gets the diagram text without the citation links (the app hides them) — the user
    # edits the Mermaid text, with an empty line in it, and saves.
    edited = "```mermaid\nflowchart LR\n  A[Гиббс] --> B[Энтропия]\n\n  B --> C[Шеннон]\n```"
    response = await env.client.put(f"/kb/wiki/pages/{page_id}/blocks/{block['id']}", json={"text": edited})
    assert response.status_code in (200, 204), response.text
    document = parse_page(env.page_text(saved.json()["title"]))
    body = next(b.body for b in document.blocks() if "```mermaid" in b.body)
    lines = body.splitlines()
    closing = lines.index("```", 1)
    assert lines[:closing + 1] == edited.splitlines()
    # The citation links stay with the diagram, on their own line under the closing fence.
    assert lines[closing + 1].startswith("[[Materials/Физика/Лекция 8/Лекция 8#^seg-1|")
