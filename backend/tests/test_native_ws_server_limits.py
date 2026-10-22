"""The production server must bound WS frames before the route receives them."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from skaz import __main__ as entry
from skaz import parent_watchdog


def test_server_bounds_websocket_buffers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    configs: list[Any] = []
    monkeypatch.setenv("SKAZ_TOKEN", "isolated-test-token")
    monkeypatch.setenv("SKAZ_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(entry, "create_app", lambda config: object())
    monkeypatch.setattr(parent_watchdog, "start", lambda: None)

    # main() runs its own uvicorn.Server subclass (decision 11); record its config instead of serving.
    def run(self: Any, sockets: Any = None) -> None:
        configs.append(self.config)
        self.started = True

    monkeypatch.setattr(entry._Server, "run", run)
    assert entry.main(["--port", "18765"]) == 0
    config = configs[0]
    assert config.ws_max_size == 48020
    assert config.ws_max_queue == 8
    assert config.ws_per_message_deflate is False
    assert config.timeout_graceful_shutdown == entry.REQUESTS_GRACE_S
