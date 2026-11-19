"""Focused tests for V4.I isolated visual transport & capability contracts."""
from __future__ import annotations

import base64
import hashlib

import pytest

from skaz.knowledge.agents.engine import ModelOption
from skaz.visual_transport041 import (
    TEXT_ONLY_DISCLOSURE,
    AdapterTransportProbe,
    AuthorizedByteCallback,
    AuthorizedVisualPayload,
    ModelVisualMetadata,
    PreparedVisual,
    UnsupportedVisualResult,
    VisualAuthorizationError,
    VisualCapabilityDecision,
    VisualFallbackSeam,
    VisualPayloadTooLargeError,
    VisualSourceLocator,
    authorize_prepared_visual,
    build_acp_prompt_blocks,
    build_claude_user_message,
    build_codex_turn_input,
    build_fallback_seam,
    evaluate_visual_capability,
    list_compatible_models,
    parse_acp_transport_probe,
    parse_claude_model_visual,
    parse_codex_model_visual,
    parse_hermes_model_visual,
    parse_opencode_model_visual,
    request_text_only_continuation,
)

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _pdf_locator(page: int = 8) -> VisualSourceLocator:
    return VisualSourceLocator(
        material_id="mat-pdf-1",
        source_kind="pdf",
        page=page,
        label=f"Inflation report.pdf · Page {page}",
    )


def _video_locator(ms: int = 760_000) -> VisualSourceLocator:
    return VisualSourceLocator(
        material_id="mat-vid-1",
        source_kind="video_link",
        timestamp_ms=ms,
        label="Inflation briefing · 12:40",
    )


def _photo_locator() -> VisualSourceLocator:
    return VisualSourceLocator(
        material_id="mat-img-1",
        source_kind="image",
        label="Chart photo.jpg",
    )


def _prepared(
    locator: VisualSourceLocator | None = None,
    *,
    data: bytes = PNG_1X1,
    media_type: str = "image/png",
    permitted: bool = True,
    permission_reason: str | None = None,
    source_text_available: bool = False,
    source_text_excerpt: str | None = None,
) -> PreparedVisual:
    loc = locator or _photo_locator()
    return PreparedVisual(
        visual_id="vis-1",
        locator=loc,
        media_type=media_type,
        data=data,
        byte_size=len(data),
        width=1,
        height=1,
        source_text_available=source_text_available,
        source_text_excerpt=source_text_excerpt,
        permitted=permitted,
        permission_reason=permission_reason,
    )


