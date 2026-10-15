"""``/kb/recordings`` with the real WebSocket recorder route and a scripted Soniox socket.

The provider socket is a fake at the external edge (``gateways.soniox.connect``);
microphone, network and recognition quality are not exercised here.
"""
from __future__ import annotations

import asyncio
import struct
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.gateways import soniox as soniox_gateway
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.speech.service import INTERRUPTED_RECORDING, STILL_STREAMING
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp
from tests.sessions_support import session_count

from .speech_support import AsyncSoniox, Recorder, ScriptedSoniox, Step, sentence

AUTH = {"Authorization": f"Bearer {TOKEN}"}
FRAME = 8_000  # 500 ms of 16 kHz PCM16


def frame(sequence: int, start: int) -> bytes:
    return struct.pack("!QQI", sequence, start, FRAME) + b"\x01\x00" * FRAME


class Provider:
    """Hands out one scripted socket per provider connection."""

    def __init__(self) -> None:
        self.scripts: list[list[Step]] = []

    async def connect(self, *args: Any, **kwargs: Any) -> ScriptedSoniox:
        return ScriptedSoniox(self.scripts.pop(0) if self.scripts else [])


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> Provider:
    fake = Provider()
    monkeypatch.setattr(soniox_gateway, "connect", fake.connect)
    return fake


@pytest.fixture
def cloud() -> FakeHttp:
    return FakeHttp()


def make_app(config: AppConfig, cloud: FakeHttp) -> Any:
    secrets = MemorySecretStore()
    secrets.set("soniox", "fixture-key-not-real")
    return create_app(config, secret_store=secrets, http_client=cloud.client())


@pytest.fixture
def http(kb_config: AppConfig, cloud: FakeHttp, provider: Provider) -> Iterator[TestClient]:
    app = make_app(kb_config, cloud)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        assert client.post("/kb/library", headers=AUTH, json={}).json()["state"] == "ready"
        assert client.put("/settings", headers=AUTH, json={"cloud_consent": True}).status_code == 200
        yield client
    app.state.runtime.close()


def wait(http: TestClient, check: Callable[[], bool], what: str) -> None:
    assert http.portal is not None
    for _ in range(300):
        if check():
            return
        http.portal.call(asyncio.sleep, 0.01)
    raise AssertionError(f"timed out waiting for {what}")


def material(http: TestClient, material_id: str) -> dict[str, Any]:
    return dict(http.get(f"/kb/materials/{material_id}", headers=AUTH).json())


def texts(http: TestClient, material_id: str) -> list[tuple[int, str, str | None]]:
    return [(item["seg"], item["text"], item["speaker"]) for item in material(http, material_id)["fragments"]]


def recording(http: TestClient, material_id: str) -> dict[str, Any]:
    return dict(http.get(f"/kb/recordings/{material_id}", headers=AUTH).json())


class Stream:
    """The recorder side of ``/sessions/{id}/live/stream``."""

    def __init__(self, http: TestClient, ws: Any, opened: dict[str, Any]) -> None:
        self.http, self.ws = http, ws
        self.sequence, self.sample = opened["next_sequence"], opened["saved_samples"]

    def send(self, frames: int = 1) -> None:
        for _ in range(frames):
            self.ws.send_bytes(frame(self.sequence, self.sample))
            reply = self.ws.receive_json()
            assert reply["type"] == "audio.saved", reply
            self.sequence += 1
            self.sample += FRAME
            assert self.http.portal is not None
            self.http.portal.call(asyncio.sleep, 0.02)  # let the provider answer this frame

    def end(self, action: str = "stop") -> dict[str, Any]:
        self.ws.send_json({"type": "end", "action": action})
        stopped = self.ws.receive_json()
        assert stopped["type"] == "stream.stopped", stopped
        return dict(stopped)


def open_stream(http: TestClient, ws: Any) -> Stream:
    ws.send_json({"type": "open", "sample_rate": 16_000})
    opened = ws.receive_json()
    assert opened["type"] == "stream.opened", opened
    assert http.portal is not None
    http.portal.call(asyncio.sleep, 0.02)  # provider connects
    return Stream(http, ws, opened)


