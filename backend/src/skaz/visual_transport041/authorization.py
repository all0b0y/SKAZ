"""Authorized byte payload gating, typed unsupported results, and explicit text-only seams."""
from __future__ import annotations

import base64
import hashlib
import inspect
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from ..knowledge.agents.engine import EngineId
from .contracts import (
    TEXT_ONLY_DISCLOSURE,
    UNSUPPORTED_CARD_TITLE,
    CompatibleModelHint,
    PreparedVisual,
    UnsupportedVisualReason,
    UnsupportedVisualResult,
    VisualCapabilityDecision,
    VisualFallbackSeam,
    VisualSourceLocator,
)

if TYPE_CHECKING:
    from ..knowledge.sources.visual import PreparedVisual as SourceVisual

ALLOWED_IMAGE_MEDIA_TYPES: frozenset[str] = frozenset(
    {"image/png", "image/jpeg", "image/webp", "image/gif"}
)
DEFAULT_MAX_VISUAL_BYTES = 2 * 1024 * 1024

VisualByteProvider = Callable[
    [VisualSourceLocator],
    PreparedVisual | Awaitable[PreparedVisual | None] | None,
]


class _UnsetType:
    """Sentinel type distinguishing an omitted optional target argument from None."""


_UNSET = _UnsetType()


