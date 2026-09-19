"""Deterministic Soniox async REST protocol tests; never contact the provider."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from audiohelper.gateways.soniox_async import (
    ASYNC_MODEL,
    AsyncRequest,
    SonioxAsyncError,
    SonioxAsyncGateway,
    SonioxAsyncProtocolError,
)

FILE_ID = "84c32fc6-4fb5-4e7a-b656-b5ec70493753"
JOB_ID = "73d4357d-cad2-4338-a60d-ec6f2044f721"


class Recorder:
    """Collects outbound requests and replays scripted responses."""

    def __init__(self, *responses: httpx.Response | Exception) -> None:
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        nxt = self.responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def client(recorder: Recorder) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(recorder.handler))


def gateway(recorder: Recorder) -> SonioxAsyncGateway:
    return SonioxAsyncGateway(api_key="secret-key", http=client(recorder))


def job_body(**over: Any) -> dict[str, Any]:
    return {"id": JOB_ID, "status": "queued", "audio_duration_ms": None,
            "error_type": None, "error_message": None, **over}


async def test_upload_sends_multipart_and_returns_identity() -> None:
    recorder = Recorder(httpx.Response(201, json={
        "id": FILE_ID, "filename": "lecture.m4a", "size": 4096,
    }))
    uploaded = await gateway(recorder).upload(filename="lecture.m4a", content=b"\x00\x01audio")

    assert uploaded.id == FILE_ID
    assert uploaded.filename == "lecture.m4a"
    assert uploaded.size == 4096
    request = recorder.requests[0]
    assert request.method == "POST"
    assert str(request.url).endswith("/v1/files")
    assert request.headers["authorization"] == "Bearer secret-key"
    assert b"lecture.m4a" in request.content


async def test_create_requests_diarization_and_language_identification() -> None:
    recorder = Recorder(httpx.Response(201, json=job_body()))
    job = await gateway(recorder).create(file_id=FILE_ID, request=AsyncRequest())

    assert job.id == JOB_ID and job.status == "queued"
    import json

    body = json.loads(recorder.requests[0].content)
    assert body == {
        "model": ASYNC_MODEL, "file_id": FILE_ID,
        "enable_speaker_diarization": True, "enable_language_identification": True,
    }


async def test_create_includes_translation_and_strict_language_hints() -> None:
    recorder = Recorder(httpx.Response(201, json=job_body()))
    await gateway(recorder).create(
        file_id=FILE_ID,
        request=AsyncRequest(translation_target_language="ru", used_languages=("ru", "en")),
    )

    import json

    body = json.loads(recorder.requests[0].content)
    assert body["translation"] == {"type": "one_way", "target_language": "ru"}
    assert body["language_hints"] == ["ru", "en"]
    assert body["language_hints_strict"] is True


def test_request_rejects_a_real_time_model() -> None:
    with pytest.raises(ValueError, match="async STT model"):
        AsyncRequest(model="stt-rt-v5")


def test_request_rejects_an_invalid_translation_language() -> None:
    with pytest.raises(ValueError, match="language code"):
        AsyncRequest(translation_target_language="Russian please")


async def test_status_reports_provider_failure_detail() -> None:
    recorder = Recorder(httpx.Response(200, json=job_body(
        status="error", error_type="audio_decode_failed",
        error_message="The audio could not be decoded.",
    )))
    job = await gateway(recorder).status(JOB_ID)

    assert job.status == "error"
    assert job.error_type == "audio_decode_failed"
    assert job.error_message == "The audio could not be decoded."


async def test_transcript_parses_speaker_language_and_translation_status() -> None:
    recorder = Recorder(httpx.Response(200, json={"id": JOB_ID, "text": "Привет", "tokens": [
        {"text": "При", "start_ms": 10, "end_ms": 90, "confidence": 0.95,
         "speaker": "1", "language": "ru", "translation_status": "original"},
        {"text": "Hi", "start_ms": 0, "end_ms": 0, "confidence": 0.9,
         "speaker": "1", "language": "en", "translation_status": "translation"},
        {"text": "вет", "start_ms": 90, "end_ms": 160, "confidence": 0.98},
    ]}))
    transcript = await gateway(recorder).transcript(JOB_ID)

    assert [token.text for token in transcript.tokens] == ["При", "Hi", "вет"]
    assert transcript.tokens[0].speaker == "1"
    assert transcript.tokens[1].translation_status == "translation"
    # An untagged token keeps the documented default rather than being guessed at.
    assert transcript.tokens[2].translation_status == "none"
    assert transcript.tokens[2].speaker is None


async def test_transcript_rejects_reversed_timestamps() -> None:
    recorder = Recorder(httpx.Response(200, json={"id": JOB_ID, "text": "x", "tokens": [
        {"text": "x", "start_ms": 500, "end_ms": 100, "confidence": 0.9},
    ]}))
    with pytest.raises(SonioxAsyncProtocolError):
        await gateway(recorder).transcript(JOB_ID)


async def test_transcript_rejects_out_of_range_confidence() -> None:
    recorder = Recorder(httpx.Response(200, json={"id": JOB_ID, "text": "x", "tokens": [
        {"text": "x", "start_ms": 0, "end_ms": 10, "confidence": 1.5},
    ]}))
    with pytest.raises(SonioxAsyncProtocolError):
        await gateway(recorder).transcript(JOB_ID)


async def test_transport_failure_is_retryable() -> None:
    recorder = Recorder(httpx.ConnectError("no route"))
    with pytest.raises(SonioxAsyncError) as raised:
        await gateway(recorder).status(JOB_ID)

    assert raised.value.retryable is True


@pytest.mark.parametrize(("status", "retryable"), [
    (400, False), (401, False), (402, False), (429, True), (500, True), (503, True),
])
async def test_http_status_classification(status: int, retryable: bool) -> None:
    recorder = Recorder(httpx.Response(status, json={"error_type": "invalid_request"}))
    with pytest.raises(SonioxAsyncError) as raised:
        await gateway(recorder).status(JOB_ID)

    assert raised.value.retryable is retryable
    assert str(status) in str(raised.value)


async def test_errors_never_leak_the_api_key_or_unsafe_provider_prose() -> None:
    recorder = Recorder(httpx.Response(401, json={
        "error_type": "key secret-key <script>alert(1)</script> leaked", "message": "x" * 500,
    }))
    with pytest.raises(SonioxAsyncError) as raised:
        await gateway(recorder).status(JOB_ID)

    assert "secret-key" not in str(raised.value)
    assert "<script>" not in str(raised.value)


async def test_deleting_an_absent_file_is_not_an_error() -> None:
    recorder = Recorder(httpx.Response(404, json={"error_type": "file_not_found"}))
    await gateway(recorder).delete_file(FILE_ID)

    assert recorder.requests[0].method == "DELETE"


async def test_deleting_a_processing_transcription_raises() -> None:
    # The provider refuses deletion while the job runs; the caller must not treat
    # that refusal as a completed cancellation.
    recorder = Recorder(httpx.Response(409, json={"error_type": "invalid_state"}))
    with pytest.raises(SonioxAsyncError):
        await gateway(recorder).delete_transcription(JOB_ID)


async def test_unknown_job_status_is_a_protocol_error() -> None:
    recorder = Recorder(httpx.Response(200, json=job_body(status="almost_done")))
    with pytest.raises(SonioxAsyncProtocolError):
        await gateway(recorder).status(JOB_ID)


async def test_non_uuid_identifier_is_rejected_before_the_request() -> None:
    recorder = Recorder()
    with pytest.raises(SonioxAsyncProtocolError):
        await gateway(recorder).status("../../admin")

    assert recorder.requests == []


def test_gateway_requires_https_and_a_key() -> None:
    recorder = Recorder()
    with pytest.raises(ValueError, match="https"):
        SonioxAsyncGateway(api_key="k", http=client(recorder), base_url="http://api.soniox.com/v1")
    with pytest.raises(ValueError, match="api_key"):
        SonioxAsyncGateway(api_key="  ", http=client(recorder))
