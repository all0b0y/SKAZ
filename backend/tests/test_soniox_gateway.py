"""Deterministic Soniox WebSocket protocol tests; never contact the provider."""

from __future__ import annotations

import asyncio
import json
import os
import runpy
import struct
import subprocess
import sys
import wave
from pathlib import Path
from typing import Any

import pytest

from audiohelper.gateways.soniox import (
    DEFAULT_MODEL,
    SONIOX_WEBSOCKET_URL,
    SonioxConfig,
    SonioxGateway,
    SonioxGatewayError,
)


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[str | bytes] = []
        self.incoming: asyncio.Queue[str | bytes | Exception] = asyncio.Queue()
        self.closed = False

    async def send(self, message: str | bytes) -> None:
        self.sent.append(message)

    async def recv(self) -> str | bytes:
        message = await self.incoming.get()
        if isinstance(message, Exception):
            raise message
        return message

    async def close(self) -> None:
        self.closed = True


class FakeConnector:
    def __init__(self, socket: FakeSocket) -> None:
        self.socket = socket
        self.urls: list[str] = []

    async def __call__(self, url: str) -> FakeSocket:
        self.urls.append(url)
        return self.socket


def response(
    *,
    tokens: list[dict[str, Any]] | None = None,
    final_ms: int = 0,
    total_ms: int = 0,
    finished: bool = False,
) -> str:
    return json.dumps(
        {
            "tokens": tokens or [],
            "final_audio_proc_ms": final_ms,
            "total_audio_proc_ms": total_ms,
            **({"finished": True} if finished else {}),
        }
    )


def token(text: str, *, final: bool, start_ms: int = 0, end_ms: int = 100) -> dict[str, Any]:
    return {
        "text": text,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "confidence": 0.9,
        "is_final": final,
        "language": "en",
    }


async def open_fake(*, sample_rate: int = 16_000) -> tuple[FakeSocket, FakeConnector, Any]:
    socket = FakeSocket()
    connector = FakeConnector(socket)
    gateway = SonioxGateway(
        api_key="secret-key",
        config=SonioxConfig(sample_rate=sample_rate),
        connector=connector,
    )
    return socket, connector, await gateway.open()


def test_config_rejects_invalid_pcm_shapes_and_models() -> None:
    for sample_rate in (0, -1, 7999, 48_001, True):
        with pytest.raises(ValueError):
            SonioxConfig(sample_rate=sample_rate)
    with pytest.raises(ValueError):
        SonioxConfig(sample_rate=16_000, num_channels=2)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        SonioxConfig(sample_rate=16_000, audio_format="wav")  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        SonioxConfig(sample_rate=16_000, model="stt-async-v5")


async def test_open_sends_accuracy_first_multilingual_configuration() -> None:
    socket, connector, session = await open_fake(sample_rate=24_000)
    settings = json.loads(str(socket.sent[0]))

    assert connector.urls == [SONIOX_WEBSOCKET_URL]
    assert settings == {
        "api_key": "secret-key",
        "model": DEFAULT_MODEL,
        "audio_format": "pcm_s16le",
        "sample_rate": 24_000,
        "num_channels": 1,
        "enable_language_identification": True,
        "enable_speaker_diarization": True,
        "enable_endpoint_detection": False,
    }
    assert "translation" not in settings
    assert "language_hints" not in settings
    await session.aclose()


async def test_translation_stream_keeps_original_and_untimed_translation_separate() -> None:
    socket = FakeSocket()
    session = await SonioxGateway(
        api_key="secret-key", connector=FakeConnector(socket),
        config=SonioxConfig(sample_rate=16_000, translation_target_language="ru"),
    ).open()
    assert json.loads(str(socket.sent[0]))["translation"] == {
        "type": "one_way", "target_language": "ru",
    }
    translated = {
        "text": "Привет", "confidence": 0.9, "is_final": False,
        "translation_status": "translation", "language": "ru",
        "source_language": "en", "speaker": "1",
    }
    socket.incoming.put_nowait(response(tokens=[
        {**token("Hello", final=True), "translation_status": "original", "speaker": "1"},
        translated,
    ], final_ms=100, total_ms=100))
    socket.incoming.put_nowait(response(tokens=[
        {**translated, "text": "Здравствуйте", "is_final": True},
    ], final_ms=100, total_ms=100))
    socket.incoming.put_nowait(response(final_ms=100, total_ms=100, finished=True))
    events = [event async for event in session.events()]
    assert len(events) == 3
    assert [item.text for item in events[0].final_tokens] == ["Hello"]
    assert events[0].partial_tokens == ()
    assert [item.text for item in events[0].partial_translation_tokens] == ["Привет"]
    result = events[1].final_translation_tokens[0]
    assert result.text == "Здравствуйте"
    assert result.speaker == "1"
    assert result.language == "ru"
    assert result.source_language == "en"
    assert not hasattr(result, "start_ms")
    assert not hasattr(result, "end_ms")
    assert events[1].final_tokens == ()
    assert events[1].partial_translation_tokens == ()
    assert (await session.finish()).finished is True


