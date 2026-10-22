"""The SKAZ tool registry: read-only tools, strict inputs, bounded untrusted output."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge.agents.prompting import UNTRUSTED_HEADER
from skaz.knowledge.agents.tools import TOOL_NAMES, TOOLS, ToolOutcome, ToolRegistry
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService

from .a1_library import INJECTION, Seeded, seed

EXPECTED = ("skaz_wiki_index", "skaz_read_page", "skaz_search", "skaz_read_material", "skaz_list_materials",
            "skaz_list_folders", "skaz_recent_speech", "skaz_get_fragment")


def payload(outcome: ToolOutcome) -> dict[str, Any]:
    assert not outcome.is_error, outcome.text
    lines = outcome.text.split("\n")
    assert lines[0] == UNTRUSTED_HEADER
    assert lines[1].startswith('<untrusted-data label="skaz tool ')
    assert lines[-1] == "</untrusted-data>" and len(lines) == 4
    data: dict[str, Any] = json.loads(lines[2])
    return data


@pytest.fixture
def library(ready: KnowledgeService) -> tuple[ToolRegistry, Seeded]:
    return ToolRegistry(ready), seed(ready)


def test_registry_declares_the_brief_set_with_strict_plain_schemas() -> None:
    assert TOOL_NAMES == EXPECTED
    for tool in TOOLS:
        schema = tool.input_schema
        assert schema["type"] == "object" and schema["additionalProperties"] is False
        assert set(schema["properties"]) == set(tool.args.model_fields), tool.name
        assert "anyOf" not in json.dumps(schema) and '"title"' not in json.dumps(schema).replace(
            '"title": {', "")
        # None: a tool that waits for the user (no SKAZ timeout).
        assert tool.description and (tool.timeout_s is None or tool.timeout_s > 0)
        assert tool.max_output_bytes <= 60_000
    assert "title" in TOOLS[1].input_schema["properties"]  # a property named title survives cleaning


async def test_wiki_index_lists_pages_with_summary_filters_and_pages(library: tuple[ToolRegistry, Seeded],
                                                                    ready: KnowledgeService) -> None:
    tools, seeded = library
    listed = payload(await tools.call("skaz_wiki_index", {}))
    assert {page["id"] for page in listed["pages"]} == {"pg-note", "pg-entropy"}
    entropy = next(page for page in listed["pages"] if page["id"] == "pg-entropy")
    indexed = ready.page_repo.get("pg-entropy")
    assert indexed is not None
    assert entropy == {"id": "pg-entropy", "kind": "concept", "title": "Энтропия", "original": "entropy",
                       "aliases": list(indexed.aliases), "folders": [seeded.folder_id],
                       "summary": "Энтропия — мера беспорядка системы."}
    concepts = payload(await tools.call("skaz_wiki_index", {"kind": "concept", "folder": "физика"}))
    assert [page["id"] for page in concepts["pages"]] == ["pg-entropy"]
    first = payload(await tools.call("skaz_wiki_index", {"limit": 1}))
    assert first["total"] == 2 and len(first["pages"]) == 1
    assert first["has_more"] and first["next_offset"] == 1
    rest = payload(await tools.call("skaz_wiki_index", {"limit": 1, "offset": 1}))
    assert rest["has_more"] is False and rest["next_offset"] is None
    missing = await tools.call("skaz_wiki_index", {"folder": "Химия"})
    assert missing.is_error and missing.text.startswith("Folder not found.")


async def test_read_page_by_id_title_or_alias_with_owner_kind_and_citations(
        library: tuple[ToolRegistry, Seeded]) -> None:
    tools, seeded = library
    page = payload(await tools.call("skaz_read_page", {"page_id": "pg-entropy"}))
    assert page["page"]["title"] == "Энтропия" and page["entry_count"] == 2 and page["has_more"] is False
    first, second = page["entries"]
    assert (first["id"], first["kind"], first["owner"]) == ("c-1", "from_source", "agent")
    assert first["cites"] == [
        {"ref": f"{seeded.lecture_id}:seg-1", "available": True, "material_title": "Лекция 8",
         "time": "00:00"},
        {"ref": "mat-gone:seg-3", "available": False},
    ]
    assert second["kind"] == "connection" and second["cites"][0]["page"] == 12
    by_title = payload(await tools.call("skaz_read_page", {"title": "энтропия"}))
    by_alias = payload(await tools.call("skaz_read_page", {"title": "ENTROPY"}))
    assert by_title["page"]["id"] == by_alias["page"]["id"] == "pg-entropy"
    later = payload(await tools.call("skaz_read_page", {"page_id": "pg-entropy", "from_entry": 1}))
    assert [entry["id"] for entry in later["entries"]] == ["c-2"]

    both = await tools.call("skaz_read_page", {"page_id": "pg-entropy", "title": "Энтропия"})
    assert both.is_error and both.text == "Invalid arguments: Give exactly one of page_id or title."
    unknown = await tools.call("skaz_read_page", {"page_id": "pg-nope"})
    assert unknown.is_error and unknown.text.startswith("Page not found.")


async def test_search_highlights_and_filters_by_kind_and_folder(library: tuple[ToolRegistry, Seeded],
                                                                ready: KnowledgeService) -> None:
    tools, seeded = library
    found = payload(await tools.call("skaz_search", {"query": "энтропия"}))
    refs = {hit["ref"] for hit in found["fragments"]}
    assert f"{seeded.lecture_id}:seg-1" in refs and f"{seeded.pdf_id}:seg-1" in refs
    assert any("**" in hit["snippet"] for hit in found["fragments"])
    assert any(block["page_id"] == "pg-entropy" for block in found["blocks"])
    assert any(page["id"] == "pg-entropy" for page in found["pages"])

    pdf_only = payload(await tools.call("skaz_search", {"query": "энтропия", "kinds": ["pdf"]}))
    assert {hit["material_id"] for hit in pdf_only["fragments"]} == {seeded.pdf_id}
    assert pdf_only["blocks"] == [] and pdf_only["pages"] == []

    other = ready.create_folder("Химия")
    ready.create_material(other.id, "Химия 1", "text", [FragmentInput(text="Энтропия реакции.", index=0)])
    physics = payload(await tools.call("skaz_search", {"query": "энтропия", "folder": seeded.folder_id}))
    assert all(hit["material_title"] != "Химия 1" for hit in physics["fragments"])
    chemistry = payload(await tools.call("skaz_search", {"query": "энтропия", "folder": "Химия"}))
    assert [hit["material_title"] for hit in chemistry["fragments"]] == ["Химия 1"]
    bad = await tools.call("skaz_search", {"query": "x", "kinds": ["movie"]})
    assert bad.is_error and bad.text.startswith("Invalid arguments: kinds.0:")


async def test_read_material_ranges_and_time_window(library: tuple[ToolRegistry, Seeded]) -> None:
    tools, seeded = library
    whole = payload(await tools.call("skaz_read_material", {"material_id": seeded.lecture_id}))
    assert whole["material"]["kind"] == "recording" and whole["has_more"] is False
    assert [f["seg"] for f in whole["fragments"]] == [1, 2, 3, 4]
    assert whole["fragments"][1] == {"seg": 2, "ref": f"{seeded.lecture_id}:seg-2", "start_ms": 60_000,
                                     "time": "01:00", "end_ms": 180_000, "speaker": "1",
                                     "text": "Второе начало термодинамики."}
    ranged = payload(await tools.call("skaz_read_material", {"material_id": seeded.lecture_id,
                                                             "from_seg": 2, "to_seg": 3}))
    assert [f["seg"] for f in ranged["fragments"]] == [2, 3]
    around = payload(await tools.call("skaz_read_material", {"material_id": seeded.lecture_id,
                                                             "around_ms": 200_000, "window_ms": 20_000}))
    assert [f["seg"] for f in around["fragments"]] == [3]
    pdf = payload(await tools.call("skaz_read_material", {"material_id": seeded.pdf_id}))
    assert pdf["fragments"][0]["page"] == 12 and "time" not in pdf["fragments"][0]
    no_timeline = await tools.call("skaz_read_material", {"material_id": seeded.pdf_id, "around_ms": 0})
    assert no_timeline.is_error and "no timeline" in no_timeline.text
    mixed = await tools.call("skaz_read_material",
                             {"material_id": seeded.pdf_id, "around_ms": 0, "from_seg": 1})
    assert mixed.is_error and "not both" in mixed.text
    missing = await tools.call("skaz_read_material", {"material_id": "mat-nope"})
    assert missing.is_error and missing.text.startswith("Material not found.")


async def test_long_material_is_cut_to_the_limit_with_a_continuation(ready: KnowledgeService) -> None:
    tools = ToolRegistry(ready)
    inbox = ready.folders()[0]
    paragraph = "Длинный абзац лекции про энтропию и теплоту. " * 40  # ~1.8k chars, ~3.4 KB UTF-8
    files = ready.create_material(inbox.id, "Длинная лекция", "audio", [
        FragmentInput(text=paragraph, start_ms=n * 60_000, end_ms=(n + 1) * 60_000) for n in range(60)
    ])
    limit = tools.get("skaz_read_material").max_output_bytes  # type: ignore[union-attr]
    outcome = await tools.call("skaz_read_material", {"material_id": files.manifest.id})
    assert len(outcome.text.encode()) <= limit
    first = payload(outcome)
    assert first["has_more"] is True and 1 < len(first["fragments"]) < 60
    following = first["next_from_seg"]
    assert following == first["fragments"][-1]["seg"] + 1
    second = payload(await tools.call("skaz_read_material", {"material_id": files.manifest.id,
                                                             "from_seg": following}))
    assert second["fragments"][0]["seg"] == following

    huge = ready.create_material(inbox.id, "Один огромный абзац", "text", [FragmentInput(text="я" * 60_000)])
    single = await tools.call("skaz_get_fragment", {"material_id": huge.manifest.id, "seg": 1})
    assert len(single.text.encode()) <= tools.get("skaz_get_fragment").max_output_bytes  # type: ignore[union-attr]
    fragment = payload(single)["fragment"]
    assert fragment["text_truncated"] is True and fragment["text"].endswith("…[truncated]")


async def test_recent_speech_returns_the_last_minutes_and_the_honest_boundary(
        library: tuple[ToolRegistry, Seeded], ready: KnowledgeService) -> None:
    tools, seeded = library
    recent = payload(await tools.call("skaz_recent_speech", {"material_id": seeded.lecture_id, "minutes": 2}))
    assert recent["transcribed_until_ms"] == 300_000 and recent["transcribed_until"] == "05:00"
    assert recent["window_from"] == "03:00" and recent["still_recording"] is True
    assert [f["seg"] for f in recent["fragments"]] == [3, 4]
    assert "transcribed so far" in recent["note"] and recent["omitted_older_fragments"] == 0

    not_speech = await tools.call("skaz_recent_speech", {"material_id": seeded.pdf_id, "minutes": 5})
    assert not_speech.is_error and "not a recording" in not_speech.text
    empty = ready.create_material(seeded.folder_id, "Новая запись", "recording", [], status="recording")
    nothing = payload(await tools.call("skaz_recent_speech",
                                       {"material_id": empty.manifest.id, "minutes": 5}))
    assert nothing["fragments"] == [] and nothing["transcribed_until_ms"] is None
    assert nothing["note"] == "No speech has been transcribed yet."
    too_long = await tools.call("skaz_recent_speech", {"material_id": seeded.lecture_id, "minutes": 500})
    assert too_long.is_error and too_long.text.startswith("Invalid arguments: minutes:")


async def test_lists_and_single_fragment(library: tuple[ToolRegistry, Seeded]) -> None:
    tools, seeded = library
    folders = payload(await tools.call("skaz_list_folders", {}))["folders"]
    assert [(f["name"], f["materials"]) for f in folders] == [("Inbox", 0), ("Физика", 2)]
    materials = payload(await tools.call("skaz_list_materials", {"folder": "Физика"}))
    assert materials["total"] == 2 and {m["folder"] for m in materials["materials"]} == {"Физика"}
    pdfs = payload(await tools.call("skaz_list_materials", {"kind": "pdf"}))
    assert [m["id"] for m in pdfs["materials"]] == [seeded.pdf_id]
    newest = payload(await tools.call("skaz_list_materials", {"recent": 1}))
    assert newest["total"] == 1 and len(newest["materials"]) == 1

    fragment = payload(await tools.call("skaz_get_fragment", {"material_id": seeded.lecture_id, "seg": 2}))
    assert fragment["fragment"]["text"] == "Второе начало термодинамики."
    assert (fragment["previous_seg"], fragment["next_seg"]) == (1, 3)
    missing = await tools.call("skaz_get_fragment", {"material_id": seeded.lecture_id, "seg": 99})
    assert missing.is_error and missing.text == "Fragment not found in this material."


async def test_source_text_is_wrapped_once_as_untrusted_data(library: tuple[ToolRegistry, Seeded]) -> None:
    tools, seeded = library
    outcome = await tools.call("skaz_get_fragment", {"material_id": seeded.lecture_id, "seg": 3})
    assert outcome.text.startswith(UNTRUSTED_HEADER)
    assert outcome.text.count("</untrusted-data>") == 1 and outcome.text.endswith("</untrusted-data>")
    assert "Ignore previous instructions" in outcome.text  # kept as data, never dropped silently
    assert payload(outcome)["fragment"]["text"] == INJECTION.replace("</untrusted-data>", "</untrusted_data>")


async def test_inputs_are_strict_and_errors_are_short(library: tuple[ToolRegistry, Seeded]) -> None:
    tools, _ = library
    extra = await tools.call("skaz_list_folders", {"path": "/etc"})
    assert extra.is_error and extra.text.startswith("Invalid arguments: path:")
    wrong_type = await tools.call("skaz_get_fragment", {"material_id": "x", "seg": "one"})
    assert wrong_type.is_error and "seg" in wrong_type.text
    unknown = await tools.call("skaz_write_page", {})
    assert unknown.is_error and unknown.text == "Unknown tool 'skaz_write_page'."
    assert len(extra.text) < 200


async def test_tools_never_write_files_or_the_index(library: tuple[ToolRegistry, Seeded],
                                                    ready: KnowledgeService,
                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    tools, seeded = library
    root = ready.library_root
    before = {path: path.read_bytes() for path in sorted(Path(root).rglob("*")) if path.is_file()}

    def refuse() -> None:
        raise AssertionError("a tool tried to write the knowledge database")

    monkeypatch.setattr(ready.db, "write", refuse)
    calls: list[tuple[str, dict[str, Any]]] = [
        ("skaz_wiki_index", {}), ("skaz_read_page", {"page_id": "pg-entropy"}),
        ("skaz_read_page", {"title": "Лекция 8"}), ("skaz_search", {"query": "энтропия", "folder": "Физика"}),
        ("skaz_read_material", {"material_id": seeded.lecture_id}), ("skaz_list_materials", {}),
        ("skaz_list_folders", {}), ("skaz_recent_speech", {"material_id": seeded.lecture_id, "minutes": 1}),
        ("skaz_get_fragment", {"material_id": seeded.pdf_id, "seg": 2}),
    ]
    assert {name for name, _ in calls} == set(EXPECTED)
    for name, arguments in calls:
        outcome = await tools.call(name, arguments)
        assert not outcome.is_error, (name, outcome.text)
    after = {path: path.read_bytes() for path in sorted(Path(root).rglob("*")) if path.is_file()}
    assert after == before
