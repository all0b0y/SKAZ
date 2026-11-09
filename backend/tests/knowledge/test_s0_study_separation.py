"""0.4.0 S0 (N4-7, N4-8): decks and tests are not wiki pages.

They stay out of every wiki search and every agent answer tool; only the dedicated read-only study tools
reach them. A test not opened for 60 days is archived; a deck never is (SKAZ only suggests it); deletion
is manual and takes the mistake history along. SKAZ's own code over a temporary library; the agent is a
tool call with the run's context, as its MCP or dynamic-tool call would be.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge.agents.tools import ToolContext
from skaz.knowledge.permissions.search_rules import ChatRules
from skaz.knowledge.permissions.store import RunRef
from skaz.knowledge.study.scheduling import CardState, review
from skaz.knowledge.study.shelf import ARCHIVE_TEST_AFTER, SUGGEST_DECK_AFTER, delete_warning
from skaz.knowledge.study.store import StudyBlock
from skaz.knowledge.wiki.links import LinkResolver

from .chat_support import Library, connect

RUN_ID = "msg-answer-1"
ENTROPY = "мера беспорядка системы"
SECOND_LAW = "запрещает вечный двигатель второго рода"
WORD = "Клаузиусэнтропия"  # only in the cards of the deck and the questions of the test
START = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)


class Clock:
    def __init__(self) -> None:
        self.now = START

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
async def world(kb_client: Any, kb_app: Any) -> tuple[Any, Library, RunRef, Clock]:
    runtime = kb_app.state.runtime
    runtime.test_client = kb_client  # the routes of this runtime, for the helpers below
    library = await connect(kb_client, runtime)
    view = await runtime.kb_chats.create(title="Study")
    ref = RunRef(RUN_ID, view.chat.id, RUN_ID, "claude_code")
    runtime.kb_study_tools.runs = lambda run_id: ref if run_id == RUN_ID else None
    runtime.kb_wiki_edits.runs = runtime.kb_study_tools.runs
    clock = Clock()
    runtime.kb_study._clock = clock
    return runtime, library, ref, clock


async def _call(runtime: Any, name: str, arguments: dict[str, Any]) -> Any:
    return await runtime.kb_tools.call(name, arguments, ToolContext(RUN_ID, "claude_code"))


async def _tool(runtime: Any, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    outcome = await _call(runtime, name, arguments)
    assert not outcome.is_error, outcome.text
    # A library tool's payload comes wrapped as untrusted data; a study tool's is plain JSON.
    text = outcome.text
    data: dict[str, Any] = json.loads(text[text.index("{"): text.rindex("}") + 1])
    return data


def _items(result: dict[str, Any]) -> list[dict[str, Any]]:
    """The items out of their untrusted-data wrapping."""
    text = result["items"]
    body = text[text.index("["): text.rindex("]") + 1]
    items: list[dict[str, Any]] = json.loads(body)
    return items


def _cite(library: Library, seg: int, quote: str) -> dict[str, Any]:
    return {"material_id": library.lecture, "seg": seg, "quote": quote}


async def _saved_deck(runtime: Any, library: Library, title: str = "Колода") -> StudyBlock:
    made = await _tool(runtime, "skaz_study_make_deck", {"title": title, "cards": [
        {"question": f"Кто такой {WORD}?", "answer": "Мера беспорядка.",
         "citations": [_cite(library, 1, ENTROPY)]},
        {"question": "Что запрещает второе начало?", "answer": "Вечный двигатель.",
         "citations": [_cite(library, 2, SECOND_LAW)]},
    ]})
    block = await asyncio.to_thread(runtime.kb_study.save, made["study_id"], "allow")
    saved: StudyBlock = block
    return saved


async def _test_block(runtime: Any, library: Library, title: str = "Тест", *,
                      save: bool = True) -> StudyBlock:
    made = await _tool(runtime, "skaz_study_make_test", {"title": title, "questions": [
        {"type": "short", "question": f"Кто такой {WORD}?", "answers": ["мера беспорядка"],
         "accept": ["мера"], "citations": [_cite(library, 1, ENTROPY)]},
        {"type": "short", "question": "Что запрещает второе начало?", "answers": ["вечный двигатель"],
         "citations": [_cite(library, 2, SECOND_LAW)]},
    ]})
    if not save:
        block: StudyBlock = runtime.kb_study.get(made["study_id"])
        return block
    saved: StudyBlock = await asyncio.to_thread(runtime.kb_study.save, made["study_id"], "allow")
    return saved


# -- where they live -----------------------------------------------------------------------------------


async def test_saved_decks_and_tests_are_written_to_study_and_not_in_the_wiki_index(world: Any) -> None:
    runtime, library, _ref, _clock = world
    deck = await _saved_deck(runtime, library)
    test = await _test_block(runtime, library)
    root: Path = runtime.kb.require().root
    assert runtime.kb.page_repo.get(deck.page_id).rel_path == "Study/Decks/Колода.md"
    assert runtime.kb.page_repo.get(test.page_id).rel_path == "Study/Tests/Тест.md"
    assert runtime.kb_study.proposed_path(deck) == "Study/Decks/Колода.md"
    assert (root / "Study/Decks/Колода.md").is_file() and not (root / "Wiki/Decks").exists()
    index = (root / "Wiki/index.md").read_text(encoding="utf-8")
    assert "Колода" not in index and "Тест" not in index and "Study/" not in index


async def test_a_moved_library_gets_a_clean_wiki_index_after_the_scan(world: Any) -> None:
    runtime, library, _ref, _clock = world
    deck = await _saved_deck(runtime, library)
    root: Path = runtime.kb.require().root
    old = root / "Wiki/Decks"
    old.mkdir()
    (root / "Study/Decks/Колода.md").rename(old / "Колода.md")
    old_index = "# Index\n\n## Decks\n\n- [[Wiki/Decks/Колода|Колода]] — 2\n"
    (root / "Wiki/index.md").write_text(old_index, encoding="utf-8")

    await asyncio.to_thread(runtime.kb.rescan)

    assert runtime.kb.page_repo.get(deck.page_id).rel_path == "Study/Decks/Колода.md"
    assert "Колода" not in (root / "Wiki/index.md").read_text(encoding="utf-8")


async def test_the_watcher_follows_an_outside_edit_of_a_deck_in_study(world: Any) -> None:
    runtime, library, _ref, _clock = world
    deck = await _saved_deck(runtime, library)
    watcher = runtime.kb_wiki.watcher
    await asyncio.to_thread(watcher.poll)
    root: Path = runtime.kb.require().root
    (root / "Study/Decks/Колода.md").rename(root / "Study/Decks/Переименована.md")
    assert await asyncio.to_thread(watcher.poll) == 1
    assert runtime.kb.page_repo.get(deck.page_id).title == "Переименована"


# -- wiki search and the agent's answer tools never return them ------------------------------------------


async def test_search_never_returns_decks_or_tests(world: Any) -> None:
    runtime, library, _ref, _clock = world
    await _saved_deck(runtime, library, "Колода Гиббс")
    await _test_block(runtime, library, "Тест Гиббс")

    for query in (WORD, "Колода", "Тест Гиббс"):
        results = await asyncio.to_thread(runtime.kb.search, query)
        assert results.blocks == () and results.pages == ()
    assert (await asyncio.to_thread(runtime.kb.search, "энтропия")).fragments  # materials are still found

    response = await _client_get(runtime, f"/kb/search?q={WORD}")
    assert response["blocks"] == [] and response["pages"] == [] and response["counts"]["wiki"] == 0
    assert (await _client_get(runtime, "/kb/search?q=Колода"))["counts"]["wiki"] == 0


async def _client_get(runtime: Any, path: str) -> Any:
    client = runtime.test_client
    response = await client.get(path)
    assert response.status_code == 200, response.text
    return response.json()


async def test_a_hit_cap_is_not_eaten_by_decks(world: Any) -> None:
    """The filter runs before the ranking's cut: decks can't push a concept out of the results."""
    runtime, library, _ref, _clock = world
    for number in range(3):
        await _saved_deck(runtime, library, f"Колода {number}")
    concept = runtime.kb.page_repo.get(library.concept)
    results = await asyncio.to_thread(lambda: runtime.kb.search(concept.title, limit=1))
    assert [hit.id for hit in results.pages] == [concept.id]


async def test_the_agents_answer_tools_never_return_decks_or_tests(world: Any) -> None:
    runtime, library, _ref, _clock = world
    deck = await _saved_deck(runtime, library)
    test = await _test_block(runtime, library)

    found = await _tool(runtime, "skaz_search", {"query": WORD})
    assert found["blocks"] == [] and found["pages"] == []
    found = await _tool(runtime, "skaz_search", {"query": "Колода"})
    assert found["pages"] == []
    index = await _tool(runtime, "skaz_wiki_index", {})
    assert {page["kind"] for page in index["pages"]} <= {"concept", "note", "folder", "analysis"}
    assert index["total"] == len(index["pages"])
    # Asking by kind isn't even offered to the agent.
    assert (await _call(runtime, "skaz_wiki_index", {"kind": "deck"})).is_error
    assert (await _call(runtime, "skaz_search", {"query": "x", "kinds": ["test"]})).is_error
    for page_id in (deck.page_id, test.page_id):
        outcome = await _call(runtime, "skaz_read_page", {"page_id": page_id})
        assert outcome.is_error and "skaz_study_read" in outcome.text
    outcome = await _call(runtime, "skaz_read_page", {"title": "Колода"})
    assert outcome.is_error and "No page has this title" in outcome.text
    # A wiki edit can't reach them either, even from where 0.3.x kept them.
    outcome = await _call(runtime, "skaz_wiki_rename_page", {"page_id": deck.page_id, "title": "Другое"})
    assert outcome.is_error and "aren't wiki pages" in outcome.text


async def test_a_title_link_means_the_wiki_page_not_a_deck_of_the_same_name(world: Any) -> None:
    runtime, library, _ref, _clock = world
    concept = runtime.kb.page_repo.get(library.concept)
    deck = await _saved_deck(runtime, library, concept.title)
    [link] = LinkResolver(runtime.kb.db).links(f"[[{concept.title}]]")
    assert link.page_id == concept.id
    # A link written before the move still finds the deck.
    [old] = LinkResolver(runtime.kb.db).links(f"[[Wiki/Decks/{concept.title}|x]]")
    assert old.page_id == deck.page_id
    assert runtime.kb_wiki.graph.refresh(force=True) is not None


async def test_a_concept_page_does_not_name_the_decks_linking_to_it(world: Any) -> None:
    runtime, library, _ref, _clock = world
    concept = runtime.kb.page_repo.get(library.concept)
    deck = await _saved_deck(runtime, library)
    root: Path = runtime.kb.require().root
    path = root / "Study/Decks/Колода.md"
    path.write_text(path.read_text(encoding="utf-8") + f"\nСм. [[{concept.rel_path.removesuffix('.md')}]]\n",
                    encoding="utf-8")
    await asyncio.to_thread(runtime.kb.rescan)
    await asyncio.to_thread(runtime.kb_wiki.graph.refresh, force=True)
    detail = await asyncio.to_thread(runtime.kb_wiki.page, concept.id)
    assert deck.page_id not in [ref.id for ref in [*detail.related, *detail.mentioned_in]]


async def test_the_wiki_page_list_leaves_them_out_and_mentions_keep_them(world: Any) -> None:
    runtime, library, _ref, _clock = world
    deck = await _saved_deck(runtime, library)
    listed = await _client_get(runtime, "/kb/wiki/pages")
    assert deck.page_id not in [page["id"] for page in listed]
    # A mention is the user's own choice: "@deck, let's review" (S12).
    mentions = await _client_get(runtime, "/kb/mentions?q=Колода")
    assert [page["id"] for page in mentions["pages"]] == [deck.page_id]


# -- the study tools: past questions and mistakes ----------------------------------------------------------


async def test_past_questions_on_a_topic_saved_or_only_in_a_chat(world: Any) -> None:
    runtime, library, _ref, _clock = world
    await _saved_deck(runtime, library)
    test = await _test_block(runtime, library)
    chat_only = await _test_block(runtime, library, "В чате", save=False)

    result = await _tool(runtime, "skaz_study_past_questions", {"topic": WORD[:12]})

    assert "untrusted" in result["items"].lower() or "<" in result["items"]
    items = _items(result)
    assert result["count"] == len(items) == 3
    assert {item["in"] for item in items} == {"Колода", "Тест", "В чате"}
    assert all(WORD in item["question"] for item in items)
    # Only what's needed not to repeat them: no answers, and so nothing given away.
    assert not any("right_answer" in item or "answers" in item or "source" in item for item in items)
    by_title = {item["in"]: item for item in items}
    assert by_title["Тест"]["page_id"] == test.page_id
    assert by_title["В чате"]["page_id"] is None and chat_only.id in by_title["В чате"]["where"]
    assert by_title["Колода"]["kind"] == "flashcard" and by_title["Тест"]["kind"] == "test question"

    nothing = await _tool(runtime, "skaz_study_past_questions", {"topic": "нетпохожегослова"})
    assert nothing["count"] == 0 and "note" in nothing


async def test_past_questions_on_a_concept_by_shared_fragments(world: Any) -> None:
    runtime, library, _ref, _clock = world
    await _test_block(runtime, library)
    concept = runtime.kb.page_repo.get(library.concept)
    cited = {(cite.material_id, cite.seg) for block in runtime.kb.page_repo.blocks(concept.id)
             for cite in block.citations}
    assert (library.lecture, 1) in cited, "the seeded concept cites the lecture's first fragment"

    result = await _tool(runtime, "skaz_study_past_questions", {"concept_page_id": concept.id})

    assert [item["question"] for item in _items(result)] == [f"Кто такой {WORD}?"]
    refused = await _call(runtime, "skaz_study_past_questions", {"concept_page_id": "pg-nope"})
    assert refused.is_error and "Concept page not found" in refused.text


async def test_mistakes_are_questions_below_one_and_cards_with_again_or_lapses(world: Any) -> None:
    runtime, library, _ref, clock = world
    study = runtime.kb_study
    deck = await _saved_deck(runtime, library)
    test = await _test_block(runtime, library)
    first, second = [q.id for q in study.questions(test)]
    # The test shown again from its page: one question wrong, one right; an open answer isn't guessed.
    await asyncio.to_thread(study.answer, test.id, first, text="не знаю")
    await asyncio.to_thread(study.answer, test.id, second, text="вечный двигатель")
    await asyncio.to_thread(study.finish, test.id)
    card_ids = [card.id for card, _page in study.cards(deck)]
    await asyncio.to_thread(study.grade, deck.id, card_ids[0], "again")
    await asyncio.to_thread(study.grade, deck.id, card_ids[1], "good")
    assert clock.now == START

    result = await _tool(runtime, "skaz_study_mistakes", {})

    items = _items(result)
    assert {item["item_id"] for item in items} == {first, card_ids[0]}
    question = next(item for item in items if item["item_id"] == first)
    assert question["kind"] == "test question"
    assert (question["times_wrong"], question["times_asked"]) == (1, 1)
    assert question["right_answer"] == ["мера беспорядка"] and "не знаю" in question["last_answer"]
    assert question["last_score"] == 0.0 and question["source"][0]["quote"] == ENTROPY
    card = next(item for item in items if item["item_id"] == card_ids[0])
    assert card["kind"] == "flashcard" and card["times_again"] == 1
    assert card["right_answer"] == ["Мера беспорядка."]

    narrowed = await _tool(runtime, "skaz_study_mistakes", {"topic": "второе начало"})
    assert narrowed["count"] == 0


async def test_a_later_right_answer_keeps_the_mistake_in_the_history_and_says_so(world: Any) -> None:
    runtime, library, _ref, _clock = world
    study = runtime.kb_study
    test = await _test_block(runtime, library)
    first = study.questions(test)[0].id
    await asyncio.to_thread(study.answer, test.id, first, text="не знаю")
    await asyncio.to_thread(study.finish, test.id)
    await asyncio.to_thread(study.retake, test.id, mistakes_only=True)
    await asyncio.to_thread(study.answer, test.id, first, text="мера")
    await asyncio.to_thread(study.finish, test.id)

    [item] = _items(await _tool(runtime, "skaz_study_mistakes", {}))

    assert (item["times_wrong"], item["times_asked"], item["last_score"]) == (1, 2, 1.0)
    assert item["right_since"] is True


async def test_an_unanswered_question_is_no_mistake_and_lapses_alone_count(world: Any) -> None:
    runtime, library, _ref, clock = world
    study = runtime.kb_study
    deck = await _saved_deck(runtime, library)
    await _test_block(runtime, library)
    card = study.cards(deck)[1][0].id
    assert deck.page_id is not None
    # A card forgotten before (its lapses in FSRS, no Again in the log of reviews).
    state, _ = review(CardState(card, deck.page_id), "good", mode="due", at=clock.now)
    study.store.put_cards([CardState(card, deck.page_id, state.fsrs, lapses=3, reps=5)], "n")

    [item] = _items(await _tool(runtime, "skaz_study_mistakes", {}))

    assert item["item_id"] == card and item["lapses"] == 3 and item["times_again"] == 0


async def test_the_chats_sources_narrow_both_tools(world: Any) -> None:
    runtime, library, ref, _clock = world
    study = runtime.kb_study
    test = await _test_block(runtime, library)
    first, second = [q.id for q in study.questions(test)]
    await asyncio.to_thread(study.answer, test.id, first, text="не знаю")
    await asyncio.to_thread(study.answer, test.id, second, text="не знаю")

    await asyncio.to_thread(runtime.kb_search_rules.set_chat, ref.chat_id,
                            ChatRules(excluded=(library.lecture,)))
    for name in ("skaz_study_past_questions", "skaz_study_mistakes"):
        result = await _tool(runtime, name, {})
        assert result["count"] == 0 and result["left_out"] == 2 and "left" in result["scope_note"]


async def test_the_study_tools_are_only_for_a_chat_and_change_nothing(world: Any) -> None:
    runtime, library, _ref, _clock = world
    test = await _test_block(runtime, library)
    outcome = await runtime.kb_tools.call("skaz_study_mistakes", {}, ToolContext("a-wiki-job", "claude_code"))
    assert outcome.is_error and "only possible in a chat" in outcome.text
    before = runtime.kb_study.store.attempts(test.id)
    await _tool(runtime, "skaz_study_mistakes", {})
    await _tool(runtime, "skaz_study_past_questions", {})
    assert runtime.kb_study.store.attempts(test.id) == before


# -- archive (N4-8) --------------------------------------------------------------------------------------


def _shelf(runtime: Any) -> dict[str | None, Any]:
    return {entry.page_id: entry for entry in runtime.kb_study.shelf.listing()}


async def test_a_test_not_opened_for_60_days_is_archived_and_stays_available_to_the_agent(world: Any) -> None:
    runtime, library, _ref, clock = world
    study = runtime.kb_study
    test = await _test_block(runtime, library)
    first = study.questions(test)[0].id
    await asyncio.to_thread(study.answer, test.id, first, text="не знаю")
    await asyncio.to_thread(study.shelf.opened, test.page_id)
    assert timedelta(days=60) == ARCHIVE_TEST_AFTER

    clock.now = START + timedelta(days=60) - timedelta(seconds=1)
    assert _shelf(runtime)[test.page_id].archived_at is None

    clock.now = START + timedelta(days=60)
    entry = _shelf(runtime)[test.page_id]
    assert entry.archived_at is not None and entry.archived_by == "auto"
    assert test.page_id not in study.shelf.visible_ids()
    assert test.page_id in study.shelf.archived_ids()
    # Hidden from the @ list; its questions and mistakes stay with the agent; the file stays.
    mentions = await _client_get(runtime, "/kb/mentions?q=Тест")
    assert mentions["pages"] == []
    assert _items(await _tool(runtime, "skaz_study_past_questions", {"topic": WORD}))[0]["archived"] is True
    assert [item["item_id"] for item in _items(await _tool(runtime, "skaz_study_mistakes", {}))] == [first]
    assert (runtime.kb.require().root / "Study/Tests/Тест.md").is_file()


async def test_opening_a_test_starts_the_60_days_again_and_brings_it_back(world: Any) -> None:
    runtime, library, _ref, clock = world
    study = runtime.kb_study
    test = await _test_block(runtime, library)
    await asyncio.to_thread(study.shelf.opened, test.page_id)
    clock.now = START + timedelta(days=59)
    await asyncio.to_thread(study.shelf.opened, test.page_id)
    clock.now = START + timedelta(days=100)
    assert _shelf(runtime)[test.page_id].archived_at is None

    clock.now = START + timedelta(days=200)
    assert _shelf(runtime)[test.page_id].archived_at is not None
    await asyncio.to_thread(study.shelf.opened, test.page_id)
    entry = _shelf(runtime)[test.page_id]
    assert entry.archived_at is None
    clock.now += timedelta(days=59)
    assert _shelf(runtime)[test.page_id].archived_at is None


async def test_showing_a_saved_test_counts_as_opening_and_an_agent_read_does_not(world: Any) -> None:
    runtime, library, ref, clock = world
    study = runtime.kb_study
    test = await _test_block(runtime, library)
    await asyncio.to_thread(study.shelf.opened, test.page_id)
    clock.now = START + timedelta(days=30)
    await _tool(runtime, "skaz_study_read", {"page_id": test.page_id})
    await _tool(runtime, "skaz_study_past_questions", {})
    assert _shelf(runtime)[test.page_id].opened_at == START.isoformat(timespec="seconds")
    await asyncio.to_thread(study.show_saved, ref, [test.page_id], "all")
    assert _shelf(runtime)[test.page_id].opened_at == clock.now.isoformat(timespec="seconds")


async def test_the_scan_archives_too(world: Any) -> None:
    runtime, library, _ref, clock = world
    test = await _test_block(runtime, library)
    await asyncio.to_thread(runtime.kb_study.shelf.opened, test.page_id)
    clock.now = START + timedelta(days=61)
    await asyncio.to_thread(runtime.kb.rescan)
    assert test.page_id in runtime.kb_study.shelf.stored_archived_ids()


async def test_a_page_first_seen_now_gets_the_full_60_days(world: Any) -> None:
    """What 0.3.x didn't record can't count against a test: the days start when SKAZ first sees it."""
    runtime, library, _ref, clock = world
    test = await _test_block(runtime, library)
    with runtime.kb.db.write() as connection:
        connection.execute("DELETE FROM study_shelf")
    clock.now = START + timedelta(days=400)
    assert _shelf(runtime)[test.page_id].archived_at is None
    clock.now += timedelta(days=60)
    assert _shelf(runtime)[test.page_id].archived_at is not None


def _learn_all(runtime: Any, deck: StudyBlock, moment: datetime) -> None:
    study = runtime.kb_study
    states = []
    for card, _page in study.cards(deck):
        state = CardState(card.id, deck.page_id or "")
        for days in (0, 2, 8, 20):
            state, _ = review(state, "easy", mode="due", at=moment + timedelta(days=days))
        states.append(state)
    study.store.put_cards(states, "n")


async def test_a_deck_is_never_archived_and_only_a_learned_unopened_one_gets_a_suggestion(world: Any) -> None:
    runtime, library, _ref, clock = world
    study = runtime.kb_study
    learned = await _saved_deck(runtime, library, "Выучена")
    learning = await _saved_deck(runtime, library, "В работе")
    _learn_all(runtime, learned, START)
    await asyncio.to_thread(study.shelf.opened, learned.page_id)
    await asyncio.to_thread(study.shelf.opened, learning.page_id)
    assert timedelta(days=60) == SUGGEST_DECK_AFTER

    clock.now = START + timedelta(days=59)
    assert not _shelf(runtime)[learned.page_id].suggest_archive

    clock.now = START + timedelta(days=365)
    shelf = _shelf(runtime)
    assert shelf[learned.page_id].suggest_archive and shelf[learned.page_id].archived_at is None
    assert not shelf[learning.page_id].suggest_archive and shelf[learning.page_id].archived_at is None

    # The user's answer: "not now" quiets it until it has been unopened that long again.
    await asyncio.to_thread(study.shelf.keep, learned.page_id)
    assert not _shelf(runtime)[learned.page_id].suggest_archive
    clock.now += timedelta(days=60)
    assert _shelf(runtime)[learned.page_id].suggest_archive

    await asyncio.to_thread(study.shelf.archive, learned.page_id)
    entry = _shelf(runtime)[learned.page_id]
    assert entry.archived_by == "user" and not entry.suggest_archive
    await asyncio.to_thread(study.shelf.unarchive, learned.page_id)
    assert _shelf(runtime)[learned.page_id].archived_at is None


def test_the_delete_warning_says_the_mistake_history_goes_too() -> None:
    for kind in ("deck", "test"):
        text = delete_warning(kind, attempts=0, reviews=0)
        assert "mistake history" in text and "can't be undone" in text
    assert "3 finished attempts" in delete_warning("test", attempts=3, reviews=0)
    assert "12 reviews" in delete_warning("deck", attempts=0, reviews=12)


async def test_nothing_deletes_by_itself_and_a_manual_delete_takes_the_history(world: Any) -> None:
    runtime, library, _ref, clock = world
    study = runtime.kb_study
    deck = await _saved_deck(runtime, library)
    test = await _test_block(runtime, library)
    first = study.questions(test)[0].id
    await asyncio.to_thread(study.answer, test.id, first, text="не знаю")
    await asyncio.to_thread(study.finish, test.id)
    card = study.cards(deck)[0][0].id
    await asyncio.to_thread(study.grade, deck.id, card, "again")
    await asyncio.to_thread(study.mark, test.id, [first], "unclear")
    clock.now = START + timedelta(days=4000)
    assert _shelf(runtime)  # the sweep ran
    root: Path = runtime.kb.require().root
    assert (root / "Study/Tests/Тест.md").is_file() and (root / "Study/Decks/Колода.md").is_file()
    assert len(_items(await _tool(runtime, "skaz_study_mistakes", {}))) == 2

    warning = await asyncio.to_thread(study.shelf.delete_warning_of, test.page_id)
    assert "mistake history" in warning.text and warning.attempts == 1
    await asyncio.to_thread(runtime.kb_wiki.delete_page, test.page_id)
    await asyncio.to_thread(runtime.kb_wiki.delete_page, deck.page_id)

    assert _items(await _tool(runtime, "skaz_study_mistakes", {})) == []
    assert study.store.attempts(test.id) == []
    assert study.store.cards([card]) == {} and study.store.last_rating(card) is None
    assert study.items.one(first) is None
    assert _shelf(runtime) == {}
    assert study.result(study.get(test.id)) is None
    log = (root / "Wiki/log.md").read_text(encoding="utf-8")
    assert "Колода" not in log and "Тест" not in log


async def test_the_routes_list_open_archive_and_warn(world: Any) -> None:
    runtime, library, _ref, clock = world
    deck = await _saved_deck(runtime, library)
    test = await _test_block(runtime, library)
    client = runtime.test_client

    listed = (await client.get("/kb/study-library")).json()
    assert [row["page_id"] for row in listed["decks"]] == [deck.page_id]
    assert [row["page_id"] for row in listed["tests"]] == [test.page_id]
    assert listed["archived"] == []

    clock.now = START + timedelta(days=30)
    opened = await client.post(f"/kb/study-library/{test.page_id}/opened")
    assert opened.status_code == 200 and opened.json()["opened_at"] == clock.now.isoformat(timespec="seconds")

    archived = (await client.post(f"/kb/study-library/{deck.page_id}/archive")).json()
    assert archived["archived_by"] == "user"
    listed = (await client.get("/kb/study-library")).json()
    assert listed["decks"] == [] and [row["page_id"] for row in listed["archived"]] == [deck.page_id]
    assert (await client.post(f"/kb/study-library/{deck.page_id}/unarchive")).json()["archived_at"] is None

    warning = (await client.get(f"/kb/study-library/{test.page_id}/delete-warning")).json()
    assert "mistake history" in warning["text"]

    for path in ("opened", "archive", "unarchive", "keep"):
        assert (await client.post(f"/kb/study-library/{library.concept}/{path}")).status_code == 404
    assert (await client.get(f"/kb/study-library/{library.concept}/delete-warning")).status_code == 404
