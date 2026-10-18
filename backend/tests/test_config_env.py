"""L3: the per-run token is read once and leaves the environment child processes inherit."""
from __future__ import annotations

import os

import pytest

from skaz.config import AppConfig


def test_the_token_is_removed_from_the_environment_after_reading(monkeypatch: pytest.MonkeyPatch,
                                                                  tmp_path: object) -> None:
    monkeypatch.setenv("SKAZ_TOKEN", "per-run-token")
    monkeypatch.setenv("SKAZ_DATA_DIR", str(tmp_path))
    config = AppConfig.from_env(port=8765)
    assert config.token == "per-run-token"
    assert "SKAZ_TOKEN" not in os.environ
