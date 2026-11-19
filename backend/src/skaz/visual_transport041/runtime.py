"""Server-side V4 visual intent derivation, capability verification, and V3 byte authorization."""

from __future__ import annotations

import os
import re
import stat
from collections.abc import Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..knowledge.agents.engine import AgentEngine, EngineId, ModelOption
from ..knowledge.agents.registry import ENGINE_IDS, EngineRegistry
from ..knowledge.errors import KnowledgeError
from ..knowledge.ids import new_id
from ..native_io import disk_call

if TYPE_CHECKING:
    from ..knowledge.chats.model import MessageInput
    from ..knowledge.library.library import MaterialFiles
    from ..knowledge.sources.visual import PreparedVisual as V3PreparedVisual
    from ..knowledge.sources.visual import VisualSourceUnsupported
from ..knowledge.permissions.source_scope import SourceScope
from ..knowledge.service import KnowledgeService
from ..knowledge.sources.duplicates import content_hash
from ..knowledge.sources.material_info import read_intake
from ..knowledge.sources.service import SourceService
from .authorization import (
    DEFAULT_MAX_VISUAL_BYTES,
    AuthorizedVisualPayload,
    authorize_prepared_visual,
    build_unsupported_result,
)
from .capabilities import (
    AdapterTransportProbe,
    ModelVisualMetadata,
    evaluate_visual_capability,
    list_compatible_models,
    parse_claude_model_visual,
)
from .contracts import (
    CompatibleModelHint,
    PreparedVisual,
    UnsupportedVisualReason,
    UnsupportedVisualResult,
    VisualCapabilityDecision,
    VisualSourceKind,
    VisualSourceLocator,
)
from .payloads import linked_frame_caption

_VISUAL_CUE_RE = re.compile(
    r"(?:"
    r"\b(?:images?|photos?|pictures?|screenshots?|charts?|graphs?|diagrams?|figures?|fig\.|"
    r"plots?|illustrations?|slides?|screens?|frames?|visuals?|drawings?|sketches?|scans?|"
    r"what\s+is\s+shown|on\s+screen|on\s+the\s+slide)\b"
    r"|"
    r"(?:график\w*|диаграмм\w*|рисун\w*|рис\.|иллюстрац\w*|картин\w*|изображ\w*|"
    r"фото\w*|скрин\w*|слайд\w*|экран\w*|кадр\w*|схем\w*|скан\w*|визуал\w*|что\s+показано)"
    r")",
    re.IGNORECASE,
)


class VisualTextOnlyUnavailable(KnowledgeError):
    status_code = 422
    code = "VISUAL_TEXT_ONLY_UNAVAILABLE"


class VisualUnsupportedError(KnowledgeError):
    """Typed refusal when a chat turn's visual request cannot be delivered."""

    status_code = 422

    def __init__(
        self,
        result: UnsupportedVisualResult,
        locator: VisualSourceLocator,
        *,
        code: str = "VISUAL_UNSUPPORTED",
    ) -> None:
        super().__init__(result.detail)
        self.result = result
        self.locator = locator
        self.code = code

    def payload(self) -> dict[str, Any]:
        return {
            "detail": self.message,
            "code": self.code,
            "reason_code": self.result.reason_code,
            "title": self.result.title,
            "engine": self.result.engine,
            "model_id": self.result.model_id,
            "source_kind": self.result.source_kind,
            "source_label": self.result.source_label,
            "text_only_available": self.result.text_only_available,
            "draft_preserved": self.result.draft_preserved,
            "locator": {
                "material_id": self.locator.material_id,
                "source_kind": self.locator.source_kind,
                "page": self.locator.page,
                "timestamp_ms": self.locator.timestamp_ms,
                "label": self.locator.label,
            },
            "compatible_models": [
                {
                    "engine": hint.engine,
                    "model_id": hint.model_id,
                    "label": hint.label,
                    "provider": hint.provider,
                }
                for hint in self.result.compatible_models
            ],
        }


@dataclass(frozen=True)
class VisualSourceCandidate:
    material_id: str
    source_kind: VisualSourceKind
    title: str
    locator: VisualSourceLocator
    has_source_text: bool
    permitted: bool
    permission_reason: str | None = None
    explicit_pages: tuple[int, ...] = ()


