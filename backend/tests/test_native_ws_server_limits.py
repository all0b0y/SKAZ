"""The production server must bound WS frames before the route receives them."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import uvicorn

from audiohelper import __main__ as entry


def test_server_bounds_websocket_buffers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setenv("AUDIOHELPER_TOKEN", "isolated-test-token")
    monkeypatch.setenv("AUDIOHELPER_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(entry, "create_app", lambda config: object())
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: calls.append(kwargs))
    assert entry.main(["--port", "18765"]) == 0
    assert calls[0]["ws_max_size"] == 48020
    assert calls[0]["ws_max_queue"] == 8
    assert calls[0]["ws_per_message_deflate"] is False
