"""Shared fixtures.

External HTTP gateways are exercised through an injected ``httpx`` transport, so
tests drive the same production code paths (request building, header handling,
response parsing) instead of patching internal methods.
"""

from __future__ import annotations

import io
import json
import math
import struct
import wave
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.secrets import MemorySecretStore

TOKEN = "test-token"


def make_wav(
    seconds: float = 1.0,
    *,
    sample_rate: int = 16_000,
    channels: int = 1,
    sample_width: int = 2,
    frequency: float = 440.0,
) -> bytes:
    """A standalone PCM WAV tone; the same shape the renderer uploads."""
    frame_count = int(seconds * sample_rate)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(sample_width)
        handle.setframerate(sample_rate)
        frames = bytearray()
        for index in range(frame_count):
            value = int(12000 * math.sin(2 * math.pi * frequency * index / sample_rate))
            for _ in range(channels):
                if sample_width == 2:
                    frames += struct.pack("<h", value)
                else:
                    frames += struct.pack("<b", value >> 8)
        handle.writeframes(bytes(frames))
    return buffer.getvalue()


def chat_completion(content: str, model: str = "google/gemini-2.5-flash-lite") -> dict[str, Any]:
    return {
        "id": "gen-test",
        "model": model,
        "choices": [{"message": {"role": "assistant", "content": content}}],
    }


@dataclass
class FakeHttp:
    """Records outbound requests and replies from registered route handlers."""

    routes: dict[tuple[str, str], Callable[[httpx.Request], httpx.Response]] = field(default_factory=dict)
    requests: list[httpx.Request] = field(default_factory=list)
    bodies: list[Any] = field(default_factory=list)

    def route(
        self, method: str, url_contains: str
    ) -> Callable[[Callable[[httpx.Request], httpx.Response]], Callable[[httpx.Request], httpx.Response]]:
        def register(
            handler: Callable[[httpx.Request], httpx.Response],
        ) -> Callable[[httpx.Request], httpx.Response]:
            self.routes[(method.upper(), url_contains)] = handler
            return handler

        return register

    def json_route(self, method: str, url_contains: str, payload: Any, status: int = 200) -> None:
        self.routes[(method.upper(), url_contains)] = lambda _request: httpx.Response(status, json=payload)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        body = request.content
        self.bodies.append(json.loads(body) if body[:1] in (b"{", b"[") else body)
        for (method, fragment), handler in self.routes.items():
            if request.method == method and fragment in str(request.url):
                return handler(request)
        return httpx.Response(404, json={"error": {"message": f"no stub for {request.method} {request.url}"}})

    @property
    def last_body(self) -> Any:
        return self.bodies[-1]

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handle), timeout=5.0)


@pytest.fixture
def outbound() -> FakeHttp:
    return FakeHttp()


@pytest.fixture
def secrets() -> MemorySecretStore:
    return MemorySecretStore()


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return AppConfig(token=TOKEN, data_dir=tmp_path / "data", request_timeout_s=5.0, retain_native_audio=True)


@pytest.fixture
def app(config: AppConfig, outbound: FakeHttp, secrets: MemorySecretStore) -> Iterator[Any]:
    application = create_app(config, secret_store=secrets, http_client=outbound.client())
    yield application
    application.state.runtime.close()


@pytest.fixture
async def client(app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as http_client:
        yield http_client