@dataclass(frozen=True)
class VisualRequestPlan:
    requires_visual: bool
    candidates: tuple[VisualSourceCandidate, ...] = ()
    text_only_available: bool = False
    primary_locator: VisualSourceLocator | None = None


@dataclass(frozen=True)
class VisualPreflightOutcome:
    requires_visual: bool
    supported: bool
    decision: VisualCapabilityDecision
    unsupported: UnsupportedVisualResult | None
    text_only_available: bool
    locator: VisualSourceLocator | None
    compatible_models: tuple[CompatibleModelHint, ...] = ()


def has_visual_query_cue(text: str, *, allow_pages: bool = True) -> bool:
    if allow_pages:
        from ..knowledge.sources.visual import parse_explicit_pages

        if parse_explicit_pages(text):
            return True
    return bool(_VISUAL_CUE_RE.search(text or ""))


def _source_kind_for_material(kind: str) -> VisualSourceKind | None:
    if kind == "image":
        return "image"
    if kind in ("pdf", "book"):
        return "pdf"
    if kind == "video_link":
        return "video_link"
    if kind == "video":
        return "local_video"
    return None


def _has_visible_fragments(sources: SourceService, material_id: str) -> bool:
    from ..knowledge.sources.visual import VisualSourceUnsupported

    try:
        files = sources.visual._material_files(material_id)
    except VisualSourceUnsupported:
        return False
    return bool(sources.visual._visible_fragments(files))


def derive_visual_intent(
    kb: KnowledgeService,
    sources: SourceService,
    given: MessageInput,
    scope: SourceScope | None = None,
) -> VisualRequestPlan:
    """Derive visual intent and source-text availability strictly from trusted backend state."""
    from ..knowledge.sources.visual import parse_explicit_pages

    ordered_ids: list[tuple[str, bool]] = []
    seen: set[str] = set()

    for material_id in given.attachments:
        if material_id not in seen:
            seen.add(material_id)
            ordered_ids.append((material_id, True))

    for ref in given.mentions:
        if ref.type == "material" and ref.id not in seen:
            seen.add(ref.id)
            ordered_ids.append((ref.id, False))

    if given.context.material_id and given.context.material_id not in seen:
        seen.add(given.context.material_id)
        ordered_ids.append((given.context.material_id, False))

    explicit_pages = tuple(parse_explicit_pages(given.text))
    pdf_cue = has_visual_query_cue(given.text, allow_pages=True)
    media_cue = has_visual_query_cue(given.text, allow_pages=False)

    candidates: list[VisualSourceCandidate] = []
    missing_attachment = False
    for material_id, is_attachment in ordered_ids:
        record = kb.material_repo.get(material_id)
        if record is None:
            missing_attachment |= is_attachment
            continue
        source_kind = _source_kind_for_material(record.kind)
        if source_kind is None:
            continue

        allowed = scope is None or scope.allows(material_id)
        has_text = _has_visible_fragments(sources, material_id) if allowed else False
        include = False
        if source_kind == "image":
            include = is_attachment or media_cue
        elif source_kind == "pdf":
            # A scope-denied attachment has no usable text in this chat and must surface a refusal.
            include = pdf_cue or (is_attachment and not has_text)
        elif source_kind in ("video_link", "local_video"):
            include = media_cue

        if not include:
            continue

        page = explicit_pages[0] if source_kind == "pdf" and explicit_pages else None
        label = _page_label(record.title, page)
        locator = VisualSourceLocator(
            material_id=material_id,
            source_kind=source_kind,
            page=page,
            label=label,
        )
        candidates.append(
            VisualSourceCandidate(
                material_id=material_id,
                source_kind=source_kind,
                title=record.title,
                locator=locator,
                has_source_text=has_text,
                permitted=allowed,
                permission_reason=scope.refusal(material_id) if (scope is not None and not allowed) else None,
                explicit_pages=explicit_pages,
            )
        )

    if not candidates:
        return VisualRequestPlan(requires_visual=False)

    text_only_ok = not missing_attachment and all(
        item.permitted and item.has_source_text for item in candidates
    )
    return VisualRequestPlan(
        requires_visual=True,
        candidates=tuple(candidates),
        text_only_available=text_only_ok,
        primary_locator=candidates[0].locator,
    )