class TestCapabilityDetection:
    def test_codex_model_declared_supported_vs_text_only_vs_undeclared(self) -> None:
        transport = AdapterTransportProbe(engine="codex", transport_supports_image=True)
        vision_meta = parse_codex_model_visual(
            {
                "model": "gpt-vision",
                "displayName": "GPT Vision",
                "inputModalities": ["text", "image"],
            }
        )
        text_only_meta = parse_codex_model_visual(
            {
                "model": "gpt-text",
                "displayName": "GPT Text",
                "inputModalities": ["text"],
            }
        )
        undeclared_meta = parse_codex_model_visual(
            {
                "model": "gpt-fixture",
                "displayName": "GPT Fixture",
            }
        )

        ok = evaluate_visual_capability("codex", "gpt-vision", transport, vision_meta)
        assert ok.supported is True
        assert ok.state == "supported"
        assert ok.reason_code is None

        no_img = evaluate_visual_capability("codex", "gpt-text", transport, text_only_meta)
        assert no_img.supported is False
        assert no_img.state == "unsupported"
        assert no_img.reason_code == "model_no_image_input"

        unverified = evaluate_visual_capability("codex", "gpt-fixture", transport, undeclared_meta)
        assert unverified.supported is False
        assert unverified.state == "unverified"
        assert unverified.reason_code == "model_capability_unverified"

    def test_claude_code_contract_and_custom_model_guard(self) -> None:
        transport_ok = AdapterTransportProbe(engine="claude_code", transport_supports_image=True)
        transport_bad = AdapterTransportProbe(
            engine="claude_code", transport_supports_image=False, reason="Outdated CLI"
        )

        sonnet = parse_claude_model_visual(ModelOption("sonnet", "Sonnet (latest)"))
        custom = parse_claude_model_visual(ModelOption("custom-endpoint-model", "Custom"))

        d_sonnet = evaluate_visual_capability("claude_code", "sonnet", transport_ok, sonnet)
        assert d_sonnet.supported is True
        assert d_sonnet.state == "supported"

        d_custom = evaluate_visual_capability("claude_code", "custom-endpoint-model", transport_ok, custom)
        assert d_custom.supported is False
        assert d_custom.state == "unverified"
        assert d_custom.reason_code == "model_capability_unverified"

        d_bad_cli = evaluate_visual_capability("claude_code", "sonnet", transport_bad, sonnet)
        assert d_bad_cli.supported is False
        assert d_bad_cli.state == "unsupported"
        assert d_bad_cli.reason_code == "adapter_no_image_transport"

    def test_hermes_acp_transport_alone_does_not_verify_undeclared_model(self) -> None:
        probe_yes = parse_acp_transport_probe(
            "hermes",
            {"agentCapabilities": {"promptCapabilities": {"image": True}}},
        )
        probe_no = parse_acp_transport_probe(
            "hermes",
            {"agentCapabilities": {"promptCapabilities": {"image": False}}},
        )
        assert probe_yes.transport_supports_image is True
        assert probe_no.transport_supports_image is False

        undeclared = parse_hermes_model_visual(
            {"modelId": "custom:probe-model", "name": "Custom endpoint · probe-model"}
        )
        decision = evaluate_visual_capability("hermes", "custom:probe-model", probe_yes, undeclared)
        assert decision.supported is False
        assert decision.state == "unverified"
        assert decision.transport_supports_image is True
        assert decision.model_supports_image is None
        assert decision.reason_code == "model_capability_unverified"

        explicit = parse_hermes_model_visual(
            {
                "modelId": "openrouter:vision-1",
                "name": "Vision 1",
                "inputModalities": ["text", "image"],
            }
        )
        ok = evaluate_visual_capability("hermes", "openrouter:vision-1", probe_yes, explicit)
        assert ok.supported is True
        assert ok.state == "supported"

        blocked_by_acp = evaluate_visual_capability("hermes", "openrouter:vision-1", probe_no, explicit)
        assert blocked_by_acp.supported is False
        assert blocked_by_acp.reason_code == "adapter_no_image_transport"

    def test_opencode_capabilities_from_probe_shapes(self) -> None:
        probe = parse_acp_transport_probe(
            "opencode",
            {"agentCapabilities": {"promptCapabilities": {"embeddedContext": True, "image": True}}},
        )
        big_pickle = parse_opencode_model_visual(
            {
                "id": "big-pickle",
                "providerID": "opencode",
                "name": "Big Pickle",
                "capabilities": {"input": {"text": True, "image": False}},
            }
        )
        claude_sonnet = parse_opencode_model_visual(
            {
                "id": "claude-sonnet-4-5-20250929",
                "providerID": "anthropic",
                "name": "Claude Sonnet 4.5",
                "capabilities": {"input": {"text": True, "image": True}},
            }
        )

        d1 = evaluate_visual_capability("opencode", "opencode/big-pickle", probe, big_pickle)
        assert d1.supported is False
        assert d1.state == "unsupported"
        assert d1.reason_code == "model_no_image_input"

        d2 = evaluate_visual_capability(
            "opencode", "anthropic/claude-sonnet-4-5-20250929", probe, claude_sonnet
        )
        assert d2.supported is True
        assert d2.state == "supported"

        hints = list_compatible_models([big_pickle, claude_sonnet], {"opencode": probe})
        assert [(h.engine, h.model_id) for h in hints] == [
            ("opencode", "anthropic/claude-sonnet-4-5-20250929")
        ]

    def test_none_model_is_blocked_unless_explicitly_allowed(self) -> None:
        transport = AdapterTransportProbe(engine="codex", transport_supports_image=True)
        decision = evaluate_visual_capability("codex", None, transport, None)
        assert decision.supported is False
        assert decision.reason_code == "model_not_selected"

        claude_transport = AdapterTransportProbe(engine="claude_code", transport_supports_image=True)
        default = ModelOption("default", "Account default")
        default_meta = parse_claude_model_visual(default)
        unknown = evaluate_visual_capability("claude_code", "default", claude_transport, default_meta)
        assert not unknown.supported and unknown.reason_code == "model_capability_unverified"

        verified_default = parse_claude_model_visual(default, explicit_supports_image=True)
        allowed_default = evaluate_visual_capability(
            "claude_code",
            None,
            claude_transport,
            verified_default,
            allow_adapter_default_model=True,
        )
        assert allowed_default.supported is True

    def test_prepared_visual_validates_byte_size_and_defaults_unpermitted(self) -> None:
        default_prepared = PreparedVisual(
            visual_id="default-unpermitted",
            locator=_photo_locator(),
            media_type="image/png",
            data=PNG_1X1,
            byte_size=len(PNG_1X1),
        )
        assert default_prepared.permitted is False

        decision = evaluate_visual_capability(
            "codex",
            "gpt-vision",
            AdapterTransportProbe(engine="codex", transport_supports_image=True),
            ModelVisualMetadata(
                engine="codex",
                model_id="gpt-vision",
                label="GPT Vision",
                input_modalities=("text", "image"),
                supports_image=True,
            ),
        )
        refused = authorize_prepared_visual(default_prepared, decision)
        assert isinstance(refused, UnsupportedVisualResult)
        assert refused.reason_code == "source_not_permitted"

        with pytest.raises(ValueError, match="byte_size"):
            PreparedVisual(
                visual_id="bad-size",
                locator=_photo_locator(),
                media_type="image/png",
                data=PNG_1X1,
                byte_size=len(PNG_1X1) + 1,
            )


