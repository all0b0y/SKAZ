"""Live acceptance run against the real backend process and real providers.

No mocks: starts nothing itself, talks HTTP to a backend that is already running,
uploads real recorded speech, asks a temporal question, writes notes and measures
how long each step took. Requires OPENROUTER_API_KEY in the environment.

The ASR default is OpenRouter's **dedicated** speech-to-text contract
(POST /api/v1/audio/transcriptions). Override the models without editing this file:

    AUDIOHELPER_LIVE_ASR_MODEL=<id>    # must be an audio->transcription model
    AUDIOHELPER_LIVE_TEXT_MODEL=<id>

Usage: python scripts/live_check.py <base_url> <token> <wav_path>
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import wave
from pathlib import Path
from typing import Any

import httpx

#: Dedicated OpenRouter STT model; catalog pricing is 0.0000075 USD/second.
ASR_MODEL = os.environ.get("AUDIOHELPER_LIVE_ASR_MODEL", "qwen/qwen3-asr-1.7b")
TEXT_MODEL = os.environ.get("AUDIOHELPER_LIVE_TEXT_MODEL", "qwen/qwen3-30b-a3b-instruct-2507")


def wav_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as handle:
        return round(handle.getnframes() * 1000 / handle.getframerate())


async def main(base_url: str, token: str, wav_path: Path) -> int:
    audio = wav_path.read_bytes()
    duration = wav_duration_ms(wav_path)
    report: dict[str, Any] = {"audio": {"path": str(wav_path), "duration_ms": duration}, "steps": []}

    def step(name: str, started: float, response: httpx.Response) -> Any:
        payload = response.json() if response.content else None
        report["steps"].append(
            {
                "step": name,
                "status": response.status_code,
                "seconds": round(time.perf_counter() - started, 3),
                "body": payload,
            }
        )
        return payload

    async with httpx.AsyncClient(
        base_url=base_url, headers={"Authorization": f"Bearer {token}"}, timeout=180.0
    ) as client:
        started = time.perf_counter()
        step("health", started, await client.get("/health"))

        # Provenance: which ASR contract the chosen model actually implements.
        started = time.perf_counter()
        catalog = step(
            "asr_catalog",
            started,
            await client.get("/models", params={"provider": "openrouter", "task": "asr"}),
        )
        models = (catalog or {}).get("models", [])
        chosen = next((model for model in models if model["id"] == ASR_MODEL), None)
        report["asr_contract"] = {
            "model": ASR_MODEL,
            "in_catalog": chosen is not None,
            "contract": (chosen or {}).get("asr_contract"),
            "pricing": (chosen or {}).get("pricing"),
            "dedicated_available": sum(1 for m in models if m.get("asr_contract") == "dedicated"),
            "legacy_available": sum(1 for m in models if m.get("asr_contract") == "legacy"),
        }
        if chosen is not None and chosen.get("asr_contract") != "dedicated":
            print(
                f"WARNING: '{ASR_MODEL}' is a {chosen.get('asr_contract')} audio-input chat model, "
                "not a dedicated speech-to-text contract. It can never be marked ASR-verified.",
                file=sys.stderr,
            )

        started = time.perf_counter()
        step(
            "settings",
            started,
            await client.put(
                "/settings",
                json={
                    "asr": {"provider": "openrouter", "model": ASR_MODEL},
                    "agent": {"provider": "openrouter", "model": TEXT_MODEL},
                    "notes": {"provider": "openrouter", "model": TEXT_MODEL},
                    "output_language": "en",
                    "cloud_consent": True,
                },
            ),
        )

        started = time.perf_counter()
        session = step(
            "create_session", started, await client.post("/sessions", json={"title": "Live check"})
        )
        session_id = session["id"]

        started = time.perf_counter()
        first = step(
            "transcribe_chunk_0",
            started,
            await client.post(
                f"/sessions/{session_id}/audio",
                params={"sequence": 0, "start_ms": 0, "end_ms": duration},
                content=audio,
                headers={"Content-Type": "audio/wav"},
            ),
        )

        # Concurrency: a question and a second chunk are in flight at the same time.
        started = time.perf_counter()
        question = asyncio.create_task(
            client.post(
                f"/sessions/{session_id}/ask",
                json={"question": "What did the speaker ask the audience to do?", "window_minutes": 5},
            )
        )
        chunk_task = asyncio.create_task(
            client.post(
                f"/sessions/{session_id}/audio",
                params={"sequence": 1, "start_ms": duration, "end_ms": duration * 2},
                content=audio,
                headers={"Content-Type": "audio/wav"},
            )
        )
        ask_response, chunk_response = await asyncio.gather(question, chunk_task)
        step("ask_concurrent", started, ask_response)
        step("transcribe_chunk_1_concurrent", started, chunk_response)

        started = time.perf_counter()
        step(
            "ask_beginning",
            started,
            await client.post(
                f"/sessions/{session_id}/ask",
                json={"question": "What was said at the very beginning of the recording?"},
            ),
        )

        started = time.perf_counter()
        step(
            "ask_missing_topic",
            started,
            await client.post(
                f"/sessions/{session_id}/ask",
                json={"question": "When did we discuss the quarterly cloud migration budget?"},
            ),
        )

        started = time.perf_counter()
        step("notes", started, await client.post(f"/sessions/{session_id}/notes", json={"language": "en"}))

        started = time.perf_counter()
        step("stop", started, await client.patch(f"/sessions/{session_id}", json={"status": "stopped"}))

        started = time.perf_counter()
        playback = await client.get(f"/sessions/{session_id}/audio/0")
        report["steps"].append(
            {
                "step": "playback",
                "status": playback.status_code,
                "seconds": round(time.perf_counter() - started, 3),
                "bytes_identical": playback.content == audio,
            }
        )

        started = time.perf_counter()
        after = step("settings_after", started, await client.get("/settings"))

    report["first_transcript"] = [segment["text"] for segment in (first or {}).get("segments", [])]
    report["verification"] = {
        task: {
            "model": (after or {}).get(task, {}).get("model"),
            "verified": (after or {}).get(task, {}).get("verified"),
            "note": (after or {}).get(task, {}).get("verification_note"),
        }
        for task in ("asr", "agent", "notes")
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if all(item["status"] < 400 for item in report["steps"]) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1], sys.argv[2], Path(sys.argv[3]))))
