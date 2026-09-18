"""Gateway-boundary privacy regressions; mock transport, not real speech evaluation."""

import httpx
import pytest

from audiohelper.audio import WavAudio
from audiohelper.gateways import ProviderError
from audiohelper.gateways.asr import (
    OpenAITranscriber,
    OpenRouterLegacyAudioTranscriber,
    OpenRouterTranscriber,
    Transcriber,
)


@pytest.mark.parametrize("adapter", ["openai", "dedicated", "legacy"])
@pytest.mark.parametrize("failure", [httpx.ConnectError, httpx.ReadTimeout])
async def test_asr_transport_error_never_exposes_exception_text(
    adapter: str, failure: type[httpx.RequestError]
) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise failure("PRIVATE_TRANSCRIPT fake-credential-in-url", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as http:
        gateway: Transcriber
        if adapter == "openai":
            gateway = OpenAITranscriber(
                http, model="whisper-1", api_key="test", provider="openai", timeout=1
            )
        elif adapter == "dedicated":
            gateway = OpenRouterTranscriber(http, model="test", api_key="test", timeout=1)
        else:
            gateway = OpenRouterLegacyAudioTranscriber(http, model="test", api_key="test", timeout=1)
        with pytest.raises(ProviderError) as caught:
            await gateway.transcribe(WavAudio(16000, b"\x00\x00" * 160), language=None)
    message = str(caught.value)
    assert "PRIVATE_TRANSCRIPT" not in message
    assert "fake-credential" not in message
    assert "could not be reached" in message
