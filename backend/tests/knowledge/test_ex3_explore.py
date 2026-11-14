"""EX3 (Explore v2): searches, finding states, filters, «From Explore», Discuss; fixtures only."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from skaz.knowledge.api.schemas_explore import KbFinding, KbFunnelStart, KbSearchRename
from skaz.knowledge.api.schemas_science import KbScienceText
from skaz.knowledge.errors import NotFound
from skaz.knowledge.library.library import EXPLORE_FOLDER_ID
from tests.knowledge.test_b2_funnel import REAL_ABSTRACT, run_to_end, work
from tests.knowledge.test_b2_funnel import parts as parts


async def search(p: SimpleNamespace, query: str = "agents", **filters: object) -> list[KbFinding]:
    run = await run_to_end(p, KbFunnelStart(query=query, channels=["search"]))
    return await page(p, run.id, **filters)


async def page(p: SimpleNamespace, run_id: str, **filters: object) -> list[KbFinding]:
    found = await p.funnel.findings(run_id=run_id, **filters)
    return [f for g in found.groups for f in g.findings]


async def test_opening_and_not_for_me_change_the_state_and_the_count(parts: SimpleNamespace) -> None:
    parts.science.search_works = [work(1, topics=["T1"]), work(2, topics=["T1"])]
    run = await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    first = await page(parts, run.id)
    assert {f.state for f in first} == {"new"}
    assert (await parts.funnel.searches()).items[0].unseen == 2
    one, other = sorted(first, key=lambda f: f.work.id)
    assert (await parts.funnel.mark_seen(one.id)).state == "seen"
    (listed,) = (await parts.funnel.searches()).items
    assert (listed.id, listed.owner, listed.unseen) == (run.id, "explore", 1)

    assert (await parts.funnel.dismiss(other.id)).state == "dismissed"
    assert [f.work.id for f in await page(parts, run.id)] == ["work-1"]
    assert [f.work.id for f in await page(parts, run.id, show="dismissed")] == ["work-2"]
    assert [f.work.id for f in await page(parts, run.id, show="seen")] == ["work-1"]
    assert (await parts.funnel.searches()).items[0].unseen == 0
    assert (await parts.funnel.restore(other.id)).state == "seen"

    # A later search never offers the same works again (found before), opened or dismissed.
    again = await run_to_end(parts, KbFunnelStart(query="agents again", channels=["search"]))
    assert await page(parts, again.id) == []


async def test_open_copy_is_checked_and_a_paper_without_text_is_dropped(parts: SimpleNamespace) -> None:
    parts.science.search_works = [
        work(1, topics=["T1"]),
        work(2, paid=True, abstract=None, topics=["T1"]),
        work(3, paid=True, abstract=REAL_ABSTRACT, topics=["T1"]),
    ]
    run = await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    findings = {f.work.id: f for f in await page(parts, run.id)}
    assert set(findings) == {"work-1", "work-3"}  # work-2: neither an open text nor a real abstract
    assert (findings["work-1"].access, findings["work-1"].read_url) == (
        "open",
        "https://example.org/read/work-1",
    )
    assert findings["work-3"].access == "paid"
    assert [f.work.id for f in await page(parts, run.id, free_only=True)] == ["work-1"]
    (listed,) = (await parts.funnel.searches()).items
    assert listed.no_text == 1


async def test_year_type_filters_and_sorts(parts: SimpleNamespace) -> None:
    parts.science.search_works = [
        work(1, year=2025, cited=40, topics=["T1"]),
        work(2, year=2026, cited=3, topics=["T1"]),
    ]
    run = await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    assert [f.work.id for f in await page(parts, run.id, year_from=2026)] == ["work-2"]
    assert [f.work.id for f in await page(parts, run.id, sort="cited")] == ["work-1", "work-2"]
    assert [f.work.id for f in await page(parts, run.id, sort="newest")] == ["work-2", "work-1"]
    assert await page(parts, run.id, types=["preprint"]) == []
    assert len(await page(parts, run.id, types=["peer_reviewed"])) == 2


async def test_add_to_materials_lands_in_from_explore_without_the_wiki(parts: SimpleNamespace) -> None:
    parts.science.search_works = [work(1, topics=["T1"])]
    (finding,) = await search(parts)
    parts.science.texts["work-1"] = KbScienceText(
        work_id="work-1",
        kind="arxiv_html",
        text="Section 1. The paper.",
        source_url="https://arxiv.org/html/1",
        access=finding.work.access,
    )
    added = await parts.funnel.add_to_materials(finding.id)
    assert (added.content, added.to_wiki) == ("full_text", False)
    ((_, folder_id, to_wiki),) = parts.sources.prepared
    assert (folder_id, to_wiki) == (EXPLORE_FOLDER_ID, False)
    assert any(f.id == EXPLORE_FOLDER_ID and f.name == "From Explore" for f in parts.kb.folders())
    assert (await parts.funnel.finding(finding.id)).state == "materials"
    again = await parts.funnel.add_to_materials(finding.id)  # a second click adds nothing
    assert again.material_id == added.material_id and len(parts.sources.prepared) == 1


async def test_discuss_opens_one_chat_on_the_card_and_downloads_nothing(parts: SimpleNamespace) -> None:
    parts.science.search_works = [work(1, title="Routing experts", abstract=REAL_ABSTRACT, topics=["T1"])]
    (finding,) = await search(parts)
    reads_before = parts.science.count("read_text")
    talk = await parts.funnel.discuss(finding.id)
    assert parts.chats.created == ["Routing experts"]
    # FX-3 (replaces UX-7a): the card is service context on each turn, never a fake user message.
    assert parts.chats.sent == []
    assert talk.material_id is None
    assert parts.science.count("read_text") == reads_before
    assert (await parts.funnel.discuss(finding.id)).chat_id == talk.chat_id
    assert len(parts.chats.created) == 1


async def test_rename_and_delete_a_search(parts: SimpleNamespace) -> None:
    parts.science.search_works = [work(1, topics=["T1"])]
    run = await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    renamed = await parts.funnel.rename_search(run.id, KbSearchRename(name="MoE routing"))
    assert renamed.name == "MoE routing"
    await parts.funnel.delete_search(run.id)
    assert (await parts.funnel.searches()).items == []
    with pytest.raises(NotFound):
        await parts.funnel.rename_search(run.id, KbSearchRename(name="x"))