@pytest.mark.parametrize("language", ["", "RU", "ru en", "../ru", "r", "r" * 33])
def test_translation_target_rejects_malformed_language_codes(language: str) -> None:
    with pytest.raises(ValueError, match="language code"):
        SonioxConfig(sample_rate=16_000, translation_target_language=language)


@pytest.mark.parametrize("override", [
    {"translation_status": "unexpected"}, {"source_language": 7},
    {"confidence": True}, {"speaker": 7}, {"language": []},
])
async def test_invalid_translation_metadata_fails_without_payload_leak(override: dict[str, Any]) -> None:
    socket = FakeSocket()
    session = await SonioxGateway(
        api_key="secret-key", connector=FakeConnector(socket),
        config=SonioxConfig(sample_rate=16_000, translation_target_language="ru"),
    ).open()
    socket.incoming.put_nowait(response(tokens=[{
        "text": "PRIVATE_TRANSCRIPT", "confidence": .9, "is_final": True,
        "translation_status": "translation", "language": "ru", "source_language": "en",
        **override,
    }]))
    assert [event async for event in session.events()] == []
    completion = await session.finish(timeout_s=.2)
    assert completion.finished is False
    assert completion.error == "Soniox returned an invalid protocol message."


async def test_unsolicited_translation_is_not_accepted_in_transcription_only_mode() -> None:
    socket, _connector, session = await open_fake()
    socket.incoming.put_nowait(response(tokens=[{
        "text": "Привет", "confidence": .9, "is_final": True,
        "translation_status": "translation",
    }]))
    assert [event async for event in session.events()] == []
    assert (await session.finish(timeout_s=.2)).finished is False


async def test_audio_is_binary_even_pcm_and_bounded() -> None:
    socket, _connector, session = await open_fake()

    await session.send_audio(b"\x01\x00" * 160)
    assert socket.sent[1] == b"\x01\x00" * 160
    assert isinstance(socket.sent[1], bytes)

    with pytest.raises(ValueError, match="non-empty"):
        await session.send_audio(b"")
    with pytest.raises(ValueError, match="whole PCM16"):
        await session.send_audio(b"\x00")
    with pytest.raises(ValueError, match="maximum"):
        await session.send_audio(b"\x00\x00" * 16_001)
    await session.aclose()


async def test_connection_and_send_failures_are_sanitized() -> None:
    async def fail_connect(_url: str) -> FakeSocket:
        raise ConnectionError("PRIVATE_TRANSCRIPT secret-key")

    gateway = SonioxGateway(
        api_key="secret-key",
        config=SonioxConfig(sample_rate=16_000),
        connector=fail_connect,
    )
    with pytest.raises(SonioxGatewayError) as connect_error:
        await gateway.open()
    assert str(connect_error.value) == "Soniox connection could not be established."

    socket, _connector, session = await open_fake()

    async def fail_send(_message: str | bytes) -> None:
        raise ConnectionError("PRIVATE_TRANSCRIPT secret-key")

    socket.send = fail_send  # type: ignore[assignment]
    with pytest.raises(SonioxGatewayError) as send_error:
        await session.send_audio(b"\x00\x00")
    assert str(send_error.value) == "Soniox connection ended while sending audio."
    completion = await session.finish()
    assert completion.finished is False
    assert completion.error == "Soniox connection ended while sending audio."


async def test_events_split_final_delta_partial_replacement_and_markers() -> None:
    socket, _connector, session = await open_fake()
    socket.incoming.put_nowait(
        response(
            tokens=[
                token("Hello", final=True, end_ms=120),
                token(" world", final=False, start_ms=120, end_ms=240),
            ],
            final_ms=120,
            total_ms=240,
        )
    )
    socket.incoming.put_nowait(
        response(
            tokens=[
                token(" world!", final=False, start_ms=120, end_ms=300),
                {"text": "<end>", "is_final": True},
                {"text": "<fin>", "is_final": True},
            ],
            final_ms=120,
            total_ms=300,
        )
    )
    socket.incoming.put_nowait(response(final_ms=300, total_ms=300, finished=True))

    events = [event async for event in session.events()]

    assert [item.text for item in events[0].final_tokens] == ["Hello"]
    assert [item.text for item in events[0].partial_tokens] == [" world"]
    assert [item.text for item in events[1].final_tokens] == []
    assert [item.text for item in events[1].partial_tokens] == [" world!"]
    assert events[1].markers == ("end", "fin")
    assert events[2].finished is True
    assert events[2].final_audio_proc_ms == 300


