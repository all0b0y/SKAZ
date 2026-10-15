"""Deleting a session never removes files it does not own.

The root, layout, group-move and preservation routes of the old interface are
gone; deletion is what the speech area still calls.
"""
from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

from skaz.config import AppConfig
from tests.sessions_support import adelete, create_session


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return AppConfig(token="test-token", data_dir=tmp_path / "data")


async def test_legacy_delete_refuses_unknown_audio_before_markdown_cleanup(
    client: httpx.AsyncClient,
    config: AppConfig,
) -> None:
    sid = create_session(client, "Legacy")
    unknown = config.audio_dir / sid / "personal.txt"
    unknown.parent.mkdir(parents=True)
    unknown.write_text("Never remove")
    with pytest.raises(HTTPException) as refused:
        await adelete(client, sid)
    assert refused.value.status_code == 409
    assert unknown.read_text() == "Never remove"
    unknown.unlink()
    await adelete(client, sid)
    assert not unknown.parent.exists()
