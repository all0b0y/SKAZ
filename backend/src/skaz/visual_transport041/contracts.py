"""Domain contracts for V4 visual transport, capability decisions, and fallback seams.

Provisional V3 shapes (``VisualSourceLocator``, ``PreparedVisual``, ``VisualFallbackSeam``)
are mirrored here without modifying any pre-existing host or predecessor files.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from ..knowledge.agents.engine import EngineId

VisualSourceKind = Literal["image", "pdf", "video_link", "local_video"]
VisualCapabilityState = Literal["supported", "unsupported", "unverified"]
UnsupportedVisualReason = Literal[
    "source_not_permitted",
    "source_mismatch",
    "local_video_no_frames",
    "adapter_no_image_transport",
    "model_no_image_input",
    "model_capability_unverified",
    "model_not_selected",
    "payload_too_large",
    "invalid_media_type",
    "empty_payload",
    "missing_payload",
]

TEXT_ONLY_DISCLOSURE = "Text only · Image not analysed"
UNSUPPORTED_CARD_TITLE = "This model can’t read images"


@dataclass(frozen=True)
class VisualSourceLocator:
    """Identifies a source material and specific visual location (page, frame timestamp, or image)."""

    material_id: str
    source_kind: VisualSourceKind
    page: int | None = None
    timestamp_ms: int | None = None
    label: str = ""
    source_sha256: str | None = None


@dataclass(frozen=True)
class PreparedVisual:
    """Locally prepared visual bytes and permission metadata before transport authorization."""

    visual_id: str
    locator: VisualSourceLocator
    media_type: str
    data: bytes = field(repr=False)
    byte_size: int
    width: int | None = None
    height: int | None = None
    source_text_available: bool = False
    source_text_excerpt: str | None = None
    permitted: bool = False
    permission_reason: str | None = None

    def __post_init__(self) -> None:
        if self.byte_size != len(self.data):
            raise ValueError(
                f"PreparedVisual byte_size ({self.byte_size}) does not match data length ({len(self.data)})."
            )

    def __repr__(self) -> str:
        return (
            f"PreparedVisual(visual_id={self.visual_id!r}, locator={self.locator!r}, "
            f"media_type={self.media_type!r}, byte_size={self.byte_size}, "
            f"permitted={self.permitted!r}, source_text_available={self.source_text_available!r})"
        )


@dataclass(frozen=True)
class CompatibleModelHint:
    """A candidate adapter/model known to accept images (never selected or sent automatically)."""

    engine: EngineId
    model_id: str
    label: str
    provider: str = ""


@dataclass(frozen=True)
class VisualCapabilityDecision:
    """Per-adapter and per-model image capability verdict."""

    engine: EngineId
    model_id: str | None
    state: VisualCapabilityState
    supported: bool
    transport_supports_image: bool
    model_supports_image: bool | None
    reason_code: UnsupportedVisualReason | None = None
    reason: str | None = None
    verified_by: str = "declared"

    def __post_init__(self) -> None:
        if self.supported:
            if self.state != "supported":
                raise ValueError("supported=True requires state=='supported'.")
            if not self.transport_supports_image or self.model_supports_image is not True:
                raise ValueError(
                    "supported=True requires verified transport_supports_image and model_supports_image."
                )
            if not isinstance(self.model_id, str) or not self.model_id.strip():
                raise ValueError("supported=True requires an explicitly selected model_id.")
        if not self.supported and self.state == "supported":
            raise ValueError("state=='supported' requires supported=True.")


@dataclass(frozen=True)
class UnsupportedVisualResult:
    """Typed non-sending refusal when an image cannot be delivered for a draft."""

    reason_code: UnsupportedVisualReason
    title: str
    detail: str
    engine: EngineId
    model_id: str | None
    source_kind: VisualSourceKind
    source_label: str
    text_only_available: bool
    compatible_models: tuple[CompatibleModelHint, ...] = ()
    draft_preserved: bool = True
    ok: Literal[False] = False


@dataclass(frozen=True)
class VisualFallbackSeam:
    """Provisional V3-compatible fallback seam connecting capability/refusal to composer UI-B."""

    decision: VisualCapabilityDecision
    unsupported: UnsupportedVisualResult | None = None
    text_only_available: bool = False
    text_only_chosen: bool = False
    draft_preserved: bool = True
    answer_disclosure: str | None = None

    def __post_init__(self) -> None:
        if self.text_only_chosen and not self.text_only_available:
            raise ValueError("Text-only continuation requires available source text.")
        if self.text_only_chosen and self.answer_disclosure != TEXT_ONLY_DISCLOSURE:
            object.__setattr__(self, "answer_disclosure", TEXT_ONLY_DISCLOSURE)
        if not self.text_only_chosen and self.answer_disclosure is not None:
            raise ValueError("answer_disclosure may only be set when text_only_chosen is True.")
