"""C-16: an OpenCode run id is taken only while its answer runs; the same id twice is refused like Codex.

Against the fake ``opencode`` of ``test_agent_opencode`` (SKAZ side of the seam only, no model).
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from skaz.knowledge.agents.engine import Completed, Failed, TextDelta
from tests.knowledge.agent_fakes import RecordingMcp
from tests.knowledge.test_agent_opencode import drain, engine_for, scenario, turn


async def test_a_run_that_was_never_started_leaves_its_id_free(tmp_path: Path) -> None:
    engine, _fake = engine_for(tmp_path, scenario(), mcp=RecordingMcp())
    dropped = engine.run(turn())
    del dropped  # created, never iterated: nothing may stay behind
    events = await asyncio.wait_for(drain(engine, turn()), 20)
    assert isinstance(events[-1], Completed), events


async def test_the_same_run_id_twice_is_a_failure_not_an_exception(tmp_path: Path) -> None:
    chunk = {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Начало"}}
    engine, _fake = engine_for(tmp_path, scenario(updates=[chunk], hang=True), mcp=RecordingMcp())
    first = engine.run(turn())
    assert await first.__anext__() == TextDelta("run-1", "Начало")

    second = [event async for event in engine.run(turn())]

    assert second == [Failed("run-1", "other", "This answer is already running.")]
    assert isinstance(second[0], Failed) and second[0].unsent and not second[0].transient
    # The refused duplicate didn't free the id of the run that is still going: interrupt reaches it.
    await engine.interrupt("run-1")
    rest = [event async for event in first]
    assert rest == [Failed("run-1", "cancelled", "The answer was stopped.")]
