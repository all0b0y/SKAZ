"""What every W2 operation needs: the library, the write lock, the decision layer, the detector."""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass

from ..corrections.store import CorrectionStore
from ..decisions.protocol import DecisionLayer, Undecided, YesNoAnswer, YesNoQuestion
from ..ingest.checks import clean_text, flags_instructions
from ..ingest.protocols import InstructionDetector
from ..ingest.settings import WikiSettings
from ..service import KnowledgeService
from .graph import GraphIndex
from .statements import Citations

#: B9: calibrated threshold of the decision layer for yes/no.
CONFIDENT = 0.7
NO_DETECTOR = (
    "The safety check for wiki output isn't available in this build, so SKAZ won't write to the "
    "wiki. Update SKAZ and retry."
)


@dataclass(frozen=True)
class Verdict:
    """A yes/no from the decision layer: ``None`` when it did not decide (the writing agent's word stands)."""

    answer: bool | None
    p_yes: float | None
    reason: str


@dataclass
class WikiContext:
    kb: KnowledgeService
    store: CorrectionStore
    graph: GraphIndex
    write_lock: threading.Lock
    decisions: Callable[[], DecisionLayer | None]
    detector: Callable[[], InstructionDetector | None]
    settings: Callable[[], WikiSettings]

    def citations(self) -> Citations:
        return Citations(self.kb, self.store)

    def flagged(self, *texts: str) -> bool:
        """Layer 5: text that reads as an instruction to an AI is never written (no detector: nothing is)."""
        detector = self.detector()
        if detector is None:
            return True
        return flags_instructions(detector, *texts, *(clean_text(text) for text in texts))

    async def confirm(self, state: str, question: str) -> Verdict:
        layer = self.decisions()
        if layer is None:
            return Verdict(None, None, "no decision layer is set up")
        try:
            answer = await layer.ask(YesNoQuestion(state=state, question=question))
        except Exception:  # an adapter failure is "undecided", never a guess
            return Verdict(None, None, "the decision layer failed")
        if isinstance(answer, YesNoAnswer):
            if answer.p_yes >= CONFIDENT:
                return Verdict(True, answer.p_yes, "")
            if answer.p_yes <= 1 - CONFIDENT:
                return Verdict(False, answer.p_yes, "")
            return Verdict(None, answer.p_yes, "the decision layer was not confident")
        if isinstance(answer, Undecided):
            return Verdict(None, None, answer.reason)
        return Verdict(None, None, "the decision layer gave no usable answer")
