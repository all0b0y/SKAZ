"""P1b: the other twelve answer blocks, their Markdown (Copy, chat export, saved analysis pages),
block sources in the chat's folders, and composition (beside / link)."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.answer_blocks.md import Refs
from skaz.knowledge.answer_blocks.part import BlockPart, MaterialSource
from skaz.knowledge.answer_blocks.registry import BLOCKS, Broken, build_block
from skaz.knowledge.answer_blocks.text import block_agent_text, block_markdown
from skaz.knowledge.chats.model import part_from_json, part_to_json
from skaz.knowledge.markdown.page import parse_page
from tests.knowledge.chat_support import Agents, chips, connect, install, text
from tests.knowledge.test_p1_answer_blocks import Env, FakeChecker

REC, DOC = "m:mat-rec:1", "m:mat-doc:2"


def _build(data: dict[str, Any]) -> tuple[dict[str, Any], int]:
    built = build_block(json.dumps(data, ensure_ascii=False), FakeChecker())
    return json.loads(built.data), built.hidden


def _broken(data: dict[str, Any]) -> str:
    with pytest.raises(Broken) as error:
        build_block(json.dumps(data, ensure_ascii=False), FakeChecker())
    return str(error.value)


def _markdown(data: dict[str, Any], refs: Refs | None = None) -> str:
    checker = FakeChecker()
    built = build_block(json.dumps(data, ensure_ascii=False), checker)
    part = BlockPart("blk-1", "ready", built.kind, built.data)
    labels = [f"[{ref}]" for ref in checker.sources]
    times = ["00:01" if ref.startswith("m:mat-rec:") else None for ref in checker.sources]
    return block_markdown(part, refs or Refs(labels, times))


# -- the catalog -----------------------------------------------------------------------------


def test_the_catalog_has_the_fifteen_blocks_of_decision_4_with_valid_examples() -> None:
    assert list(BLOCKS) == ["compare", "pros_cons", "verdict", "timeline", "steps", "cause_chain",
                            "definition", "concept_cards", "hierarchy", "glossary", "key_numbers", "chart",
                            "quote", "disagreement", "action_items"]
    for spec in BLOCKS.values():
        spec.schema.model_validate(spec.example)
        assert 4 <= len(spec.when.split()) <= 22, spec.name  # decision 3: one short line in the index
        # Every example draws (in a fake library where all its made-up ids exist).
        built = build_block(json.dumps(spec.example), _Everything())
        assert built.kind == spec.name and built.hidden == 0, spec.name


def test_compare_puts_compared_objects_in_rows_and_criteria_in_columns() -> None:
    spec = BLOCKS["compare"]
    assert spec.when == ("two to six compared objects as rows, two to six criteria as columns "
                         "(a comparison table)")
    properties = spec.schema.model_json_schema()["properties"]
    assert properties["columns"]["description"] == "The comparison criteria (column headings)."
    assert properties["rows"]["description"] == "One row per compared object."
    assert spec.example["columns"] == ["Leader", "Used in"]
    assert [row["label"] for row in spec.example["rows"]] == ["Raft", "Paxos"]


def test_concept_cards_and_key_numbers_descriptions_match_their_schemas() -> None:
    concepts = BLOCKS["concept_cards"]
    assert concepts.when == ("the key concepts of a topic at a glance, each explained in one line "
                             "on its own card")
    numbers = BLOCKS["key_numbers"]
    assert numbers.when == "one to six numbers that matter, shown large with what each measures"
    schema = numbers.schema.model_json_schema()["properties"]["numbers"]
    assert (schema["minItems"], schema["maxItems"]) == (1, 6)


class _Everything(FakeChecker):
    def source(self, ref: str) -> int | None:
        if ref not in self.sources:
            self.sources.append(ref)
        return self.sources.index(ref)

    def timed(self, index: int) -> bool:
        return True


# -- each block: valid items drawn, invalid or unsourced ones hidden ---------------------------


def test_pros_cons_numbers_pros_and_cons_apart_and_needs_at_least_one() -> None:
    data, hidden = _build({"type": "pros_cons", "title": "Raft",
                           "pros": [{"text": "Simple", "cite": REC},
                                    {"text": "Made up", "cite": "m:mat-none:1"}],
                           "cons": [{"text": "Leader bottleneck", "basis": "agent"}]})
    assert hidden == 1 and data["title"] == "Raft"
    assert [(p["id"], p["text"]) for p in data["pros"]] == [("p1", "Simple")]
    assert [(c["id"], c["agent"]) for c in data["cons"]] == [("c1", True)]
    assert "at least one pro or con" in _broken({"type": "pros_cons", "pros": [], "cons": []})


def test_verdict_and_quote_are_one_item_without_which_the_block_is_broken() -> None:
    data, _ = _build({"type": "verdict",
                      "verdict": {"text": "Choose Raft", "reason": "Simpler", "cite": [REC, DOC]}})
    assert data["verdict"] == {"id": "v", "src": [0, 1], "agent": False, "text": "Choose Raft",
                               "reason": "Simpler"}
    assert "The verdict couldn't be shown" in _broken({"type": "verdict", "verdict": {"text": "x"}})
    data, _ = _build({"type": "quote", "quote": {"text": "The timeout is the trick.", "who": "Lecturer",
                                                 "cite": f"{REC}|The timeout is the trick"}})
    assert data["quote"]["who"] == "Lecturer" and data["quote"]["src"] == [0]
    assert "The quote couldn't be shown" in _broken(
        {"type": "quote", "quote": {"text": "x", "cite": "m:mat-none:1"}})


def test_a_deeply_nested_block_is_drawn_capped_or_broken_never_an_error() -> None:
    """FIX-1 F2.2: hierarchy depth/size are counted iteratively; JSON nested past Python's recursion
    limit is a broken block, not an exception."""
    deep: dict[str, Any] = {"text": "лист", "basis": "agent"}
    for _ in range(1_500):
        deep = {"text": "узел", "basis": "agent", "children": [deep]}
    data, hidden = _build({"type": "hierarchy", "nodes": [deep]})
    assert [node["depth"] for node in data["nodes"]] == [0, 1, 2, 3] and hidden > 0
    with pytest.raises(Broken):
        build_block("[" * 20_000 + "]" * 20_000, FakeChecker())


def test_an_unexpected_error_while_building_a_block_breaks_only_that_block(
        monkeypatch: pytest.MonkeyPatch) -> None:
    from skaz.knowledge.chats import blocks as chat_blocks

    def explode(_payload: str, _checker: Any) -> Any:
        raise RecursionError("maximum recursion depth exceeded")

    monkeypatch.setattr(chat_blocks, "build_block", explode)
    answer = chat_blocks.AnswerBlocks.__new__(chat_blocks.AnswerBlocks)
    answer.resolver, answer.web = None, None  # type: ignore[assignment]
    part = answer.resolve('{"type": "steps"}', "blk-1")
    assert part.state == "broken" and part.error and part.raw == '{"type": "steps"}'


def test_block_titles_columns_row_labels_and_chart_labels_are_cleaned_like_items() -> None:
    """FIX-1 F2.5: the block's own text gets ``base.clean()`` too — no reference tokens, no invisible
    format characters — and so does the selection's title read from a stored block."""
    data, _hidden = _build({"type": "compare", "title": "⟦m:mat-rec:1⟧ Raft\u200b  vs ⟦x⟧ Paxos",
                            "columns": ["Raft\u200b", "Paxos ⟦p:pg-real⟧"],
                            "rows": [{"label": "Leader\u2066 ⟦m:mat-rec:1⟧", "cells": [
                                {"text": "One", "cite": REC}, {"text": "None", "cite": DOC}]}]})
    assert data["title"] == "Raft vs Paxos"
    assert data["columns"] == ["Raft", "Paxos"] and data["rows"][0]["label"] == "Leader"
    data, _hidden = _build({"type": "chart", "title": "⟦m:mat-rec:1⟧", "unit": "ms\u200b",
                            "alt_label": "⟦m:mat-rec:1⟧ No\u200b leader",
                            "bars": [{"label": "A", "value": 1, "alt": True, "cite": REC}]})
    assert (data["title"], data["unit"], data["alt_label"]) == (None, "ms", "No leader")
    from skaz.knowledge.chats.model import Message, SelectedItem, Selection
    from skaz.knowledge.chats.selection import check_selection
    stored = json.dumps({"kind": "steps", "title": "Шаги\u200b ⟦m:mat-rec:1⟧", "steps": [
        {"id": "s1", "src": [], "agent": True, "title": "Шаг", "text": None}]})
    answer = Message("msg-a", "chat-1", 2, "assistant", "done", "2026-10-27T00:00:00Z",
                     parts=(BlockPart("blk-1", "ready", "steps", stored),))
    picked = Selection("msg-a", "blk-1", "block", None, (SelectedItem("s1", "x"),))
    checked = check_selection([answer], picked)
    assert checked.title == "Шаги"


