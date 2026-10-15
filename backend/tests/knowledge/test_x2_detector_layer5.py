"""Layer 5 (the model's output) catches every decision-41 form layer 3 catches (review H1).

Same list as the layer-3 tests (``decision41.py``), through the detector the app wires into ingest
(``wiring.GuardDetector``) and ``flags_instructions``. A verbatim quote of an instruction passes the
quote check (layer 4) — layer 5 must still keep it out of the wiki.
"""

from __future__ import annotations

import pytest

from skaz.knowledge.ingest.checks import flags_instructions
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiring import GuardDetector
from tests.knowledge.decision41 import ATTACKS, NEAR_MISSES, REVIEW_MISSES

from .ingest_support import ScriptedWiki, block, cite, notes, wait_finished
from .test_wiring import wired


@pytest.mark.parametrize("text", ATTACKS)
def test_layer5_flags_every_decision41_form(text: str) -> None:
    assert flags_instructions(GuardDetector(), text), text


@pytest.mark.parametrize("text", NEAR_MISSES)
def test_layer5_lets_near_misses_through(text: str) -> None:
    assert not flags_instructions(GuardDetector(), text), text


@pytest.mark.parametrize("attack", REVIEW_MISSES)
async def test_a_verbatim_quote_of_an_instruction_never_reaches_the_wiki(
        ready: KnowledgeService, attack: str) -> None:
    good = block("from_source", "Entropy measures disorder.", cite(1, "a measure of the disorder"))
    quoted = block("from_source", attack, cite(2, attack))  # layer 4: the quote is in the source
    wiki = ScriptedWiki(notes=[notes(("Entropy", [good, quoted]))])
    ingest, sources = wired(ready, wiki)
    source = f"Entropy is a measure of the disorder of a system.\n\n{attack}"
    result = sources.add_text(source, "fld-inbox", "Quoted")
    for seg in list(sources.excluded_segs(result.material_id)):
        sources.restore(result.material_id, seg)  # the user restored it: layer 3 is out of the way
    job = await ingest.request_ingest(result.material_id)
    finished = await wait_finished(ingest, job.id)
    assert finished.state == "done", finished
    page = (ready.library_root / "Wiki" / "Notes" / "Quoted.md").read_text(encoding="utf-8")
    assert "Entropy measures disorder." in page and attack not in page
    assert any(item.kind == "blocked_output" for item in ready.notifications())
