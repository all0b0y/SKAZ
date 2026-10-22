"""C-04: study blocks keep every grade and are saved once when requests arrive at the same time.

The routes run each study call in its own worker thread (``disk_call``). These tests call the
service from two threads and hold both at the service's clock (an injected dependency read after the
block) so that, without one-at-a-time changes per block, both would work from the same old block.
With the fix the second thread can't reach the clock while the first holds the block: the gate
then times out and lets the first go on alone.
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
from collections.abc import Callable
from datetime import datetime
from typing import Any

import pytest

from skaz.knowledge.errors import KnowledgeError
from skaz.knowledge.permissions.store import RunRef

from .chat_support import Library, connect
from .test_s_study import RUN_ID, _deck, _ids

GATE_SECONDS = 1.0


@pytest.fixture
async def world(kb_client: Any, kb_app: Any) -> tuple[Any, Library]:
    runtime = kb_app.state.runtime
    library = await connect(kb_client, runtime)
    view = await runtime.kb_chats.create(title="Study")
    ref = RunRef(RUN_ID, view.chat.id, RUN_ID, "claude_code")
    runtime.kb_study_tools.runs = lambda run_id: ref if run_id == RUN_ID else None
    return runtime, library


def _gate_clock(study: Any) -> None:
    """The next two clock reads wait for each other (at most ``GATE_SECONDS``)."""
    barrier = threading.Barrier(2)
    real: Callable[[], datetime] = study._clock

    def clock() -> datetime:
        with contextlib.suppress(threading.BrokenBarrierError):
            barrier.wait(timeout=GATE_SECONDS)
        return real()

    study._clock = clock


async def _together(*calls: Callable[[], Any]) -> list[Any]:
    return list(await asyncio.gather(*(asyncio.to_thread(call) for call in calls), return_exceptions=True))


async def test_two_grades_at_once_on_an_unsaved_deck_both_stay(world: Any) -> None:
    runtime, library = world
    study = runtime.kb_study
    block = await _deck(runtime, library)
    first, second, _third = _ids(runtime, block)
    _gate_clock(study)

    results = await _together(lambda: study.grade(block.id, first, "good"),
                              lambda: study.grade(block.id, second, "again"))

    assert not [r for r in results if isinstance(r, BaseException)], results
    state = study.get(block.id).state
    assert state["grades"] == {first: "good", second: "again"}
    assert set(state["pending"]) == {first, second}
    assert len(state["reviews"]) == 2


async def test_save_pressed_twice_at_once_writes_one_page(world: Any) -> None:
    runtime, library = world
    study = runtime.kb_study
    block = await _deck(runtime, library)
    _gate_clock(study)

    results = await _together(lambda: study.save(block.id, "allow"), lambda: study.save(block.id, "allow"))

    decks = [page for page in runtime.kb.page_repo.list_all() if page.kind == "deck"]
    assert [page.rel_path for page in decks] == ["Wiki/Decks/Термодинамика.md"]
    saved = [r for r in results if not isinstance(r, BaseException)]
    refused = [r for r in results if isinstance(r, BaseException)]
    assert len(saved) == 1 and saved[0].page_id == decks[0].id
    assert len(refused) == 1 and isinstance(refused[0], KnowledgeError)
    assert "Already saved" in str(refused[0])
    assert study.get(block.id).page_id == decks[0].id


async def test_a_grade_landing_during_save_enters_fsrs(world: Any) -> None:
    runtime, library = world
    study = runtime.kb_study
    block = await _deck(runtime, library)
    first, second, _third = _ids(runtime, block)
    block = await asyncio.to_thread(study.grade, block.id, first, "good")
    _gate_clock(study)

    results = await _together(lambda: study.save(block.id, "allow"),
                              lambda: study.grade(block.id, second, "hard"))

    assert not [r for r in results if isinstance(r, BaseException)], results
    page_id = study.get(block.id).page_id
    assert page_id is not None
    stored = study.store.cards([first, second])
    assert set(stored) == {first, second}
    assert stored[second].page_id == page_id