class TestAuthorizationAndFallback:
    def test_callback_never_reads_bytes_when_unsupported_or_local_video(self) -> None:
        called = 0

        def provider(_loc: VisualSourceLocator) -> PreparedVisual:
            nonlocal called
            called += 1
            return _prepared(_photo_locator())

        bad_decision = evaluate_visual_capability(
            "opencode",
            "opencode/big-pickle",
            AdapterTransportProbe(engine="opencode", transport_supports_image=True),
            ModelVisualMetadata(
                engine="opencode",
                model_id="opencode/big-pickle",
                label="Big Pickle",
                supports_image=False,
            ),
        )
        gate = AuthorizedByteCallback(
            engine="opencode",
            model_id="opencode/big-pickle",
            decision=bad_decision,
            provider=provider,
        )
        res = gate.authorize(_photo_locator(), source_text_available=False)
        assert isinstance(res, UnsupportedVisualResult)
        assert res.ok is False
        assert res.reason_code == "model_no_image_input"
        assert res.text_only_available is False
        assert res.draft_preserved is True
        assert called == 0

        # Even if model supports images, local_video never yields frames (Decision 3).
        ok_decision = evaluate_visual_capability(
            "claude_code",
            "sonnet",
            AdapterTransportProbe(engine="claude_code", transport_supports_image=True),
            parse_claude_model_visual(ModelOption("sonnet", "Sonnet")),
        )
        local_vid = VisualSourceLocator(
            material_id="mat-local-vid",
            source_kind="local_video",
            label="lecture.mp4",
        )
        gate_ok = AuthorizedByteCallback(
            engine="claude_code",
            model_id="sonnet",
            decision=ok_decision,
            provider=provider,
        )
        res_vid = gate_ok.authorize(local_vid, source_text_available=True)
        assert isinstance(res_vid, UnsupportedVisualResult)
        assert res_vid.reason_code == "local_video_no_frames"
        assert res_vid.text_only_available is True
        assert called == 0

    def test_unpermitted_source_is_refused(self) -> None:
        ok_decision = evaluate_visual_capability(
            "claude_code",
            "sonnet",
            AdapterTransportProbe(engine="claude_code", transport_supports_image=True),
            parse_claude_model_visual(ModelOption("sonnet", "Sonnet")),
        )
        unpermitted = _prepared(
            _pdf_locator(8),
            permitted=False,
            permission_reason="Cloud transfer is disabled for this folder.",
            source_text_available=True,
        )
        res = authorize_prepared_visual(unpermitted, ok_decision)
        assert isinstance(res, UnsupportedVisualResult)
        assert res.reason_code == "source_not_permitted"
        assert res.text_only_available is True
        assert "Cloud transfer is disabled" in res.detail

    def test_invalid_media_type_empty_and_oversized_rejected(self) -> None:
        ok_decision = evaluate_visual_capability(
            "codex",
            "gpt-vision",
            AdapterTransportProbe(engine="codex", transport_supports_image=True),
            ModelVisualMetadata(
                engine="codex",
                model_id="gpt-vision",
                label="GPT Vision",
                input_modalities=("text", "image"),
                supports_image=True,
            ),
        )
        bad_mime = authorize_prepared_visual(_prepared(media_type="image/svg+xml"), ok_decision)
        assert isinstance(bad_mime, UnsupportedVisualResult)
        assert bad_mime.reason_code == "invalid_media_type"

        empty = authorize_prepared_visual(_prepared(data=b""), ok_decision)
        assert isinstance(empty, UnsupportedVisualResult)
        assert empty.reason_code == "empty_payload"

        huge = authorize_prepared_visual(_prepared(data=b"x" * 1024), ok_decision, max_bytes=512)
        assert isinstance(huge, UnsupportedVisualResult)
        assert huge.reason_code == "payload_too_large"

    @pytest.mark.asyncio
    async def test_async_callback_authorizes_permitted_bytes_and_redacts_repr(self) -> None:
        ok_decision = evaluate_visual_capability(
            "claude_code",
            "opus",
            AdapterTransportProbe(engine="claude_code", transport_supports_image=True),
            parse_claude_model_visual(ModelOption("opus", "Opus")),
        )
        prepared = _prepared(_pdf_locator(3), source_text_available=True)

        async def async_provider(_loc: VisualSourceLocator) -> PreparedVisual:
            return prepared

        gate = AuthorizedByteCallback(
            engine="claude_code",
            model_id="opus",
            decision=ok_decision,
            provider=async_provider,
        )
        result = await gate.authorize_async(_pdf_locator(3))
        assert isinstance(result, AuthorizedVisualPayload)
        assert result.approved_bytes == PNG_1X1
        assert result.byte_size == len(PNG_1X1)
        assert result.sha256 == hashlib.sha256(PNG_1X1).hexdigest()
        assert result.engine == "claude_code"
        assert result.model_id == "opus"
        assert base64.b64encode(PNG_1X1).decode("ascii") not in repr(result)

    def test_text_only_requires_both_source_text_and_explicit_choice(self) -> None:
        decision = evaluate_visual_capability(
            "opencode",
            "opencode/big-pickle",
            AdapterTransportProbe(engine="opencode", transport_supports_image=True),
            ModelVisualMetadata(
                engine="opencode",
                model_id="opencode/big-pickle",
                label="Big Pickle",
                supports_image=False,
            ),
        )
        pdf_seam = build_fallback_seam(
            decision=decision,
            locator=_pdf_locator(8),
            source_text_available=True,
        )
        assert pdf_seam.text_only_available is True
        assert pdf_seam.text_only_chosen is False
        assert pdf_seam.answer_disclosure is None
        assert pdf_seam.draft_preserved is True
        assert pdf_seam.unsupported is not None
        assert pdf_seam.unsupported.detail == "The PDF text is still available."

        # Implicit / unchosen text-only is refused.
        with pytest.raises(ValueError, match="explicit"):
            request_text_only_continuation(pdf_seam, explicit_user_choice=False)

        chosen = request_text_only_continuation(pdf_seam, explicit_user_choice=True)
        assert chosen.text_only_chosen is True
        assert chosen.answer_disclosure == TEXT_ONLY_DISCLOSURE

        # Video link with transcript
        vid_seam = build_fallback_seam(
            decision=decision,
            locator=_video_locator(),
            source_text_available=True,
        )
        assert vid_seam.unsupported is not None
        assert vid_seam.unsupported.detail == "The video transcript is still available."
        chosen_vid = request_text_only_continuation(vid_seam, explicit_user_choice=True)
        assert chosen_vid.answer_disclosure == TEXT_ONLY_DISCLOSURE

        # Photo without source text -> text-only is NOT allowed even if requested
        photo_seam = build_fallback_seam(
            decision=decision,
            locator=_photo_locator(),
            source_text_available=False,
        )
        assert photo_seam.text_only_available is False
        assert photo_seam.unsupported is not None
        assert photo_seam.unsupported.detail == "This attachment has no text to use instead."
        with pytest.raises(ValueError, match="source text"):
            request_text_only_continuation(photo_seam, explicit_user_choice=True)

        # Invariant enforced on direct construction too
        with pytest.raises(ValueError, match="source text"):
            VisualFallbackSeam(
                decision=decision,
                text_only_available=False,
                text_only_chosen=True,
            )

    @pytest.mark.asyncio
    async def test_source_and_location_mismatches_fail_closed_sync_and_async(self) -> None:
        decision = evaluate_visual_capability(
            "claude_code",
            "sonnet",
            AdapterTransportProbe(engine="claude_code", transport_supports_image=True),
            parse_claude_model_visual(ModelOption("sonnet", "Sonnet")),
        )
        requested_pdf = _pdf_locator(8)
        mismatches = [
            VisualSourceLocator(material_id="mat-pdf-other", source_kind="pdf", page=8, label="Other.pdf"),
            VisualSourceLocator(material_id="mat-pdf-1", source_kind="image", page=8, label="Wrong kind"),
            _pdf_locator(3),
            VisualSourceLocator(
                material_id="mat-pdf-1",
                source_kind="pdf",
                page=8,
                timestamp_ms=500,
                label="Unexpected timestamp",
            ),
        ]

        for returned_loc in mismatches:
            wrong_prepared = _prepared(returned_loc, permitted=True, source_text_available=True)

            def sync_provider(
                _loc: VisualSourceLocator, item: PreparedVisual = wrong_prepared
            ) -> PreparedVisual:
                return item

            async def async_provider(
                _loc: VisualSourceLocator, item: PreparedVisual = wrong_prepared
            ) -> PreparedVisual:
                return item

            sync_gate = AuthorizedByteCallback(
                engine="claude_code", model_id="sonnet", decision=decision, provider=sync_provider
            )
            async_gate = AuthorizedByteCallback(
                engine="claude_code", model_id="sonnet", decision=decision, provider=async_provider
            )

            sync_res = sync_gate.authorize(requested_pdf, source_text_available=False)
            async_res = await async_gate.authorize_async(requested_pdf, source_text_available=False)

            for res in (sync_res, async_res):
                assert isinstance(res, UnsupportedVisualResult)
                assert res.reason_code == "source_mismatch"
                assert res.source_kind == "pdf"
                assert res.source_label == requested_pdf.label
                assert res.text_only_available is False
                assert res.draft_preserved is True

        # Video timestamp mismatch also fails closed identically across sync/async.
        requested_vid = _video_locator(760_000)
        wrong_vid = _prepared(_video_locator(120_000), permitted=True, source_text_available=False)
        sync_vid = AuthorizedByteCallback(
            engine="claude_code", model_id="sonnet", decision=decision, provider=lambda _l: wrong_vid
        ).authorize(requested_vid, source_text_available=True)

        async def _vid_async(_l: VisualSourceLocator) -> PreparedVisual:
            return wrong_vid

        async_vid = await AuthorizedByteCallback(
            engine="claude_code", model_id="sonnet", decision=decision, provider=_vid_async
        ).authorize_async(requested_vid, source_text_available=True)
        for res in (sync_vid, async_vid):
            assert isinstance(res, UnsupportedVisualResult)
            assert res.reason_code == "source_mismatch"
            assert res.text_only_available is True

        # Missing payload (None) aligns across sync/async.
        async def _none_async(_l: VisualSourceLocator) -> None:
            return None

        sync_none = AuthorizedByteCallback(
            engine="claude_code", model_id="sonnet", decision=decision, provider=lambda _l: None
        ).authorize(requested_pdf, source_text_available=True)
        async_none = await AuthorizedByteCallback(
            engine="claude_code", model_id="sonnet", decision=decision, provider=_none_async
        ).authorize_async(requested_pdf, source_text_available=True)
        assert sync_none == async_none
        assert isinstance(sync_none, UnsupportedVisualResult)
        assert sync_none.reason_code == "missing_payload"

    @pytest.mark.asyncio
    async def test_stale_or_mismatched_model_selection_fails_closed_sync_and_async(self) -> None:
        called = 0

        def provider(_loc: VisualSourceLocator) -> PreparedVisual:
            nonlocal called
            called += 1
            return _prepared(_photo_locator(), permitted=True)

        codex_vision = evaluate_visual_capability(
            "codex",
            "gpt-vision",
            AdapterTransportProbe(engine="codex", transport_supports_image=True),
            ModelVisualMetadata(
                engine="codex",
                model_id="gpt-vision",
                label="GPT Vision",
                input_modalities=("text", "image"),
                supports_image=True,
            ),
        )

        # Same adapter ("codex"), stale/different model ("gpt-other").
        mismatched_gate = AuthorizedByteCallback(
            engine="codex",
            model_id="gpt-other",
            decision=codex_vision,
            provider=provider,
        )
        sync_bad = mismatched_gate.authorize(_photo_locator())
        async_bad = await mismatched_gate.authorize_async(_photo_locator())
        assert sync_bad == async_bad
        assert isinstance(sync_bad, UnsupportedVisualResult)
        assert sync_bad.reason_code == "model_capability_unverified"
        assert called == 0

        # No model selected (model_id=None) even if paired with an old decision.
        no_model_gate = AuthorizedByteCallback(
            engine="codex",
            model_id=None,
            decision=codex_vision,
            provider=provider,
        )
        sync_none = no_model_gate.authorize(_photo_locator())
        async_none = await no_model_gate.authorize_async(_photo_locator())
        assert sync_none == async_none
        assert isinstance(sync_none, UnsupportedVisualResult)
        assert sync_none.reason_code == "model_not_selected"
        assert called == 0

        # Matching gate refuses call-time runtime model switch on same adapter.
        valid_gate = AuthorizedByteCallback(
            engine="codex",
            model_id="gpt-vision",
            decision=codex_vision,
            provider=provider,
        )
        sync_stale = valid_gate.authorize(_photo_locator(), model_id="gpt-text")
        async_stale = await valid_gate.authorize_async(_photo_locator(), model_id="gpt-text")
        assert sync_stale == async_stale
        assert isinstance(sync_stale, UnsupportedVisualResult)
        assert sync_stale.reason_code == "model_capability_unverified"
        assert called == 0

        # Direct authorize_prepared_visual checks expected target and missing decision.
        prepared = _prepared(_photo_locator(), permitted=True)
        direct_mismatch = authorize_prepared_visual(
            prepared,
            codex_vision,
            expected_locator=_photo_locator(),
            expected_engine="codex",
            expected_model_id="gpt-other",
        )
        assert isinstance(direct_mismatch, UnsupportedVisualResult)
        assert direct_mismatch.reason_code == "model_capability_unverified"

        direct_missing_model = authorize_prepared_visual(
            prepared,
            codex_vision,
            expected_locator=_photo_locator(),
            expected_engine="codex",
            expected_model_id=None,
        )
        assert isinstance(direct_missing_model, UnsupportedVisualResult)
        assert direct_missing_model.reason_code == "model_not_selected"

        direct_missing_decision = authorize_prepared_visual(
            prepared,
            None,
            expected_locator=_photo_locator(),
            expected_engine="codex",
            expected_model_id="gpt-vision",
        )
        assert isinstance(direct_missing_decision, UnsupportedVisualResult)
        assert direct_missing_decision.reason_code == "model_capability_unverified"

        # Forged supported=True without model_id or transport is rejected by contract.
        with pytest.raises(ValueError, match="model_id"):
            VisualCapabilityDecision(
                engine="codex",
                model_id=None,
                state="supported",
                supported=True,
                transport_supports_image=True,
                model_supports_image=True,
            )
        with pytest.raises(ValueError, match="model_id"):
            AuthorizedVisualPayload(
                visual_id="v1",
                locator=_photo_locator(),
                media_type="image/png",
                approved_bytes=PNG_1X1,
                byte_size=len(PNG_1X1),
                sha256=hashlib.sha256(PNG_1X1).hexdigest(),
                engine="codex",
                model_id="",
            )


