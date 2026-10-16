"""Review Low: an unknown ``local_whisper_model`` is a plain 4xx with a code, never a traceback/500."""

from __future__ import annotations

from typing import Any

import httpx

from skaz.local_models import LOCAL_WHISPER_REPOSITORIES


async def test_an_unknown_whisper_model_is_refused_in_plain_words(
        kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    # The legacy settings update already refuses it in plain words (kept as it is).
    refused = await kb_client.put("/settings", json={"local_whisper_model": "giant"})
    assert refused.status_code == 400, refused.text
    assert "giant" not in LOCAL_WHISPER_REPOSITORIES
    assert "Unknown Local Whisper model" in refused.text

    known = next(iter(LOCAL_WHISPER_REPOSITORIES))
    assert (await kb_client.put("/settings", json={"local_whisper_model": known})).status_code == 200


async def test_a_stored_unknown_model_does_not_break_the_speech_settings(
        kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    runtime = kb_app.state.runtime
    stored = runtime.settings_store.load().model_copy(update={"local_whisper_model": "giant"})
    runtime.settings_store.save(stored)
    view = await kb_client.get("/kb/settings/speech")
    assert view.status_code == 200, view.text
    assert view.json()["local_model"]["state"] != "ready"
    deleted = await kb_client.delete("/kb/settings/speech/local-model")
    assert deleted.status_code == 422, deleted.text
    assert deleted.json()["detail"] == "SKAZ doesn't know the speech model “giant”. Choose another one."
