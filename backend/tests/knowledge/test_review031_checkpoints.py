"""Review 0.3.1 (C-09): a finished material stays finished across an interrupted re-run with the
same choice, so another choice later starts it over (C1-f #4)."""
from __future__ import annotations

from skaz.knowledge.ingest.checkpoints import Checkpoints
from skaz.knowledge.service import KnowledgeService
from tests.knowledge.ingest_support import add_material

A, B = "Codex · model-a · low", "Codex · model-b · low"


def test_an_interrupted_re_run_by_the_same_choice_keeps_the_material_finished(
        ready: KnowledgeService) -> None:
    material_id = add_material(ready, "Физика", "Лекция 8")
    first = Checkpoints(ready.db, material_id, "rev", A)
    first.prepare()
    first.put("notes-1", '{"sections": [], "more": false}')
    first.finished()
    again = Checkpoints(ready.db, material_id, "rev", A)
    again.prepare()  # every step comes from the checkpoint; the run is stopped before it saves pages
    assert again.get("notes-1") is not None
    other = Checkpoints(ready.db, material_id, "rev", B)
    other.prepare()
    assert other.get("notes-1") is None  # the finished material starts over with another choice


def test_a_re_run_that_wrote_new_answers_and_stopped_is_continued_by_another_choice(
        ready: KnowledgeService) -> None:
    material_id = add_material(ready, "Физика", "Лекция 8")
    first = Checkpoints(ready.db, material_id, "rev", A)
    first.prepare()
    first.put("notes-1", "one")
    first.finished()
    again = Checkpoints(ready.db, material_id, "rev", A)
    again.prepare()
    again.put("notes-2", "two")  # the stored answers changed: this is now a stopped run's work
    other = Checkpoints(ready.db, material_id, "rev", B)
    other.prepare()
    assert (other.get("notes-1"), other.get("notes-2")) == ("one", "two")
