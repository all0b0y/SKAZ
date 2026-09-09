"""The public gateway enforces a wall-clock budget, not only httpx phase limits."""

import asyncio

import httpx
import pytest

from audiohelper.gateways.chat import ChatMessage, ProviderTimeout, build_chat


@pytest.mark.parametrize("provider", ["openrouter", "anthropic"])
async def test_slow_response_cannot_outlive_whole_operation_budget(provider: str) -> None:
    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.08)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "late"}}],
            "content": [{"type": "text", "text": "late"}],
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(slow)) as http:
        gateway = build_chat(
            http=http, provider=provider, model="test", api_key="test", base_url=None, timeout=0.01
        )
        with pytest.raises(ProviderTimeout):
            await gateway.complete([ChatMessage("user", "question")], max_tokens=10)