def _is_nonempty_str(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _locators_match(expected: VisualSourceLocator, actual: VisualSourceLocator) -> bool:
    """Verify canonical source identity and visual location (material, kind, page, timestamp)."""
    return (
        _is_nonempty_str(expected.material_id)
        and expected.material_id == actual.material_id
        and expected.source_kind == actual.source_kind
        and expected.page == actual.page
        and expected.timestamp_ms == actual.timestamp_ms
        and expected.source_sha256 == actual.source_sha256
        and expected.source_url == actual.source_url
    )


@dataclass(frozen=True)
class AuthorizedVisualPayload:
    """Approved visual bytes bound to one explicitly authorized (engine, model_id) target."""

    visual_id: str
    locator: VisualSourceLocator
    media_type: str
    approved_bytes: bytes = field(repr=False)
    byte_size: int
    sha256: str
    engine: EngineId
    model_id: str
    linked_frame: SourceVisual | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if not _is_nonempty_str(self.visual_id):
            raise ValueError("AuthorizedVisualPayload requires a non-empty visual_id.")
        if not _is_nonempty_str(self.locator.material_id):
            raise ValueError("AuthorizedVisualPayload requires a valid source locator.")
        if self.locator.source_kind == "local_video":
            raise ValueError("AuthorizedVisualPayload cannot be created for local_video.")
        if not _is_nonempty_str(self.model_id):
            raise ValueError("AuthorizedVisualPayload requires a non-empty model_id.")
        if self.media_type not in ALLOWED_IMAGE_MEDIA_TYPES:
            raise ValueError(f"Unsupported image media type: {self.media_type}")
        if not self.approved_bytes:
            raise ValueError("AuthorizedVisualPayload cannot be empty.")
        if self.byte_size != len(self.approved_bytes):
            raise ValueError("byte_size must match len(approved_bytes).")
        expected_sha = hashlib.sha256(self.approved_bytes).hexdigest()
        if self.sha256 != expected_sha:
            raise ValueError("sha256 must match approved_bytes.")
        frame = self.linked_frame
        if frame is not None and (
            self.locator.source_kind != "video_link"
            or frame.locator.kind != "video_frame"
            or frame.locator.material_id != self.locator.material_id
            or frame.locator.source_url != self.locator.source_url
            or frame.timestamp_ms != self.locator.timestamp_ms
            or frame.sha256 != self.sha256
            or frame.data != self.approved_bytes
        ):
            raise ValueError("The retained frame must match the authorized visual.")

    def __repr__(self) -> str:
        return (
            f"AuthorizedVisualPayload(visual_id={self.visual_id!r}, engine={self.engine!r}, "
            f"model_id={self.model_id!r}, media_type={self.media_type!r}, "
            f"byte_size={self.byte_size}, sha256={self.sha256[:12]!r})"
        )

    def base64_data(self) -> str:
        """Encode approved bytes as ASCII base64 for transport adapters."""
        return base64.b64encode(self.approved_bytes).decode("ascii")


def _default_detail_for(
    reason_code: UnsupportedVisualReason,
    locator: VisualSourceLocator,
    text_only_available: bool,
    custom_reason: str | None = None,
) -> str:
    if custom_reason:
        return custom_reason
    if reason_code == "local_video_no_frames":
        return "SKAZ transcribes the audio only. It doesn’t save the video or its frames."
    if locator.source_kind == "pdf":
        if locator.page is not None and not text_only_available:
            return "Text-only continuation requires readable text for the selected pages and sources."
        return (
            "The PDF text is still available."
            if text_only_available
            else "This PDF has no readable text layer to use instead."
        )
    if locator.source_kind == "video_link":
        return (
            "The video transcript is still available."
            if text_only_available
            else "No video transcript is available to use instead."
        )
    return (
        "Accompanying text is still available."
        if text_only_available
        else "This attachment has no text to use instead."
    )


def _title_for(reason_code: UnsupportedVisualReason) -> str:
    if reason_code == "source_not_permitted":
        return "Image access is not permitted"
    if reason_code == "local_video_no_frames":
        return "Video frames are unavailable"
    if reason_code in (
        "source_mismatch",
        "payload_too_large",
        "invalid_media_type",
        "empty_payload",
        "missing_payload",
    ):
        return "Image couldn’t be sent"
    return UNSUPPORTED_CARD_TITLE


def build_unsupported_result(
    *,
    reason_code: UnsupportedVisualReason,
    engine: EngineId,
    model_id: str | None,
    locator: VisualSourceLocator,
    text_only_available: bool,
    compatible_models: Sequence[CompatibleModelHint] = (),
    custom_title: str | None = None,
    custom_detail: str | None = None,
) -> UnsupportedVisualResult:
    """Create a typed non-sending refusal preserving the user's draft."""
    return UnsupportedVisualResult(
        reason_code=reason_code,
        title=custom_title or _title_for(reason_code),
        detail=_default_detail_for(
            reason_code,
            locator,
            text_only_available,
            custom_reason=custom_detail,
        ),
        engine=engine,
        model_id=model_id,
        source_kind=locator.source_kind,
        source_label=locator.label or locator.material_id,
        text_only_available=text_only_available,
        compatible_models=tuple(compatible_models),
        draft_preserved=True,
    )


def build_fallback_seam(
    *,
    decision: VisualCapabilityDecision,
    locator: VisualSourceLocator,
    source_text_available: bool,
    compatible_models: Sequence[CompatibleModelHint] = (),
    reason_override: UnsupportedVisualReason | None = None,
    custom_detail: str | None = None,
) -> VisualFallbackSeam:
    """Construct the pre-send fallback seam for an unsupported or unverified visual request."""
    reason_code = reason_override or decision.reason_code or "model_capability_unverified"
    unsupported = build_unsupported_result(
        reason_code=reason_code,
        engine=decision.engine,
        model_id=decision.model_id,
        locator=locator,
        text_only_available=source_text_available,
        compatible_models=compatible_models,
        custom_detail=custom_detail,
    )
    return VisualFallbackSeam(
        decision=decision,
        unsupported=unsupported,
        text_only_available=source_text_available,
        text_only_chosen=False,
        draft_preserved=True,
        answer_disclosure=None,
    )


def request_text_only_continuation(
    seam: VisualFallbackSeam,
    *,
    explicit_user_choice: bool,
) -> VisualFallbackSeam:
    """Transition a fallback seam to text-only mode ONLY with source text and explicit choice."""
    if not explicit_user_choice:
        raise ValueError("Text-only continuation requires an explicit user choice.")
    if not seam.text_only_available:
        raise ValueError("Text-only continuation is unavailable because no source text exists.")
    return VisualFallbackSeam(
        decision=seam.decision,
        unsupported=seam.unsupported,
        text_only_available=True,
        text_only_chosen=True,
        draft_preserved=seam.draft_preserved,
        answer_disclosure=TEXT_ONLY_DISCLOSURE,
    )


def _decision_is_verified(decision: VisualCapabilityDecision) -> bool:
    return (
        decision.supported
        and decision.state == "supported"
        and decision.transport_supports_image
        and decision.model_supports_image is True
        and _is_nonempty_str(decision.model_id)
    )


def authorize_prepared_visual(
    prepared: PreparedVisual | None,
    decision: VisualCapabilityDecision | None,
    *,
    expected_locator: VisualSourceLocator | None = None,
    expected_engine: EngineId | None = None,
    expected_model_id: str | _UnsetType | None = _UNSET,
    source_text_available: bool | None = None,
    compatible_models: Sequence[CompatibleModelHint] = (),
    max_bytes: int = DEFAULT_MAX_VISUAL_BYTES,
) -> AuthorizedVisualPayload | UnsupportedVisualResult:
    """Authorize prepared visual bytes only for matching source/target and permitted verified state."""
    if prepared is not None and not isinstance(prepared, PreparedVisual):
        raise TypeError("prepared must be a PreparedVisual or None.")

    if expected_locator is not None:
        ref_locator = expected_locator
        locator_matches = prepared is not None and _locators_match(expected_locator, prepared.locator)
    elif prepared is not None:
        ref_locator = prepared.locator
        locator_matches = _is_nonempty_str(prepared.locator.material_id)
    else:
        raise ValueError("Cannot authorize or report refusal without prepared visual or expected_locator.")

    if prepared is not None and locator_matches:
        safe_text_available = (
            prepared.source_text_available
            if source_text_available is None
            else (prepared.source_text_available or source_text_available)
        )
    else:
        safe_text_available = bool(source_text_available)

    if decision is None:
        if expected_engine is None:
            raise ValueError("VisualCapabilityDecision is required.")
        report_model = None if isinstance(expected_model_id, _UnsetType) else expected_model_id
        return build_unsupported_result(
            reason_code="model_capability_unverified",
            engine=expected_engine,
            model_id=report_model,
            locator=ref_locator,
            text_only_available=safe_text_available,
            compatible_models=compatible_models,
            custom_detail="Missing visual capability decision.",
        )

    report_engine = expected_engine if expected_engine is not None else decision.engine
    report_model_id = decision.model_id if isinstance(expected_model_id, _UnsetType) else expected_model_id

    if expected_engine is not None and decision.engine != expected_engine:
        return build_unsupported_result(
            reason_code="model_capability_unverified",
            engine=report_engine,
            model_id=report_model_id,
            locator=ref_locator,
            text_only_available=safe_text_available,
            compatible_models=compatible_models,
            custom_detail="Capability decision does not match the selected adapter.",
        )

    if not isinstance(expected_model_id, _UnsetType):
        if not _is_nonempty_str(expected_model_id):
            return build_unsupported_result(
                reason_code="model_not_selected",
                engine=report_engine,
                model_id=expected_model_id,
                locator=ref_locator,
                text_only_available=safe_text_available,
                compatible_models=compatible_models,
                custom_detail="Select an image-capable model explicitly before sending images.",
            )
        if decision.model_id != expected_model_id:
            return build_unsupported_result(
                reason_code="model_capability_unverified",
                engine=report_engine,
                model_id=expected_model_id,
                locator=ref_locator,
                text_only_available=safe_text_available,
                compatible_models=compatible_models,
                custom_detail="Capability decision does not match the explicitly selected model.",
            )

    if not _decision_is_verified(decision):
        fallback_reason: UnsupportedVisualReason = (
            "model_not_selected" if not _is_nonempty_str(decision.model_id) else "model_capability_unverified"
        )
        reason_code: UnsupportedVisualReason = decision.reason_code or fallback_reason
        return build_unsupported_result(
            reason_code=reason_code,
            engine=report_engine,
            model_id=report_model_id,
            locator=ref_locator,
            text_only_available=safe_text_available,
            compatible_models=compatible_models,
        )

    assert decision.model_id is not None

    if not _is_nonempty_str(ref_locator.material_id):
        return build_unsupported_result(
            reason_code="source_mismatch",
            engine=report_engine,
            model_id=decision.model_id,
            locator=ref_locator,
            text_only_available=safe_text_available,
            compatible_models=compatible_models,
            custom_detail="Source locator is missing a material identifier.",
        )
    if ref_locator.source_kind == "local_video":
        return build_unsupported_result(
            reason_code="local_video_no_frames",
            engine=report_engine,
            model_id=decision.model_id,
            locator=ref_locator,
            text_only_available=safe_text_available,
            compatible_models=compatible_models,
        )
    if prepared is None:
        return build_unsupported_result(
            reason_code="missing_payload",
            engine=report_engine,
            model_id=decision.model_id,
            locator=ref_locator,
            text_only_available=safe_text_available,
            compatible_models=compatible_models,
            custom_detail="No prepared image is available for this source.",
        )
    if expected_locator is not None and not locator_matches:
        return build_unsupported_result(
            reason_code="source_mismatch",
            engine=report_engine,
            model_id=decision.model_id,
            locator=ref_locator,
            text_only_available=bool(source_text_available),
            compatible_models=compatible_models,
            custom_detail="Prepared visual does not match the requested source or location.",
        )
    if prepared.permitted is not True:
        return build_unsupported_result(
            reason_code="source_not_permitted",
            engine=report_engine,
            model_id=decision.model_id,
            locator=ref_locator,
            text_only_available=safe_text_available,
            compatible_models=compatible_models,
            custom_detail=prepared.permission_reason or "This source is not permitted for transfer.",
        )
    if prepared.media_type not in ALLOWED_IMAGE_MEDIA_TYPES:
        return build_unsupported_result(
            reason_code="invalid_media_type",
            engine=report_engine,
            model_id=decision.model_id,
            locator=ref_locator,
            text_only_available=safe_text_available,
            compatible_models=compatible_models,
            custom_detail=f"Unsupported image format: {prepared.media_type}.",
        )
    if not prepared.data:
        return build_unsupported_result(
            reason_code="empty_payload",
            engine=report_engine,
            model_id=decision.model_id,
            locator=ref_locator,
            text_only_available=safe_text_available,
            compatible_models=compatible_models,
            custom_detail="Prepared image payload is empty.",
        )
    if len(prepared.data) > max_bytes:
        return build_unsupported_result(
            reason_code="payload_too_large",
            engine=report_engine,
            model_id=decision.model_id,
            locator=ref_locator,
            text_only_available=safe_text_available,
            compatible_models=compatible_models,
            custom_detail=f"Image exceeds the {max_bytes}-byte transport limit.",
        )

    digest = hashlib.sha256(prepared.data).hexdigest()
    return AuthorizedVisualPayload(
        visual_id=prepared.visual_id,
        locator=ref_locator,
        media_type=prepared.media_type,
        approved_bytes=prepared.data,
        byte_size=len(prepared.data),
        sha256=digest,
        engine=decision.engine,
        model_id=decision.model_id,
        linked_frame=prepared.linked_frame,
    )


class AuthorizedByteCallback:
    """Lazy byte-authorization gate: invokes ``provider`` only after capability & source checks."""

    def __init__(
        self,
        *,
        engine: EngineId,
        model_id: str | None,
        decision: VisualCapabilityDecision,
        provider: VisualByteProvider,
        compatible_models: Sequence[CompatibleModelHint] = (),
        max_bytes: int = DEFAULT_MAX_VISUAL_BYTES,
    ) -> None:
        self.engine = engine
        self.model_id = model_id
        self.decision = decision
        self._provider = provider
        self.compatible_models = tuple(compatible_models)
        self.max_bytes = max_bytes

    def _precheck(
        self,
        locator: VisualSourceLocator,
        *,
        source_text_available: bool,
        engine: EngineId | None = None,
        model_id: str | _UnsetType | None = _UNSET,
    ) -> UnsupportedVisualResult | None:
        effective_engine = self.engine if engine is None else engine
        effective_model_id = self.model_id if isinstance(model_id, _UnsetType) else model_id

        if effective_engine != self.engine or effective_model_id != self.model_id:
            return build_unsupported_result(
                reason_code="model_capability_unverified",
                engine=effective_engine,
                model_id=effective_model_id,
                locator=locator,
                text_only_available=source_text_available,
                compatible_models=self.compatible_models,
                custom_detail="Authorization gate target no longer matches the selected model.",
            )
        if self.decision is None or self.decision.engine != effective_engine:
            return build_unsupported_result(
                reason_code="model_capability_unverified",
                engine=effective_engine,
                model_id=effective_model_id,
                locator=locator,
                text_only_available=source_text_available,
                compatible_models=self.compatible_models,
                custom_detail="Capability decision does not match the selected adapter.",
            )
        if not _is_nonempty_str(effective_model_id):
            reason: UnsupportedVisualReason = (
                self.decision.reason_code
                if (not self.decision.supported and self.decision.reason_code is not None)
                else "model_not_selected"
            )
            return build_unsupported_result(
                reason_code=reason,
                engine=effective_engine,
                model_id=effective_model_id,
                locator=locator,
                text_only_available=source_text_available,
                compatible_models=self.compatible_models,
            )
        if self.decision.model_id != effective_model_id:
            return build_unsupported_result(
                reason_code="model_capability_unverified",
                engine=effective_engine,
                model_id=effective_model_id,
                locator=locator,
                text_only_available=source_text_available,
                compatible_models=self.compatible_models,
                custom_detail="Capability decision does not match the explicitly selected model.",
            )
        if not _decision_is_verified(self.decision):
            reason_code: UnsupportedVisualReason = (
                self.decision.reason_code or "model_capability_unverified"
            )
            return build_unsupported_result(
                reason_code=reason_code,
                engine=effective_engine,
                model_id=effective_model_id,
                locator=locator,
                text_only_available=source_text_available,
                compatible_models=self.compatible_models,
            )
        if not _is_nonempty_str(locator.material_id):
            return build_unsupported_result(
                reason_code="source_mismatch",
                engine=effective_engine,
                model_id=effective_model_id,
                locator=locator,
                text_only_available=source_text_available,
                compatible_models=self.compatible_models,
                custom_detail="Source locator is missing a material identifier.",
            )
        if locator.source_kind == "local_video":
            return build_unsupported_result(
                reason_code="local_video_no_frames",
                engine=effective_engine,
                model_id=effective_model_id,
                locator=locator,
                text_only_available=source_text_available,
                compatible_models=self.compatible_models,
            )
        return None

    def _finalize(
        self,
        prepared: PreparedVisual | None,
        locator: VisualSourceLocator,
        *,
        source_text_available: bool,
        engine: EngineId | None,
        model_id: str | _UnsetType | None,
    ) -> AuthorizedVisualPayload | UnsupportedVisualResult:
        effective_engine = self.engine if engine is None else engine
        effective_model_id = self.model_id if isinstance(model_id, _UnsetType) else model_id
        return authorize_prepared_visual(
            prepared,
            self.decision,
            expected_locator=locator,
            expected_engine=effective_engine,
            expected_model_id=effective_model_id,
            source_text_available=source_text_available,
            compatible_models=self.compatible_models,
            max_bytes=self.max_bytes,
        )

    def authorize(
        self,
        locator: VisualSourceLocator,
        *,
        source_text_available: bool = False,
        engine: EngineId | None = None,
        model_id: str | _UnsetType | None = _UNSET,
    ) -> AuthorizedVisualPayload | UnsupportedVisualResult:
        """Synchronously authorize and load bytes if and only if prechecks pass."""
        blocked = self._precheck(
            locator,
            source_text_available=source_text_available,
            engine=engine,
            model_id=model_id,
        )
        if blocked is not None:
            return blocked
        prepared = self._provider(locator)
        if inspect.isawaitable(prepared):
            raise TypeError("Use authorize_async() with an async byte provider.")
        return self._finalize(
            prepared,
            locator,
            source_text_available=source_text_available,
            engine=engine,
            model_id=model_id,
        )

    async def authorize_async(
        self,
        locator: VisualSourceLocator,
        *,
        source_text_available: bool = False,
        engine: EngineId | None = None,
        model_id: str | _UnsetType | None = _UNSET,
    ) -> AuthorizedVisualPayload | UnsupportedVisualResult:
        """Asynchronously authorize and load bytes if and only if prechecks pass."""
        blocked = self._precheck(
            locator,
            source_text_available=source_text_available,
            engine=engine,
            model_id=model_id,
        )
        if blocked is not None:
            return blocked
        raw = self._provider(locator)
        prepared = await raw if inspect.isawaitable(raw) else raw
        return self._finalize(
            prepared,
            locator,
            source_text_available=source_text_available,
            engine=engine,
            model_id=model_id,
        )