LECTURE: list[Step] = [
    [("Hello", 0, 400, "1")], [(" world", 500, 900, "1")],
    [("Question", 1_000, 1_400, "2")], [(" here", 1_500, 1_900, "2")],
    [("Answer", 2_000, 2_400, "1")],
]


def test_a_recording_grows_by_closed_monologues_and_continues_into_the_same_material(
    http: TestClient, provider: Provider,
) -> None:
    finished: list[str] = []
    http.app.state.runtime.kb_speech.on_finished(finished.append)  # type: ignore[attr-defined]
    created = http.post("/kb/recordings", headers=AUTH, json={})
    assert created.status_code == 201, created.text
    rec = created.json()
    material_id, session_id = rec["material_id"], rec["session_id"]
    assert rec["title"].startswith("Recording ") and rec["folder_id"] == INBOX_ID
    assert (rec["kind"], rec["status"]) == ("recording", "recording")

    provider.scripts.append(LECTURE)
    with http.websocket_connect(f"ws://127.0.0.1/sessions/{session_id}/live/stream", headers=AUTH) as ws:
        stream = open_stream(http, ws)
        stream.send(3)
        wait(http, lambda: len(texts(http, material_id)) == 1, "the first closed monologue")
        assert texts(http, material_id) == [(1, "Hello world", "1")]
        stream.send(2)
        wait(http, lambda: len(texts(http, material_id)) == 2, "the second closed monologue")
        live = recording(http, material_id)
        assert (live["recording_state"], live["status"]) == ("recording", "recording")
        refused = http.post(f"/kb/recordings/{material_id}/stop", headers=AUTH)
        assert refused.status_code == 409 and refused.json()["detail"] == STILL_STREAMING
        ended = stream.end("stop")
        assert ended["transcription_complete"] is True, ended
    wait(http, lambda: recording(http, material_id)["status"] == "ready", "ready after Stop")
    assert texts(http, material_id) == [
        (1, "Hello world", "1"), (2, "Question here", "2"), (3, "Answer", "1"),
    ]
    stopped = http.post(f"/kb/recordings/{material_id}/stop", headers=AUTH).json()
    assert (stopped["status"], stopped["recording_state"], stopped["error"]) == ("ready", "stopped", None)
    # Finished once (the wiki may take it now), not again for the explicit Stop that changed nothing.
    assert finished == [material_id]

    # Continue recording: the same material, ``seg`` continues after the existing ones.
    assert http.post(f"/kb/recordings/{material_id}/resume", headers=AUTH).status_code == 200
    provider.scripts.append([[("More", 0, 400, "1")]])
    with http.websocket_connect(f"ws://127.0.0.1/sessions/{session_id}/live/stream", headers=AUTH) as ws:
        stream = open_stream(http, ws)
        wait(http, lambda: recording(http, material_id)["status"] == "recording", "recording again")
        stream.send(1)
        stream.end("pause")
    wait(http, lambda: len(texts(http, material_id)) == 4, "the paused tail")
    wait(http, lambda: recording(http, material_id)["status"] == "ready", "ready after Pause")
    paused = recording(http, material_id)
    assert (paused["status"], paused["recording_state"]) == ("ready", "paused")
    assert texts(http, material_id)[-1] == (4, "More", "3")
    assert len(http.get("/kb/materials", headers=AUTH).json()) == 1
    assert finished == [material_id]  # a Pause is not a finished recording


