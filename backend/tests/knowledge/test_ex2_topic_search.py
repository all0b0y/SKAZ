"""EX2 X2: the hidden OpenAlex topic lookup uses the existing consent and egress door."""

from __future__ import annotations

import pytest

from skaz.knowledge.science.client import ScienceGateway
from skaz.knowledge.science.protocols import ScienceConsentRequired, ScienceDailyLimit, ScienceUnavailable
from tests.knowledge.test_b1_science import (
    Bases,
    enable,
    ok_json,
    status,
)
from tests.knowledge.test_b1_science import (
    bases as bases,
)
from tests.knowledge.test_b1_science import (
    gateway as gateway,
)
from tests.knowledge.test_b1_science import (
    secrets as secrets,
)
from tests.knowledge.test_b1_science import (
    sleeps as sleeps,
)


async def test_topic_search_is_bounded_free_and_journalled(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on(
        "api.openalex.org",
        "/topics",
        ok_json(
            {
                "results": [
                    {"id": "https://openalex.org/T1", "display_name": "Agent memory"},
                    {"id": "https://openalex.org/T2", "display_name": "Tool use"},
                    {"id": "bad", "display_name": "Ignore me"},
                ]
            }
        ),
    )
    found = await gateway.search_topics(["AI agents", "Memory"], run_id=None)
    assert [(n.taxonomy_id, n.name) for n in found] == [("T1", "Agent memory"), ("T2", "Tool use")]
    # EX3 S4: OpenAlex ANDs the words of a search, so each term is its own search (never joined).
    assert [r.url.path for r in bases.requests] == ["/topics", "/topics"]
    assert [r.url.params["search"] for r in bases.requests] == ["AI agents", "Memory"]
    assert all(int(r.url.params["per-page"]) <= 30 for r in bases.requests)
    entries = (await gateway.journal()).records
    assert sorted(tuple(e.payload.topics) for e in entries) == [("AI agents",), ("Memory",)]
    assert {(e.operation, e.outcome) for e in entries} == {("taxonomy", "succeeded")}
    assert gateway.kb.settings.get("science.openalex.ledger")["usd"] == 0


async def test_topic_search_no_match_empty_terms_and_consent(gateway: ScienceGateway, bases: Bases) -> None:
    assert await gateway.search_topics([]) == []
    with pytest.raises(ScienceConsentRequired):
        await gateway.search_topics(["Business communication"])
    assert bases.requests == []
    await enable(gateway)
    bases.on("api.openalex.org", "/topics", ok_json({"results": []}))
    assert await gateway.search_topics(["Business communication"]) == []


@pytest.mark.parametrize("code,error", [(429, ScienceDailyLimit), (503, ScienceUnavailable)])
async def test_topic_search_never_switches_provider_on_failure(
    gateway: ScienceGateway,
    bases: Bases,
    code: int,
    error: type[Exception],
) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/topics", status(code, **{"retry-after": "3600"}))
    with pytest.raises(error):
        await gateway.search_topics(["AI agents"])
    assert bases.hosts() == ["api.openalex.org"]
