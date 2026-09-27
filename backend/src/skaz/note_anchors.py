"""Turning a model's labelled draft into a clean note plus a separate anchor map.

The generator still cites with ``[P2]`` / ``[S7]`` so its grounding can be checked,
but those labels are an artefact of generation, not part of the note. Once checked
they are removed: what is stored, exported and edited is plain prose, and the
provenance lives beside it as spans over that prose.

A span is deliberately coarse — the block (line or list item) the label was attached
to. A label sits at the end of a statement and vouches for that statement, so the
statement is what gets linked. Guessing a narrower range would be inventing precision
the model never expressed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .agent.context import LABEL_PATTERN, _labels_in_block

#: Whitespace left stranded where a label was removed, before the line's end.
_TRAILING_SPACE = re.compile(r"[ \t]+(?=\n|$)")
#: A label together with the space that separated it from the preceding word, so
#: removing it mid-line does not leave a double gap in the prose.
_SPACED_LABEL = re.compile(r"[ \t]*" + LABEL_PATTERN.pattern)


@dataclass(frozen=True)
class NoteLink:
    """One stretch of note text and the transcript labels it rests on.

    ``start``/``end`` index the cleaned content. The editor moves them as the user
    types; a link whose text is rewritten beyond recognition or deleted is dropped
    rather than repointed.
    """

    start: int
    end: int
    labels: tuple[str, ...]


@dataclass(frozen=True)
class CleanedNote:
    content: str
    links: tuple[NoteLink, ...]


def strip_labels(content: str) -> CleanedNote:
    """Remove every citation label from ``content``, keeping where each one pointed.

    Call this only after the labels have been validated against the transcript.
    Stripping first would throw away the evidence that the note is checkable at all.
    """
    cleaned_lines: list[str] = []
    links: list[NoteLink] = []
    offset = 0
    for line in content.split("\n"):
        labels: list[str] = []
        for block in LABEL_PATTERN.findall(line):
            labels.extend(_labels_in_block(block))
        stripped = _TRAILING_SPACE.sub("", _SPACED_LABEL.sub("", line))
        if labels:
            start, end = _statement_span(stripped)
            if end > start:
                links.append(
                    NoteLink(start=offset + start, end=offset + end, labels=tuple(dict.fromkeys(labels)))
                )
        cleaned_lines.append(stripped)
        offset += len(stripped) + 1
    return CleanedNote(content="\n".join(cleaned_lines), links=tuple(links))


def _statement_span(line: str) -> tuple[int, int]:
    """The statement inside one line: its text without markdown bullet and indent.

    Linking the marker as well would underline ``- `` and, worse, make an anchor that
    a user removing the bullet would break for no reason.
    """
    start = 0
    while start < len(line) and line[start] in " \t":
        start += 1
    marker = re.compile(r"(?:[-*+]|\d{1,3}[.)]|#{1,6})\s+").match(line, start)
    if marker:
        start = marker.end()
    end = len(line)
    while end > start and line[end - 1] in " \t":
        end -= 1
    return start, end
