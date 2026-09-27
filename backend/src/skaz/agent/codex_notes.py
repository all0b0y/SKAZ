"""What a Codex note is asked to be, and the check that it is one.

Codex notes get the same rules as ordinary notes (``agent/notes.py``) so both
paths produce the same kind of document; only the transport differs. The check
runs after the turn: a note is saved as evidence about the recording, so every
label must name speech this run read, and the text must be exactly one document.
"""

from __future__ import annotations

import re

from ..monologue_context import unresolved_labels
from .context import LABEL_PATTERN, _labels_in_block
from .note_completion import MULTIPART_RULES
from .notes import DETAIL_RULES, SYSTEM_RULES, Detail

_H1 = re.compile(r"^#[ \t]+\S", re.MULTILINE)
_FENCE = re.compile(r"^(```|~~~).*?^\1", re.MULTILINE | re.DOTALL)

ONE_DOCUMENT = (
    "Output exactly ONE note: a single level-1 heading (# Title) at the top, then the body. "
    "No preface, no commentary about your work, no second version, never repeat the note. "
    "Markdown tables are allowed when a comparison is clearer as a table."
)


def notes_request(language: str, detail: str) -> str:
    density = DETAIL_RULES[_detail(detail)]
    return (
        f"{SYSTEM_RULES}\n\n"
        "The transcript is not in this message: read it with skaz_read_transcript. Read the ENTIRE "
        "snapshot from after=0 until next_after is null, without query or time filters, before "
        "writing. Each returned block is one monologue; cite it by its citation_label, e.g. [P2].\n"
        f"Write the note in language: {language}.\n{density}\n{ONE_DOCUMENT}\n{MULTIPART_RULES}"
    )


def note_problems(answer: str, issued: set[str]) -> list[str]:
    """Why ``answer`` cannot be saved as a note; empty when it can."""
    problems: list[str] = []
    headings = len(_H1.findall(_FENCE.sub("", answer)))
    if headings != 1:
        problems.append(
            f"it has {headings} level-1 headings; a note is one document with exactly one."
        )
    unresolved = unresolved_labels(issued, answer)
    if unresolved:
        problems.append(
            "it cites labels that no block you read carries: " + ", ".join(unresolved[:10]) + "."
        )
    elif not cited_labels(answer) & issued:
        problems.append("it cites no transcript block; cite each point with its [P<n>] label.")
    return problems


def cited_labels(text: str) -> set[str]:
    return {key for block in LABEL_PATTERN.findall(text) for key in _labels_in_block(block)}


def _detail(value: str) -> Detail:
    return value if value in DETAIL_RULES else "normal"
