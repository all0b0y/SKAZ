"""Per-adapter transport payload builders for authorized image bytes."""
from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from typing import Any, Literal

from ..knowledge.agents.engine import EngineId
from ..knowledge.markdown.text import format_timestamp
from ..media_source import InvalidMediaSource, video_source
from .authorization import AuthorizedVisualPayload
from .contracts import VisualSourceLocator

DEFAULT_CODEX_MAX_FRAME_BYTES = 4 * 1024 * 1024 - 4096
NDJSON_MAX_FRAME_BYTES = 32 * 1024 * 1024


class VisualAuthorizationError(ValueError):
    """Raised when an adapter payload builder receives unverified or mismatched visual bytes."""


class VisualPayloadTooLargeError(ValueError):
    """Raised when serialized adapter payload exceeds the transport frame limit."""


def frame_timestamp(timestamp_ms: int) -> str:
    return f"{format_timestamp(timestamp_ms)}.{timestamp_ms % 1000:03d}"


def public_frame_source(canonical_url: str) -> str:
    """Publish source identity without the optional unlisted Vimeo access component."""
    source = video_source(canonical_url)
    if source.platform == "vimeo":
        return f"https://vimeo.com/{source.video_id}"
    return source.url


def linked_frame_caption(locator: VisualSourceLocator, visual_id: str) -> str | None:
    if locator.source_kind != "video_link":
        return None
    timestamp = locator.timestamp_ms
    if timestamp is None or timestamp < 0 or not locator.source_url:
        raise VisualAuthorizationError("A linked frame requires its source and actual timestamp.")
    try:
        source = public_frame_source(locator.source_url)
    except InvalidMediaSource as error:
        raise VisualAuthorizationError("A linked frame requires a canonical video source.") from error
    return (
        f"Linked video frame from {source} (material {locator.material_id}), "
        f"actual timestamp {frame_timestamp(timestamp)} ({timestamp} ms). "
        f"Use ⟦frame:{visual_id}⟧ after a claim based on this frame."
    )


def _validate_for_target(
    visuals: Sequence[AuthorizedVisualPayload],
    expected_engine: EngineId,
    expected_model_id: str | None,
) -> None:
    if visuals is None:
        raise VisualAuthorizationError("Visual payload sequence cannot be None.")
    if not visuals:
        return
    if not isinstance(expected_model_id, str) or not expected_model_id.strip():
        raise VisualAuthorizationError(
            f"A selected {expected_engine} model_id is required to serialize visual payloads."
        )
    for item in visuals:
        if not isinstance(item, AuthorizedVisualPayload):
            raise VisualAuthorizationError("Only AuthorizedVisualPayload objects may be sent.")
        if item.engine != expected_engine:
            raise VisualAuthorizationError(
                f"Visual payload was authorized for {item.engine}, not {expected_engine}."
            )
        if item.model_id != expected_model_id:
            raise VisualAuthorizationError(
                f"Visual payload was authorized for model {item.model_id!r}, not {expected_model_id!r}."
            )
        if not item.approved_bytes or item.byte_size != len(item.approved_bytes):
            raise VisualAuthorizationError("Visual payload contains missing or invalid approved bytes.")
        if item.sha256 != hashlib.sha256(item.approved_bytes).hexdigest():
            raise VisualAuthorizationError("Visual payload digest verification failed.")


def _check_ndjson_size(frame: object, limit: int, transport: str) -> None:
    size = len(json.dumps(frame, ensure_ascii=False).encode("utf-8")) + 1
    if size > limit:
        raise VisualPayloadTooLargeError(
            f"{transport} visual frame ({size} bytes) exceeds the transport limit ({limit} bytes)."
        )


def build_codex_turn_input(
    prompt_text: str,
    visuals: Sequence[AuthorizedVisualPayload] = (),
    *,
    model_id: str | None = None,
    max_frame_bytes: int = DEFAULT_CODEX_MAX_FRAME_BYTES,
) -> list[dict[str, Any]]:
    """Build Codex App Server ``turn/start`` ``input`` items with optional authorized images."""
    _validate_for_target(visuals, "codex", model_id)
    items: list[dict[str, Any]] = [{"type": "text", "text": prompt_text, "text_elements": []}]
    for visual in visuals:
        if (caption := linked_frame_caption(visual.locator, visual.visual_id)) is not None:
            items.append({"type": "text", "text": caption, "text_elements": []})
        items.append({
            "type": "image",
            "url": f"data:{visual.media_type};base64,{visual.base64_data()}",
        })
    encoded_size = len(json.dumps(items, ensure_ascii=False).encode("utf-8"))
    if encoded_size > max_frame_bytes:
        raise VisualPayloadTooLargeError(
            f"Codex turn input ({encoded_size} bytes) exceeds limit ({max_frame_bytes} bytes)."
        )
    return items


def build_claude_user_message(
    prompt_text: str,
    visuals: Sequence[AuthorizedVisualPayload] = (),
    *,
    model_id: str | None = None,
    max_frame_bytes: int = NDJSON_MAX_FRAME_BYTES,
) -> dict[str, Any]:
    """Build Claude Code ``stream-json`` stdin user message with optional base64 image blocks."""
    _validate_for_target(visuals, "claude_code", model_id)
    if not visuals:
        content: str | list[dict[str, Any]] = prompt_text
    else:
        content = [{"type": "text", "text": prompt_text}]
        for visual in visuals:
            if (caption := linked_frame_caption(visual.locator, visual.visual_id)) is not None:
                content.append({"type": "text", "text": caption})
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": visual.media_type,
                    "data": visual.base64_data(),
                },
            })
    message = {
        "type": "user",
        "message": {"role": "user", "content": content},
        "parent_tool_use_id": None,
    }
    if visuals:
        _check_ndjson_size(message, max_frame_bytes, "Claude Code")
    return message


def build_acp_prompt_blocks(
    prompt_text: str,
    visuals: Sequence[AuthorizedVisualPayload] = (),
    *,
    engine: Literal["hermes", "opencode"],
    model_id: str | None = None,
    session_id: str = "",
    max_frame_bytes: int = NDJSON_MAX_FRAME_BYTES,
) -> list[dict[str, Any]]:
    """Build ACP ``session/prompt`` ``prompt`` content blocks for Hermes or OpenCode."""
    _validate_for_target(visuals, engine, model_id)
    blocks: list[dict[str, Any]] = [{"type": "text", "text": prompt_text}]
    for visual in visuals:
        if (caption := linked_frame_caption(visual.locator, visual.visual_id)) is not None:
            blocks.append({"type": "text", "text": caption})
        blocks.append({
            "type": "image",
            "data": visual.base64_data(),
            "mimeType": visual.media_type,
        })
    if visuals:
        frame = {
            "jsonrpc": "2.0",
            # Reserve enough space for an ACP connection's request counter.
            "id": 2**63 - 1,
            "method": "session/prompt",
            "params": {"sessionId": session_id, "prompt": blocks},
        }
        _check_ndjson_size(frame, max_frame_bytes, "ACP")
    return blocks