def _page_label(title: str, page: int | None) -> str:
    return f"{title} · Page {page}" if page is not None else title


async def probe_engine_visual_transport(engine: AgentEngine) -> AdapterTransportProbe:
    """Ask an adapter for its real transport image probe (fail-closed if unimplemented)."""
    probe_fn = getattr(engine, "probe_visual_transport", None)
    if callable(probe_fn):
        result = await probe_fn()
        if isinstance(result, AdapterTransportProbe):
            return result
    static_probe = getattr(engine, "visual_transport_probe", None)
    if isinstance(static_probe, AdapterTransportProbe):
        return static_probe
    return AdapterTransportProbe(
        engine=engine.id,
        transport_supports_image=False,
        reason=f"{engine.id} does not declare verified image transport.",
    )


def model_visual_metadata(engine_id: EngineId, option: ModelOption) -> ModelVisualMetadata:
    """Convert an adapter's ``ModelOption`` into ``ModelVisualMetadata`` without guessing."""
    if engine_id == "claude_code" and option.supports_image is None:
        return parse_claude_model_visual(option)
    return ModelVisualMetadata(
        engine=engine_id,
        model_id=option.id,
        label=option.label,
        provider=engine_id,
        input_modalities=option.input_modalities,
        supports_image=option.supports_image,
        declared_by="adapter_catalog"
        if (option.supports_image is not None or option.input_modalities)
        else "undeclared",
    )


async def _collect_catalog_and_probes(
    registry: EngineRegistry,
) -> tuple[list[ModelVisualMetadata], dict[EngineId, AdapterTransportProbe]]:
    catalog: list[ModelVisualMetadata] = []
    probes: dict[EngineId, AdapterTransportProbe] = {}
    for eid in ENGINE_IDS:
        eng = registry.engines.get(eid)
        if eng is None:
            continue
        try:
            view = await registry.known_view(eid)
        except Exception:
            continue
        if view.state != "ready":
            continue
        probes[eid] = await probe_engine_visual_transport(eng)
        for option in view.models:
            catalog.append(model_visual_metadata(eid, option))
    return catalog, probes


async def evaluate_target_capability(
    registry: EngineRegistry,
    engine_id: EngineId,
    model_id: str | None,
) -> tuple[VisualCapabilityDecision, AdapterTransportProbe, tuple[CompatibleModelHint, ...]]:
    """Evaluate capability for ``(engine_id, model_id)`` and return verified compatible alternatives."""
    engine = registry.engine(engine_id)
    transport = await probe_engine_visual_transport(engine)
    model_meta: ModelVisualMetadata | None = None
    if isinstance(model_id, str) and model_id.strip():
        try:
            view = await registry.known_view(engine_id)
            option = next((opt for opt in view.models if opt.id == model_id), None)
            if option is not None:
                model_meta = model_visual_metadata(engine_id, option)
        except Exception:
            model_meta = None

    decision = evaluate_visual_capability(engine_id, model_id, transport, model_meta)
    catalog, probes = await _collect_catalog_and_probes(registry)
    compatible = list_compatible_models(catalog, probes)
    return decision, transport, compatible


def _map_v3_unsupported(
    error: VisualSourceUnsupported,
    *,
    engine_id: EngineId,
    model_id: str | None,
    candidate: VisualSourceCandidate,
    compatible: Sequence[CompatibleModelHint],
    text_only_available: bool,
) -> UnsupportedVisualResult:
    reason_map: dict[str, UnsupportedVisualReason] = {
        "local_video_audio_only": "local_video_no_frames",
        "unauthorized_path": "source_not_permitted",
        "oversized_image": "payload_too_large",
        "unsupported_image_format": "invalid_media_type",
        "source_not_found": "missing_payload",
    }
    source_titles = {
        "page_out_of_range": "PDF page is out of range",
        "page_range_required": "Specify PDF pages",
        "pdf_render_unavailable": "PDF pages are unavailable",
        "video_frames_unsupported": "Video frames are unavailable",
    }
    missing = error.reason == "source_not_found" or isinstance(error.__cause__, FileNotFoundError)
    code: UnsupportedVisualReason = (
        "missing_payload"
        if missing
        else reason_map.get(
            error.reason,
            "missing_payload",
        )
    )
    text_avail = text_only_available and not missing and error.reason != "unauthorized_path"
    result = build_unsupported_result(
        reason_code=code,
        engine=engine_id,
        model_id=model_id,
        locator=candidate.locator,
        text_only_available=text_avail,
        compatible_models=compatible,
        custom_title=None if missing else source_titles.get(error.reason),
        custom_detail=error.message,
    )
    return result


