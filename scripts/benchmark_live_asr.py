"""Measure Local Whisper live transcription on real speech: WER, latency, CPU and RAM.

Runs the *product* code path (the same decoder, VAD, LocalAgreement session and
optional speaker tracker the app uses) over PCM16 WAV files, fed at real-time pace
the way a microphone would, with the Hugging Face hub forced offline. Nothing is
downloaded: prepare the model in Settings → Transcription (or with the
``/models/local/prepare`` endpoint) first.

For each ``speech.wav`` a reference transcript ``speech.txt`` must sit next to it.
Use real human speech you are allowed to process (for example a Common Voice or
LibriSpeech/Golos clip); synthetic speech is not evidence of quality.

    backend/.venv/bin/python scripts/benchmark_live_asr.py --model small \\
        --language ru ru_sample.wav --language en en_sample.wav

Reported per file:

* ``wer`` — word error rate of the confirmed transcript against the reference,
  case- and punctuation-insensitive;
* ``offline_wer`` — the same audio transcribed in one pass (media-import path);
* ``latency_ms`` — median and p90 of (wall time a word became *confirmed*) minus
  (wall time its audio had been fed), i.e. how long after being spoken a word is
  final; ``first_partial_ms`` — the same for the first provisional text;
* ``cpu_percent`` — process CPU time / wall time (100 % = one core);
* ``peak_rss_mb`` — peak resident memory of the process.

Convert other formats first: ``ffmpeg -i in.m4a -ac 1 -ar 16000 -c:a pcm_s16le out.wav``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import resource
import statistics
import sys
import time
import unicodedata
import wave
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HUB_OFFLINE", "1")  # local mode must never need the network
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend" / "src"))

from skaz.file_asr import transcribe_pcm_file
from skaz.gateways.asr import LocalWhisperTranscriber, load_speaker_embedder
from skaz.gateways.whisper_local import LocalWhisperDecoder, SileroVoiceActivity
from skaz.gateways.whisper_stream import (
    SpeakerTracker,
    StreamResampler,
    StreamSettings,
    WhisperStreamSession,
)

FRAME_S = 0.5


def words(text: str) -> list[str]:
    folded = unicodedata.normalize("NFKC", text).casefold().replace("ё", "е")
    cleaned = "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in folded)
    return cleaned.split()


def wer(reference: str, hypothesis: str) -> float:
    ref, hyp = words(reference), words(hypothesis)
    previous = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        current = [i]
        for j, h in enumerate(hyp, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (r != h)))
        previous = current
    return previous[-1] / max(1, len(ref))


def read_wav(path: Path) -> tuple[int, bytes]:
    with wave.open(str(path), "rb") as handle:
        if handle.getnchannels() != 1 or handle.getsampwidth() != 2:
            raise SystemExit(f"{path}: expected PCM16 mono WAV (see the module docstring).")
        return handle.getframerate(), handle.readframes(handle.getnframes())


def peak_rss_mb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / 1024 / 1024 if sys.platform == "darwin" else peak / 1024


async def live_run(engine: Any, model: str, rate: int, pcm: bytes, language: str,
                   speakers: SpeakerTracker) -> dict[str, Any]:
    session = WhisperStreamSession(
        StreamSettings(sample_rate=rate, label="Local Whisper", used_languages=(language,)),
        decoder=LocalWhisperDecoder(engine, model=model), vad=SileroVoiceActivity(), speakers=speakers,
    )
    started = time.perf_counter()
    confirmed: list[tuple[str, float, float]] = []  # text, audio end (s), wall time confirmed (s)
    first_partial: float | None = None

    async def receive() -> None:
        nonlocal first_partial
        async for event in session.events():
            now = time.perf_counter() - started
            if event.partial_tokens and first_partial is None:
                first_partial = now - event.partial_tokens[0].end_ms / 1000
            confirmed.extend((token.text, token.end_ms / 1000, now) for token in event.final_tokens)

    receiver = asyncio.create_task(receive())
    frame = int(rate * FRAME_S) * 2
    cpu_start = time.process_time()
    for index, offset in enumerate(range(0, len(pcm), frame)):
        # Real-time pace: a frame is sent once its audio would have been spoken.
        await asyncio.sleep(max(0.0, (index + 1) * FRAME_S - (time.perf_counter() - started)))
        await session.send_audio(pcm[offset:offset + frame])
    await session.finish()
    await session.aclose()
    await receiver
    wall = time.perf_counter() - started
    cpu = time.process_time() - cpu_start
    latencies = sorted(max(0.0, when - end) * 1000 for _text, end, when in confirmed)
    return {
        "text": "".join(text for text, _end, _when in confirmed).strip(),
        "latency_ms": {
            "median": round(statistics.median(latencies)) if latencies else None,
            "p90": round(latencies[int(0.9 * (len(latencies) - 1))]) if latencies else None,
        },
        "first_partial_ms": round(first_partial * 1000) if first_partial is not None else None,
        "cpu_percent": round(100 * cpu / wall, 1),
        "failure": session.failure_message,
        "speakers": speakers.speaker_count if speakers.enabled else None,
    }


async def offline_run(engine: Any, model: str, rate: int, pcm: bytes, language: str,
                      speakers: SpeakerTracker, scratch: Path) -> str:
    resampler = StreamResampler(rate)
    path = scratch / "benchmark.s16le"
    path.write_bytes(resampler.feed(pcm))
    try:
        transcript = await transcribe_pcm_file(
            path, decoder=LocalWhisperDecoder(engine, model=model), vad=SileroVoiceActivity(),
            speakers=speakers, languages=(language,), translation_target=None,
        )
    finally:
        path.unlink(missing_ok=True)
    return "".join(token.text for token in transcript.tokens).strip()


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="small")
    parser.add_argument("--cache-dir", type=Path, default=None, help="Hugging Face cache (default: shared)")
    parser.add_argument("--speakers", action="store_true", help="use the downloaded speaker model")
    parser.add_argument("--language", action="append", required=True, help="language of the next file")
    parser.add_argument("files", nargs="+", type=Path)
    args = parser.parse_args()
    if len(args.language) != len(args.files):
        raise SystemExit("Give one --language per file, in the same order.")

    load_started = time.perf_counter()
    engine = LocalWhisperTranscriber(model=args.model, allow_download=False, cache_dir=args.cache_dir)._engine()
    load_s = time.perf_counter() - load_started
    embedder = load_speaker_embedder(cache_dir=args.cache_dir) if args.speakers else None
    results = []
    for language, path in zip(args.language, args.files, strict=True):
        reference = path.with_suffix(".txt").read_text(encoding="utf-8")
        rate, pcm = read_wav(path)
        live = await live_run(engine, args.model, rate, pcm, language, SpeakerTracker(embedder))
        offline = await offline_run(engine, args.model, rate, pcm, language, SpeakerTracker(embedder), path.parent)
        results.append({
            "file": path.name, "language": language, "audio_s": round(len(pcm) / 2 / rate, 1),
            "wer": round(wer(reference, live.pop("text")), 3),
            "offline_wer": round(wer(reference, offline), 3),
            **live,
        })
    report = {
        "model": args.model, "machine": platform.machine(), "system": platform.platform(),
        "processor": platform.processor(), "model_load_s": round(load_s, 1),
        "peak_rss_mb": round(peak_rss_mb()), "results": results,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print("\n| file | lang | audio s | live WER | one-pass WER | confirm latency median / p90 ms "
          "| first partial ms | CPU % |")
    print("|---|---|---|---|---|---|---|---|")
    for row in results:
        print(f"| {row['file']} | {row['language']} | {row['audio_s']} | {row['wer']:.1%} | "
              f"{row['offline_wer']:.1%} | {row['latency_ms']['median']} / {row['latency_ms']['p90']} | "
              f"{row['first_partial_ms']} | {row['cpu_percent']} |")
    print(f"\nPeak RSS {report['peak_rss_mb']} MB; model load {report['model_load_s']} s; {report['system']}")


if __name__ == "__main__":
    asyncio.run(main())
