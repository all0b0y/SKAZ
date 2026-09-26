"""Multi-turn Notes through the production Codex runtime with an authored subprocess peer."""
from __future__ import annotations

from pathlib import Path

import pytest

from audiohelper import note_store
from tests.test_codex_notes_fix import generate


async def test_codex_sections_form_one_clean_complete_document(tmp_path: Path) -> None:
    first = "# Lecture\n\n## Definition\nDetailed definition [P1]\n\n<!-- SKAZ_NOTE_CONTINUE -->"
    last = "## Example\nWorked example, reasoning and qualification [P1]"
    db, service, sid, task = await generate(tmp_path, [first, last])
    try:
        assert service.queue.get(task["id"]).status == "completed"
        [note] = note_store.list_notes(db, sid)
        assert note.content == (
            "# Lecture\n\n## Definition\nDetailed definition\n\n"
            "## Example\nWorked example, reasoning and qualification"
        )
        assert "SKAZ_NOTE" not in service.queue.get(task["id"]).answer
        assert len(note.citations) == 1
    finally:
        await service.close()
        db.close()


async def test_multipart_correction_replaces_the_entire_rejected_draft(tmp_path: Path) -> None:
    answers = [
        "# First\n\nFirst copy [P1]\n<!-- SKAZ_NOTE_CONTINUE -->",
        "# Duplicate title\n\nWrong second document [P1]",
        "# Corrected\n\nDefinition [P1]\n<!-- SKAZ_NOTE_CONTINUE -->",
        "## Example\n\nFull example [P1]",
    ]
    db, service, sid, task = await generate(tmp_path, answers)
    try:
        assert service.queue.get(task["id"]).status == "completed"
        [note] = note_store.list_notes(db, sid)
        assert note.content == "# Corrected\n\nDefinition\n\n## Example\n\nFull example"
        assert "First copy" not in note.content and "Wrong second" not in note.content
    finally:
        await service.close()
        db.close()


@pytest.mark.parametrize("last", ["", "# Lecture\n\nDetailed definition [P1]\n<!-- SKAZ_NOTE_CONTINUE -->"])
async def test_codex_unfinished_multipart_note_is_not_saved(tmp_path: Path, last: str) -> None:
    first = "# Lecture\n\nDetailed definition [P1]\n<!-- SKAZ_NOTE_CONTINUE -->"
    db, service, sid, task = await generate(tmp_path, [first, last])
    try:
        assert service.queue.get(task["id"]).status != "completed"
        assert note_store.list_notes(db, sid) == []
    finally:
        await service.close()
        db.close()
