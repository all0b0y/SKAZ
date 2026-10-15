"""A transcription-only model cannot be saved for a text task (the model list route is gone)."""

import httpx
import pytest


@pytest.mark.parametrize("task", ["agent", "notes"])
async def test_known_openai_transcription_model_cannot_be_saved_for_text(
    client: httpx.AsyncClient, task: str
) -> None:
    response = await client.put(
        "/settings", json={task: {"provider": "openai", "model": "whisper-1"}}
    )
    assert response.status_code == 400
    assert "transcription" in response.json()["detail"]
    assert (await client.get("/settings")).json()[task]["model"] == ""