def test_cause_chain_needs_two_links_and_keeps_their_roles() -> None:
    data, hidden = _build({"type": "cause_chain", "nodes": [
        {"label": "Cause", "text": "Hard to understand", "cite": DOC},
        {"text": "Bugs", "cite": "m:mat-none:2"},
        {"label": "Response", "text": "Raft", "cite": REC}]})
    assert hidden == 1
    assert [(n["id"], n["label"], n["text"]) for n in data["nodes"]] == [
        ("n1", "Cause", "Hard to understand"), ("n3", "Response", "Raft")]
    assert "Invalid block data: nodes" in _broken(
        {"type": "cause_chain", "nodes": [{"text": "x", "basis": "agent"}]})


def test_definition_needs_its_definition_the_example_may_be_hidden() -> None:
    data, hidden = _build({"type": "definition", "term": "  Term ", "also": [" epoch "],
                           "definition": {"text": "A logical clock", "cite": REC},
                           "example": {"text": "Term 5 ignores term 4", "cite": "m:mat-none:1"}})
    assert hidden == 1 and data["term"] == "Term" and data["also"] == ["epoch"] and data["example"] is None
    assert data["definition"]["id"] == "def"
    assert "The definition couldn't be shown" in _broken(
        {"type": "definition", "term": "T", "definition": {"text": "x", "cite": "m:mat-none:1"}})


