"""Media-import transcription with a window decoder (Local Whisper or OpenAI).

The file is decoded once to raw 16 kHz mono PCM16, then read in windows of about
ten minutes that are cut inside a pause, never mid-word. Each window is decoded
once; words the decoder placed in silence are dropped, speakers come from the
same local voice tracker live recordings use, and the result is the provider-
neutral :class:`~.gateways.soniox_async.AsyncToken` list that
:meth:`~.import_store.ImportStore.apply_transcript` already stores for Soniox.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from .gateways.soniox_async import AsyncToken
from .gateways.whisper_stream import (
    SAMPLE_RATE,
    DecodedWord,
    SpeakerTracker,
    VoiceActivity,
    WindowDecoder,
    _speaker_groups,
    _within_speech,
)

#: Window length; ten minutes of PCM16 WAV is ~19 MB, under OpenAI's 25 MB upload limit.
WINDOW_S = 600
#: A window is cut at the pause closest to its nominal end within this much audio.
CUT_SEARCH_S = 30
#: Translation is requested per sentence, or at most this much speech.
TRANSLATION_MAX_S = 20.0
_SENTENCE_END = re.compile(r"[.!?…。！？]['\"»”)]*$")


@dataclass
class _Unit:
    words: list[DecodedWord] = field(default_factory=list)
    speaker: str = "1"
    language: str | None = None


@dataclass(frozen=True)
class FileTranscript:
    tokens: list[AsyncToken]
    duration_ms: int


async def transcribe_pcm_file(
    path: Path,
    *,
    decoder: WindowDecoder,
    vad: VoiceActivity,
    speakers: SpeakerTracker,
    languages: tuple[str, ...] | None,
    translation_target: str | None,
    window_s: int = WINDOW_S,
) -> FileTranscript:
    total = path.stat().st_size // 2
    tokens: list[AsyncToken] = []
    prompt = ""
    start = 0
    with path.open("rb") as handle:
        while start < total:
            nominal_end = min(total, start + window_s * SAMPLE_RATE)
            handle.seek(start * 2)
            available = min(total, nominal_end + CUT_SEARCH_S * SAMPLE_RATE) - start
            pcm = handle.read(available * 2)
            cut = nominal_end if nominal_end >= total else await _cut(pcm, start, nominal_end, vad)
            window = pcm[: (cut - start) * 2]
            window_tokens, prompt = await _window(
                window, start / SAMPLE_RATE, decoder=decoder, vad=vad, speakers=speakers,
                languages=languages, translation_target=translation_target, prompt=prompt,
            )
            tokens.extend(window_tokens)
            start = cut
    return FileTranscript(tokens, total * 1000 // SAMPLE_RATE)


async def _cut(pcm: bytes, start: int, nominal_end: int, vad: VoiceActivity) -> int:
    """The middle of the pause nearest to ``nominal_end``; the nominal end if none.

    Only pauses in the second half of the window qualify, so a window is never
    shortened to a sliver by a pause right after its start.
    """
    offset = max(0, nominal_end - start - CUT_SEARCH_S * SAMPLE_RATE)
    region = pcm[offset * 2:]
    region_s = len(region) / 2 / SAMPLE_RATE
    speech = await vad.speech(region)
    if not speech:
        return nominal_end
    gaps = [(speech[i][1] + speech[i + 1][0]) / 2 for i in range(len(speech) - 1)]
    if speech[0][0] > 0.2:
        gaps.append(speech[0][0] / 2)
    if region_s - speech[-1][1] > 0.2:
        gaps.append((speech[-1][1] + region_s) / 2)
    earliest = (nominal_end - start) / 2 / SAMPLE_RATE
    target = (nominal_end - start - offset) / SAMPLE_RATE
    usable = [gap for gap in gaps if offset / SAMPLE_RATE + gap >= earliest]
    if not usable:
        return nominal_end
    best = min(usable, key=lambda gap: abs(gap - target))
    return start + offset + int(best * SAMPLE_RATE)


async def _window(
    pcm: bytes, base_s: float, *, decoder: WindowDecoder, vad: VoiceActivity, speakers: SpeakerTracker,
    languages: tuple[str, ...] | None, translation_target: str | None, prompt: str,
) -> tuple[list[AsyncToken], str]:
    speech = await vad.speech(pcm)
    if not speech:
        return [], prompt
    language = languages[0] if languages and len(languages) == 1 else None
    decoded = await decoder.decode(pcm, language=language, languages=languages, prompt=prompt)
    duration_s = len(pcm) / 2 / SAMPLE_RATE
    words = [
        DecodedWord(w.text, max(0.0, w.start_s), min(duration_s, max(w.start_s, w.end_s)), w.probability)
        for w in decoded.words if w.text.strip()
    ]
    words = [w for w in words if _within_speech(w, speech)]
    language = decoded.language or language
    units: list[_Unit] = []
    for group in _speaker_groups(words):
        a = max(0, int((group[0].start_s - 0.05) * SAMPLE_RATE) * 2)
        b = max(a, int((group[-1].end_s + 0.05) * SAMPLE_RATE) * 2)
        speaker = await speakers.assign(pcm[a:b])
        for word in group:
            unit = units[-1] if units else None
            if (unit is None or unit.speaker != speaker
                    or _SENTENCE_END.search(unit.words[-1].text.strip())
                    or word.end_s - unit.words[0].start_s > TRANSLATION_MAX_S):
                units.append(_Unit([word], speaker, language))
            else:
                unit.words.append(word)
    translating = translation_target is not None and language != translation_target
    status: Literal["none", "original"] = "original" if translating else "none"
    tokens: list[AsyncToken] = []
    for unit in units:
        for word in unit.words:
            start_ms = int((base_s + word.start_s) * 1000)
            end_ms = max(start_ms + 1, int((base_s + word.end_s) * 1000))
            tokens.append(AsyncToken(word.text, start_ms, end_ms, min(1.0, max(0.0, word.probability)),
                                     unit.speaker, unit.language, status))
        if translating and translation_target is not None:
            a = max(0, int((unit.words[0].start_s - 0.05) * SAMPLE_RATE) * 2)
            b = max(a, int((unit.words[-1].end_s + 0.05) * SAMPLE_RATE) * 2)
            text = (await decoder.translate(pcm[a:b], source_language=unit.language,
                                            target_language=translation_target)).strip()
            for piece in text.split():
                tokens.append(AsyncToken(f" {piece}", 0, 0, 1.0, unit.speaker,
                                         translation_target, "translation"))
    committed = "".join(w.text for w in words)
    return tokens, (prompt + committed)[-200:].strip()
