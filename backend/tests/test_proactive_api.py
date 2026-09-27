"""Proactive assistant cards through the real store, service and HTTP routes (issue #10).

Speech is written as confirmed Soniox events into a real temporary SQLite; the model
is an injected ``httpx`` transport replying with authored JSON. These fixtures pin
the card lifecycle and grounding rules; they are not evidence of recognition or
answer quality on real human speech.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from starlette.testclient import TestClient

from skaz.gateways import soniox
from skaz.gateways.soniox import SonioxEvent, SonioxToken
from skaz.schemas import ProactiveSettings
from skaz.secrets import MemorySecretStore
from skaz.settings_store import DEFAULT_SETTINGS, StoredProfile
from tests.conftest import FakeHttp, chat_completion
from tests.test_native_live_ws import AUTH, packet
from tests.test_native_soniox_ws import ProviderSocket

MODEL = "qwen/qwen3-30b-a3b-instruct-2507"
RATE = 16_000


def configure(app: Any, secrets: MemorySecretStore, **proactive: Any) -> None:
    runtime = app.state.runtime
    secrets.set("openrouter", "sk-test")
    options = {"enabled": True, "aliases": ["Alex", "Саша"], "model_consent": True, **proactive}
    runtime.settings_store.save(DEFAULT_SETTINGS.model_copy(update={
        "cloud_consent": True,
        "agent": StoredProfile(provider="openrouter", model=MODEL),
        "proactive": ProactiveSettings(**options),
    }))


def speak(app: Any, session_id: str, turns: list[tuple[int, str]], *, gap_ms: int = 4000) -> None:
    """Save ``turns`` of (speaker, text) as one confirmed Soniox event, a word per token."""
    store = app.state.runtime.live_store
    words: list[tuple[int, str]] = [(speaker, word) for speaker, text in turns for word in text.split()]
    duration_ms = len(words) * 300 + gap_ms * len(turns) + 500
    connection = store.open(session_id, sample_rate=RATE, model="stt-rt-v3")
    samples = duration_ms * RATE // 1000
    block = RATE // 2
    for sequence, start in enumerate(range(0, samples, block)):
        count = min(block, samples - start)
        store.append_audio(connection.id, sequence=sequence, start_sample=start, pcm=b"\0\0" * count)
    tokens: list[SonioxToken] = []
    at = 0
    previous: int | None = None
    for speaker, word in words:
        if previous is not None and speaker != previous:
            at += gap_ms
        previous = speaker
        text = word if not tokens else f" {word}"
        tokens.append(SonioxToken(text, at, at + 250, 0.99, True, "en", str(speaker)))
        at += 300
    store.save_event(connection.id, ordinal=0, event=SonioxEvent(
        final_tokens=tuple(tokens), partial_tokens=(), markers=(),
        final_audio_proc_ms=at, total_audio_proc_ms=at, finished=True,
    ))
    store.close(connection.id, finished=True)


async def new_session(client: httpx.AsyncClient, title: str = "Standup") -> str:
    response = await client.post("/sessions", json={"title": title})
    response.raise_for_status()
    return str(response.json()["id"])


async def settle(app: Any, session_id: str) -> None:
    service = app.state.runtime.proactive
    await service.scan(session_id)
    state = service._sessions.get(session_id)
    while state is not None and state.tasks:
        await asyncio.gather(*state.tasks.values(), return_exceptions=True)


def model_reply(outbound: FakeHttp, payload: dict[str, str] | str) -> None:
    content = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    outbound.json_route("POST", "chat/completions", chat_completion(content, model=MODEL))


MEETING = [
    (1, "The beta starts on March 3 after the security review."),
    (2, "And the pricing page ships a week later."),
    (1, "Alex, when does the beta start?"),
]


async def test_settings_are_off_by_default_and_need_names_and_consent(client: httpx.AsyncClient) -> None:
    settings = (await client.get("/settings")).json()
    assert settings["proactive"] == {"enabled": False, "aliases": [], "sound": False, "model_consent": False}

    missing_names = await client.put(
        "/settings", json={"proactive": {"enabled": True, "model_consent": True}},
    )
    assert missing_names.status_code == 400
    assert "name" in missing_names.json()["detail"]

    missing_consent = await client.put(
        "/settings", json={"proactive": {"enabled": True, "aliases": ["Alex"]}},
    )
    assert missing_consent.status_code == 400
    assert "model" in missing_consent.json()["detail"]

    enabled = await client.put("/settings", json={"proactive": {
        "enabled": True, "aliases": [" Alex ", "alex", "Саша"], "model_consent": True, "sound": True,
    }})
    assert enabled.status_code == 200
    assert enabled.json()["proactive"] == {
        "enabled": True, "aliases": ["Alex", "Саша"], "sound": True, "model_consent": True,
    }
    # Revoking consent alone would leave an enabled feature that may not call the model.
    assert (await client.put("/settings", json={"proactive": {"model_consent": False}})).status_code == 400
    off = await client.put("/settings", json={"proactive": {"enabled": False, "model_consent": False}})
    assert off.json()["proactive"]["enabled"] is False
    assert off.json()["proactive"]["aliases"] == ["Alex", "Саша"]


async def test_alias_list_is_bounded(client: httpx.AsyncClient) -> None:
    response = await client.put("/settings", json={"proactive": {"aliases": ["x"] * 21}})
    assert response.status_code == 422
    response = await client.put("/settings", json={"proactive": {"aliases": ["a\nb"]}})
    assert response.status_code == 422


async def test_direct_question_gets_one_card_with_grounded_answer(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, outbound: FakeHttp,
) -> None:
    configure(app, secrets)
    session_id = await new_session(client)
    speak(app, session_id, MEETING)
    model_reply(outbound, {
        "context": "The team discussed the launch schedule [P1].",
        "answer": "The beta starts on March 3, after the security review [P1]. It will be great.",
        "missing": "",
        "outside_recording": "Betas usually last a few weeks [P2].",
    })

    await settle(app, session_id)
    view = (await client.get(f"/sessions/{session_id}/proactive")).json()

    assert view["enabled"] is True and view["live"] is True and view["session_enabled"] is True
    [card] = view["cards"]
    assert card["addressed"] == "direct"
    assert card["question"] == "Alex, when does the beta start?"
    assert card["question_citation"]["text"] == "Alex, when does the beta start?"
    assert card["question_citation"]["speaker"] == 1
    assert [citation["text"] for citation in card["context_citations"]] == [
        "The beta starts on March 3 after the security review.", "And the pricing page ships a week later.",
    ]
    assert card["status"] == "answered"
    assert card["context"] == "The team discussed the launch schedule [P1]."
    # The uncited sentence is removed rather than shown as if it were said.
    assert card["answer"] == "The beta starts on March 3, after the security review [P1]."
    assert card["notice"] == "Sentences without a transcript source were removed."
    # Every claim resolves to a transcript fragment with timestamps.
    [citation] = card["citations"]
    assert citation["labels"] == ["P1"]
    assert citation["text"].startswith("The beta starts on March 3")
    assert citation["end_ms"] > citation["start_ms"] >= 0
    # The assistant's own knowledge carries no transcript labels.
    assert card["outside_recording"] == "Betas usually last a few weeks."
    assert card["public_query"] == "when does the beta start?"
    assert card["timings"]["answer_ms"] is not None

    # The model saw only the transcript up to the question, with the question marked.
    body = outbound.last_body
    prompt = body["messages"][-1]["content"]
    assert "Alex, when does the beta start?" in prompt
    assert "The question addressed to the listener is in [P3]" in prompt

    # A later scan of the same speech neither duplicates the card nor calls the model again.
    calls = len(outbound.requests)
    await settle(app, session_id)
    assert len((await client.get(f"/sessions/{session_id}/proactive")).json()["cards"]) == 1
    assert len(outbound.requests) == calls


async def test_third_person_mentions_and_statements_raise_no_card(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, outbound: FakeHttp,
) -> None:
    configure(app, secrets)
    session_id = await new_session(client)
    speak(app, session_id, [
        (1, "As Alex said, the beta starts on March 3."),
        (2, "Alex, thanks for the update."),
        (1, "Как сказал Саша, дедлайн в пятницу. Какие вопросы?"),
    ])
    await settle(app, session_id)
    assert (await client.get(f"/sessions/{session_id}/proactive")).json()["cards"] == []
    assert outbound.requests == []


async def test_missing_answer_is_stated_and_question_with_context_is_kept(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, outbound: FakeHttp,
) -> None:
    configure(app, secrets)
    session_id = await new_session(client)
    speak(app, session_id, [(1, "We reviewed the hiring plan."), (2, "Саша, какой бюджет на рекламу?")])
    model_reply(outbound, {
        "context": "Обсуждали план найма [P1].", "answer": "",
        "missing": "Бюджет на рекламу в записи не называли [P2].", "outside_recording": "",
    })
    await settle(app, session_id)
    [card] = (await client.get(f"/sessions/{session_id}/proactive")).json()["cards"]
    assert card["status"] == "no_answer"
    assert card["question"] == "Саша, какой бюджет на рекламу?"
    assert card["answer"] == ""
    assert card["missing"] == "Бюджет на рекламу в записи не называли."
    assert card["context_citations"][0]["text"] == "We reviewed the hiring plan."


async def test_invented_source_discards_the_draft(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, outbound: FakeHttp,
) -> None:
    configure(app, secrets)
    session_id = await new_session(client)
    speak(app, session_id, MEETING)
    model_reply(outbound, {"context": "", "answer": "It starts in April [P9].", "missing": "",
                           "outside_recording": ""})
    await settle(app, session_id)
    [card] = (await client.get(f"/sessions/{session_id}/proactive")).json()["cards"]
    assert card["status"] == "failed"
    assert card["answer"] == ""
    assert "not in this transcript" in card["notice"]


async def test_model_failure_keeps_question_and_context(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, outbound: FakeHttp,
) -> None:
    configure(app, secrets)
    session_id = await new_session(client)
    speak(app, session_id, MEETING)
    outbound.json_route("POST", "chat/completions", {"error": {"message": "overloaded"}}, status=503)
    await settle(app, session_id)
    [card] = (await client.get(f"/sessions/{session_id}/proactive")).json()["cards"]
    assert card["status"] == "no_answer"
    assert card["notice"].startswith("No draft answer")
    assert card["question"] == "Alex, when does the beta start?"
    assert len(card["context_citations"]) == 2


async def test_feature_off_or_imported_audio_never_triggers(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, outbound: FakeHttp,
) -> None:
    configure(app, secrets, enabled=False)
    session_id = await new_session(client)
    speak(app, session_id, MEETING)
    await settle(app, session_id)
    view = (await client.get(f"/sessions/{session_id}/proactive")).json()
    assert view["enabled"] is False and view["cards"] == []

    configure(app, secrets)
    imported = await new_session(client, "Imported lecture")
    speak(app, imported, MEETING)
    with app.state.runtime.db.write() as connection:
        connection.execute("UPDATE native_recordings SET origin='import' WHERE session_id=?", (imported,))
    await settle(app, imported)
    view = (await client.get(f"/sessions/{imported}/proactive")).json()
    assert view["live"] is False and view["cards"] == []
    assert outbound.requests == []


async def test_turning_off_for_a_session_stops_model_calls(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(app, secrets)
    session_id = await new_session(client)
    speak(app, session_id, MEETING)
    started = asyncio.Event()
    cancelled = asyncio.Event()
    calls: list[str] = []

    class SlowModel:
        provider, model = "openrouter", MODEL

        async def complete(self, messages: list[Any], *, max_tokens: int) -> str:
            calls.append(messages[-1].content)
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise
            return ""

    monkeypatch.setattr("skaz.agent.ask._gateway", lambda _runtime: SlowModel())
    service = app.state.runtime.proactive
    await service.scan(session_id)
    await asyncio.wait_for(started.wait(), 2)

    view = (await client.put(f"/sessions/{session_id}/proactive", json={"enabled": False})).json()
    await asyncio.wait_for(cancelled.wait(), 2)
    assert view["session_enabled"] is False
    [card] = view["cards"]
    assert card["status"] == "stopped"
    assert "Nothing more is sent" in card["notice"]

    # New speech in the same session starts no scan and no model call.
    service.notify(session_id)
    await service.scan(session_id)
    await asyncio.sleep(0)
    assert len(calls) == 1
    assert service._sessions[session_id].tasks == {}


async def test_disabling_the_feature_cancels_running_answers(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(app, secrets)
    session_id = await new_session(client)
    speak(app, session_id, MEETING)
    started = asyncio.Event()

    class SlowModel:
        provider, model = "openrouter", MODEL

        async def complete(self, messages: list[Any], *, max_tokens: int) -> str:
            started.set()
            await asyncio.Event().wait()
            return ""

    monkeypatch.setattr("skaz.agent.ask._gateway", lambda _runtime: SlowModel())
    await app.state.runtime.proactive.scan(session_id)
    await asyncio.wait_for(started.wait(), 2)
    response = await client.put("/settings", json={"proactive": {"enabled": False}})
    assert response.status_code == 200
    await asyncio.sleep(0)
    [card] = (await client.get(f"/sessions/{session_id}/proactive")).json()["cards"]
    assert card["status"] == "stopped"


async def test_notify_from_confirmed_speech_shows_the_card(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, outbound: FakeHttp,
) -> None:
    configure(app, secrets)
    session_id = await new_session(client)
    speak(app, session_id, MEETING)
    model_reply(outbound, {
        "context": "", "answer": "On March 3 [P1].", "missing": "", "outside_recording": "",
    })
    service = app.state.runtime.proactive
    service.notify(session_id)
    for _ in range(100):
        cards = (await client.get(f"/sessions/{session_id}/proactive")).json()["cards"]
        if cards and cards[0]["status"] == "answered":
            break
        await asyncio.sleep(0.02)
    assert cards[0]["answer"] == "On March 3 [P1]."
    assert cards[0]["timings"]["detect_ms"] is not None


async def test_unstructured_reply_is_read_as_the_draft_answer(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, outbound: FakeHttp,
) -> None:
    configure(app, secrets)
    session_id = await new_session(client)
    speak(app, session_id, MEETING)
    model_reply(outbound, "The beta starts on March 3. [P1]")
    await settle(app, session_id)
    [card] = (await client.get(f"/sessions/{session_id}/proactive")).json()["cards"]
    assert card["status"] == "answered"
    assert card["answer"] == "The beta starts on March 3 [P1]."
    assert card["notice"] is None


async def test_web_lookup_sends_only_an_approved_public_query_and_updates_the_card(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, outbound: FakeHttp,
) -> None:
    configure(app, secrets)
    session_id = await new_session(client)
    speak(app, session_id, MEETING)
    model_reply(outbound, {"context": "", "answer": "", "missing": "Not said.", "outside_recording": ""})
    await settle(app, session_id)
    [card] = (await client.get(f"/sessions/{session_id}/proactive")).json()["cards"]
    path = f"/sessions/{session_id}/proactive/cards/{card['id']}/web"

    not_configured = await client.post(path, json={"query": "beta programme length"})
    assert not_configured.status_code == 409

    sent: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json={"web": {"results": [
            {"title": "Beta testing", "url": "https://example.com/beta", "description": "How betas work."},
        ]}})

    runtime = app.state.runtime
    runtime.web_search._transport = lambda: httpx.MockTransport(respond)
    secrets.set("brave_search", "brave-key")
    await runtime.web_search.configure(enabled=True)

    named = await client.post(path, json={"query": "when does Alex's beta start"})
    assert named.status_code == 409
    assert "names" in named.json()["detail"]

    waiting = (await client.post(path, json={"query": "how long does a beta usually last"})).json()
    assert waiting["cards"][0]["web"]["status"] == "awaiting_approval"
    await asyncio.sleep(0)
    [pending] = (await client.get("/web-search/pending")).json()["requests"]
    assert pending["chat_id"] == f"proactive-{card['id']}"
    assert pending["query"] == "how long does a beta usually last"
    assert sent == []  # Nothing leaves before the exact query is approved.

    decision = await client.post(f"/web-search/requests/{pending['id']}/decision", json={
        "chat_id": pending["chat_id"], "query": pending["query"], "approved": True,
    })
    assert decision.status_code == 200
    for _ in range(50):
        web = (await client.get(f"/sessions/{session_id}/proactive")).json()["cards"][0]["web"]
        if web["status"] != "awaiting_approval":
            break
        await asyncio.sleep(0.01)
    assert web["status"] == "completed"
    assert web["results"][0]["url"] == "https://example.com/beta"
    [request] = sent
    assert request.url.params["q"] == "how long does a beta usually last"
    # Still the same single card: the lookup updated it in place.
    assert len((await client.get(f"/sessions/{session_id}/proactive")).json()["cards"]) == 1


async def test_unknown_session_is_404(client: httpx.AsyncClient) -> None:
    assert (await client.get("/sessions/missing/proactive")).status_code == 404
    assert (await client.put("/sessions/missing/proactive", json={"enabled": False})).status_code == 404


def test_live_stream_confirmed_speech_raises_the_card(
    app: Any, secrets: MemorySecretStore, outbound: FakeHttp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The production WS path: a final Soniox event wakes the scanner by itself."""

    class Speech(ProviderSocket):
        async def send(self, message: str | bytes) -> None:
            if isinstance(message, bytes) and message:
                self.audio.append(message)
            elif not message:
                words = ["Alex,", " when", " does", " the", " beta", " start?"]
                await self.responses.put(json.dumps({
                    "tokens": [
                        {"text": word, "speaker": "1", "start_ms": index * 10, "end_ms": index * 10 + 8,
                         "confidence": .99, "is_final": True, "language": "en"}
                        for index, word in enumerate(words)
                    ],
                    "final_audio_proc_ms": 100, "total_audio_proc_ms": 100, "finished": True,
                }))

    async def connect(*args: Any, **kwargs: Any) -> Speech:
        return Speech()

    monkeypatch.setattr(soniox, "connect", connect)
    configure(app, secrets)
    secrets.set("soniox", "fixture-key-not-real")
    model_reply(outbound, {"context": "", "answer": "", "missing": "Not said.", "outside_recording": ""})
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        sid = http.post("/sessions", headers=AUTH, json={"title": "Live"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            assert http.portal is not None
            http.portal.call(asyncio.sleep, 0)
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["type"] == "audio.saved"
            ws.send_json({"type": "end", "action": "stop"})
            assert ws.receive_json()["type"] == "stream.stopped"
        cards: list[dict[str, Any]] = []
        for _ in range(200):
            cards = http.get(f"/sessions/{sid}/proactive", headers=AUTH).json()["cards"]
            if cards and cards[0]["status"] != "answering":
                break
            http.portal.call(asyncio.sleep, 0.01)
        assert [card["question"] for card in cards] == ["Alex, when does the beta start?"]
        assert cards[0]["status"] == "no_answer"
        assert cards[0]["timings"]["detect_ms"] is not None


def speak_events(app: Any, session_id: str, sentences: list[tuple[int, str]]) -> None:
    """One confirmed Soniox event per sentence, as a long live recording stores them."""
    store = app.state.runtime.live_store
    words = sum(len(text.split()) for _speaker, text in sentences)
    total_ms = words * 300 + 1000
    connection = store.open(session_id, sample_rate=RATE, model="stt-rt-v3")
    samples = total_ms * RATE // 1000
    for sequence, start in enumerate(range(0, samples, RATE // 2)):
        store.append_audio(connection.id, sequence=sequence, start_sample=start,
                           pcm=b"\0\0" * min(RATE // 2, samples - start))
    at = 0
    for ordinal, (speaker, text) in enumerate(sentences):
        tokens = []
        for word in text.split():
            text_piece = f" {word}" if at else word
            tokens.append(SonioxToken(text_piece, at, at + 250, 0.99, True, "en", str(speaker)))
            at += 300
        store.save_event(connection.id, ordinal=ordinal, event=SonioxEvent(
            final_tokens=tuple(tokens), partial_tokens=(), markers=(),
            final_audio_proc_ms=at, total_audio_proc_ms=at, finished=False,
        ))
    store.close(connection.id, finished=True)


async def test_long_session_scan_reads_only_recent_speech(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, outbound: FakeHttp,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An hour-long transcript: the old question stays silent, the new one gets its context."""
    from skaz import proactive as service

    configure(app, secrets, model_consent=True)
    session_id = await new_session(client)
    filler = [
        (1 + index % 2, f"Point number {index} of the lecture was explained in detail.")
        for index in range(1500)
    ]
    speak_events(app, session_id, [
        (2, "Alex, what was the first topic?"),  # Long ago: never raised now.
        *filler,
        (1, "The release moves to June because of the audit."),
        (2, "Alex, when is the release?"),
    ])
    model_reply(outbound, {"context": "", "answer": "In June [P1].", "missing": "", "outside_recording": ""})
    reads: list[int] = []
    original = service.ProactiveService._recent

    def counting(self: Any, session_id: str, *, span_ms: int | None, chars: int | None) -> Any:
        result = original(self, session_id, span_ms=span_ms, chars=chars)
        reads.append(sum(len(item.tokens) for item in result))
        return result

    monkeypatch.setattr(service.ProactiveService, "_recent", counting)
    await settle(app, session_id)
    [card] = (await client.get(f"/sessions/{session_id}/proactive")).json()["cards"]
    assert card["question"] == "Alex, when is the release?"
    assert card["context_citations"][-1]["text"] == "The release moves to June because of the audit."
    assert card["answer"] == "In June [P1]."
    total_words = 7 + sum(len(text.split()) for _speaker, text in filler) + 13
    # Detection read a bounded tail, far from the whole transcript.
    assert reads[0] < total_words // 5


async def test_many_names_are_matched_in_one_pass(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, outbound: FakeHttp,
) -> None:
    names = [f"Name{index}" for index in range(19)] + ["Alex"]
    configure(app, secrets, aliases=names)
    session_id = await new_session(client)
    speak(app, session_id, MEETING)
    model_reply(outbound, {"context": "", "answer": "", "missing": "Not said.", "outside_recording": ""})
    await settle(app, session_id)
    [card] = (await client.get(f"/sessions/{session_id}/proactive")).json()["cards"]
    assert card["question"] == "Alex, when does the beta start?"
    assert card["public_query"] == "when does the beta start?"


async def test_push_feed_reports_new_cards_without_content(
    app: Any, client: httpx.AsyncClient, secrets: MemorySecretStore, outbound: FakeHttp,
) -> None:
    configure(app, secrets, sound=True)
    session_id = await new_session(client)
    start = (await client.get("/proactive/events", params={"after": -1})).json()
    assert start == {"seq": 0, "changes": [], "sound": True}

    # Nothing yet: the long-poll waits and returns empty at its timeout.
    idle = (await client.get("/proactive/events", params={"after": 0, "timeout": 0.05})).json()
    assert idle["changes"] == []

    speak(app, session_id, MEETING)
    model_reply(outbound, {"context": "", "answer": "", "missing": "Not said.", "outside_recording": ""})
    waiting = asyncio.create_task(client.get("/proactive/events", params={"after": 0, "timeout": 5}))
    await asyncio.sleep(0.05)
    assert not waiting.done()
    await settle(app, session_id)
    feed = (await asyncio.wait_for(waiting, 2)).json()
    assert feed["changes"][0] == {"session_id": session_id, "new_cards": 1}
    assert "Alex" not in json.dumps(feed)  # Ids and counts only, never card text.

    # The answer filling the same card is a change, not a new card.
    later = (await client.get("/proactive/events", params={"after": feed["seq"], "timeout": 0})).json()
    assert all(change["new_cards"] == 0 for change in later["changes"])
    # A reader from before a backend restart starts over instead of replaying.
    assert (await client.get("/proactive/events", params={"after": 10_000})).json()["changes"] == []