def test_cards_glossary_key_numbers_and_action_items_check_each_item() -> None:
    data, hidden = _build({"type": "concept_cards", "cards": [
        {"name": "Quorum", "text": "A majority", "cite": "p:pg-real"},
        {"name": "", "text": "x", "basis": "agent"}]})
    assert hidden == 1 and [card["name"] for card in data["cards"]] == ["Quorum"]
    data, hidden = _build({"type": "glossary", "terms": [
        {"term": "Follower", "text": "Passive node", "cite": REC}, {"term": "Leader", "text": "x"}]})
    assert hidden == 1 and data["terms"][0]["term"] == "Follower"
    data, _ = _build({"type": "key_numbers", "numbers": [
        {"value": "150–300", "unit": "ms", "label": "Election timeout", "cite": REC}]})
    assert data["numbers"][0] == {"id": "k1", "src": [0], "agent": False, "value": "150–300", "unit": "ms",
                                  "label": "Election timeout"}
    data, _ = _build({"type": "action_items", "tasks": [
        {"task": "Implement it", "owner": "Anna", "due": "by 3 November", "cite": REC},
        {"task": "Read the paper", "owner_is_you": True, "cite": REC},
        {"task": "A test", "cite": REC}]})
    assert [(t["owner"], t["owner_is_you"], t["due"]) for t in data["tasks"]] == [
        ("Anna", False, "by 3 November"), (None, True, None), (None, False, None)]


def test_hierarchy_is_stored_flat_in_reading_order_and_a_hidden_node_takes_its_subtree() -> None:
    data, hidden = _build({"type": "hierarchy", "nodes": [{"text": "Consensus", "cite": DOC, "children": [
        {"text": "With a leader", "basis": "agent", "children": [
            {"text": "Raft", "cite": REC}, {"text": "Multi-Paxos", "note": "an optimisation", "cite": DOC}]},
        {"text": "Made up", "cite": "m:mat-none:1", "children": [{"text": "Lost", "cite": REC}]},
        {"text": "Deep", "basis": "agent", "children": [{"text": "3", "basis": "agent", "children": [
            {"text": "4", "basis": "agent", "children": [{"text": "5", "basis": "agent"}]}]}]},
    ]}]})
    assert hidden == 2 + 1  # «Made up» with its child; the fifth level
    assert [(n["id"], n["depth"], n["text"]) for n in data["nodes"]] == [
        ("n1", 0, "Consensus"), ("n1-1", 1, "With a leader"), ("n1-1-1", 2, "Raft"),
        ("n1-1-2", 2, "Multi-Paxos"), ("n1-3", 1, "Deep"), ("n1-3-1", 2, "3"), ("n1-3-1-1", 3, "4")]