def _preflight_source_block(
    sources: SourceService,
    candidate: VisualSourceCandidate,
    *,
    engine_id: EngineId,
    model_id: str | None,
    compatible: Sequence[CompatibleModelHint],
    text_only_available: bool,
    query: str = "",
) -> UnsupportedVisualResult | None:
    if not candidate.permitted:
        return build_unsupported_result(
            reason_code="source_not_permitted",
            engine=engine_id,
            model_id=model_id,
            locator=candidate.locator,
            text_only_available=False,
            compatible_models=compatible,
            custom_detail=candidate.permission_reason,
        )
    if candidate.source_kind == "local_video":
        return build_unsupported_result(
            reason_code="local_video_no_frames",
            engine=engine_id,
            model_id=model_id,
            locator=candidate.locator,
            text_only_available=text_only_available,
            compatible_models=compatible,
        )
    if candidate.source_kind == "image":
        from ..knowledge.sources.visual import VisualSourceUnsupported

        try:
            _prepare_local_visuals(sources, candidate, query=query)
        except VisualSourceUnsupported as err:
            return _map_v3_unsupported(
                err,
                engine_id=engine_id,
                model_id=model_id,
                candidate=candidate,
                compatible=compatible,
                text_only_available=text_only_available,
            )
        except (KnowledgeError, OSError):
            return build_unsupported_result(
                reason_code="missing_payload",
                engine=engine_id,
                model_id=model_id,
                locator=candidate.locator,
                text_only_available=False,
                compatible_models=compatible,
            )
    if candidate.source_kind == "video_link":
        from ..knowledge.sources.visual import VisualSourceUnsupported

        try:
            files = sources.visual._material_files(candidate.material_id)
            raw_url = files.manifest.origin.url if files.manifest.origin is not None else None
            if not raw_url:
                raise VisualSourceUnsupported(
                    "source_not_found",
                    "This linked video has no source URL.",
                    has_source_text=candidate.has_source_text,
                )
            from ..media_source import InvalidMediaSource, video_source

            try:
                vsrc = video_source(raw_url)
            except InvalidMediaSource as err:
                raise VisualSourceUnsupported(
                    "source_not_found", str(err), has_source_text=candidate.has_source_text
                ) from err
            policy = sources.visual._policy_for(vsrc)
            if not policy.retrieval_permitted or sources.visual.frame_retriever is None:
                raise VisualSourceUnsupported(
                    "video_frames_unsupported",
                    "SKAZ can't retrieve video frames from this source. Open the video at the timestamp "
                    "or attach a screenshot instead.",
                    has_source_text=candidate.has_source_text,
                )
        except VisualSourceUnsupported as err:
            return _map_v3_unsupported(
                err,
                engine_id=engine_id,
                model_id=model_id,
                candidate=candidate,
                compatible=compatible,
                text_only_available=text_only_available,
            )
    if candidate.source_kind == "pdf":
        from ..knowledge.sources.visual import (
            MAX_SELECTED_PDF_PAGES,
            VisualSourceUnsupported,
            select_pdf_pages_by_text,
        )

        try:
            from ..knowledge.sources.native_intake041.formats import MAX_PDF_BYTES
            from ..knowledge.sources.pdf import PdfRejected, open_pdf

            files = sources.visual._material_files(candidate.material_id)
            intake = read_intake(files.directory)
            original_name = str(intake.get("original") or "original.pdf")
            original_path = sources.visual._authorized_service_file(files, original_name)
            try:
                reader = open_pdf(_read_verified_original(files, original_path, max_bytes=MAX_PDF_BYTES))
            except PdfRejected as err:
                raise VisualSourceUnsupported(
                    "pdf_render_unavailable",
                    err.message,
                    has_source_text=candidate.has_source_text,
                ) from err
            page_count = len(reader.pages)
            if candidate.explicit_pages:
                for number in candidate.explicit_pages:
                    if number < 1 or number > page_count:
                        raise VisualSourceUnsupported(
                            "page_out_of_range",
                            f"Page {number} is out of range. This PDF has {page_count} "
                            f"{'page' if page_count == 1 else 'pages'} (1–{page_count}).",
                            page_count=page_count,
                            has_source_text=candidate.has_source_text,
                        )
                if len(candidate.explicit_pages) > MAX_SELECTED_PDF_PAGES:
                    raise VisualSourceUnsupported(
                        "page_range_required",
                        f"Specify at most {MAX_SELECTED_PDF_PAGES} pages at a time (1–{page_count}).",
                        ask_page_range=True,
                        page_count=page_count,
                        has_source_text=candidate.has_source_text,
                    )
            else:
                if not candidate.has_source_text:
                    raise VisualSourceUnsupported(
                        "page_range_required",
                        "This PDF has no text layer to locate the page automatically. "
                        f"Specify a page number or a short page range (1–{page_count}).",
                        ask_page_range=True,
                        page_count=page_count,
                        has_source_text=False,
                    )
                excluded = sources.visual._excluded_segs(files.directory)
                selected = select_pdf_pages_by_text(files.fragments, excluded, query)
                if not selected:
                    raise VisualSourceUnsupported(
                        "page_range_required",
                        "SKAZ couldn't locate a matching page from headings, captions or text. "
                        f"Specify a page number or a short page range (1–{page_count}).",
                        ask_page_range=True,
                        page_count=page_count,
                        has_source_text=True,
                    )
            if sources.visual.pdf_renderer_known_unavailable():
                raise VisualSourceUnsupported(
                    "pdf_render_unavailable",
                    "SKAZ couldn't find a local renderer for the selected PDF pages.",
                    page_count=page_count,
                    has_source_text=candidate.has_source_text,
                )
        except VisualSourceUnsupported as err:
            return _map_v3_unsupported(
                err,
                engine_id=engine_id,
                model_id=model_id,
                candidate=candidate,
                compatible=compatible,
                text_only_available=text_only_available,
            )
        except (KnowledgeError, OSError) as err:
            return build_unsupported_result(
                reason_code="missing_payload",
                engine=engine_id,
                model_id=model_id,
                locator=candidate.locator,
                text_only_available=False,
                compatible_models=compatible,
                custom_detail=err.message
                if isinstance(err, KnowledgeError)
                else "The material's original file can't be opened.",
            )
    return None


