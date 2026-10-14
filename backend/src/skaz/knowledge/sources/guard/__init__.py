"""Poisoning layers 2–3 for sources: invisible content and instructions aimed at an AI.

* Layer 2 (``invisible``): only text a reader can see goes on — invisible
  characters, hidden HTML and hidden PDF text are removed, and every
  meaningful removal is recorded as a ``Finding``.
* Layer 3 (``detector``): heuristics (ru/en) that flag a fragment addressed to
  a model; ``exclusions`` keeps such fragments out of processing (the source
  file keeps them, for evidence) until the user restores them.
"""

from __future__ import annotations

from .detector import THRESHOLD, Detection, detect_instruction
from .exclusions import ExcludedFragment, ExclusionFile, RestoredFragment
from .findings import Finding, FindingKind
from .invisible import Cleaned, clean_invisible, strip_invisible

__all__ = [
    "THRESHOLD",
    "Cleaned",
    "Detection",
    "ExcludedFragment",
    "ExclusionFile",
    "Finding",
    "FindingKind",
    "RestoredFragment",
    "clean_invisible",
    "detect_instruction",
    "strip_invisible",
]