def test_chart_sorts_by_value_unless_told_and_shows_one_text_for_each_value() -> None:
    data, hidden = _build({"type": "chart", "unit": "ms", "alt_label": "No leader", "bars": [
        {"label": "Raft", "value": 4, "cite": REC},
        {"label": "Paxos", "value": 8.4, "alt": True, "cite": DOC},
        {"label": "Negative", "value": -1, "cite": REC},
        {"label": "Big", "value": 1234567.25, "cite": REC}]})
    assert hidden == 1
    assert [(b["label"], b["display"], b["alt"]) for b in data["bars"]] == [
        ("Big", "1234567.25", False), ("Paxos", "8.4", True), ("Raft", "4", False)]
    assert data["alt_label"] == "No leader"
    data, _ = _build({"type": "chart", "order": "given", "alt_label": "unused", "bars": [
        {"label": "A", "value": 1, "basis": "agent"}, {"label": "B", "value": 2, "basis": "agent"}]})
    assert [b["label"] for b in data["bars"]] == ["A", "B"] and data["alt_label"] is None


def test_disagreement_needs_two_sides_and_an_agreement_that_can_be_shown() -> None:
    data, hidden = _build({"type": "disagreement", "title": "Leader?", "sides": [
        {"text": "No leader at all", "cite": REC}, {"text": "A proposer is needed", "cite": DOC}],
        "agree": {"text": "Safety needs none", "basis": "agent"}})
    assert hidden == 0 and [s["id"] for s in data["sides"]] == ["d1", "d2"]
    assert data["agree"]["text"] == "Safety needs none"
    assert "at least two sides" in _broken({"type": "disagreement", "sides": [
        {"text": "a", "cite": REC}, {"text": "b", "cite": "m:mat-none:1"}],
        "agree": {"text": "Still safe", "basis": "agent"}})
    assert "The agreement couldn't be shown" in _broken({"type": "disagreement", "sides": [
        {"text": "a", "cite": REC}, {"text": "b", "cite": DOC}],
        "agree": {"text": "Unknown", "cite": "m:mat-none:1"}})
    assert "agree" in _broken({"type": "disagreement", "sides": [
        {"text": "a", "cite": REC}, {"text": "b", "cite": DOC}]})


# -- composition (decision 2) ------------------------------------------------------------------


def test_beside_and_link_are_kept_with_the_part_and_checked() -> None:
    checker = FakeChecker()
    built = build_block(json.dumps({"type": "steps", "beside": True, "link": "  why  it happened ",
                                    "steps": [{"title": "x", "cite": REC}]}), checker)
    assert built.beside is True and built.link == "why it happened"
    part = BlockPart("blk-1", "ready", built.kind, built.data, (MaterialSource("mat-rec", 1),),
                     beside=built.beside, link=built.link)
    assert part_from_json(part_to_json(part)) == part
    history = block_agent_text(part)
    assert '"beside": true' in history and '"link": "why it happened"' in history
    assert "Invalid block data: beside" in _broken({"type": "steps", "beside": "yes",
                                                     "steps": [{"title": "x", "cite": REC}]})
    assert "Invalid block data: link" in _broken({"type": "steps", "link": "x" * 61,
                                                  "steps": [{"title": "x", "cite": REC}]})


def test_the_agent_sees_its_hierarchy_as_a_tree_and_its_chart_without_derived_fields() -> None:
    checker = FakeChecker()
    built = build_block(json.dumps({"type": "hierarchy", "nodes": [{"text": "A", "cite": REC, "children": [
        {"text": "B", "basis": "agent", "children": [{"text": "C", "basis": "agent"}]},
        {"text": "D", "cite": REC}]}]}), checker)
    history = block_agent_text(BlockPart("blk-1", "ready", built.kind, built.data,
                                         (MaterialSource("mat-rec", 1),)))
    body = json.loads(history.strip().removeprefix("```skaz-block").removesuffix("```"))
    assert body == {"type": "hierarchy", "nodes": [{"text": "A", "cite": "m:mat-rec:1", "children": [
        {"text": "B", "basis": "agent", "children": [{"text": "C", "basis": "agent"}]},
        {"text": "D", "cite": "m:mat-rec:1"}]}]}
    built = build_block(json.dumps({"type": "chart", "bars": [{"label": "A", "value": 2, "basis": "agent"}]}),
                        FakeChecker())
    assert "display" not in block_agent_text(BlockPart("blk-2", "ready", built.kind, built.data))