async def preflight_visual_turn(
    *,
    kb: KnowledgeService,
    sources: SourceService,
    registry: EngineRegistry,
    engine_id: EngineId,
    model_id: str | None,
    given: MessageInput,
    scope: SourceScope | None = None,
) -> VisualPreflightOutcome:
    """Validate visual intent, source access, and ``(engine_id, model_id)`` capability before send."""
    plan = await disk_call(derive_visual_intent, kb, sources, given, scope)
    if not plan.requires_visual:
        # Image support is unevaluated and irrelevant to admission for a plain-text turn.
        decision = VisualCapabilityDecision(
            engine=engine_id,
            model_id=model_id,
            state="unverified",
            supported=False,
            transport_supports_image=False,
            model_supports_image=None,
            verified_by="not_evaluated",
        )
        return VisualPreflightOutcome(
            requires_visual=False,
            supported=False,
            decision=decision,
            unsupported=None,
            text_only_available=False,
            locator=None,
            compatible_models=(),
        )

    assert plan.candidates
    primary = plan.candidates[0]
    decision, _transport, compatible = await evaluate_target_capability(registry, engine_id, model_id)

    blocked, locator, text_only_available = await disk_call(
        _check_sources,
        sources,
        plan,
        engine_id,
        model_id,
        compatible,
        given.text,
    )
    if blocked is not None:
        return VisualPreflightOutcome(
            requires_visual=True,
            supported=False,
            decision=decision,
            unsupported=blocked,
            text_only_available=text_only_available,
            locator=locator,
            compatible_models=compatible,
        )

    if not decision.supported:
        reason = decision.reason_code or "model_capability_unverified"
        unsupported = build_unsupported_result(
            reason_code=reason,
            engine=engine_id,
            model_id=model_id,
            locator=primary.locator,
            text_only_available=plan.text_only_available,
            compatible_models=compatible,
        )
        return VisualPreflightOutcome(
            requires_visual=True,
            supported=False,
            decision=decision,
            unsupported=unsupported,
            text_only_available=plan.text_only_available,
            locator=primary.locator,
            compatible_models=compatible,
        )

    return VisualPreflightOutcome(
        requires_visual=True,
        supported=True,
        decision=decision,
        unsupported=None,
        text_only_available=plan.text_only_available,
        locator=primary.locator,
        compatible_models=compatible,
    )


