"""Area S2: speech (live recordings, imported audio/video) as library materials."""
from __future__ import annotations

from typing import TYPE_CHECKING

from .legacy import LegacySpeech
from .service import SpeechService

if TYPE_CHECKING:  # pragma: no cover
    from ...runtime import Runtime


def create_speech_service(runtime: Runtime) -> SpeechService:
    """Wire the speech service to the runtime's legacy recorder/importer and ``runtime.kb``."""
    return SpeechService(runtime.kb, LegacySpeech(runtime), guard=runtime.kb_sources)


__all__ = ["SpeechService", "create_speech_service"]