# -- Markdown (decision 11) ----------------------------------------------------------------------


def test_every_block_has_a_markdown_serializer_with_its_sources() -> None:
    assert _markdown({"type": "compare", "title": "Raft | Paxos", "columns": ["Raft", "Paxos"], "rows": [
        {"label": "Leader", "cells": [{"text": "One", "cite": REC},
                                      {"text": "x", "cite": "m:mat-none:1"}]}]}) == (
        "**Raft | Paxos**\n\n|  | Raft | Paxos |\n| --- | --- | --- |\n| Leader | One [m:mat-rec:1] | — |")
    assert _markdown({"type": "pros_cons", "pros": [{"text": "Simple", "cite": REC}],
                      "cons": [{"text": "Slow", "basis": "agent"}]}) == (
        "Pros:\n\n- Simple [m:mat-rec:1]\n\nCons:\n\n- Slow [Agent’s knowledge]")
    assert _markdown({"type": "verdict", "verdict": {"text": "Raft", "reason": "Simpler", "cite": DOC}}) == (
        "**Verdict:** Raft — Simpler [m:mat-doc:2]")
    assert _markdown({"type": "timeline", "events": [{"when": "1998", "title": "Paxos", "cite": DOC},
                                                     {"title": "Raft", "text": "Why", "cite": REC}]}) == (
        "- 1998 — **Paxos** [m:mat-doc:2]\n- 00:01 — **Raft**: Why [m:mat-rec:1]")
    assert _markdown({"type": "steps", "steps": [{"title": "# One", "text": "a", "cite": REC}]}) == (
        "1. **# One**: a [m:mat-rec:1]")
    assert _markdown({"type": "cause_chain", "nodes": [{"label": "Cause", "text": "A", "cite": REC},
                                                       {"text": "B", "cite": REC}]}) == (
        "1. **Cause:** A [m:mat-rec:1]\n2. B [m:mat-rec:1]")
    assert _markdown({"type": "definition", "term": "Term", "also": ["epoch"],
                      "definition": {"text": "A clock", "cite": REC},
                      "example": {"text": "Term 5", "basis": "agent"}}) == (
        "**Term** (epoch): A clock [m:mat-rec:1]\n\n*Example:* Term 5 [Agent’s knowledge]")
    assert _markdown({"type": "concept_cards",
                      "cards": [{"name": "Quorum", "text": "Majority", "cite": REC}]}) == (
        "- **Quorum**: Majority [m:mat-rec:1]")
    assert _markdown({"type": "hierarchy", "nodes": [{"text": "A", "cite": REC, "children": [
        {"text": "B", "note": "rare", "cite": DOC}]}]}) == "- A [m:mat-rec:1]\n  - B — rare [m:mat-doc:2]"
    assert _markdown({"type": "glossary", "terms": [{"term": "Leader", "text": "Writes", "cite": REC}]}) == (
        "- **Leader**: Writes [m:mat-rec:1]")
    assert _markdown({"type": "key_numbers",
                      "numbers": [{"value": "2f+1", "label": "Nodes", "cite": REC}]}) == (
        "- **2f+1**: Nodes [m:mat-rec:1]")
    assert _markdown({"type": "quote", "quote": {"text": "The trick.", "who": "Lecturer", "cite": REC}}) == (
        "> The trick.\n>\n> — Lecturer [m:mat-rec:1]")
    assert _markdown({"type": "disagreement", "title": "Leader?", "sides": [
        {"text": "No", "cite": REC}, {"text": "Yes", "cite": DOC}],
        "agree": {"text": "Safety", "basis": "agent"}}) == (
        "**Sources disagree: Leader?**\n\n- No [m:mat-rec:1]\n- Yes [m:mat-doc:2]\n\n"
        "*They agree:* Safety [Agent’s knowledge]")
    assert _markdown({"type": "action_items", "tasks": [
        {"task": "Implement", "owner": "Anna", "due": "by Monday", "cite": REC},
        {"task": "Read", "owner_is_you": True, "cite": REC}, {"task": "Test", "cite": REC}]}) == (
        "- [ ] Implement (Anna, due by Monday) [m:mat-rec:1]\n- [ ] Read (You) [m:mat-rec:1]\n"
        "- [ ] Test [m:mat-rec:1]")