class TestTransportPayloadBuilders:
    def _auth(self, engine: str, model_id: str) -> AuthorizedVisualPayload:
        decision = evaluate_visual_capability(
            engine,  # type: ignore[arg-type]
            model_id,
            AdapterTransportProbe(engine=engine, transport_supports_image=True),  # type: ignore[arg-type]
            ModelVisualMetadata(
                engine=engine,  # type: ignore[arg-type]
                model_id=model_id,
                label=model_id,
                input_modalities=("text", "image"),
                supports_image=True,
            ),
        )
        res = authorize_prepared_visual(_prepared(_pdf_locator(8), source_text_available=True), decision)
        assert isinstance(res, AuthorizedVisualPayload)
        return res

    def test_codex_turn_input_with_image_and_size_guard(self) -> None:
        plain = build_codex_turn_input("Plain question", ())
        assert plain == [{"type": "text", "text": "Plain question", "text_elements": []}]

        auth = self._auth("codex", "gpt-vision")
        items = build_codex_turn_input("Explain page 8", [auth], model_id="gpt-vision")
        assert items[0] == {"type": "text", "text": "Explain page 8", "text_elements": []}
        assert items[1] == {
            "type": "image",
            "url": f"data:image/png;base64,{base64.b64encode(PNG_1X1).decode('ascii')}",
        }

        with pytest.raises(VisualPayloadTooLargeError):
            build_codex_turn_input("Explain page 8", [auth], model_id="gpt-vision", max_frame_bytes=64)

    def test_claude_user_message_with_and_without_images(self) -> None:
        plain = build_claude_user_message("Hello", ())
        assert plain == {
            "type": "user",
            "message": {"role": "user", "content": "Hello"},
            "parent_tool_use_id": None,
        }

        auth = self._auth("claude_code", "sonnet")
        msg = build_claude_user_message("Explain chart", [auth], model_id="sonnet")
        assert msg["type"] == "user"
        assert msg["parent_tool_use_id"] is None
        content = msg["message"]["content"]
        assert content[0] == {"type": "text", "text": "Explain chart"}
        assert content[1] == {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": base64.b64encode(PNG_1X1).decode("ascii"),
            },
        }

    def test_acp_prompt_blocks_for_hermes_and_opencode(self) -> None:
        h_auth = self._auth("hermes", "openrouter:vision-1")
        h_blocks = build_acp_prompt_blocks(
            "Check slide", [h_auth], engine="hermes", model_id="openrouter:vision-1"
        )
        assert h_blocks == [
            {"type": "text", "text": "Check slide"},
            {
                "type": "image",
                "data": base64.b64encode(PNG_1X1).decode("ascii"),
                "mimeType": "image/png",
            },
        ]

        o_auth = self._auth("opencode", "anthropic/claude-sonnet-4-5-20250929")
        o_blocks = build_acp_prompt_blocks(
            "Check slide",
            [o_auth],
            engine="opencode",
            model_id="anthropic/claude-sonnet-4-5-20250929",
        )
        assert o_blocks[1]["mimeType"] == "image/png"

    def test_combined_images_exceed_claude_and_acp_frame_limits(self) -> None:
        claude = self._auth("claude_code", "sonnet")
        assert build_claude_user_message("Chart", [claude], model_id="sonnet", max_frame_bytes=400)
        with pytest.raises(VisualPayloadTooLargeError):
            build_claude_user_message("Chart", [claude, claude], model_id="sonnet", max_frame_bytes=400)

        hermes = self._auth("hermes", "vision")
        assert build_acp_prompt_blocks(
            "Chart", [hermes], engine="hermes", model_id="vision", session_id="s1", max_frame_bytes=400,
        )
        with pytest.raises(VisualPayloadTooLargeError):
            build_acp_prompt_blocks(
                "Chart", [hermes, hermes], engine="hermes", model_id="vision",
                session_id="s1", max_frame_bytes=400,
            )

    def test_cross_adapter_and_same_adapter_model_mismatch_or_missing_model_rejected(self) -> None:
        codex_auth = self._auth("codex", "gpt-vision")
        claude_auth = self._auth("claude_code", "sonnet")
        hermes_auth = self._auth("hermes", "openrouter:vision-1")
        opencode_auth = self._auth("opencode", "anthropic/claude-sonnet-4-5-20250929")

        # Cross-adapter rejections even with matching-looking model_id
        with pytest.raises(VisualAuthorizationError):
            build_claude_user_message("Explain", [codex_auth], model_id="sonnet")
        with pytest.raises(VisualAuthorizationError):
            build_acp_prompt_blocks("Explain", [codex_auth], engine="hermes", model_id="openrouter:vision-1")

        # Missing / empty model_id fails closed when visuals are present
        with pytest.raises(VisualAuthorizationError, match="model_id"):
            build_codex_turn_input("Explain", [codex_auth])
        with pytest.raises(VisualAuthorizationError, match="model_id"):
            build_claude_user_message("Explain", [claude_auth], model_id=None)
        with pytest.raises(VisualAuthorizationError, match="model_id"):
            build_acp_prompt_blocks("Explain", [hermes_auth], engine="hermes", model_id="  ")

        # Same adapter, stale/different model_id fails closed
        with pytest.raises(VisualAuthorizationError, match="model"):
            build_codex_turn_input("Explain", [codex_auth], model_id="gpt-text")
        with pytest.raises(VisualAuthorizationError, match="model"):
            build_claude_user_message("Explain", [claude_auth], model_id="haiku")
        with pytest.raises(VisualAuthorizationError, match="model"):
            build_acp_prompt_blocks("Explain", [hermes_auth], engine="hermes", model_id="custom:probe-model")
        with pytest.raises(VisualAuthorizationError, match="model"):
            build_acp_prompt_blocks(
                "Explain", [opencode_auth], engine="opencode", model_id="opencode/big-pickle"
            )

        # Text-only / empty visuals remain unaffected without model_id
        assert build_acp_prompt_blocks("Text only", (), engine="hermes") == [
            {"type": "text", "text": "Text only"}
        ]