async def test_finish_sends_empty_binary_once_and_waits_for_finished() -> None:
    socket, _connector, session = await open_fake()

    first_task = asyncio.create_task(session.finish())
    second_task = asyncio.create_task(session.finish())

    async def wait_for_end_frame() -> None:
        while b"" not in socket.sent:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait_for_end_frame(), timeout=0.1)
    assert socket.sent.count(b"") == 1
    socket.incoming.put_nowait(response(final_ms=160, total_ms=160, finished=True))
    first, second = await asyncio.gather(first_task, second_task)

    assert first == second
    assert first.finished is True
    assert first.error is None
    assert socket.closed is True


async def test_finish_timeout_is_explicit_incomplete_and_closes() -> None:
    socket, _connector, session = await open_fake()

    completion = await session.finish(timeout_s=0.01)

    assert completion.finished is False
    assert completion.error == "Soniox finalization timed out."
    assert socket.closed is True


async def test_finish_deadline_includes_a_blocked_end_frame_send() -> None:
    class BlockedEndSocket(FakeSocket):
        async def send(self, message: str | bytes) -> None:
            if message == b"":
                await asyncio.Event().wait()
            await super().send(message)

    socket = BlockedEndSocket()
    session = await SonioxGateway(
        api_key="test-key",
        config=SonioxConfig(sample_rate=16_000),
        connector=FakeConnector(socket),
    ).open()
    try:
        completion = await asyncio.wait_for(session.finish(timeout_s=0.01), timeout=0.2)
        assert completion.finished is False
        assert completion.error == "Soniox finalization timed out."
        assert socket.closed
    finally:
        await session.aclose()


async def test_socket_close_never_counts_as_finished() -> None:
    socket, _connector, session = await open_fake()
    socket.incoming.put_nowait(ConnectionError("PRIVATE_TRANSCRIPT secret-key"))

    completion = await session.finish(timeout_s=0.2)

    assert completion.finished is False
    assert completion.error == "Soniox connection ended before finished confirmation."
    assert "PRIVATE_TRANSCRIPT" not in completion.error
    assert "secret-key" not in completion.error


async def test_provider_error_is_sanitized_and_request_id_is_preserved() -> None:
    socket, _connector, session = await open_fake()
    socket.incoming.put_nowait(
        json.dumps(
            {
                "tokens": [],
                "error_code": 401,
                "error_type": "unauthenticated",
                "error_message": "bad secret-key PRIVATE_TRANSCRIPT",
                "request_id": "request-safe-123",
            }
        )
    )

    completion = await session.finish(timeout_s=0.2)

    assert completion.finished is False
    assert completion.error == (
        "Soniox request failed (HTTP 401, unauthenticated, request request-safe-123)."
    )
    assert "secret-key" not in completion.error
    assert "PRIVATE_TRANSCRIPT" not in completion.error


@pytest.mark.parametrize(
    "payload",
    [
        b"binary response",
        "not json",
        "[]",
        json.dumps({"tokens": "wrong", "final_audio_proc_ms": 0, "total_audio_proc_ms": 0}),
        response(tokens=[{"text": "x", "is_final": "yes"}]),
        response(tokens=[token("x", final=True, start_ms=20, end_ms=10)]),
        response(tokens=[token("x", final=True)], final_ms=2, total_ms=1),
    ],
)
async def test_invalid_messages_end_in_protocol_error_without_payload_leak(
    payload: str | bytes,
) -> None:
    socket, _connector, session = await open_fake()
    socket.incoming.put_nowait(payload)

    completion = await session.finish(timeout_s=0.2)

    assert completion.finished is False
    assert completion.error == "Soniox returned an invalid protocol message."


async def test_progress_cannot_move_backwards() -> None:
    socket, _connector, session = await open_fake()
    socket.incoming.put_nowait(response(final_ms=100, total_ms=120))
    socket.incoming.put_nowait(response(final_ms=90, total_ms=120))

    events = session.events()
    first = await anext(events)
    assert first.final_audio_proc_ms == 100
    with pytest.raises(StopAsyncIteration):
        await anext(events)
    completion = await session.finish(timeout_s=0.2)
    assert completion.error == "Soniox returned an invalid protocol message."


async def test_events_are_bounded_when_consumer_is_slow() -> None:
    socket = FakeSocket()
    connector = FakeConnector(socket)
    gateway = SonioxGateway(
        api_key="secret-key",
        config=SonioxConfig(sample_rate=16_000, event_queue_size=2),
        connector=connector,
    )
    session = await gateway.open()
    for index in range(20):
        socket.incoming.put_nowait(response(final_ms=index, total_ms=index))
    await asyncio.sleep(0)

    assert session.pending_event_count <= 2
    await session.aclose()