def _read_verified_original(files: MaterialFiles, path: Path, *, max_bytes: int) -> bytes:
    """Return the bounded snapshot that the decoder receives after checking its intake digest."""
    from ..knowledge.sources.visual import VisualSourceUnsupported

    try:
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            descriptor = os.open(
                path.name,
                os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW,
                dir_fd=directory,
            )
        finally:
            os.close(directory)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise VisualSourceUnsupported("unauthorized_path", "Choose a readable regular file.")
            if info.st_size > max_bytes:
                raise VisualSourceUnsupported("oversized_image", "This source exceeds the visual size limit.")
            data = handle.read(info.st_size + 1)
            if len(data) > max_bytes:
                raise VisualSourceUnsupported("oversized_image", "This source exceeds the visual size limit.")
            after = os.fstat(handle.fileno())
    except OSError as err:
        raise VisualSourceUnsupported("source_not_found", "The stored original can't be read.") from err
    if not data:
        raise VisualSourceUnsupported("source_not_found", "The stored original is empty.")
    origin = files.manifest.origin
    expected_sha = (origin.model_extra or {}).get("sha256") if origin is not None else None
    if (
        len(data) != info.st_size
        or (info.st_size, info.st_mtime_ns) != (after.st_size, after.st_mtime_ns)
        or (
            expected_sha is not None
            and (not isinstance(expected_sha, str) or content_hash(data) != expected_sha.lower())
        )
    ):
        raise VisualSourceUnsupported(
            "unauthorized_path",
            "The stored original no longer matches its recorded intake version.",
        )
    return data


def _check_sources(
    sources: SourceService,
    plan: VisualRequestPlan,
    engine_id: EngineId,
    model_id: str | None,
    compatible: Sequence[CompatibleModelHint],
    query: str,
) -> tuple[UnsupportedVisualResult | None, VisualSourceLocator | None, bool]:
    first: UnsupportedVisualResult | None = None
    locator: VisualSourceLocator | None = None
    text_only_available = plan.text_only_available
    for candidate in plan.candidates:
        blocked = _preflight_source_block(
            sources,
            candidate,
            engine_id=engine_id,
            model_id=model_id,
            compatible=compatible,
            text_only_available=plan.text_only_available,
            query=query,
        )
        if blocked is not None:
            text_only_available &= blocked.text_only_available
            if first is None:
                first, locator = blocked, candidate.locator
            if not text_only_available:
                break
    if first is not None:
        first = replace(first, text_only_available=text_only_available)
    return first, locator, text_only_available


def _to_v4_prepared(
    v3_item: V3PreparedVisual,
    *,
    visual_id: str,
    candidate: VisualSourceCandidate,
) -> PreparedVisual:
    page = v3_item.locator.page
    return PreparedVisual(
        visual_id=visual_id,
        locator=VisualSourceLocator(
            material_id=candidate.material_id,
            source_kind=candidate.source_kind,
            page=page,
            timestamp_ms=v3_item.locator.timestamp_ms,
            label=_page_label(candidate.title, page),
            source_sha256=v3_item.locator.source_sha256 or v3_item.sha256,
            source_url=v3_item.locator.source_url,
        ),
        media_type=v3_item.media_type,
        data=v3_item.data,
        byte_size=len(v3_item.data),
        width=v3_item.width,
        height=v3_item.height,
        source_text_available=candidate.has_source_text,
        permitted=candidate.permitted,
        permission_reason=candidate.permission_reason,
        linked_frame=v3_item if candidate.source_kind == "video_link" else None,
    )


