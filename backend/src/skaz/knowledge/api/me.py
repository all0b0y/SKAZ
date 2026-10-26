"""``/kb/me``: the user's «Я» (Me) — skills, versions, restore and Undo of an agent's edit (N6).

Route contract: ``.dev/docs/backlog-2026-10-26/N6-ME-API.md``. Errors are the knowledge API shape
(``{"detail": "…", "code": "…"}``): 404 ``not_found``, 422 ``limit_exceeded`` / ``invalid``, 409
``builtin`` (rename / delete a built-in) and ``already_undone``. Texts never go to logs.
"""
from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from ...native_io import disk_call
from ..chats.service import ChatService
from ..errors import KnowledgeError
from ..me import DESCRIPTION_MAX, SKILL_CAP, TITLE_MAX, MeError, MeSkill, MeVersion
from ..me.access import me_store
from ..me.store import MeStore
from ..me.tools import mark_undone

KbMeKind = Literal["profile", "how_to_work", "search", "skill"]
KbMeSource = Literal["agent", "user", "restore"]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KbMeSkill(BaseModel):
    #: ``profile`` | ``how-to-work`` | ``search`` | a user/agent slug (``^[a-z0-9-]{1,48}$``).
    id: str
    kind: KbMeKind
    builtin: bool
    title: str
    #: One line; shown in the agent's skill index.
    description: str
    enabled: bool
    #: Profile and How to work with me: in every chat prompt when enabled.
    always_on: bool
    chars: int
    #: 1400 profile, 2200 how-to-work, null otherwise.
    limit: int | None
    #: Current version (1-based; 0 = never written).
    version: int
    updated_at: str | None


class KbMe(BaseModel):
    #: Master switch: off = nothing of «Я» goes to any agent and its tools refuse.
    enabled: bool
    #: Built-ins first (profile, how-to-work, search), then the others by title.
    skills: list[KbMeSkill]


class KbMeSkillDetail(KbMeSkill):
    text: str


class KbMeVersion(BaseModel):
    version: int
    created_at: str
    source: KbMeSource
    #: Set when the agent wrote it in a chat.
    chat_id: str | None
    summary: str
    chars: int


class KbMeVersions(BaseModel):
    #: Newest first.
    versions: list[KbMeVersion]


class KbMeUpdate(_Request):
    enabled: bool | None = None
    title: str | None = Field(default=None, min_length=1, max_length=TITLE_MAX)
    description: str | None = Field(default=None, max_length=DESCRIPTION_MAX)
    text: str | None = Field(default=None, max_length=SKILL_CAP)


class KbMeCreate(_Request):
    title: str = Field(min_length=1, max_length=TITLE_MAX)
    description: str = Field(max_length=DESCRIPTION_MAX)
    text: str = Field(max_length=SKILL_CAP)


class KbMeSwitch(_Request):
    enabled: bool


class MeRoute(APIRoute):
    """«Я» errors become ``{"detail", "code"}`` JSON with their status."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def guarded(request: Request) -> Response:
            try:
                return await handler(request)
            except MeError as error:
                return JSONResponse(status_code=error.status_code,
                                    content={"detail": error.message, "code": error.code})
            except KnowledgeError as error:
                return JSONResponse(status_code=error.status_code, content={"detail": error.message})

        return guarded


router = APIRouter(prefix="/kb/me", tags=["kb"], route_class=MeRoute)


def get_me(request: Request) -> MeStore:
    return me_store(request.app.state.runtime.kb)


def get_chats(request: Request) -> ChatService:
    return cast(ChatService, request.app.state.runtime.kb_chats)


MeDep = Annotated[MeStore, Depends(get_me)]
ChatsDep = Annotated[ChatService, Depends(get_chats)]


def _skill(skill: MeSkill) -> KbMeSkill:
    return KbMeSkill(id=skill.id, kind=skill.kind, builtin=skill.builtin, title=skill.title,
                     description=skill.description, enabled=skill.enabled, always_on=skill.always_on,
                     chars=skill.chars, limit=skill.limit, version=skill.version, updated_at=skill.updated_at)


def _detail(skill: MeSkill) -> KbMeSkillDetail:
    return KbMeSkillDetail(**_skill(skill).model_dump(), text=skill.text)


def _version(item: MeVersion) -> KbMeVersion:
    return KbMeVersion(version=item.version, created_at=item.created_at, source=item.source,
                       chat_id=item.chat_id, summary=item.summary, chars=item.chars)


async def _me(store: MeStore) -> KbMe:
    def read() -> KbMe:
        return KbMe(enabled=store.enabled(), skills=[_skill(skill) for skill in store.skills()])

    return await disk_call(read)


@router.get("")
async def read_me(store: MeDep) -> KbMe:
    return await _me(store)


@router.put("")
async def switch_me(body: KbMeSwitch, store: MeDep) -> KbMe:
    """The master switch: applies from the next answer (a live session gets a note, or is reseeded when it
    holds the profile)."""
    await disk_call(store.set_enabled, body.enabled)
    return await _me(store)


@router.get("/skills/{skill_id}")
async def read_skill(skill_id: str, store: MeDep) -> KbMeSkillDetail:
    return _detail(await disk_call(store.skill, skill_id))


@router.put("/skills/{skill_id}")
async def update_skill(skill_id: str, body: KbMeUpdate, store: MeDep) -> KbMeSkillDetail:
    """A text change is a new version (source ``user``); built-ins keep their titles (409)."""
    return _detail(await disk_call(store.update, skill_id, enabled=body.enabled, title=body.title,
                                   description=body.description, text=body.text))


@router.post("/skills", status_code=201)
async def create_skill(body: KbMeCreate, store: MeDep) -> KbMeSkillDetail:
    return _detail(await disk_call(store.create, body.title, body.description, body.text))


@router.delete("/skills/{skill_id}", status_code=204)
async def delete_skill(skill_id: str, store: MeDep) -> Response:
    await disk_call(store.delete, skill_id)
    return Response(status_code=204)


@router.get("/skills/{skill_id}/versions")
async def read_versions(skill_id: str, store: MeDep) -> KbMeVersions:
    return KbMeVersions(versions=[_version(item) for item in await disk_call(store.versions, skill_id)])


@router.post("/skills/{skill_id}/versions/{version}/restore")
async def restore_version(skill_id: str, version: int, store: MeDep) -> KbMeSkillDetail:
    return _detail(await disk_call(store.restore, skill_id, version))


@router.post("/edits/{edit_id}/undo")
async def undo_edit(edit_id: str, store: MeDep, chats: ChatsDep) -> KbMeSkillDetail:
    """Undo an agent's change: the skill goes back to the version before it; the chat chip says Undone."""
    skill, edit = await disk_call(store.undo, edit_id)
    await mark_undone(chats, edit)
    return _detail(skill)
