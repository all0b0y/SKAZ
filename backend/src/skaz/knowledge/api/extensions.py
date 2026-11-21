"""Authenticated desktop routes. The chat's per-run MCP bearer never authorizes these settings."""

from __future__ import annotations

from typing import Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from ...native_io import disk_call
from ..extensions.service import Extensions
from .chats import ChatRoute


class KbExternalTool(BaseModel):
    name: str
    description: str = ""
    inputSchema: dict[str, Any] = Field(default_factory=dict)


class KbToolSource(BaseModel):
    kind: Literal["mcp", "skill"]
    name: str
    recipient: str | None = None
    tools: list[KbExternalTool] = Field(default_factory=list)
    trust: Literal["local", "verified", "unverified"] | None = None
    warning: str | None = None
    publisher: str | None = None
    version: str | None = None


class KbExternalItem(KbToolSource):
    id: str
    url: str | None = None
    active: bool
    built_in: bool = False


class KbToolsSettings(BaseModel):
    mcp: list[KbExternalItem]
    skills: list[KbExternalItem]


class KbCheckSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["mcp", "skill"]
    url: str = Field(min_length=1, max_length=4096)


class KbCheckedSource(KbToolSource):
    check_id: str


class KbConnectSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=1, max_length=4096)
    check_id: str = Field(min_length=1, max_length=120)
    acknowledge_unverified: bool = False


class KbSetToolActive(BaseModel):
    model_config = ConfigDict(extra="forbid")
    active: bool


class KbLocalResultFile(BaseModel):
    id: str
    name: str
    mime_type: str
    size: int
    data: str


def extensions(request: Request) -> Extensions:
    return cast(Extensions, request.app.state.runtime.kb_extensions)


Ext = Annotated[Extensions, Depends(extensions)]
router = APIRouter(prefix="/kb", tags=["kb"], route_class=ChatRoute)


@router.get("/settings/tools")
async def list_tools(service: Ext) -> KbToolsSettings:
    return KbToolsSettings.model_validate(await disk_call(service.settings_view))


@router.post("/settings/tools/check")
async def check_source(body: KbCheckSource, service: Ext) -> KbCheckedSource:
    return KbCheckedSource.model_validate(await service.check(body.kind, body.url))


@router.post("/settings/tools", status_code=201)
async def add_source(body: KbConnectSource, service: Ext) -> KbExternalItem:
    return KbExternalItem.model_validate(
        await service.add(body.url, body.check_id, body.acknowledge_unverified)
    )


@router.patch("/settings/tools/{item_id}")
async def set_active(item_id: str, body: KbSetToolActive, service: Ext) -> KbExternalItem:
    return KbExternalItem.model_validate(await disk_call(service.toggle, item_id, body.active))


@router.post("/settings/tools/{item_id}/refresh")
async def refresh_tools(item_id: str, service: Ext) -> KbExternalItem:
    return KbExternalItem.model_validate(await service.refresh_mcp(item_id))


@router.delete("/settings/tools/{item_id}", status_code=204)
async def remove_source(item_id: str, service: Ext) -> None:
    await disk_call(service.remove, item_id)


@router.get("/chats/{chat_id}/messages/{message_id}/files/{file_id}")
async def read_file(chat_id: str, message_id: str, file_id: str, service: Ext) -> KbLocalResultFile:
    return KbLocalResultFile.model_validate(await disk_call(service.file, chat_id, message_id, file_id))