def _prepare_local_visuals(
    sources: SourceService,
    candidate: VisualSourceCandidate,
    *,
    query: str,
) -> tuple[PreparedVisual, ...]:
    from ..knowledge.sources.native_intake041.formats import MAX_PDF_BYTES
    from ..knowledge.sources.native_intake041.images import decode_image
    from ..knowledge.sources.visual import (
        IMAGE_EXTENSIONS,
        MAX_IMAGE_BYTES,
        VisualSourceUnsupported,
        inspect_image_bytes,
    )

    if candidate.source_kind == "pdf":
        pages = sources.visual.prepare_pdf_pages(
            candidate.material_id,
            pages=candidate.explicit_pages or None,
            query=query,
            read_original=lambda files, path: _read_verified_original(files, path, max_bytes=MAX_PDF_BYTES),
        )
        return tuple(
            _to_v4_prepared(item, visual_id=f"vis-{candidate.material_id}-p{item.page}", candidate=candidate)
            for item in pages
        )

    files = sources.visual._material_files(candidate.material_id)
    intake = read_intake(files.directory)
    original_name = str(intake.get("original") or "")
    if not original_name:
        raise VisualSourceUnsupported("source_not_found", "This image material has no stored original file.")
    path = sources.visual._authorized_service_file(files, original_name)
    suffix = path.suffix.lower()
    if suffix not in IMAGE_EXTENSIONS and suffix != ".heic":
        raise VisualSourceUnsupported(
            "unsupported_image_format",
            "SKAZ can only prepare PNG, JPEG, WebP, GIF or HEIC images.",
        )
    data = _read_verified_original(files, path, max_bytes=MAX_IMAGE_BYTES)
    original_sha256 = content_hash(data)
    if suffix == ".heic":
        decoded = decode_image(data, expected_format="heic", mime_type="image/heic", generate_preview=True)
        assert decoded.preview_png is not None
        data = decoded.preview_png
    header = inspect_image_bytes(data)
    return (
        PreparedVisual(
            visual_id=f"vis-{candidate.material_id}",
            locator=replace(candidate.locator, source_sha256=original_sha256),
            media_type=header.media_type,
            data=data,
            byte_size=len(data),
            width=header.width,
            height=header.height,
            source_text_available=candidate.has_source_text,
            permitted=candidate.permitted,
            permission_reason=candidate.permission_reason,
        ),
    )


async def _prepare_candidate_v4_items(
    sources: SourceService,
    candidate: VisualSourceCandidate,
    *,
    query: str,
) -> tuple[PreparedVisual, ...]:
    from ..knowledge.sources.visual import VisualSourceUnsupported

    if candidate.source_kind in ("pdf", "image"):
        return await disk_call(_prepare_local_visuals, sources, candidate, query=query)
    if candidate.source_kind == "video_link":
        frames = await sources.prepare_video_frames(candidate.material_id, query=query)
        return tuple(
            _to_v4_prepared(
                item,
                visual_id=new_id("vis"),
                candidate=candidate,
            )
            for item in frames
        )

    raise VisualSourceUnsupported(
        "local_video_audio_only",
        "SKAZ transcribes the audio only. It doesn’t save the video or its frames.",
        has_source_text=candidate.has_source_text,
    )


