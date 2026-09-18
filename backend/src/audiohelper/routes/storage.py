"""Explicit root preference; never a migration or a model operation."""
from __future__ import annotations

import sqlite3
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..native_io import disk_call
from ..storage_root import RootChangeBlocked, StorageRootView
from .deps import RuntimeDep

router = APIRouter(prefix="/storage", tags=["storage"])


class Group(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-f0-9-]{32,36}$")
    name: str = Field(min_length=1, max_length=60)
    tag: str = Field(max_length=32)


class GroupsData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    groups: list[Group] = Field(max_length=200)
    membership: dict[str, str | None]

    @model_validator(mode="after")
    def unique_names(self) -> GroupsData:
        names = [g.name.strip().casefold() for g in self.groups]
        if (len(set(names)) != len(names) or any(n in ("", "all", "ungrouped") for n in names)
                or any(g.tag and not all(ch.isalnum() or ch in "_-" for ch in g.tag) for g in self.groups)):
            raise ValueError("Use unique group names and a single short tag.")
        return self


class GroupsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)
    data: GroupsData


@router.get("/layout")
async def read_layout(rt: RuntimeDep) -> dict[str, Any]:
    return await disk_call(rt.storage.view)


@router.post("/layout")
async def enable_layout(rt: RuntimeDep) -> dict[str, Any]:
    return await disk_call(rt.storage.enable)


@router.put("/groups")
async def update_groups(body: GroupsUpdate, rt: RuntimeDep) -> dict[str, Any]:
    return await disk_call(rt.storage.update_groups, body.data.model_dump(), body.expected_revision)


@router.post("/recover")
async def recover_storage(rt: RuntimeDep) -> dict[str, Any]:
    return await disk_call(rt.storage.recover)


class RootUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    root: str | None = Field(max_length=4096)
    expected_root: str | None = Field(max_length=4096)


class RootMove(BaseModel):
    model_config = ConfigDict(extra="forbid")
    root: str = Field(max_length=4096)
    expected_root: str = Field(max_length=4096)


@router.post("/move-root")
async def move_root(body: RootMove, rt: RuntimeDep) -> dict[str, Any]:
    return await disk_call(rt.storage.move_root, body.root, body.expected_root)


@router.get("/root")
async def read_root(rt: RuntimeDep) -> StorageRootView:
    return await disk_call(rt.session_files.root_settings)


@router.put("/root")
async def update_root(body: RootUpdate, rt: RuntimeDep) -> StorageRootView:
    try:
        return await disk_call(rt.session_files.configure_root, body.root, body.expected_root)
    except RootChangeBlocked as error:
        raise HTTPException(409, "Root is managed, changed, or already used; no files were moved.") from error
    except (OSError, ValueError) as error:
        raise HTTPException(
            422, "Choose an absolute non-linked folder outside private app storage.",
        ) from error
    except sqlite3.Error as error:
        raise HTTPException(503, "Root preference could not be saved; read the current setting.") from error
