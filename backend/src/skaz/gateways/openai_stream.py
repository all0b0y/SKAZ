"""OpenAI speech-to-text as a live (utterance) and file transcription provider.

The dedicated ``/v1/audio/transcriptions`` endpoint is request/response, so it is
used in utterance mode: each utterance is sent once, at its pause, and returns
final text only. ``whisper-1`` provides real word timestamps; the ``gpt-4o``
transcription models return plain text, whose words are spread evenly over the
utterance — an approximation the UI labels as such.
"""

from __future__ import annotations

import httpx

from ..audio import WavAudio
from . import LiveAsrError, describe_http_error, describe_transport_error, is_retryable_http_status
from .whisper_stream import SAMPLE_RATE, Decoded, DecodedWord

OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions"
#: Models whose responses carry word timestamps.
WORD_TIMESTAMP_MODELS = frozenset({"whisper-1"})

#: Whisper reports languages by English name in verbose JSON.
WHISPER_LANGUAGE_CODES: dict[str, str] = {
    "afrikaans": "af", "albanian": "sq", "arabic": "ar", "azerbaijani": "az", "basque": "eu",
    "belarusian": "be", "bengali": "bn", "bosnian": "bs", "bulgarian": "bg", "catalan": "ca",
    "chinese": "zh", "croatian": "hr", "czech": "cs", "danish": "da", "dutch": "nl", "english": "en",
    "estonian": "et", "finnish": "fi", "french": "fr", "galician": "gl", "german": "de", "greek": "el",
    "gujarati": "gu", "hebrew": "he", "hindi": "hi", "hungarian": "hu", "indonesian": "id",
    "italian": "it", "japanese": "ja", "kannada": "kn", "kazakh": "kk", "korean": "ko", "latvian": "lv",
    "lithuanian": "lt", "macedonian": "mk", "malay": "ms", "malayalam": "ml", "marathi": "mr",
    "norwegian": "no", "persian": "fa", "polish": "pl", "portuguese": "pt", "punjabi": "pa",
    "romanian": "ro", "russian": "ru", "serbian": "sr", "slovak": "sk", "slovenian": "sl",
    "spanish": "es", "swahili": "sw", "swedish": "sv", "tagalog": "tl", "tamil": "ta", "telugu": "te",
    "thai": "th", "turkish": "tr", "ukrainian": "uk", "urdu": "ur", "vietnamese": "vi", "welsh": "cy",
}


def language_code(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    lowered = value.strip().lower()
    if lowered in WHISPER_LANGUAGE_CODES.values():
        return lowered
    return WHISPER_LANGUAGE_CODES.get(lowered)


class OpenAIWindowDecoder:
    redecode = False

    def __init__(self, http: httpx.AsyncClient, *, api_key: str, model: str, timeout: float = 60.0,
                 url: str = OPENAI_TRANSCRIPTIONS_URL) -> None:
        self._http = http
        self._key = api_key
        self.model = model
        self._timeout = timeout
        self._url = url

    @property
    def word_timestamps(self) -> bool:
        return self.model in WORD_TIMESTAMP_MODELS

    def can_translate(self, target_language: str) -> bool:
        del target_language
        return False

    async def translate(self, pcm: bytes, *, source_language: str | None, target_language: str) -> str:
        raise LiveAsrError("OpenAI live translation is not supported.", retryable=False)

    async def decode(
        self, pcm: bytes, *, language: str | None, languages: tuple[str, ...] | None, prompt: str,
    ) -> Decoded:
        if language is None and languages and len(languages) == 1:
            language = languages[0]
        duration_s = len(pcm) / 2 / SAMPLE_RATE
        if duration_s <= 0.1:
            return Decoded((), language)
        data: dict[str, str | list[str]] = {"model": self.model}
        if self.word_timestamps:
            data["response_format"] = "verbose_json"
            data["timestamp_granularities[]"] = ["word"]
        else:
            data["response_format"] = "json"
        if language:
            data["language"] = language
        if prompt:
            data["prompt"] = prompt[-400:]
        wav = WavAudio(SAMPLE_RATE, pcm).to_wav_bytes()
        try:
            response = await self._http.post(
                self._url, headers={"Authorization": f"Bearer {self._key}"}, data=data,
                files={"file": ("speech.wav", wav, "audio/wav")}, timeout=self._timeout,
            )
        except httpx.HTTPError as error:
            raise LiveAsrError(describe_transport_error("OpenAI", error), retryable=True) from error
        if response.status_code >= 400:
            raise LiveAsrError(describe_http_error("OpenAI", response.status_code),
                               retryable=is_retryable_http_status(response.status_code))
        try:
            payload = response.json()
        except ValueError as error:
            raise LiveAsrError("OpenAI returned a non-JSON transcription.", retryable=True) from error
        if not isinstance(payload, dict):
            raise LiveAsrError("OpenAI returned an unexpected transcription shape.", retryable=False)
        detected = language_code(payload.get("language")) or language
        return Decoded(parse_words(payload, duration_s), detected)


def parse_words(payload: dict[str, object], duration_s: float) -> tuple[DecodedWord, ...]:
    """Word timing from ``words``; otherwise the text spread evenly (approximate)."""
    raw_words = payload.get("words")
    words: list[DecodedWord] = []
    if isinstance(raw_words, list):
        for item in raw_words:
            if not isinstance(item, dict):
                continue
            text, start, end = item.get("word"), item.get("start"), item.get("end")
            if not isinstance(text, str) or not text.strip():
                continue
            if isinstance(start, bool) or isinstance(end, bool):
                continue
            if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
                continue
            start_s = min(max(0.0, float(start)), duration_s)
            end_s = min(max(start_s, float(end)), duration_s)
            words.append(DecodedWord(text if text[:1].isspace() else f" {text}", start_s, end_s))
        if words:
            return tuple(words)
    text = payload.get("text")
    if not isinstance(text, str):
        return ()
    pieces = text.split()
    if not pieces:
        return ()
    step = duration_s / len(pieces)
    return tuple(DecodedWord(f" {piece}", index * step, (index + 1) * step)
                 for index, piece in enumerate(pieces))