def test_a_chart_copies_as_a_table_of_numbers() -> None:
    data = {"type": "chart", "title": "Latency", "unit": "ms", "alt_label": "No leader", "bars": [
        {"label": "Raft", "value": 4, "cite": REC},
        {"label": "Paxos", "value": 8.4, "alt": True, "cite": DOC}]}
    assert _markdown(data) == (
        "**Latency**\n\n|  | Value, ms | Source |\n| --- | --- | --- |\n| Paxos † | 8.4 | [m:mat-doc:2] |\n"
        "| Raft | 4 | [m:mat-rec:1] |\n\n† No leader")
    # Wiki links carry a «|»: they follow the row, past its last cell.
    links = Refs(["[[A|a]]", "[[B|b]]"], cells=False, agent="")
    assert _markdown(data, links).splitlines()[2:5] == [
        "|  | Value, ms |", "| --- | --- |", "| Paxos † | 8.4 | [[B|b]]"]


def test_hierarchies_and_cause_chains_are_blocks_and_the_layout_rule_is_in_the_tool() -> None:
    from skaz.knowledge.agents.tools import BLOCK_RULES
    from skaz.knowledge.chats.context import instructions

    full = instructions(None)
    mermaid = full[full.index("Diagrams:"):full.index("Answer blocks:")]
    assert "- hierarchy" not in mermaid  # decision 9: not a Mermaid type
    assert "not plain steps" in mermaid and "a hierarchy (those are answer blocks)" in mermaid
    rules = full[full.index("Answer blocks:"):]
    assert "a timeline, steps, a hierarchy or a cause chain is a block" in rules
    layout = next(rule for rule in BLOCK_RULES if rule.startswith("Layout"))
    assert '"beside": true' in layout and '"link"' in layout and "no text between" in layout


# -- in a chat: the API part, the folders, export and Save to wiki --------------------------------


@pytest.fixture
async def env(kb_app: Any, kb_client: httpx.AsyncClient) -> AsyncIterator[Env]:
    runtime = kb_app.state.runtime
    agents = Agents()
    install(runtime, agents)
    library = await connect(kb_client, runtime)
    yield Env(kb_client, runtime, runtime.kb_chats, agents, library)
    await runtime.kb_chats.close()


def _fence(data: dict[str, Any]) -> str:
    return "```skaz-block\n" + json.dumps(data, ensure_ascii=False) + "\n```\n"


async def test_a_block_comes_with_its_markdown_its_place_and_its_folders(env: Env) -> None:
    lib = env.library
    first = {"type": "key_numbers", "numbers": [
        {"value": "2", "label": "Начала термодинамики", "cite": f"m:{lib.lecture}:2"}]}
    second = {"type": "glossary", "beside": True, "link": "откуда это",
              "terms": [{"term": "Энтропия", "text": "Мера беспорядка", "cite": f"m:{lib.textbook}:1"},
                        {"term": "Страница", "text": "Вики", "cite": f"p:{lib.concept}"}]}
    env.agents.scripts["codex"] = lambda _turn: text("Кратко.\n", _fence(first), _fence(second), "Всё.")
    chat_id, message = await env.answered("Цифры?")
    numbers, glossary = chips(message, "answer_block")
    assert (numbers["beside"], numbers["link"]) == (False, None)
    assert (glossary["beside"], glossary["link"]) == (True, "откуда это")
    assert numbers["markdown"] == "- **2**: Начала термодинамики [Лекция 8 · 01:00]"
    assert glossary["markdown"] == ("- **Энтропия**: Мера беспорядка [Учебник химии · p. 10]\n"
                                    "- **Страница**: Вики [Энтропия]")
    # The chemistry folder is cited only inside a block: the chat still belongs to it.
    chat = (await env.client.get(f"/kb/chats/{chat_id}")).json()
    assert set(chat["folder_ids"]) == {lib.physics, lib.chemistry}
    exported = (await env.client.get(f"/kb/chats/{chat_id}/export")).json()["markdown"]
    assert "- **2**: Начала термодинамики [Лекция 8 · 01:00]" in exported
    assert "- **Энтропия**: Мера беспорядка [Учебник химии · p. 10]" in exported
    assert "skaz-block" not in exported


