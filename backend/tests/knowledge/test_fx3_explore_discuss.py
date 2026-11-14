"""FX-3: Discuss binds a chat to its Explore finding — the card is service context of every
question (never a fake user message), and once the paper is a material the same chat answers
from its full text with numbered segments. Fixtures only: no model and no science API is called.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from skaz.knowledge.agents.engine import AgentTurn
from skaz.knowledge.api.schemas_explore import KbFunnelStart
from skaz.knowledge.api.schemas_explore_common import KbRunBudget
from skaz.knowledge.api.schemas_science import KbScienceText
from skaz.knowledge.chats.context import ContextBuilder
from skaz.knowledge.chats.model import Chat, MessageInput
from skaz.knowledge.chats.resolve import MaterialReader
from skaz.knowledge.chats.store import ChatRepository
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService
from tests.knowledge.chat_support import Agents, connect, finished, install, text
from tests.knowledge.ingest_support import add_material
from tests.knowledge.test_b2_funnel import REAL_ABSTRACT, run_to_end, work
from tests.knowledge.test_b2_funnel import parts as parts  # fixture re-export

PAPER_TEXT = "Section 1. Routing experts improves accuracy. Section 2. The exact number is 42%."
QUESTION = "What is the paper about?"
CARD_NOTE = "This chat is discussing a paper from Explore that is not in the user's materials yet"
MATERIAL_NOTE = "This chat is discussing a paper from Explore that is in the user's materials"


async def search(p: SimpleNamespace) -> list[Any]:
    run = await run_to_end(p, KbFunnelStart(query="agents", channels=["search"]))
    found = await p.funnel.findings(run_id=run.id)
    return [f for g in found.groups for f in g.findings]


def request_text(kb: KnowledgeService, chat_id: str, question: str = QUESTION) -> str:
    """What the agent would receive for ``question`` in the chat ``chat_id``."""
    chat = Chat(id=chat_id, title="Chat", title_auto=True, pinned=False, engine="codex", model=None,
                effort=None, recording_material_id=None, folder_ids=(), unread=False, last_preview="",
                created_at="", updated_at="")
    return ContextBuilder(kb, MaterialReader(kb)).request(chat, MessageInput(text=question),
                                                          lambda _id: None)


# -- the Discuss click ---------------------------------------------------------------------------


async def test_discuss_opens_a_clean_chat_bound_to_the_finding(parts: SimpleNamespace) -> None:
    parts.science.search_works = [work(1, title="Routing experts", abstract=REAL_ABSTRACT, topics=["T1"])]
    (finding,) = await search(parts)
    reads_before = parts.science.count("read_text")
    talk = await parts.funnel.discuss(finding.id)
    # The chat is created from the paper's title, and nothing is sent in the user's name (FX-3).
    assert parts.chats.created == ["Routing experts"]
    assert parts.chats.sent == []
    assert talk.material_id is None
    assert parts.science.count("read_text") == reads_before  # Discuss downloads nothing
    # A second click returns the same chat.
    assert (await parts.funnel.discuss(finding.id)).chat_id == talk.chat_id
    assert len(parts.chats.created) == 1


async def test_the_card_reaches_the_agent_as_service_context_not_as_a_message(
    parts: SimpleNamespace,
) -> None:
    parts.science.search_works = [work(1, title="Routing experts", abstract=REAL_ABSTRACT, topics=["T1"])]
    (finding,) = await search(parts)
    talk = await parts.funnel.discuss(finding.id)
    context = request_text(parts.kb, talk.chat_id)
    assert CARD_NOTE in context
    assert '<untrusted-data label="paper card">' in context
    assert "Routing experts" in context and REAL_ABSTRACT in context
    assert "Add to materials" in context  # the agent points at the button of this chat
    assert context.endswith(f"The user's message:\n{QUESTION}")
    assert "paper in materials" not in context


async def test_after_add_to_materials_the_same_chat_sees_the_full_text(parts: SimpleNamespace) -> None:
    parts.science.search_works = [work(1, title="Routing experts", abstract=REAL_ABSTRACT, topics=["T1"])]
    (finding,) = await search(parts)
    talk = await parts.funnel.discuss(finding.id)
    assert CARD_NOTE in request_text(parts.kb, talk.chat_id)  # the card first
    parts.science.texts["work-1"] = KbScienceText(
        work_id="work-1", kind="arxiv_html", text=PAPER_TEXT,
        source_url="https://arxiv.org/html/1", access=finding.work.access,
    )
    added = await parts.funnel.add_to_materials(finding.id)
    assert added.material_id is not None
    # The next question of the same chat gets the material's text with segment numbers, not the card.
    context = request_text(parts.kb, talk.chat_id, "What are the exact numbers?")
    assert MATERIAL_NOTE in context and f"(material id {added.material_id})" in context
    assert '<untrusted-data label="paper in materials">' in context
    assert f"[{added.material_id}:1]" in context  # the first fragment, citable as ⟦m:<id>:1⟧
    assert "Routing experts improves accuracy" in context
    assert f"⟦m:{added.material_id}:<seg>|<exact words>⟧" in context
    assert "skaz_read_material" in context
    assert CARD_NOTE not in context and "paper card" not in context


async def test_discuss_on_a_paper_already_in_materials_binds_the_chat_at_once(
    parts: SimpleNamespace,
) -> None:
    parts.science.search_works = [work(1, title="Routing experts", abstract=REAL_ABSTRACT, topics=["T1"])]
    (finding,) = await search(parts)
    material_id = add_material(parts.kb, "Papers", "Routing experts",
                               [FragmentInput(text=PAPER_TEXT)], kind="text")
    parts.funnel.store.set_material(finding.id, material_id)
    talk = await parts.funnel.discuss(finding.id)
    assert talk.material_id == material_id
    chat = ChatRepository(parts.kb.db).get(talk.chat_id)
    record = parts.kb.material_repo.get(material_id)
    assert chat is not None and record.folder_id in chat.folder_ids  # the folder joins the chat
    context = request_text(parts.kb, talk.chat_id)
    assert MATERIAL_NOTE in context and f"[{material_id}:1]" in context
    assert CARD_NOTE not in context


# -- over the API --------------------------------------------------------------------------------


@pytest.fixture
async def env(kb_app: Any, kb_client: Any) -> Any:
    runtime = kb_app.state.runtime
    agents = Agents()
    install(runtime, agents)
    library = await connect(kb_client, runtime)
    turns: list[AgentTurn] = []

    def capture(turn: AgentTurn) -> Any:
        turns.append(turn)
        return text("OK.")

    for engine_id in list(agents.scripts):
        agents.scripts[engine_id] = capture
    yield SimpleNamespace(client=kb_client, runtime=runtime, chats=runtime.kb_chats, agents=agents,
                          turns=turns, library=library)
    await runtime.kb_chats.close()


def seed_finding(runtime: Any, title: str = "Routing experts") -> str:
    """A finding row as a finished search would leave it (no science call)."""
    budget = KbRunBudget(unit="candidate", limit=30, used=0, remaining=30, total_used=0, batch=1,
                         free_only=True)
    job = runtime.kb_jobs.create("explore", "Agents", "collect", budget)
    store = runtime.kb_explore.store
    store.create_run(job.id, area_id=None, task_id=None, request={})
    found = work(1, title=title, abstract=REAL_ABSTRACT, topics=["T1"])
    return str(
        store.add_finding(
            run_id=job.id, task_id=None, area_id=None, work_id=found.id, channel="search", label="new",
            reason="new", theses=[], details={"work": found.model_dump(mode="json")},
        )
    )


async def ask(env: Any, chat_id: str, question: str) -> None:
    response = await env.client.post(f"/kb/chats/{chat_id}/messages", json={"text": question})
    assert response.status_code == 202, response.text
    await finished(env.chats)


def last_request(env: Any) -> str:
    return str(env.turns[-1].messages[-1].content)


async def test_discuss_api_returns_a_clean_chat_with_the_badge(env: Any) -> None:
    finding_id = seed_finding(env.runtime)
    response = await env.client.post(f"/kb/explore/findings/{finding_id}/discuss")
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["finding_id"], body["material_id"]) == (finding_id, None)
    chat_id = body["chat_id"]
    chat = (await env.client.get(f"/kb/chats/{chat_id}")).json()
    assert chat["messages"] == []  # no fake user message: the chat opens clean
    assert chat["discuss_finding"] == {"finding_id": finding_id, "title": "Routing experts",
                                       "material_id": None, "importing": False}
    listed = (await env.client.get("/kb/chats")).json()
    (entry,) = [item for item in listed if item["id"] == chat_id]
    assert entry["discuss_finding"]["finding_id"] == finding_id


async def test_the_agent_sees_the_card_and_the_stored_question_stays_the_user_s_own(env: Any) -> None:
    finding_id = seed_finding(env.runtime)
    chat_id = (await env.client.post(f"/kb/explore/findings/{finding_id}/discuss")).json()["chat_id"]
    await ask(env, chat_id, QUESTION)
    request = last_request(env)
    assert CARD_NOTE in request and '<untrusted-data label="paper card">' in request
    assert "Routing experts" in request and REAL_ABSTRACT in request
    stored = (await env.client.get(f"/kb/chats/{chat_id}")).json()
    (user,) = [message for message in stored["messages"] if message["role"] == "user"]
    assert user["input"]["text"] == QUESTION  # the card never becomes the user's words


async def test_after_the_import_the_same_chat_answers_from_the_material(env: Any) -> None:
    finding_id = seed_finding(env.runtime)
    chat_id = (await env.client.post(f"/kb/explore/findings/{finding_id}/discuss")).json()["chat_id"]
    await ask(env, chat_id, QUESTION)
    assert CARD_NOTE in last_request(env)
    # «Add to materials» finished (FX-2's import writes exactly this link).
    material_id = add_material(env.runtime.kb, "Papers", "Routing experts",
                               [FragmentInput(text=PAPER_TEXT)], kind="text")
    env.runtime.kb_explore.store.set_material(finding_id, material_id)
    await ask(env, chat_id, "What are the exact numbers?")
    request = last_request(env)
    assert MATERIAL_NOTE in request and f"(material id {material_id})" in request
    assert f"[{material_id}:1]" in request and "The exact number is 42%" in request
    assert CARD_NOTE not in request
    badge = (await env.client.get(f"/kb/chats/{chat_id}")).json()["discuss_finding"]
    assert badge["material_id"] == material_id and badge["importing"] is False
