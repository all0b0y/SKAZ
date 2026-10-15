"""Test access to the technical sessions a recording or an import runs in.

The HTTP routes that created, listed, read and deleted sessions belonged to the
old interface and are gone. The Knowledge Wiki creates a recording's session
(``LegacySpeech.create_recording_session``) and an import's
(``LegacySpeech.create_import_session``) through the repository, reads them
through the repository and deletes them through ``routes.sessions.delete_session``.
These helpers call exactly those paths, so the recording/import tests keep
exercising the code the product runs.
"""
from __future__ import annotations

from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from starlette.testclient import TestClient

from skaz import repository as repo
from skaz.routes.sessions import delete_session
from skaz.runtime import Runtime
from skaz.schemas import Session


def runtime_of(target: Any) -> Runtime:
    """The runtime behind a TestClient, an ``httpx`` ASGI client, an app or a runtime."""
    if isinstance(target, Runtime):
        return target
    if isinstance(target, FastAPI):
        return target.state.runtime  # type: ignore[no-any-return]
    if isinstance(target, TestClient):
        return runtime_of(target.app)
    if isinstance(target, httpx.AsyncClient):
        transport = target._transport
        assert isinstance(transport, httpx.ASGITransport), transport
        return runtime_of(transport.app)
    raise TypeError(f"No runtime behind {target!r}")


def create_session(target: Any, title: str = "Untitled session") -> str:
    """A recording's technical session, created the way the Knowledge Wiki recorder creates it."""
    return repo.create_session(runtime_of(target).db, title.strip() or "Untitled session", "legacy").id


def create_import_session(target: Any, title: str) -> str:
    """An import's technical session, created the way the speech area creates it."""
    return repo.create_session(runtime_of(target).db, title).id


def get_session(target: Any, session_id: str) -> Session | None:
    return repo.get_session(runtime_of(target).db, session_id)


def session_count(target: Any) -> int:
    return len(repo.list_sessions(runtime_of(target).db))


def session_gone(target: Any, session_id: str) -> bool:
    return repo.get_session(runtime_of(target).db, session_id) is None


def session_detail(target: Any, session_id: str) -> dict[str, Any]:
    """The session row and its transcript segments (the session must exist)."""
    runtime = runtime_of(target)
    session = repo.get_session(runtime.db, session_id)
    assert session is not None, f"session {session_id} does not exist"
    return {
        "session": session.model_dump(mode="json"),
        "segments": [segment.model_dump(mode="json")
                     for segment in repo.list_segments(runtime.db, session_id)],
    }


def live_status(target: Any, session_id: str) -> dict[str, Any]:
    """What the recorder's background worker is doing for one session (runtime state, read-only)."""
    runtime = runtime_of(target)
    stream = runtime.native_streams.get(session_id)
    return {
        "state": stream.state if stream is not None else "inactive",
        "attempt": stream.recovery.attempt if stream is not None else 0,
        "processing": bool(stream and stream.processing),
        "background_sessions": [sid for sid, worker in runtime.native_streams.items() if worker.processing],
        "incomplete": runtime.live_store.last_incomplete(session_id),
        "buffered_audio_ms": (stream.buffer.size_bytes * 500 // stream.connection.sample_rate
                              if stream is not None else 0),
    }


def delete(http: TestClient, session_id: str) -> None:
    """Delete on the app's own event loop, as the speech area does (``LegacySpeech.delete_session``)."""
    assert http.portal is not None, "use the TestClient as a context manager"
    http.portal.call(delete_session, session_id, runtime_of(http))


async def adelete(target: Any, session_id: str) -> None:
    await delete_session(session_id, runtime_of(target))


def delete_status(http: TestClient, session_id: str) -> int:
    """Delete like ``delete`` and report the outcome as the HTTP status the app gives it."""
    try:
        delete(http, session_id)
    except HTTPException as error:
        return error.status_code
    return 200


async def adelete_status(target: Any, session_id: str) -> tuple[int, str]:
    """Delete like ``adelete``; the outcome as (HTTP status, detail) the app gives it."""
    try:
        await adelete(target, session_id)
    except HTTPException as error:
        return error.status_code, str(error.detail)
    return 200, ""

