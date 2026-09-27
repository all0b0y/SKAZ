"""Read-only public description of the experimental contextual ASR seam."""

from fastapi import APIRouter

from ..schemas import LiveAsrCapabilities, LiveAsrCapabilityRequirements
from .deps import RuntimeDep

router = APIRouter(prefix="/asr")


@router.get("/live/capabilities")
async def live_capabilities(runtime: RuntimeDep) -> LiveAsrCapabilities:
    settings = runtime.settings_store.load()
    profile = settings.profile("asr")
    requirements = LiveAsrCapabilityRequirements(
        local_profile_selected=profile.provider == "local-whisper",
        contextual_local_enabled=settings.contextual_local_enabled,
        # Effective values: this read reports them, it never turns them on.
        live_finality_enabled=runtime.live_finality_enabled,
        local_speech_gate_enabled=runtime.local_speech_gate,
    )
    capable = all(
        (
            requirements.local_profile_selected,
            requirements.live_finality_enabled,
            requirements.local_speech_gate_enabled,
        )
    )
    if capable:
        detail = "Contextual local recording is available for newly created sessions."
    elif not requirements.local_profile_selected:
        detail = "Select a local-whisper ASR profile before using contextual local recording."
    elif not requirements.contextual_local_enabled:
        detail = (
            "Turn on experimental contextual local mode in Settings; it enables local "
            "live finality and the local speech gate for new recordings."
        )
    else:
        detail = "Enable live finality and the local speech gate to use contextual local recording."
    return LiveAsrCapabilities(capable=capable, requirements=requirements, detail=detail)