def test_continuous_speech_is_readable_live_before_the_monologue_closes(
    http: TestClient, provider: Provider,
) -> None:
    """One speaker, no pause: the material gets nothing yet, but the live route has every final word."""
    rec = http.post("/kb/recordings", headers=AUTH, json={}).json()
    material_id, session_id = rec["material_id"], rec["session_id"]
    provider.scripts.append([
        [("We", 0, 400, "1")], [(" keep", 500, 900, "1")], [(" talking", 1_000, 1_400, "1")],
    ])

    def live() -> dict[str, Any]:
        response = http.get(f"/kb/recordings/{material_id}/live", headers=AUTH)
        assert response.status_code == 200, response.text
        return dict(response.json())

    with http.websocket_connect(f"ws://127.0.0.1/sessions/{session_id}/live/stream", headers=AUTH) as ws:
        stream = open_stream(http, ws)
        stream.send(1)
        wait(http, lambda: live()["monologues"] != [], "the first live words")
        stream.send(2)
        wait(http, lambda: [m["text"] for m in live()["monologues"]] == ["We keep talking"],
             "every final word")
        now = live()
        assert (now["after_seg"], now["stream"], now["partial"]) == (0, "streaming", None)
        assert now["monologues"][0]["speaker"] == "1" and now["monologues"][0]["start_ms"] == 0
        assert texts(http, material_id) == []  # the open monologue is not in the material yet
        stream.end("stop")
    wait(http, lambda: recording(http, material_id)["status"] == "ready", "ready after Stop")
    assert texts(http, material_id) == [(1, "We keep talking", "1")]
    done = live()
    assert (done["after_seg"], done["monologues"], done["stream"]) == (1, [], "inactive")
    # Only recordings have a live tail.
    assert http.get("/kb/recordings/nope/live", headers=AUTH).status_code == 404


def test_a_recognition_error_keeps_the_text_and_belongs_to_the_attempt(
    http: TestClient, provider: Provider,
) -> None:
    rec = http.post("/kb/recordings", headers=AUTH, json={"title": "Seminar"}).json()
    material_id, session_id = rec["material_id"], rec["session_id"]
    provider.scripts.append([[("Kept", 0, 400, "1")], "fail"])
    with http.websocket_connect(f"ws://127.0.0.1/sessions/{session_id}/live/stream", headers=AUTH) as ws:
        stream = open_stream(http, ws)
        stream.send(1)
        ws.send_bytes(frame(stream.sequence, stream.sample))
        messages = [ws.receive_json(), ws.receive_json()]
        assert {message["type"] for message in messages} == {"audio.saved", "transcription.failed"}
        stream.sequence, stream.sample = stream.sequence + 1, stream.sample + FRAME
        assert stream.end("stop")["transcription_complete"] is False
    wait(http, lambda: recording(http, material_id)["status"] == "ready", "settled after the error")
    failed_attempt = recording(http, material_id)
    assert failed_attempt["error"] and "401" in failed_attempt["error"]
    assert texts(http, material_id) == [(1, "Kept", "1")]

    # Continue recording: a new attempt clears the warning when it succeeds.
    provider.scripts.append([[("Again", 0, 400, "1")]])
    with http.websocket_connect(f"ws://127.0.0.1/sessions/{session_id}/live/stream", headers=AUTH) as ws:
        stream = open_stream(http, ws)
        stream.send(1)
        stream.end("stop")
    wait(http, lambda: len(texts(http, material_id)) == 2, "the continued attempt")
    wait(http, lambda: recording(http, material_id)["status"] == "ready", "ready again")
    assert recording(http, material_id)["error"] is None  # the new attempt's success cleared the warning


def test_an_error_before_any_text_leaves_a_failed_material_that_can_continue(
    http: TestClient, provider: Provider,
) -> None:
    rec = http.post("/kb/recordings", headers=AUTH, json={"title": "Silent"}).json()
    provider.scripts.append(["fail"])
    url = f"ws://127.0.0.1/sessions/{rec['session_id']}/live/stream"
    with http.websocket_connect(url, headers=AUTH) as ws:
        stream = open_stream(http, ws)
        ws.send_bytes(frame(stream.sequence, stream.sample))
        replies = {ws.receive_json()["type"], ws.receive_json()["type"]}
        assert replies == {"audio.saved", "transcription.failed"}
        stream.sequence, stream.sample = stream.sequence + 1, stream.sample + FRAME
        stream.end("stop")
    wait(http, lambda: recording(http, rec["material_id"])["status"] == "failed", "failed without text")
    assert http.post(f"/kb/recordings/{rec['material_id']}/resume", headers=AUTH).status_code == 200
    provider.scripts.append([[("Finally", 0, 400, None)]])
    with http.websocket_connect(url, headers=AUTH) as ws:
        stream = open_stream(http, ws)
        stream.send(1)
        stream.end("stop")
    wait(http, lambda: recording(http, rec["material_id"])["status"] == "ready", "ready after continuing")
    assert texts(http, rec["material_id"]) == [(1, "Finally", None)]


