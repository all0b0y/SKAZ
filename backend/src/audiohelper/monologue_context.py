"""Rendering monologues as a prompt block, and reading the labels back.

The prompt keeps the ``[P<n>]`` label shape the grounding checks already
understand, but a label now names one monologue — a continuous stretch of one
speaker — instead of a pause-delimited passage. That single change is what makes
a note, an answer and the transcript view all point at the same unit of speech.

Labels are never stored. They exist for the length of one generation: the model
cites them, :mod:`note_anchors` records which text they vouched for, and the
citation that survives is a monologue id with a token range.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import monologues as mono
from .agent.context import (
    CITATION_SHAPED_PATTERN,
    LABEL_PATTERN,
    MAX_CITATIONS,
    UNTRUSTED_HEADER,
    _labels_in_block,
    _parse_block,
    clock,
)
from .schemas import Citation

MONOLOGUE_NOTE = (
    "Each [P<n>] entry below is ONE monologue: a continuous stretch of speech by a single "
    "speaker, already joined into its full text. The recorder's chunk edges are invisible here "
    "and carry no meaning. Cite a monologue as [P<n>]. A citation names the speaker and the "
    "stretch of speech, which is what a listener can check back against the recording."
)


@dataclass(frozen=True)
class MonologueContext:
    text: str
    references: dict[str, mono.Monologue] = field(default_factory=dict)
    truncated: bool = False

    def citations_for(self, answer: str) -> list[Citation]:
        return citations_from(self.references, answer)


def build(monologues: list[mono.Monologue], *, budget_chars: int, offset: int = 0) -> MonologueContext:
    """Render ``monologues`` as labelled entries that fit ``budget_chars``.

    ``offset`` continues the numbering of an earlier batch, so a label cited by a
    partial summary still names the same monologue after the parts are merged.
    """
    lines: list[str] = []
    references: dict[str, mono.Monologue] = {}
    used = 0
    truncated = False
    for index, monologue in enumerate(monologues):
        key = f"P{index + 1 + offset}"
        line = (
            f"[{key}] {clock(monologue.start_ms)}–{clock(monologue.end_ms)} "
            f"({mono.speaker_label(monologue)}) {monologue.text}"
        )
        if used + len(line) + 1 > budget_chars and lines:
            truncated = True
            break
        references[key] = monologue
        lines.append(line)
        used += len(line) + 1
    body = "\n".join(lines) if lines else "NO MATCHING TRANSCRIPT"
    if truncated:
        body = (
            f"[truncated: {len(monologues) - len(lines)} of {len(monologues)} monologues were left "
            f"out to fit the context budget; the earliest are kept]\n" + body
        )
    return MonologueContext(
        text=f"{UNTRUSTED_HEADER}\n{MONOLOGUE_NOTE}\n{body}",
        references=references,
        truncated=truncated,
    )


def citations_from(references: dict[str, mono.Monologue], answer: str) -> list[Citation]:
    """Citations for every known label cited in ``answer``, in first-use order.

    A label the context never issued is dropped rather than repaired, so a model
    cannot invent a source by naming one. The whole monologue is cited: the model
    was shown it as one unit and said nothing about which part of it it used, and
    narrowing on its behalf would fabricate precision.
    """
    cited: dict[str, Citation] = {}
    for block in LABEL_PATTERN.findall(answer):
        for key in _labels_in_block(block):
            monologue = references.get(key)
            if monologue is None or monologue.id in cited or len(cited) >= MAX_CITATIONS:
                continue
            cited[monologue.id] = citation_for(monologue, monologue.tokens)
    return list(cited.values())


def citation_for(monologue: mono.Monologue, tokens: tuple[mono.Token, ...]) -> Citation:
    anchor = mono.anchor(monologue, tokens)
    # segment_id keeps the older consumers working unchanged — the transcript scroll
    # and the player both address speech by segment — while the anchor above is what
    # the citation actually resolves by.
    return Citation(
        segment_id=tokens[0].segment_id or tokens[0].id,
        start_ms=anchor.start_ms,
        end_ms=anchor.end_ms,
        text=anchor.text,
        monologue_id=anchor.monologue_id,
        start_token_id=anchor.start_token_id,
        end_token_id=anchor.end_token_id,
        speaker=monologue.speaker,
    )


def unresolved(references: dict[str, mono.Monologue], answer: str) -> list[str]:
    """Citation-shaped tokens naming no monologue, in first-use order.

    A label that resolves to nothing would leave its sentence looking sourced while
    resting on nothing, and reading ``[П1]`` as ``[P1]`` would invent the grounding.
    Both are reported so the caller can discard the generated text instead.
    """
    known = set(references)
    reported: list[str] = []
    for token in CITATION_SHAPED_PATTERN.findall(answer):
        if token in reported:
            continue
        # The whole declared span is checked, not the bounded slice resolution keeps:
        # [P1-P9999] must fail on P9999 even when P1 exists.
        parsed = _parse_block(token, limit=None) if LABEL_PATTERN.fullmatch(token) else None
        if parsed is None or parsed.malformed or not parsed.keys or not set(parsed.keys) <= known:
            reported.append(token)
    return reported
