#!/usr/bin/env python3
"""User-invoked paid Soniox smoke over a saved PCM16 mono WAV.

This script deliberately shares the production gateway.  The agent may exercise
``--help`` and ``--validate-only``; only a user should pass ``--allow-paid-api``.
Transcript content is written only to the explicitly selected report path.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import sys
import time
import wave
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BACKEND_SRC = ROOT / "backend" / "src"
if str(BACKEND_SRC) not in sys.path:
    sys.path.insert(0, str(BACKEND_SRC))

from audiohelper.gateways.soniox import (  # noqa: E402
    DEFAULT_MODEL,
    SonioxCompletion,
    SonioxConfig,
    SonioxEvent,
    SonioxGateway,
    SonioxGatewayError,
    SonioxSession,
)

DEFAULT_FRAME_MS = 100
API_KEY_ENV = "SONIOX_API_KEY"


class SmokeInputError(ValueError):
    """The saved audio or command-line safety contract is invalid."""


@dataclass(frozen=True)
class WavInfo:
    path: Path
    sample_rate: int
    frame_count: int
    duration_ms: int
    sha256: str


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=(
            "Stream a saved PCM16 mono WAV through the production Soniox gateway. "
            "This can incur provider charges."
        )
    )
    result.add_argument("audio", type=Path, nargs="?", help="saved PCM16 mono WAV")
    result.add_argument(
        "--output", type=Path, help="local JSON report path (may contain transcript)"
    )
    result.add_argument(
        "--model", default=DEFAULT_MODEL, help="explicit Soniox real-time model ID"
    )
    result.add_argument(
        "--frame-ms",
        type=int,
        default=DEFAULT_FRAME_MS,
        help="streaming frame duration; default: 100",
    )
    result.add_argument(
        "--validate-only",
        action="store_true",
        help="validate local WAV metadata without credentials or network",
    )
    result.add_argument(
        "--allow-paid-api",
        action="store_true",
        help="required opt-in before credential lookup or provider connection",
    )
    return result


def inspect_wav(path: Path) -> WavInfo:
    try:
        with wave.open(str(path), "rb") as audio:
            channels = audio.getnchannels()
            sample_width = audio.getsampwidth()
            compression = audio.getcomptype()
            sample_rate = audio.getframerate()
            frame_count = audio.getnframes()
    except (FileNotFoundError, IsADirectoryError, wave.Error, OSError) as error:
        raise SmokeInputError("audio must be a readable PCM16 mono WAV") from error
    if channels != 1 or sample_width != 2 or compression != "NONE":
        raise SmokeInputError("audio must be a PCM16 mono WAV")
    config = SonioxConfig(sample_rate=sample_rate)
    if frame_count <= 0:
        raise SmokeInputError("audio WAV must contain at least one PCM frame")
    return WavInfo(
        path=path,
        sample_rate=config.sample_rate,
        frame_count=frame_count,
        duration_ms=round(frame_count * 1_000 / sample_rate),
        sha256=_sha256(path),
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(64 * 1_024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validated_frame_ms(value: int, sample_rate: int) -> int:
    if isinstance(value, bool) or not 20 <= value <= 1_000:
        raise SmokeInputError("--frame-ms must be between 20 and 1000")
    samples = sample_rate * value / 1_000
    if not samples.is_integer():
        raise SmokeInputError("--frame-ms must produce a whole number of PCM samples")
    return value


async def _consume_events(
    session: SonioxSession,
    *,
    started: float,
    report: dict[str, Any],
) -> None:
    final_parts: list[str] = []
    event_records: list[dict[str, Any]] = []
    first_partial_s: float | None = None
    first_final_s: float | None = None
    report["events"] = event_records
    async for event in session.events():
        elapsed = time.monotonic() - started
        if event.partial_tokens and first_partial_s is None:
            first_partial_s = elapsed
        if event.final_tokens and first_final_s is None:
            first_final_s = elapsed
        final_delta = "".join(token.text for token in event.final_tokens)
        partial = "".join(token.text for token in event.partial_tokens)
        final_parts.append(final_delta)
        event_records.append(_event_record(event, elapsed, final_delta, partial))
        # Preserve evidence incrementally even when the sender fails and cancels
        # this consumer before the event iterator reaches its normal end.
        report["final_text"] = "".join(final_parts)
        report["timing_s"]["first_partial"] = _rounded(first_partial_s)
        report["timing_s"]["first_final"] = _rounded(first_final_s)


def _event_record(
    event: SonioxEvent, elapsed: float, final_delta: str, partial: str
) -> dict[str, Any]:
    return {
        "elapsed_s": round(elapsed, 3),
        "final_delta": final_delta,
        "partial_replacement": partial,
        "final_tokens": [asdict(token) for token in event.final_tokens],
        "partial_tokens": [asdict(token) for token in event.partial_tokens],
        "markers": list(event.markers),
        "final_audio_proc_ms": event.final_audio_proc_ms,
        "total_audio_proc_ms": event.total_audio_proc_ms,
        "finished": event.finished,
    }


def _rounded(value: float | None) -> float | None:
    return None if value is None else round(value, 3)


async def _stream(
    info: WavInfo,
    *,
    model: str,
    frame_ms: int,
    api_key: str,
    report: dict[str, Any],
) -> SonioxCompletion:
    gateway = SonioxGateway(
        api_key=api_key,
        config=SonioxConfig(sample_rate=info.sample_rate, model=model),
    )
    session = await gateway.open()
    started = time.monotonic()
    report["timing_s"] = {
        "first_partial": None,
        "first_final": None,
        "finished": None,
        "wall": None,
    }
    consumer = asyncio.create_task(
        _consume_events(session, started=started, report=report), name="smoke-events"
    )
    samples_per_frame = info.sample_rate * frame_ms // 1_000
    try:
        with wave.open(str(info.path), "rb") as audio:
            sent_samples = 0
            while True:
                frame = audio.readframes(samples_per_frame)
                if not frame:
                    break
                target = started + sent_samples / info.sample_rate
                delay = target - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
                await session.send_audio(frame)
                sent_samples += len(frame) // 2
        completion = await session.finish()
        await asyncio.wait_for(consumer, timeout=1.0)
    except BaseException:
        # Closing ends the iterator without discarding already queued events.
        await session.aclose()
        try:
            await asyncio.wait_for(consumer, timeout=1.0)
        except (asyncio.CancelledError, TimeoutError):
            consumer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await consumer
        raise
    finished = time.monotonic() - started
    report["timing_s"]["finished"] = round(finished, 3) if completion.finished else None
    report["timing_s"]["wall"] = round(finished, 3)
    return completion


def _base_report(info: WavInfo, *, model: str, frame_ms: int) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "scope": "saved WAV through production Soniox real-time gateway; not microphone acceptance",
        "provider": "soniox",
        "model": model,
        "input_sha256": info.sha256,
        "input_duration_ms": info.duration_ms,
        "sample_rate": info.sample_rate,
        "frame_ms": frame_ms,
        "cost_usd": None,
        "quality_metrics": None,
        "events": [],
        "final_text": "",
        "completion": None,
        "errors": [],
        "timing_s": {
            "first_partial": None,
            "first_final": None,
            "finished": None,
            "wall": None,
        },
    }


def _write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    path.write_text(encoded, encoding="utf-8")


async def run(args: argparse.Namespace) -> int:
    if args.audio is None:
        raise SmokeInputError("audio path is required")
    info = inspect_wav(args.audio)
    frame_ms = _validated_frame_ms(args.frame_ms, info.sample_rate)
    if args.validate_only:
        print(
            f"valid PCM16 mono WAV: {info.sample_rate} Hz, "
            f"{info.duration_ms} ms, sha256={info.sha256}"
        )
        return 0

    # Consent gates both credential lookup and all networking.
    if not args.allow_paid_api:
        raise SmokeInputError(
            "--allow-paid-api is required before credentials or network access"
        )
    if args.output is None:
        raise SmokeInputError("--output is required for a paid run")
    if args.output.resolve() == info.path.resolve():
        raise SmokeInputError("--output must not overwrite the input WAV")
    api_key = os.environ.get(API_KEY_ENV)
    if not api_key:
        raise SmokeInputError(f"{API_KEY_ENV} is not set")

    report = _base_report(info, model=args.model, frame_ms=frame_ms)
    try:
        completion = await _stream(
            info,
            model=args.model,
            frame_ms=frame_ms,
            api_key=api_key,
            report=report,
        )
        report["completion"] = asdict(completion)
        if not completion.finished and completion.error is not None:
            report["errors"].append(completion.error)
    except (SonioxGatewayError, ValueError) as error:
        report["errors"].append(str(error))
    except (OSError, TimeoutError):
        report["errors"].append(
            "The local smoke run failed before Soniox confirmed completion."
        )
    _write_report(args.output, report)
    print(f"Report written to {args.output}")
    return 0 if not report["errors"] else 1


def main() -> int:
    args = parser().parse_args()
    try:
        return asyncio.run(run(args))
    except SmokeInputError as error:
        parser().error(str(error))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
