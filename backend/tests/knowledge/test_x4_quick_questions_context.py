"""Quick questions while recording (brief X4) attach the running recording to the question. What the
agent then reads of it is the material's closed monologues only — never the open monologue or the
words still being recognised (the live tail is for the panel, not for agents). Verification of the
existing context path: the UI sends just the material id.
"""
from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from skaz import repository as repo
from skaz.db import Database
from skaz.knowledge.chats.context import ContextBuilder
from skaz.knowledge.chats.model import Chat, MessageInput
from skaz.knowledge.chats.resolve import MaterialReader
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.speech.projector import SpeechProjector

from .speech_support import Recorder, sentence


@pytest.fixture
def legacy(tmp_path: Path) -> Iterator[Database]:
    db = Database(tmp_path / "legacy.sqlite3")
    yield db
    db.close()


def chat(recording_material_id: str | None) -> Chat:
    return Chat(id="chat-1", title="Lecture", title_auto=False, pinned=False, engine="codex", model=None,
                effort=None, recording_material_id=recording_material_id, folder_ids=(), unread=False,
                last_preview="", created_at="2026-10-15T09:00:00Z", updated_at="2026-10-15T09:00:00Z")


@pytest.mark.parametrize("own_chat", [False, True], ids=["another chat", "the recording's chat"])
def test_an_attached_live_recording_gives_the_agent_closed_monologues_only(
    ready: KnowledgeService, legacy: Database, own_chat: bool,
) -> None:
    session = repo.create_session(legacy, "Lecture")
    material_id = ready.create_material(INBOX_ID, "Lecture", "recording", [], status="recording").manifest.id
    projector = SpeechProjector(ready, legacy.read)
    mic = Recorder.open(legacy, session.id)
    mic.say(sentence("Today we talk about entropy", 0, "1"))
    mic.say(sentence("Is it disorder", 2_000, "2"), partial=[(" really", 2_900, 3_100, "2")])
    projector.project(material_id, session.id, final=False)
    live = projector.live(material_id, session.id)
    # On screen: the open monologue and the words still being recognised.
    assert [item.text for item in live.monologues] == ["Is it disorder"] and live.partial is not None

    request = ContextBuilder(ready, MaterialReader(ready)).request(
        chat(material_id if own_chat else None),
        MessageInput(text="What did I miss?", attachments=(material_id,)),
        lambda _chat_id: None,
    )
    assert "Today we talk about entropy" in request
    assert "Is it disorder" not in request and "really" not in request
    assert request.endswith("The user's message:\nWhat did I miss?")
