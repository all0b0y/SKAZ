"""``.skaz/translation.md``: the provider's translation of a speech material.

Translated tokens have no timestamps and no reliable word alignment with the
original (SONIOX-TRANSLATION-STORAGE.md), so the file carries neither ``seg``
ids nor times: it is the translator's own monologues, in provider order, one
paragraph per run of one speaker within one connection. Rewritten as a whole
at settle points (pause, stop, end of tail processing, import completion).
"""
from __future__ import annotations

import re
from collections.abc import Sequence

from ..markdown.frontmatter import render_frontmatter
from .transcript import TranslationToken

TRANSLATION_FILE = "translation.md"
#: Same ceiling as an original monologue, so a long uninterrupted speaker stays readable.
MAX_PARAGRAPH_CHARS = 1_500
_SENTENCE_END = re.compile(r"[.!?…]['\")\]]*\s*$")
_LINE_BREAKS = re.compile(r"\s*\n\s*")


def one_line(text: str) -> str:
    """Speech is one paragraph: line breaks inside recognised text become spaces."""
    return _LINE_BREAKS.sub(" ", text).strip()


def paragraphs(tokens: Sequence[TranslationToken]) -> list[tuple[int | None, str]]:
    groups: list[tuple[str, int | None, list[str]]] = []
    for token in tokens:
        if not token.text:
            continue
        current = groups[-1] if groups else None
        same_turn = current is not None and current[0] == token.connection_id and current[1] == token.speaker
        too_long = current is not None and sum(len(part) for part in current[2]) >= MAX_PARAGRAPH_CHARS \
            and bool(_SENTENCE_END.search(current[2][-1]))
        if current is None or not same_turn or too_long:
            groups.append((token.connection_id, token.speaker, [token.text]))
        else:
            current[2].append(token.text)
    result = []
    for _connection, speaker, parts in groups:
        text = one_line("".join(parts))
        if text:
            result.append((speaker, text))
    return result


def render_translation(material_id: str, language: str | None, tokens: Sequence[TranslationToken]) -> str:
    fields: dict[str, object] = {"skaz_id": material_id, "kind": "translation"}
    if language:
        fields["language"] = language
    blocks = [f"**Speaker {speaker}**\n{text}" if speaker is not None else text
              for speaker, text in paragraphs(tokens)]
    return render_frontmatter(fields) + "\n" + "\n\n".join(blocks) + ("\n" if blocks else "")
