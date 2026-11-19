"""Per-adapter and per-model image capability detection (no family-name guessing)."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..knowledge.agents.engine import EngineId, ModelOption
from .contracts import CompatibleModelHint, VisualCapabilityDecision

#: Documented first-party Claude Code aliases from ``claude_code.CLAUDE_MODELS``.
DOCUMENTED_CLAUDE_IMAGE_MODELS: frozenset[str] = frozenset({"opus", "sonnet", "haiku"})


@dataclass(frozen=True)
class AdapterTransportProbe:
    """Transport-level image delivery capability for one adapter."""

    engine: EngineId
    transport_supports_image: bool | None
    max_payload_bytes: int | None = None
    reason: str | None = None


@dataclass(frozen=True)
class ModelVisualMetadata:
    """Declared image capability metadata extracted from an adapter's model catalog."""

    engine: EngineId
    model_id: str
    label: str
    provider: str = ""
    input_modalities: tuple[str, ...] = ()
    supports_image: bool | None = None
    declared_by: str = "metadata"


def _modalities_tuple(raw: object) -> tuple[str, ...]:
    if not isinstance(raw, Sequence) or isinstance(raw, str | bytes):
        return ()
    return tuple(str(item).strip().lower() for item in raw if isinstance(item, str) and item.strip())


def _explicit_image_flag(raw_model: Mapping[str, Any]) -> bool | None:
    for key in ("supportsImage", "supports_image", "vision"):
        val = raw_model.get(key)
        if isinstance(val, bool):
            return val
    caps = raw_model.get("capabilities")
    if isinstance(caps, Mapping):
        inp = caps.get("input")
        if isinstance(inp, Mapping) and isinstance(inp.get("image"), bool):
            return bool(inp["image"])
    return None


def parse_acp_transport_probe(
    engine: EngineId,
    initialized: Mapping[str, Any] | None,
    *,
    max_payload_bytes: int | None = None,
) -> AdapterTransportProbe:
    """Extract ACP ``agentCapabilities.promptCapabilities.image`` from an ``initialize`` reply."""
    if not isinstance(initialized, Mapping):
        return AdapterTransportProbe(
            engine=engine,
            transport_supports_image=False,
            max_payload_bytes=max_payload_bytes,
            reason=f"{engine} did not report ACP initialize capabilities.",
        )
    agent_caps = initialized.get("agentCapabilities")
    prompt_caps = agent_caps.get("promptCapabilities") if isinstance(agent_caps, Mapping) else None
    image_flag = prompt_caps.get("image") if isinstance(prompt_caps, Mapping) else None
    if image_flag is True:
        return AdapterTransportProbe(
            engine=engine,
            transport_supports_image=True,
            max_payload_bytes=max_payload_bytes,
        )
    return AdapterTransportProbe(
        engine=engine,
        transport_supports_image=False,
        max_payload_bytes=max_payload_bytes,
        reason=f"{engine} ACP promptCapabilities.image is not enabled.",
    )


def parse_codex_model_visual(raw_model: Mapping[str, Any]) -> ModelVisualMetadata:
    """Parse one Codex ``model/list`` entry without guessing undeclared modalities."""
    model_id = str(raw_model.get("model") or raw_model.get("id") or "")
    label = str(raw_model.get("displayName") or raw_model.get("name") or model_id)
    modalities = _modalities_tuple(raw_model.get("inputModalities") or raw_model.get("input_modalities"))
    supports = _explicit_image_flag(raw_model)
    if supports is None and modalities:
        supports = "image" in modalities
    return ModelVisualMetadata(
        engine="codex",
        model_id=model_id,
        label=label,
        provider="codex",
        input_modalities=modalities,
        supports_image=supports,
        declared_by="codex_model_list" if (supports is not None or modalities) else "undeclared",
    )


def parse_opencode_model_visual(raw_model: Mapping[str, Any]) -> ModelVisualMetadata:
    """Parse one OpenCode ``models --verbose`` / ``api model.list`` entry."""
    provider = str(raw_model.get("providerID") or "")
    raw_id = str(raw_model.get("id") or "")
    model_id = f"{provider}/{raw_id}" if provider and "/" not in raw_id else raw_id
    label = str(raw_model.get("name") or raw_id or model_id)

    modalities_obj = raw_model.get("modalities")
    modalities: tuple[str, ...] = ()
    if isinstance(modalities_obj, Mapping):
        modalities = _modalities_tuple(modalities_obj.get("input"))
    if not modalities:
        caps = raw_model.get("capabilities")
        inp = caps.get("input") if isinstance(caps, Mapping) else None
        if isinstance(inp, Mapping):
            modalities = tuple(str(k).lower() for k, v in inp.items() if v is True)

    supports = _explicit_image_flag(raw_model)
    if supports is None and modalities:
        supports = "image" in modalities
    return ModelVisualMetadata(
        engine="opencode",
        model_id=model_id,
        label=label,
        provider=provider,
        input_modalities=modalities,
        supports_image=supports,
        declared_by="opencode_catalog" if (supports is not None or modalities) else "undeclared",
    )