async def authorize_visual_turn(
    *,
    kb: KnowledgeService,
    sources: SourceService,
    registry: EngineRegistry,
    engine_id: EngineId,
    model_id: str | None,
    given: MessageInput,
    scope: SourceScope | None = None,
) -> tuple[tuple[AuthorizedVisualPayload, ...], bool]:
    """Revalidate visual intent, capability, and source permissions; authorize bytes or text-only."""
    from ..knowledge.sources.visual import MAX_IMAGE_BYTES, VisualSourceUnsupported

    plan = await disk_call(derive_visual_intent, kb, sources, given, scope)
    if not plan.requires_visual:
        if given.text_only:
            raise VisualTextOnlyUnavailable("Text-only continuation requires available visual source text.")
        return (), False

    assert plan.candidates
    primary = plan.candidates[0]
    decision, transport, compatible = await evaluate_target_capability(registry, engine_id, model_id)

    if given.text_only:
        blocked, locator, text_only_available = (
            await disk_call(
                _check_sources,
                sources,
                plan,
                engine_id,
                model_id,
                compatible,
                given.text,
            )
            if plan.text_only_available
            else (None, None, False)
        )
        if text_only_available:
            return (), True
        blocked_cand = next((c for c in plan.candidates if not c.permitted), primary)
        result = build_unsupported_result(
            reason_code="source_not_permitted" if not blocked_cand.permitted else "missing_payload",
            engine=engine_id,
            model_id=model_id,
            locator=locator or blocked_cand.locator,
            text_only_available=False,
            compatible_models=compatible,
            custom_detail=(
                (blocked.detail if blocked is not None else None)
                or blocked_cand.permission_reason
                or "Text-only continuation requires available source text for every selected source."
            ),
        )
        raise VisualUnsupportedError(
            result, locator or blocked_cand.locator, code="VISUAL_TEXT_ONLY_UNAVAILABLE",
        )

    visual_block = next(
        (c for c in plan.candidates if not c.permitted or c.source_kind == "local_video"),
        None,
    )
    if visual_block is not None:
        blocked = await disk_call(
            _preflight_source_block,
            sources,
            visual_block,
            engine_id=engine_id,
            model_id=model_id,
            compatible=compatible,
            text_only_available=plan.text_only_available,
        )
        assert blocked is not None
        raise VisualUnsupportedError(blocked, visual_block.locator)

    if not decision.supported:
        reason = decision.reason_code or "model_capability_unverified"
        result = build_unsupported_result(
            reason_code=reason,
            engine=engine_id,
            model_id=model_id,
            locator=primary.locator,
            text_only_available=plan.text_only_available,
            compatible_models=compatible,
        )
        raise VisualUnsupportedError(result, primary.locator)

    max_bytes = transport.max_payload_bytes or DEFAULT_MAX_VISUAL_BYTES
    # Budget base64 and framing across the turn. Adapters also check their final prompt.
    remaining = max_bytes - 4096 - len(given.text.encode("utf-8"))

    authorized: list[AuthorizedVisualPayload] = []
    for cand in plan.candidates:
        try:
            v4_items = await _prepare_candidate_v4_items(sources, cand, query=given.text)
        except VisualSourceUnsupported as err:
            _, _, can_use_text = await disk_call(
                _check_sources, sources, plan, engine_id, model_id, compatible, given.text,
            )
            locator = cand.locator
            if err.locator is not None:
                locator = replace(
                    locator, page=err.locator.page, timestamp_ms=err.locator.timestamp_ms,
                    label=_page_label(cand.title, err.locator.page),
                )
            raise VisualUnsupportedError(
                _map_v3_unsupported(
                    err,
                    engine_id=engine_id,
                    model_id=model_id,
                    candidate=cand,
                    compatible=compatible,
                    text_only_available=can_use_text,
                ),
                locator,
            ) from err
        except (KnowledgeError, OSError) as err:
            raise VisualUnsupportedError(
                build_unsupported_result(
                    reason_code="missing_payload",
                    engine=engine_id,
                    model_id=model_id,
                    locator=cand.locator,
                    text_only_available=False,
                    compatible_models=compatible,
                    custom_detail=err.message
                    if isinstance(err, KnowledgeError)
                    else "The material's original file can't be opened.",
                ),
                cand.locator,
            ) from err

        for item in v4_items:
            caption = linked_frame_caption(item.locator, item.visual_id)
            overhead = 256 + (len(caption.encode("utf-8")) + 96 if caption is not None else 0)
            raw_limit = min(MAX_IMAGE_BYTES, max(0, (remaining - overhead) // 4) * 3)
            if raw_limit <= 0 or item.byte_size > raw_limit:
                raise VisualUnsupportedError(
                    build_unsupported_result(
                        reason_code="payload_too_large",
                        engine=engine_id,
                        model_id=model_id,
                        locator=item.locator,
                        text_only_available=plan.text_only_available,
                        compatible_models=compatible,
                        custom_detail="The images together exceed this agent's visual transport limit.",
                    ),
                    item.locator,
                )
            outcome = await disk_call(
                authorize_prepared_visual,
                item,
                decision,
                expected_locator=item.locator,
                expected_engine=engine_id,
                expected_model_id=model_id,
                source_text_available=plan.text_only_available,
                compatible_models=compatible,
                max_bytes=raw_limit,
            )
            if isinstance(outcome, UnsupportedVisualResult):
                raise VisualUnsupportedError(outcome, item.locator)
            authorized.append(outcome)
            remaining -= overhead + 4 * ((item.byte_size + 2) // 3)

    return tuple(authorized), False
