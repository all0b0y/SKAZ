"""Local PCM WebSocket intake with independent Soniox forwarding.

Only Electron main should connect. An ACK means the PCM and metadata were saved,
not that an ASR provider received or transcribed them.
"""
from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import sqlite3
import struct
from contextlib import suppress
from typing import Any, Literal

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .. import repository as repo
from ..gateways.soniox import DEFAULT_MODEL
from ..live_store import LiveConflict, LiveConnection
from ..native_io import disk_call, drain_on_cancel
from ..native_stream import NativeStream
from ..runtime import Runtime
from ..security import local_access_error

router = APIRouter(prefix="/sessions")
HEADER = struct.Struct("!QQI")
MAX_MESSAGE_BYTES = HEADER.size + 48_000  # 500ms PCM16 mono at 48kHz
MAX_INTEGER = 2**63 - 1


class OpenStream(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["open"]
    sample_rate: int = Field(ge=8000, le=48000)
    audio_format: Literal["pcm_s16le"] = "pcm_s16le"
    num_channels: Literal[1] = 1


class EndStream(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["end"]
    action: Literal["pause", "stop"] = "stop"


def _authorized(socket: WebSocket, runtime: Runtime) -> bool:
    scheme, _, token = socket.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(
        token.strip().encode(), runtime.config.token.encode()
    ):
        return False
    try:
        return (
            socket.client is not None
            and ipaddress.ip_address(socket.client.host).is_loopback
            and local_access_error(socket, runtime.config) is None
        )
    except ValueError:
        return False


def _decode_audio(data: bytes) -> tuple[int, int, bytes]:
    if not HEADER.size < len(data) <= MAX_MESSAGE_BYTES:
        raise LiveConflict("Audio message exceeds the allowed size or is empty.")
    sequence, start_sample, sample_count = HEADER.unpack_from(data)
    pcm = data[HEADER.size:]
    if len(pcm) != sample_count * 2 or max(sequence, start_sample + sample_count) > MAX_INTEGER:
        raise LiveConflict("Audio message metadata does not match its PCM payload.")
    return sequence, start_sample, pcm


@router.websocket("/{session_id}/live/stream")
async def receive_live_audio(socket: WebSocket, session_id: str) -> None:
    runtime: Runtime = socket.app.state.runtime
    if not _authorized(socket, runtime) or await disk_call(repo.get_session, runtime.db, session_id) is None:
        await socket.close(code=1008)
        return
    await socket.accept()
    connection: LiveConnection | None = None
    stream: NativeStream | None = None
    end_state: Literal["paused", "stopped"] = "stopped"
    disconnected = False
    settled = False
    failure: asyncio.Task[None] | None = None
    incoming: asyncio.Task[Any] | None = None
    try:
        async with asyncio.timeout(5):
            opening = await socket.receive()
        if opening["type"] == "websocket.disconnect":
            disconnected = True
            return
        raw = opening.get("text")
        if not isinstance(raw, str) or len(raw.encode()) > 4096:
            raise LiveConflict("Stream configuration must be a bounded text message.")
        config = OpenStream.model_validate_json(raw)
        if (runtime.native_shutdown or session_id in runtime.native_closing
                or session_id in runtime.native_tasks):
            raise LiveConflict("Session is closing.")
        task = asyncio.current_task()
        assert task is not None
        # Reserve ownership before the first disk await (including open).
        runtime.native_tasks[session_id] = (task, asyncio.Event())

        async def open_storage() -> None:
            nonlocal connection
            connection = await disk_call(
                runtime.live_store.open, session_id, sample_rate=config.sample_rate, model=DEFAULT_MODEL,
                recording_mode=("transcription" if not runtime.live_store.retain_audio
                                and settings.native_recording_mode == "audio_only"
                                else settings.native_recording_mode),
                translation_target_language=settings.translation_target_language,
                used_languages=(tuple(settings.used_languages)
                                if settings.used_languages is not None else None),
            )
            await disk_call(repo.update_session, runtime.db, session_id, status="recording")

        async with runtime.native_settings_lock:
            settings = await disk_call(runtime.settings_store.load)
            await drain_on_cancel(open_storage())
            assert connection is not None
            key = (
                await disk_call(runtime.api_key, "soniox")
                if settings.cloud_consent and connection.recording_mode != "audio_only" else None
            )
            stream = NativeStream(runtime.live_store, connection, key)
            runtime.native_streams[session_id] = stream
        saved_samples = connection.start_sample
        await socket.send_json({
            "type": "stream.opened", "connection_id": connection.id,
            "sample_rate": config.sample_rate, "saved_samples": saved_samples,
            "next_sequence": connection.next_sequence, "transcription": stream.state,
            **({"audio_retained": False} if not runtime.live_store.retain_audio else {}),
        })
        failure = asyncio.create_task(stream.wait_failure())
        while True:
            incoming = asyncio.create_task(socket.receive())
            done, _ = await asyncio.wait((incoming, failure), return_when=asyncio.FIRST_COMPLETED)
            if failure in done:
                failure.result()
                raise LiveConflict("Stream worker ended unexpectedly.")
            message = incoming.result()
            incoming = None
            if message["type"] == "websocket.disconnect":
                disconnected = True
                break
            data = message.get("bytes")
            if data is not None:
                sequence, start_sample, pcm = _decode_audio(data)
                added = await stream.append_audio(
                    sequence=sequence, start_sample=start_sample, pcm=pcm,
                    replay_start_sample=connection.start_sample,
                )
                saved_samples = max(saved_samples, start_sample + len(pcm) // 2)
                await socket.send_json({
                    "type": "audio.saved", "sequence": sequence,
                    "saved_samples": saved_samples, "duplicate": not added,
                })
                continue
            text = message.get("text")
            if not isinstance(text, str) or len(text.encode()) > 4096:
                raise LiveConflict("Invalid stream control message.")
            control = EndStream.model_validate(json.loads(text))
            end_state = "paused" if control.action == "pause" else "stopped"
            failure.cancel()
            await asyncio.gather(failure, return_exceptions=True)
            complete = await stream.finish()
            await disk_call(repo.update_session, runtime.db, session_id, status=end_state)
            await disk_call(runtime.session_files.project, session_id)
            settled = True
            completed_owner = runtime.native_tasks.pop(session_id)
            runtime.native_streams.pop(session_id, None)
            completed_owner[1].set()
            await socket.send_json({
                "type": "stream.stopped", "saved_samples": saved_samples,
                "transcription_complete": complete, "status": end_state,
            })
            break
    except asyncio.CancelledError:
        # Runtime deletion/shutdown waits for this route to release provider tasks.
        pass
    except WebSocketDisconnect:
        disconnected = True
    except (LiveConflict, ValidationError, ValueError, TimeoutError):
        await socket.send_json({"type": "stream.error", "code": "invalid_stream"})
    except (OSError, sqlite3.Error):
        await socket.send_json({"type": "stream.error", "code": "storage_failed"})
    finally:
        async def cleanup() -> None:
            for pending in (incoming, failure):
                if pending is not None:
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
            if connection is not None and not settled:
                # Recovery handles a database which also refuses cleanup writes.
                with suppress(OSError, sqlite3.Error):
                    if stream is not None:
                        await stream.abort()
                    else:
                        await disk_call(runtime.live_store.close, connection.id, finished=False)
                with suppress(OSError, sqlite3.Error):
                    await disk_call(repo.update_session, runtime.db, session_id, status=end_state)

        try:
            with suppress(asyncio.CancelledError):
                await drain_on_cancel(cleanup())
        finally:
            owner = runtime.native_tasks.get(session_id)
            if owner is not None and owner[0] is asyncio.current_task():
                runtime.native_tasks.pop(session_id, None)
                runtime.native_streams.pop(session_id, None)
                owner[1].set()
        if not disconnected:
            await socket.close()