def test_media_imports_run_while_recording(http: TestClient, provider: Provider, cloud: FakeHttp,
                                           tmp_path: Path) -> None:
    AsyncSoniox(cloud)
    rec = http.post("/kb/recordings", headers=AUTH, json={"title": "Live"}).json()
    provider.scripts.append(LECTURE)
    source = tmp_path / "Imported.m4a"
    source.write_bytes(b"\x00\x01" * 2048)
    url = f"ws://127.0.0.1/sessions/{rec['session_id']}/live/stream"
    with http.websocket_connect(url, headers=AUTH) as ws:
        stream = open_stream(http, ws)
        stream.send(2)
        started = http.post("/kb/imports", headers=AUTH, json={"path": str(source)})
        assert started.status_code == 201, started.text
        imported = started.json()["material_id"]
        stream.send(3)
        wait(http, lambda: http.get(f"/kb/imports/{imported}", headers=AUTH).json()["status"] == "ready",
             "the import while recording")
        assert recording(http, rec["material_id"])["recording_state"] == "recording"
        stream.end("stop")
    wait(http, lambda: recording(http, rec["material_id"])["status"] == "ready", "the recording")
    assert len(texts(http, rec["material_id"])) == 3
    assert [text for _seg, text, _speaker in texts(http, imported)] == ["Hello there", "Hi"]


def test_creating_a_recording_checks_folder_and_name(http: TestClient) -> None:
    physics = http.post("/kb/folders", headers=AUTH, json={"name": "Physics"}).json()["id"]
    first = http.post("/kb/recordings", headers=AUTH, json={"folder_id": physics, "title": "Lecture 1"})
    assert first.status_code == 201 and first.json()["folder_id"] == physics
    assert http.get("/kb/recordings/defaults", headers=AUTH).json() == {"folder_id": physics}
    assert http.post("/kb/recordings", headers=AUTH, json={}).json()["folder_id"] == physics
    taken = http.post("/kb/recordings", headers=AUTH, json={"folder_id": physics, "title": "lecture 1"})
    assert taken.status_code == 409
    assert http.post("/kb/recordings", headers=AUTH, json={"title": "a/b"}).status_code == 422
    assert http.post("/kb/recordings", headers=AUTH, json={"folder_id": "fld-nope"}).status_code == 404
    assert session_count(http) == 2  # refused requests left no session behind
    imported = http.post(f"/kb/recordings/{first.json()['material_id']}/stop", headers=AUTH)
    assert imported.status_code == 200


def test_a_restart_settles_an_interrupted_recording_without_losing_or_duplicating(
    kb_config: AppConfig, cloud: FakeHttp, provider: Provider,
) -> None:
    app = make_app(kb_config, cloud)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.post("/kb/library", headers=AUTH, json={})
        rec = http.post("/kb/recordings", headers=AUTH, json={"title": "Crash"}).json()
        runtime = app.state.runtime
        # Speech reaches the legacy store, then the process dies before Stop.
        mic = Recorder.open(runtime.db, rec["session_id"])
        mic.say(sentence("First thought", 0, "1"))
        mic.say(sentence("Second voice", 1_000, "2"))
        runtime.kb_speech.projector.project(rec["material_id"], rec["session_id"], final=False)
        mic.say(sentence("Unfinished", 2_000, "1"))
        assert len(texts(http, rec["material_id"])) == 1
    app.state.runtime.close()

    again = make_app(kb_config, cloud)
    with TestClient(again, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        wait(http, lambda: recording(http, rec["material_id"])["status"] == "ready", "the startup settle")
        assert texts(http, rec["material_id"]) == [
            (1, "First thought", "1"), (2, "Second voice", "2"), (3, "Unfinished", "1"),
        ]
        settled = recording(http, rec["material_id"])
        assert settled["error"] == INTERRUPTED_RECORDING and settled["recording_state"] == "paused"
    again.state.runtime.close()
