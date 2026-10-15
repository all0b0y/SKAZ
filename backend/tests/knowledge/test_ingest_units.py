"""Pure parts of ingest: parts, exclusions, text cleaning, layer-4 checks, page merging, schemas."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from skaz.knowledge.ingest import prompts
from skaz.knowledge.ingest.checks import CheckedBlock, check_statement, clean_text
from skaz.knowledge.ingest.model import AnswerInvalid, BlockOut, CiteOut, NotesOut, parse_answer
from skaz.knowledge.ingest.pages import (
    ConceptUpdate,
    NoteSection,
    PageRef,
    SourceRef,
    build_note,
    merge_concept,
    render_statement,
)
from skaz.knowledge.ingest.sources import ExclusionsUnreadable, read_exclusions, split_parts
from skaz.knowledge.markdown.page import Block, Cite, Heading, PageDocument, PageMeta, parse_page, render_page
from skaz.knowledge.markdown.source import Fragment
from skaz.knowledge.markdown.text import block_hash

FRAGMENTS = {1: Fragment(1, "Энтропия — это  мера\nбеспорядка."), 2: Fragment(2, "Второй абзац.")}
SOURCE = SourceRef("mat-aaa", "Физика", "Лекция 8", "Лекция 8", start_ms={1: 0, 2: 65_000})


def test_split_parts_never_cuts_or_loses_a_fragment() -> None:
    fragments = [Fragment(n, "x" * size) for n, size in enumerate([50, 50, 400, 10, 10, 90], start=1)]
    parts = split_parts(fragments, budget=100)
    assert [[f.seg for f in part] for part in parts] == [[1, 2], [3], [4, 5], [6]]
    assert [f.seg for part in parts for f in part] == [1, 2, 3, 4, 5, 6]
    assert split_parts([], budget=10) == []


def test_read_exclusions_accepts_the_s1_shapes(tmp_path: Path) -> None:
    service = tmp_path / ".skaz"
    service.mkdir()
    assert read_exclusions(tmp_path) == frozenset()
    (service / "excluded.json").write_text(json.dumps([3, "seg-5", {"seg": 7}, {"seg": 9, "restored": True}]))
    assert read_exclusions(tmp_path) == {3, 5, 7}
    (service / "excluded.json").write_text(json.dumps({"excluded": [{"id": "seg-2", "reason": "x"}]}))
    assert read_exclusions(tmp_path) == {2}
    (service / "excluded.json").write_text("{broken")
    with pytest.raises(ExclusionsUnreadable):
        read_exclusions(tmp_path)
    (service / "excluded.json").write_text(json.dumps([{"seg": "first"}]))
    with pytest.raises(ExclusionsUnreadable):
        read_exclusions(tmp_path)


def test_clean_text_makes_model_text_inert() -> None:
    assert clean_text("  a\n\nb\tc  ") == "a b c"
    assert clean_text("## Title") == "\\## Title"
    assert clean_text("x [[Secret|y]] ![[img.png]] %% skaz:block %% ^c-1") == (
        "x [Secret|y] ![img.png] % skaz:block %")
    assert clean_text("zero\u200bwidth \U000e0041tag\u202e") == "zerowidth tag"
    assert clean_text("--- not a rule") == "\\--- not a rule"
    assert clean_text(" \u200b ") == ""


def test_check_statement_layer4() -> None:
    def out(kind: str, text: str, *cites: tuple[int, str], links: tuple[str, ...] = ()) -> BlockOut:
        return BlockOut(kind=kind, text=text, cites=[CiteOut(seg=s, quote=q) for s, q in cites],  # type: ignore[arg-type]
                        links=list(links))

    none: frozenset[int] = frozenset()
    twice = out("from_source", "Мера.", (1, "мера беспорядка"), (1, "Энтропия — это"))
    ok = check_statement(twice, FRAGMENTS, none)
    # Whitespace-normalised match; the seg is counted once, both checked quotes are kept for the marker.
    assert ok == CheckedBlock("from_source", "Мера.", (1,),
                              quotes=((1, "мера беспорядка"), (1, "Энтропия — это")))
    assert check_statement(out("from_source", "Мера.", (1, "Мера беспорядка")), FRAGMENTS, none) == \
        "quote_not_in_source"  # case is preserved
    assert check_statement(out("from_source", "Мера.", (1, "")), FRAGMENTS, none) == "quote_not_in_source"
    # A word or two is in almost any fragment: too weak to count as evidence.
    assert check_statement(out("from_source", "Мера.", (1, "мера")), FRAGMENTS, none) == "quote_too_short"
    # ...unless the quote is the whole (short) fragment.
    assert check_statement(out("from_source", "Абзац.", (2, "Второй абзац.")), FRAGMENTS, none) == \
        CheckedBlock("from_source", "Абзац.", (2,), quotes=((2, "Второй абзац."),))
    assert check_statement(out("from_source", "Мера.", (2, "Второй")), FRAGMENTS, frozenset({2})) == \
        "excluded_fragment"
    assert check_statement(out("from_source", "  "), FRAGMENTS, none) == "empty_text"
    explanation = check_statement(out("explanation", "Моё пояснение.", (1, "выдумка")), FRAGMENTS, none)
    assert explanation == CheckedBlock("explanation", "Моё пояснение.", ())
    linked = check_statement(
        out("connection", "Связь.", (1, "мера беспорядка"), links=("Энтропия",)), FRAGMENTS, none)
    assert isinstance(linked, CheckedBlock) and linked.links == ("Энтропия",)
    both = check_statement(
        out("connection", "Связь.", (1, "мера беспорядка"), (2, "Второй абзац")), FRAGMENTS, none)
    assert isinstance(both, CheckedBlock) and both.segs == (1, 2)


def test_parse_answer_accepts_fenced_json_and_seg_labels() -> None:
    text = '```json\n{"sections": [{"title": "A", "blocks": [{"kind": "from_source", "text": "t", ' \
           '"cites": [{"seg": "seg-2", "quote": "q"}], "links": []}]}], "more": false}\n```'
    parsed = parse_answer(text, NotesOut)
    assert parsed.sections[0].blocks[0].cites[0].seg == 2
    with pytest.raises(AnswerInvalid):
        parse_answer('{"sections": "nope", "more": false}', NotesOut)


def test_schemas_are_strict_objects() -> None:
    def walk(schema: object) -> None:
        if isinstance(schema, dict):
            if schema.get("type") == "object":
                assert schema["additionalProperties"] is False
                assert set(schema["required"]) == set(schema["properties"])
            for value in schema.values():
                walk(value)
        elif isinstance(schema, list):
            for value in schema:
                walk(value)

    for schema in prompts.SCHEMAS.values():
        walk(schema)


def test_render_statement_builds_links_from_ids() -> None:
    rendered = render_statement(CheckedBlock("connection", "Связь.", (1, 2)), SOURCE,
                                [PageRef("Wiki/Concepts/Энтропия", "Энтропия")])
    assert rendered.body == ("Связь. [[Materials/Физика/Лекция 8/Лекция 8#^seg-1|Лекция 8 · 00:00]] "
                             "[[Materials/Физика/Лекция 8/Лекция 8#^seg-2|Лекция 8 · 01:05]] "
                             "[[Wiki/Concepts/Энтропия|Энтропия]]")
    assert rendered.cites == (Cite("mat-aaa", 1), Cite("mat-aaa", 2)) and rendered.id.startswith("c-aaa-")
    pdf = SourceRef("mat-b", "Книги", "Учебник", "Учебник (старое имя)", page={4: 12})
    assert render_statement(CheckedBlock("from_source", "Факт.", (4,)), pdf, []).body == (
        "Факт. [[Materials/Книги/Учебник/Учебник (старое имя)#^seg-4|Учебник · p. 12]]")


def _note_meta() -> PageMeta:
    return PageMeta(skaz_id="pg-n", kind="note", title="Лекция 8", language="en", sources=("mat-aaa",))


def test_build_note_keeps_orphaned_user_sections_in_place() -> None:
    def agent(text: str) -> Block:
        return Block.create(f"c-aaa-{block_hash(text)[:8]}", "from_source", text, cites=(Cite("mat-aaa", 1),))

    first = build_note(None, _note_meta(), [NoteSection("Один", (agent("a1"),)),
                                           NoteSection("Два", (agent("b1"),)),
                                           NoteSection("Три", (agent("c1"),))])
    text = render_page(first).replace("## Два\n", "## Два\n\nМоё под двумя.\n\n")
    text = text.replace("## Три\n", "## Свой раздел\n\nТекст пользователя.\n\n## Три\n")
    text = "---" + text[3:].replace("---\n\n## Один", "---\n\nВступление пользователя.\n\n## Один", 1)
    again = build_note(parse_page(text), _note_meta(), [NoteSection("Один", (agent("a2"),)),
                                                       NoteSection("Три", (agent("c2"),))])
    rendered = render_page(again)
    order = [line for line in rendered.splitlines() if line.startswith("## ") or "пользовател" in line
             or "под двумя" in line]
    assert order == ["Вступление пользователя.", "## Один", "## Два", "Моё под двумя.", "## Свой раздел",
                     "Текст пользователя.", "## Три"]
    assert "a1" not in rendered and "a2" in rendered and "c2" in rendered
    assert parse_page(rendered).meta.skaz_id == "pg-n"


def test_merge_concept_touches_only_this_material() -> None:
    other = Block.create("c-other-1", "from_source", "Из другого источника.", cites=(Cite("mat-other", 3),))
    mine_old = Block.create("c-aaa-1", "from_source", "Старое.", cites=(Cite("mat-aaa", 1),))
    user = Block.create("c-u", "user_note", "Моя заметка.", owner="user")
    meta = PageMeta(skaz_id="pg-c", kind="concept", title="Энтропия", language="en",
                    aliases=("Энтропия",), sources=("mat-other", "mat-aaa"))
    text = render_page(PageDocument(meta=meta, parts=[Heading(2, "From sources"), other, mine_old,
                                                      Heading(2, "My notes"), user]))
    document = parse_page(text)
    new = Block.create("c-aaa-2", "from_source", "Новое.", cites=(Cite("mat-aaa", 2),))
    merged = merge_concept(document, ConceptUpdate("mat-aaa", [new], ["entropy"], []), material_id="mat-aaa",
                           folders_of=lambda sources: ("fld-1",) if sources else (),
                           folders_body=lambda meta: None)
    result = render_page(merged)
    assert other.render() in result and user.render() in result and "Старое." not in result
    assert result.index("Новое.") < result.index("## My notes")
    assert merged.meta.aliases == ("Энтропия", "entropy") and merged.meta.sources == ("mat-other", "mat-aaa")

    removed = merge_concept(parse_page(result), None, material_id="mat-aaa", folders_of=lambda sources: (),
                            folders_body=lambda meta: None)
    assert "Новое." not in render_page(removed) and removed.meta.sources == ("mat-other",)
