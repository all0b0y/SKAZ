"""Seams of the ingest pipeline that other areas fill in.

* ``InstructionDetector`` — the poisoning layer-3 detector of area S1
  (``knowledge/sources/guard/``), reused here as the layer-5 output check.
* ``TextLayer`` — recognition corrections of area W2; identity until then.
* ``ConceptUpdateHook`` — area W2 looks for discrepancies after a concept page
  received new blocks. Ingest never picks a winner itself (decision 4).
* ``EngineResolver`` — the engine registry of area A2: the engine chosen for
  the wiki (``None`` = the default engine), or ``None`` when nothing is ready.
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Protocol

from ..agents.engine import AgentEngine
from ..markdown.source import Fragment


class InstructionDetector(Protocol):
    def detect(self, text: str) -> Sequence[object]:
        """Findings of instructions addressed to an AI; empty when the text is clean."""
        ...


class TextLayer(Protocol):
    def apply(self, material_id: str, fragments: Sequence[Fragment]) -> list[Fragment]:
        """Fragments as the wiki must see them (accepted corrections applied), same ``seg`` ids."""
        ...


class IdentityTextLayer:
    """No corrections layer yet (W2): the source text as stored."""

    def apply(self, material_id: str, fragments: Sequence[Fragment]) -> list[Fragment]:
        return list(fragments)


class ConceptUpdateHook(Protocol):
    async def on_concept_updated(self, page_id: str, new_block_ids: Sequence[str]) -> None:
        """A concept page that already existed got new blocks from another material."""
        ...


EngineResolver = Callable[[str | None], AgentEngine | None]
