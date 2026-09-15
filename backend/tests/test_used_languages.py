"""Used languages through settings and the native provider boundary."""
from __future__ import annotations

import httpx
import pytest


async def test_used_languages_require_explicit_selection_and_preserve_partial_updates(
    client: httpx.AsyncClient,
) -> None:
    before = (await client.get("/settings")).json()
    assert before["used_languages"] is None
    supported = before["supported_languages"]
    assert "ru" in supported and "en" in supported and "cy" in supported
    assert len(supported) == len(set(supported))
    response = await client.put("/settings", json={"used_languages": ["ru", "en"]})
    assert response.status_code == 200
    assert response.json()["used_languages"] == ["ru", "en"]
    for patch in ({"used_languages": None}, {"output_language": "de"}):
        response = await client.put("/settings", json=patch)
        assert response.status_code == 200
        assert response.json()["used_languages"] == ["ru", "en"]
    assert response.json()["cloud_consent"] is False
    assert response.json()["asr"] == before["asr"]
    for languages in (["en"], supported):
        response = await client.put("/settings", json={"used_languages": languages})
        assert response.status_code == 200
        assert (await client.get("/settings")).json()["used_languages"] == languages


@pytest.mark.parametrize("languages", [[], ["xx"], ["ru", "ru"], ["EN"], ["en "],
                                       ["auto"], [True], "en", ["pt-BR"]])
async def test_invalid_languages_do_not_partially_apply(
    client: httpx.AsyncClient, languages: object,
) -> None:
    before = (await client.get("/settings")).json()
    response = await client.put("/settings", json={
        "used_languages": languages, "output_language": "fr",
    })
    assert response.status_code == 422
    assert (await client.get("/settings")).json() == before
