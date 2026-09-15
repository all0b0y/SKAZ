"""Soniox's documented STT language set, independent of credentials/network.

Source: https://soniox.com/docs/stt/concepts/supported-languages
Restrictions: https://soniox.com/docs/stt/concepts/language-restrictions
Strict hints are best-effort; they do not disable language identification.
"""
from typing import Annotated

from pydantic import AfterValidator, Field

SUPPORTED_LANGUAGES = (
    "af", "sq", "ar", "az", "eu", "be", "bn", "bs", "bg", "ca", "zh", "hr", "cs", "da", "nl",
    "en", "et", "fi", "fr", "gl", "de", "el", "gu", "he", "hi", "hu", "id", "it", "ja", "kn",
    "kk", "ko", "lv", "lt", "mk", "ms", "ml", "mr", "no", "fa", "pl", "pt", "pa", "ro", "ru",
    "sr", "sk", "sl", "es", "sw", "sv", "tl", "ta", "te", "th", "tr", "uk", "ur", "vi", "cy",
)


def validate_languages(languages: list[str]) -> list[str]:
    if not languages or len(languages) != len(set(languages)):
        raise ValueError("Choose one or more distinct supported languages.")
    if any(language not in SUPPORTED_LANGUAGES for language in languages):
        raise ValueError("Unsupported spoken language.")
    return languages


UsedLanguages = Annotated[
    list[str], Field(min_length=1, max_length=len(SUPPORTED_LANGUAGES)),
    AfterValidator(validate_languages),
]
