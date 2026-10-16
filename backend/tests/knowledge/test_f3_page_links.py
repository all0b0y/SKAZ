"""QA 16.10 C1/C2/C4: block links the reader can follow, and editing a block keeps its links."""

from __future__ import annotations

import re
from typing import Any

import httpx

from skaz.knowledge.wiki.edit import readable_text, relink

from .test_wiki_edits import blocks, lecture_and_textbook, page_file
from .wiki_support import ENTROPY_TITLE

CARNOT = "[[Wiki/Concepts/Carnot engine (машина Карно)|Carnot engine (машина Карно)]]"
CITE_1 = "[[Materials/B5/Heat/Heat#^seg-1|Heat · ¶ 1]]"
CITE_6 = "[[Materials/B5/Heat/Heat#^seg-6|Heat · ¶ 6]]"


def test_saving_the_readable_text_unchanged_gives_back_the_same_block() -> None:
    body = f"An ideal benchmark is the Carnot engine. {CITE_1} {CITE_6} {CARNOT}"
    shown = readable_text(body)
    assert shown == "An ideal benchmark is the Carnot engine. Carnot engine (машина Карно)"
    assert relink(body, shown) == body


def test_an_edited_sentence_keeps_the_page_link_where_its_words_still_are() -> None:
    body = f"Steam engines realise a heat engine. {CITE_1} [[Wiki/Concepts/Steam engine|Steam engine]]"
    edited = "The Steam engine was the first heat engine people used widely."
    assert relink(body, edited) == (
        "The [[Wiki/Concepts/Steam engine|Steam engine]] was the first heat engine people used widely. "
        + CITE_1
    )
    # Words the user removed take their link with them; a word inside another word is not a match.
    assert relink(body, "Steamy engines everywhere.") == f"Steamy engines everywhere. {CITE_1}"
    # A link the user typed is kept, never doubled.
    typed = "See [[Wiki/Concepts/Steam engine|Steam engine]] here."
    assert relink(body, typed) == f"{typed} {CITE_1}"


def test_folder_and_material_links_come_back_too() -> None:
    body = "B5: [[Materials/B5/Heat/Heat|Heat]], [[Materials/B5/Coal/Coal|Coal]]"
    assert readable_text(body) == "B5: Heat, Coal"
    assert relink(body, "B5: Heat, Coal") == body


async def test_the_page_lists_where_each_block_link_goes(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    page_id = case.concept_id(ENTROPY_TITLE)
    page = (await kb_client.get(f"/kb/wiki/pages/{page_id}")).json()
    by_id = {block["id"]: block for block in page["blocks"]}
    folders = by_id["c-in-folders"]
    material = next(link for link in folders["links"] if link["material_id"])
    assert material["material_id"] in {case.lecture, case.textbook} and material["page"] is None
    related = by_id["c-related"]
    temperature = next(link for link in related["links"] if link["page"])
    assert temperature["page"]["title"].startswith("Температура")
    assert temperature["page"]["id"] == case.concept_id(temperature["page"]["title"])
    # Citations are footnotes, not links.
    for block in page["blocks"]:
        assert not any("#^seg-" in link["target"] for link in block["links"])


async def test_editing_a_block_keeps_its_links_in_the_file(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    case = await lecture_and_textbook(kb_app, kb_client)
    page_id = case.concept_id(ENTROPY_TITLE)
    target = next(block for block in blocks(case.kb, page_id).values() if "газа растёт" in block.body)
    path = page_file(case.kb, page_id)
    # A connection the agent wrote with a page link and its citation link.
    original = target.body
    citation = re.search(r"\[\[Materials/[^\]]+\]\]", original)
    assert citation is not None
    body_with_link = f"{original} [[Wiki/Concepts/Температура|Температура]]"
    path.write_text(path.read_text("utf-8").replace(original, body_with_link, 1), "utf-8")
    await kb_client.get(f"/kb/wiki/pages/{page_id}")  # outside edit picked up on open
    edited_text = "Температура поднимает энтропию газа."
    response = await kb_client.put(f"/kb/wiki/pages/{page_id}/blocks/{target.id}", json={"text": edited_text})
    assert response.status_code == 200
    on_disk = blocks(case.kb, page_id)[target.id]
    assert on_disk.body == (
        "[[Wiki/Concepts/Температура|Температура]] поднимает энтропию газа. " + citation.group(0)
    )
    edited = next(block for block in response.json()["blocks"] if block["id"] == target.id)
    assert any(link["page"] and link["page"]["title"].startswith("Температура") for link in edited["links"])
