"""Pin only a frame that was prepared for an existing completed answer."""
from __future__ import annotations

from typing import cast

from fastapi import Request
from pydantic import BaseModel, ConfigDict

from ..chats.service import ChatService


class KbAnswerFrame(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    message_id: str
    frame_id: str
    material_id: str
    label: str
    timestamp_ms: int
    pinned: bool


def _chats(request: Request) -> ChatService:
    return cast(ChatService, request.app.state.runtime.kb_chats)


async def list_answer_frames(chat_id: str, request: Request) -> list[KbAnswerFrame]:
    choices = await _chats(request).answer_frames(chat_id)
    return [KbAnswerFrame.model_validate(choice) for choice in choices]


async def pin_answer_frame(chat_id: str, message_id: str, frame_id: str, request: Request) -> KbAnswerFrame:
    item = await _chats(request).pin_answer_frame(chat_id, message_id, frame_id)
    return KbAnswerFrame.model_validate(item)
