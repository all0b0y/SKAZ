"""QA 16.10 C18: deleting a source never leaves a kept text citing an unrelated source, and
links to the pages removed with it go too."""

from __future__ import annotations

from typing import Any

import httpx

from skaz.knowledge.markdown.page import Block, Cite, PageDocument, PageMeta, parse_page, render_page
from skaz.knowledge.wiki.retract import retract_material, strip_links

from .test_wiki_edits import blocks, lecture_and_textbook, page_file
from .wiki_support import ENTROPY_TITLE

BEES = "mat-bees"
PLATES = "mat-plates"


def _link(material: str, title: str, seg: int) -> str:
    return f"[[Materials/B5/{title}/{title}#^seg-{seg}|{title} · ¶ {seg}]]"


def _overview() -> PageDocument:
    covered = Block.create(
        "c-ov-1",
        "from_source",
        "Next come honeybee colonies, followed by plate tectonics. "
        f"{_link(BEES, 'Honeybees', 1)} {_link(PLATES, 'Plate tectonics', 1)}",
        cites=(Cite(BEES, 1), Cite(PLATES, 1)),
    )
    confirmed = Block.create(
        "c-plates-1",
        "from_source",
        "Plates move a few centimetres a year. "
        f"{_link(BEES, 'Honeybees', 2)} {_link(PLATES, 'Plate tectonics', 2)}",
        cites=(Cite(BEES, 2), Cite(PLATES, 2)),
    )
    link = Block.create(
        "c-link-1",
        "connection",
        f"Both are slow processes. {_link(BEES, 'Honeybees', 3)} {_link(PLATES, 'Plate tectonics', 3)}",
        cites=(Cite(BEES, 3), Cite(PLATES, 3)),
    )
    materials = Block.create(
        "c-ov-materials",
        "connection",
        "1. [[Wiki/Notes/Coal, steam and efficiency|Coal, steam and efficiency]]; "
        "2. [[Wiki/Notes/Honeybees|Honeybees]]; 3. [[Wiki/Notes/Plate tectonics|Plate tectonics]]",
    )
    meta = PageMeta(skaz_id="pg-b5", kind="folder", title="B5", sources=(BEES, PLATES), language="en")
    return PageDocument(meta, [covered, confirmed, link, materials])


def test_a_synthesis_over_several_sources_goes_with_one_of_them() -> None:
    document, retraction = retract_material(_overview(), BEES, "Materials/B5/Honeybees")
    ids = [block.id for block in document.blocks()]
    # The overview paragraph and the connection talk about bees too: kept, they would cite only plates.
    assert "c-ov-1" in retraction.removed and "c-link-1" in retraction.removed
    # A plain statement two sources confirm keeps the other source.
    assert retraction.kept == ["c-plates-1"] and "c-plates-1" in ids
    kept = document.block("c-plates-1")
    assert kept is not None and {cite.material_id for cite in kept.cites} == {PLATES}
    assert "Honeybees" not in kept.body


def test_links_to_removed_pages_leave_lists_and_statements() -> None:
    document = _overview()
    stripped, changed = strip_links(document, {"Wiki/Notes/Honeybees"})
    materials = stripped.block("c-ov-materials")
    assert materials is not None
    assert materials.body == (
        "1. [[Wiki/Notes/Coal, steam and efficiency|Coal, steam and efficiency]]; "
        "2. [[Wiki/Notes/Plate tectonics|Plate tectonics]]"
    )
    assert changed == ["c-ov-materials"]
    # A trailing pointer link of a statement goes; an inline one reads as its label.
    statement = Block.create("c-x", "connection", "Heat flows. [[Wiki/Concepts/Gone|Gone]]")
    inline = Block.create("c-y", "connection", "The [[Wiki/Concepts/Gone|Gone]] page was here.")
    note = Block.create("c-u-1", "user_note", "My [[Wiki/Concepts/Gone|Gone]] link.", owner="user")
    page = PageDocument(document.meta, [statement, inline, note])
    stripped, changed = strip_links(page, {"Wiki/Concepts/Gone"})
    assert [block.body for block in stripped.blocks()] == [
        "Heat flows.", "The Gone page was here.", "My [[Wiki/Concepts/Gone|Gone]] link."
    ]
    assert changed == ["c-x", "c-y"]
    assert render_page(stripped)  # still a valid page


async def test_deleting_a_material_unlinks_its_removed_notes_page_everywhere(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    entropy = case.concept_id(ENTROPY_TITLE)
    note = case.kb.page_repo.get(case.note_id(case.lecture))
    assert note is not None
    target = note.rel_path.removesuffix(".md")
    # An agent connection on the entropy page that points at the lecture's Notes page.
    path = page_file(case.kb, entropy)
    document = parse_page(path.read_text("utf-8"))
    textbook_cite = next(block for block in document.blocks() if block.cites and all(
        cite.material_id == case.textbook for cite in block.cites))
    pointer = Block.create(
        "c-link-pointer", "connection", f"See the lecture notes. [[{target}|{note.title}]]",
        cites=textbook_cite.cites,
    )
    parts = list(document.parts)
    parts.insert(parts.index(textbook_cite) + 1, pointer)
    path.write_text(render_page(PageDocument(document.meta, parts)), "utf-8")
    case.service.rescan()

    preview = (await kb_client.get(f"/kb/materials/{case.lecture}/delete-preview")).json()
    assert note.id in {ref["id"] for ref in preview["pages_removed"]}
    assert entropy in {ref["id"] for ref in preview["pages_changed"]}
    assert (await kb_client.delete(f"/kb/materials/{case.lecture}")).status_code == 200
    after = blocks(case.kb, entropy)["c-link-pointer"]
    assert after.body == "See the lecture notes."
    assert target not in page_file(case.kb, entropy).read_text("utf-8")
    hits = (await kb_client.get("/kb/search", params={"q": "Лекция"})).json()
    assert all(hit["id"] != note.id for hit in hits.get("pages", []))