async def test_a_broken_block_has_no_markdown_and_is_left_out_of_the_export(env: Env) -> None:
    env.agents.scripts["codex"] = lambda _turn: text("До.\n```skaz-block\n{oops}\n```\nПосле.")
    chat_id, message = await env.answered("Блок?")
    (block,) = chips(message, "answer_block")
    assert block["state"] == "broken" and block["markdown"] is None
    exported = (await env.client.get(f"/kb/chats/{chat_id}/export")).json()["markdown"]
    assert "oops" not in exported and "До." in exported and "После." in exported


def test_a_web_source_is_one_safe_markdown_link_in_copy_export_and_save() -> None:
    """FIX-1 F2.6: one helper writes web links — the title can't close its brackets, the URL its
    parentheses — for the in-app Copy, the chat export and Save to wiki alike."""
    from skaz.knowledge.answer_blocks.part import WebSource
    from skaz.knowledge.api.schemas_blocks import KbBlockWebSource, copy_refs
    from skaz.knowledge.chats.analysis import paragraphs
    from skaz.knowledge.chats.export import _Labels
    url, title = "https://ex.org/wiki/Raft_(algorithm)", "Raft [consensus] ] (x"
    expected = "[Raft (consensus) ) (x](https://ex.org/wiki/Raft_%28algorithm%29)"
    data = json.dumps({"kind": "steps", "title": None, "steps": [
        {"id": "s1", "src": [0], "agent": False, "title": "Сайт", "text": None}]})
    part = BlockPart("blk-1", "ready", "steps", data, sources=(WebSource(url, title),))
    copied = copy_refs([KbBlockWebSource(type="web", url=url, title=title, site="ex.org")]).labels
    assert copied == [expected]
    assert _Labels(None).block(part) == f"1. **Сайт** {expected}"  # type: ignore[arg-type]
    (chunk,) = paragraphs([part])
    assert expected in "\n".join(chunk.lines)  # type: ignore[union-attr]


async def test_save_to_wiki_keeps_a_block_as_markdown_with_wiki_links(env: Env) -> None:
    lib = env.library
    table = {"type": "compare", "columns": ["Физика", "Химия"], "rows": [
        {"label": "Энтропия", "cells": [
            {"text": "Мера беспорядка", "cite": f"m:{lib.lecture}:1|мера беспорядка системы"},
            {"text": "Направление реакций", "cite": f"m:{lib.textbook}:1"}]}]}
    steps = {"type": "steps", "steps": [{"title": "Страница", "cite": f"p:{lib.concept}"},
                                        {"title": "Своё", "basis": "agent"}]}
    timeline = {"type": "timeline",
                "events": [{"title": "Лектор о беспорядке", "cite": f"m:{lib.lecture}:2"}]}
    env.agents.scripts["codex"] = lambda _turn: text("Сравнение:\n", _fence(table), _fence(steps),
                                                     _fence(timeline))
    chat_id, message = await env.answered("Сравни энтропию")
    saved = await env.client.post(f"/kb/chats/{chat_id}/messages/{message['id']}/save")
    assert saved.status_code == 200, saved.text
    ref = saved.json()
    path = Path(env.runtime.kb.library_root) / "Wiki" / "Analyses" / f"{ref['title']}.md"
    document = parse_page(path.read_text(encoding="utf-8"))
    assert document.meta.sources == (lib.lecture, lib.textbook)
    blocks = document.blocks()
    table_block = next(block for block in blocks if "| Энтропия |" in block.body)
    assert table_block.kind == "from_source"  # the exact words were checked
    assert [(c.material_id, c.seg) for c in table_block.cites] == [(lib.lecture, 1)]
    row = next(line for line in table_block.body.splitlines() if line.startswith("| Энтропия"))
    assert row.startswith("| Энтропия | Мера беспорядка | Направление реакций |")
    assert "[[Materials/Физика/Лекция 8/Лекция 8#^seg-1|" in row and "Учебник химии#^seg-1|" in row
    steps_block = next(block for block in blocks if "**Страница**" in block.body)
    assert "1. **Страница** [[Wiki/Concepts/Энтропия|Энтропия]]" in steps_block.body
    # FIX-1 F2.4 (migrated: the mark was dropped): the agent's own item keeps a visible mark on the page,
    # and a timeline moment without a date keeps its recording time.
    assert "2. **Своё** (agent’s knowledge)" in steps_block.body
    timeline_block = next(block for block in blocks if "Лектор о беспорядке" in block.body)
    assert timeline_block.body.startswith("- 01:00 — **Лектор о беспорядке**")