def parse_hermes_model_visual(raw_model: Mapping[str, Any]) -> ModelVisualMetadata:
    """Parse one Hermes ``session/new`` ``availableModels`` entry (fail-closed when undeclared)."""
    model_id = str(raw_model.get("modelId") or raw_model.get("id") or "")
    label = str(raw_model.get("name") or model_id)
    modalities = _modalities_tuple(raw_model.get("inputModalities") or raw_model.get("input_modalities"))
    supports = _explicit_image_flag(raw_model)
    if supports is None and modalities:
        supports = "image" in modalities
    provider = model_id.split(":", 1)[0] if ":" in model_id else "hermes"
    return ModelVisualMetadata(
        engine="hermes",
        model_id=model_id,
        label=label,
        provider=provider,
        input_modalities=modalities,
        supports_image=supports,
        declared_by="hermes_metadata" if (supports is not None or modalities) else "undeclared",
    )


def parse_claude_model_visual(
    option: ModelOption,
    *,
    explicit_supports_image: bool | None = None,
) -> ModelVisualMetadata:
    """Map a Claude Code ``ModelOption``; documented aliases use the adapter's image contract."""
    if explicit_supports_image is not None:
        supports: bool | None = explicit_supports_image
        declared_by = "explicit"
    elif option.id in DOCUMENTED_CLAUDE_IMAGE_MODELS:
        supports = True
        declared_by = "adapter_contract"
    else:
        supports = None
        declared_by = "undeclared"
    modalities = ("text", "image") if supports is True else (("text",) if supports is False else ())
    return ModelVisualMetadata(
        engine="claude_code",
        model_id=option.id,
        label=option.label,
        provider="claude_code",
        input_modalities=modalities,
        supports_image=supports,
        declared_by=declared_by,
    )


def evaluate_visual_capability(
    engine: EngineId,
    model_id: str | None,
    transport: AdapterTransportProbe,
    model_meta: ModelVisualMetadata | None = None,
    *,
    allow_adapter_default_model: bool = False,
) -> VisualCapabilityDecision:
    """Determine whether ``(engine, model_id)`` is verified to accept real image content."""
    if transport.engine != engine:
        raise ValueError(f"Transport probe engine ({transport.engine}) does not match {engine}.")

    if transport.transport_supports_image is not True:
        return VisualCapabilityDecision(
            engine=engine,
            model_id=model_id,
            state="unsupported",
            supported=False,
            transport_supports_image=False,
            model_supports_image=model_meta.supports_image if model_meta else None,
            reason_code="adapter_no_image_transport",
            reason=transport.reason or f"{engine} cannot deliver image content over its current transport.",
            verified_by="transport_probe",
        )

    selected_model_id = model_id.strip() if isinstance(model_id, str) else None
    if not selected_model_id:
        if allow_adapter_default_model and model_meta is not None and model_meta.model_id == "default":
            selected_model_id = "default"
        else:
            return VisualCapabilityDecision(
                engine=engine,
                model_id=model_id,
                state="unverified",
                supported=False,
                transport_supports_image=True,
                model_supports_image=None,
                reason_code="model_not_selected",
                reason="Select an image-capable model explicitly before sending images.",
                verified_by="missing",
            )

    if model_meta is None:
        return VisualCapabilityDecision(
            engine=engine,
            model_id=selected_model_id,
            state="unverified",
            supported=False,
            transport_supports_image=True,
            model_supports_image=None,
            reason_code="model_capability_unverified",
            reason="This model does not declare image input support.",
            verified_by="undeclared",
        )

    if model_meta.engine != engine:
        raise ValueError(f"Model metadata engine ({model_meta.engine}) does not match {engine}.")
    if model_meta.model_id != selected_model_id:
        raise ValueError(f"Model metadata id ({model_meta.model_id}) does not match {selected_model_id}.")

    has_modalities = bool(model_meta.input_modalities)
    modality_image = "image" in model_meta.input_modalities if has_modalities else None

    if model_meta.supports_image is False or modality_image is False:
        return VisualCapabilityDecision(
            engine=engine,
            model_id=selected_model_id,
            state="unsupported",
            supported=False,
            transport_supports_image=True,
            model_supports_image=False,
            reason_code="model_no_image_input",
            reason=f"Model {model_meta.label} does not accept image input.",
            verified_by=model_meta.declared_by,
        )

    if model_meta.supports_image is True or modality_image is True:
        return VisualCapabilityDecision(
            engine=engine,
            model_id=selected_model_id,
            state="supported",
            supported=True,
            transport_supports_image=True,
            model_supports_image=True,
            reason_code=None,
            reason=None,
            verified_by=model_meta.declared_by,
        )

    return VisualCapabilityDecision(
        engine=engine,
        model_id=selected_model_id,
        state="unverified",
        supported=False,
        transport_supports_image=True,
        model_supports_image=None,
        reason_code="model_capability_unverified",
        reason=f"Image support for {model_meta.label} could not be verified from its metadata.",
        verified_by=model_meta.declared_by,
    )


def list_compatible_models(
    catalog: Sequence[ModelVisualMetadata],
    transports: Mapping[EngineId, AdapterTransportProbe],
) -> tuple[CompatibleModelHint, ...]:
    """Return models whose adapter transport AND model metadata both verify image support."""
    compatible: list[CompatibleModelHint] = []
    for entry in catalog:
        probe = transports.get(entry.engine)
        if probe is None:
            continue
        decision = evaluate_visual_capability(entry.engine, entry.model_id, probe, entry)
        if decision.supported:
            compatible.append(
                CompatibleModelHint(
                    engine=entry.engine,
                    model_id=entry.model_id,
                    label=entry.label,
                    provider=entry.provider,
                )
            )
    return tuple(compatible)