async def test_protocol_failure_keeps_already_queued_events() -> None:
    socket = FakeSocket()
    connector = FakeConnector(socket)
    session = await SonioxGateway(
        api_key="secret-key",
        config=SonioxConfig(sample_rate=16_000, event_queue_size=2),
        connector=connector,
    ).open()
    socket.incoming.put_nowait(response(final_ms=1, total_ms=1))
    socket.incoming.put_nowait(response(final_ms=2, total_ms=2))
    socket.incoming.put_nowait("invalid")

    events = [event async for event in session.events()]
    completion = await session.finish()

    assert [event.final_audio_proc_ms for event in events] == [1, 2]
    assert completion.finished is False
    assert completion.error == "Soniox returned an invalid protocol message."


async def test_smoke_keeps_received_text_and_token_times_after_send_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FailingSocket(FakeSocket):
        audio_count = 0

        async def send(self, message: str | bytes) -> None:
            if isinstance(message, bytes) and message:
                self.audio_count += 1
                if self.audio_count == 2:
                    raise OSError("private transport error")
                self.incoming.put_nowait(response(
                    tokens=[token("Hello", final=True, start_ms=10, end_ms=90)],
                    final_ms=100, total_ms=100,
                ))
            await super().send(message)

    socket = FailingSocket()

    async def connect_locally(*args: Any, **kwargs: Any) -> FakeSocket:
        return socket

    # Replace the external network boundary, not the production gateway.
    monkeypatch.setattr("audiohelper.gateways.soniox.connect", connect_locally)
    monkeypatch.setenv("SONIOX_API_KEY", "local-test-key")
    wav = tmp_path / "fixture.wav"
    with wave.open(str(wav), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16_000)
        handle.writeframes(b"\x00\x00" * 3200)
    output = tmp_path / "report.json"
    root = Path(__file__).resolve().parents[2]
    script = runpy.run_path(str(root / "scripts" / "streaming_asr_smoke.py"))
    args = script["parser"]().parse_args([
        str(wav), "--output", str(output), "--allow-paid-api",
    ])
    assert await script["run"](args) == 1
    report = json.loads(output.read_text())
    assert report["final_text"] == "Hello"
    assert report["events"][0]["final_tokens"][0]["start_ms"] == 10
    assert report["events"][0]["final_tokens"][0]["end_ms"] == 90
    assert report["timing_s"]["first_final"] is not None
    assert "private transport error" not in output.read_text()


def _write_wav(path: Path, *, channels: int = 1, sample_width: int = 2) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(sample_width)
        handle.setframerate(16_000)
        handle.writeframes(struct.pack("<h", 1) * 160)


def _run_smoke(root: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    script = root / "scripts" / "streaming_asr_smoke.py"
    return subprocess.run(
        [sys.executable, str(script), *args],
        cwd=root,
        env=env,
        text=True,
        capture_output=True,
        timeout=5,
        check=False,
    )


def test_smoke_help_and_validation_need_no_credentials(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[2]
    wav = tmp_path / "fixture.wav"
    _write_wav(wav)
    env = {key: value for key, value in os.environ.items() if key != "SONIOX_API_KEY"}

    help_result = _run_smoke(root, "--help", env=env)
    validate_result = _run_smoke(root, str(wav), "--validate-only", env=env)

    assert help_result.returncode == 0
    assert "--allow-paid-api" in help_result.stdout
    assert validate_result.returncode == 0
    assert "valid PCM16 mono WAV" in validate_result.stdout


def test_smoke_refuses_before_credentials_or_network(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[2]
    wav = tmp_path / "fixture.wav"
    output = tmp_path / "report.json"
    _write_wav(wav)
    env = dict(os.environ)
    env["SONIOX_API_KEY"] = "must-not-be-used"

    result = _run_smoke(root, str(wav), "--output", str(output), env=env)

    assert result.returncode == 2
    assert "--allow-paid-api is required" in result.stderr
    assert not output.exists()


@pytest.mark.parametrize("channels,sample_width", [(2, 2), (1, 1)])
def test_smoke_validation_rejects_non_pcm16_mono_wav(
    tmp_path: Path, channels: int, sample_width: int
) -> None:
    root = Path(__file__).resolve().parents[2]
    wav = tmp_path / "bad.wav"
    _write_wav(wav, channels=channels, sample_width=sample_width)

    result = _run_smoke(root, str(wav), "--validate-only")

    assert result.returncode == 2
    assert "PCM16 mono WAV" in result.stderr
