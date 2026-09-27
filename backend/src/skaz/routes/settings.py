"""Model profiles and language/consent settings."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException

from ..capabilities import IncompatibleProfile, validate_profile
from ..catalog import ProviderCatalogs
from ..native_io import disk_call, drain_on_cancel
from ..schemas import Settings, SettingsUpdate
from ..secrets import MemorySecretStore
from ..settings_store import TASKS, apply_update
from .deps import RuntimeDep

router = APIRouter()


@router.get("/settings")
async def read_settings(runtime: RuntimeDep) -> Settings:
    return runtime.settings_view()


@router.put("/settings")
async def update_settings(payload: SettingsUpdate, runtime: RuntimeDep) -> Settings:
    # Serialize read/validate/write with native open: an older unrelated settings
    # request must not restore consent from a snapshot taken before revocation.
    async with runtime.native_settings_lock:
        return await _update_settings(payload, runtime)


async def _update_settings(payload: SettingsUpdate, runtime: RuntimeDep) -> Settings:
    current = runtime.settings_store.load()
    merged = apply_update(current, payload)
    # Keys are provider-scoped: a credential is written for a provider regardless of
    # which task (if any) currently uses it, so a key can be saved ahead of assignment.
    key_updates: dict[str, str] = {
        provider: secret.get_secret_value()
        for provider, secret in (payload.provider_keys or {}).items()
    }
    catalogs = runtime.catalogs
    if key_updates:
        # Request-local credentials: validate with the proposed key without changing
        # the live store (or credentials observed by concurrent requests).
        candidates = MemorySecretStore(key_updates)
        for provider in {merged.profile(task).provider for task in TASKS} - key_updates.keys():
            value = runtime.secrets.get(provider)
            if value:
                candidates.set(provider, value)
        catalogs = ProviderCatalogs(runtime.http, candidates, runtime.config.data_dir)
    for task in TASKS:
        if merged.profile(task) == current.profile(task):
            continue
        try:
            await validate_profile(task, merged.profile(task), catalogs)
        except IncompatibleProfile as error:
            raise HTTPException(status_code=400, detail=f"{task}: {error}") from error
    async def save_and_revoke() -> None:
        remove_soniox = False
        try:
            # All credential writes are off-loop and cancellation-drained. Once
            # Soniox is deleted, a later provider/DB failure must still revoke it.
            for provider, value in key_updates.items():
                try:
                    if value:
                        await disk_call(runtime.secrets.set, provider, value)
                    else:
                        await disk_call(runtime.secrets.delete, provider)
                        remove_soniox = remove_soniox or provider == "soniox"
                except Exception:
                    raise HTTPException(
                        status_code=503, detail="Could not update the provider key in secure storage."
                    ) from None
            await disk_call(runtime.settings_store.save, merged)
        finally:
            # Key removal must close cloud work even if the subsequent DB write fails.
            if not merged.cloud_consent or remove_soniox:
                await asyncio.gather(*(
                    stream.disable_provider() for stream in list(runtime.native_streams.values())
                ))

    # Cancellation after the durable write must still complete cloud shutdown
    # before releasing the lock to a new native open or settings update.
    await drain_on_cancel(save_and_revoke())
    return runtime.settings_view(merged)
