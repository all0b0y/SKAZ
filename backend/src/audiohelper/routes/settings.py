"""Model profiles and language/consent settings."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..capabilities import IncompatibleProfile, validate_profile
from ..schemas import Settings, SettingsUpdate
from ..settings_store import TASKS, apply_update
from .deps import RuntimeDep

router = APIRouter()


@router.get("/settings")
async def read_settings(runtime: RuntimeDep) -> Settings:
    return runtime.settings_view()


@router.put("/settings")
async def update_settings(payload: SettingsUpdate, runtime: RuntimeDep) -> Settings:
    current = runtime.settings_store.load()
    merged = apply_update(current, payload)
    for task in TASKS:
        if merged.profile(task) == current.profile(task):
            continue
        try:
            await validate_profile(task, merged.profile(task), runtime.catalogs)
        except IncompatibleProfile as error:
            raise HTTPException(status_code=400, detail=f"{task}: {error}") from error
    # Keys are stored outside the database and only after the profile itself is valid.
    for task in TASKS:
        patch = getattr(payload, task)
        if patch is not None and patch.api_key is not None:
            provider = merged.profile(task).provider
            if patch.api_key:
                runtime.secrets.set(provider, patch.api_key)
            else:
                runtime.secrets.delete(provider)
    runtime.settings_store.save(merged)
    return runtime.settings_view(merged)
