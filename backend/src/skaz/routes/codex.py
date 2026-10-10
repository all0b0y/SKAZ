"""Authenticated native API for the explicitly enabled Codex assistant."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, HTTPException

from .. import note_store
from ..agent.codex_runtime import LargeTaskConfirmation
from ..codex_schemas import (
    CodexSettings,
    Confirmation,
    Consent,
    CreateChat,
    GenerateNote,
    SendMessage,
    UpdateChat,
)
from ..native_io import disk_call
from .deps import RuntimeDep

router = APIRouter(prefix="/codex")


@contextmanager
def errors() -> Iterator[None]:
    try:
        yield
    except LargeTaskConfirmation as e:
        raise HTTPException(status_code=428, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except (OSError, RuntimeError) as e:
        raise HTTPException(status_code=503, detail="Codex operation failed; nothing retried") from e


@router.get("/state")
async def state(runtime: RuntimeDep, session_id: str | None = None) -> dict[str, Any]:
    service = runtime.codex
    return {
        "chats": await disk_call(service.chats.list, session_id) if session_id else [],
        "selected_chat_id": await disk_call(service.chats.selected, session_id) if session_id else None,
        "group_scope": await disk_call(service.chats.group_scope, session_id) if session_id else None,
        "tasks": await disk_call(service.task_views),
        "settings": await disk_call(service.settings),
        "connection": dict(service.connection.view),
        "agent": await disk_call(service.agent_view),
    }


@router.get("/chats/{chat_id}")
async def chat_detail(chat_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        service = runtime.codex
        return {
            "chat": await disk_call(service.chats.get, chat_id),
            "messages": await disk_call(service.messages, chat_id),
            "tasks": await disk_call(service.task_views, chat_id),
        }


@router.get("/previews")
async def previews(chat_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        return {"previews": await disk_call(runtime.codex.previews, chat_id)}


@router.post("/previews/{preview_id}/discard")
async def discard(preview_id: str, runtime: RuntimeDep) -> dict[str, bool]:
    with errors():
        await disk_call(runtime.codex.apply_preview, preview_id, apply=False)
        return {"deleted": True}


@router.get("/settings")
async def settings(runtime: RuntimeDep) -> dict[str, Any]:
    return await disk_call(runtime.codex.settings)


@router.put("/settings")
async def configure(payload: CodexSettings, runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        return await runtime.codex.configure(payload)


@router.get("/connection")
async def connection(runtime: RuntimeDep) -> dict[str, Any]:
    return dict(runtime.codex.connection.view)


@router.post("/connection/check")
async def check(runtime: RuntimeDep) -> dict[str, Any]:
    return await runtime.codex.connection.check()


@router.post("/connection/login")
async def login(payload: Consent, runtime: RuntimeDep) -> dict[str, str]:
    with errors():
        return {"auth_url": await runtime.codex.connection.login(payload.consent)}


@router.post("/connection/logout")
async def logout(runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        return await runtime.codex.logout()


@router.get("/chats")
async def chats(session_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        return {
            "chats": await disk_call(runtime.codex.chats.list, session_id),
            "selected_chat_id": await disk_call(runtime.codex.chats.selected, session_id),
            "group_scope": await disk_call(runtime.codex.chats.group_scope, session_id),
        }


@router.post("/chats")
async def create_chat(payload: CreateChat, runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        return await disk_call(runtime.codex.chats.create, payload.session_id, payload.scope)


@router.patch("/chats/{chat_id}")
async def update_chat(chat_id: str, payload: UpdateChat, runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        if payload.title is not None:
            await disk_call(runtime.codex.chats.rename, chat_id, payload.title)
        if payload.scope is not None:
            await disk_call(runtime.codex.chats.rescope, chat_id, payload.scope)
        if payload.selected:
            await disk_call(runtime.codex.chats.select, chat_id)
        return await disk_call(runtime.codex.chats.get, chat_id)


@router.delete("/chats/{chat_id}")
async def delete_chat(chat_id: str, runtime: RuntimeDep, confirmed: bool = False) -> dict[str, bool]:
    with errors():
        await runtime.codex.delete_chat(chat_id, confirmed)
        return {"deleted": True}


@router.get("/chats/{chat_id}/messages")
async def messages(chat_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        service = runtime.codex
        return {
            "messages": await disk_call(service.messages, chat_id),
            "tasks": [asdict(t) for t in await disk_call(service.queue.list) if t.chat_id == chat_id],
            "previews": await disk_call(service.previews, chat_id),
        }


@router.post("/chats/{chat_id}/messages")
async def send(chat_id: str, payload: SendMessage, runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        return await runtime.codex.send(chat_id, payload.question, confirmed=payload.confirmed_large)


@router.get("/tasks")
async def tasks(runtime: RuntimeDep) -> dict[str, Any]:
    return {"tasks": [asdict(t) for t in await disk_call(runtime.codex.queue.list)]}


@router.post("/tasks/{task_id}/stop")
async def stop(task_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        await runtime.codex.dispatcher.stop(task_id)
        return await disk_call(runtime.codex.task_view, await disk_call(runtime.codex.queue.get, task_id))


@router.post("/tasks/{task_id}/resume")
async def resume(task_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        return await runtime.codex.resume(task_id)


@router.post("/tasks/{task_id}/steer")
async def steer(task_id: str, payload: SendMessage, runtime: RuntimeDep) -> dict[str, bool]:
    with errors():
        task = await disk_call(runtime.codex.queue.get, task_id)
        await disk_call(runtime.codex.chats.authorize, task.chat_id)
        await runtime.codex.dispatcher.steer(task_id, payload.question)
        await disk_call(runtime.codex.chats.append, task.chat_id, "user", payload.question, [])
        return {"accepted": True}


@router.post("/sessions/{session_id}/notes")
async def notes(session_id: str, payload: GenerateNote, runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        return await runtime.codex.notes(session_id, payload.language, payload.detail)


@router.post("/previews/{preview_id}/apply")
async def apply(preview_id: str, payload: Confirmation, runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        if not payload.confirmed:
            raise ValueError("Applying a note revision requires confirmation")
        result = await disk_call(runtime.codex.apply_preview, preview_id, apply=True)
        await disk_call(runtime.session_files.project, result["session_id"])
        notes = await disk_call(note_store.list_notes, runtime.db, result["session_id"])
        return next(n.model_dump() for n in notes if n.id == result["note_id"])


@router.post("/previews/{preview_id}/reject")
async def reject(preview_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    with errors():
        return await disk_call(runtime.codex.apply_preview, preview_id, apply=False)
