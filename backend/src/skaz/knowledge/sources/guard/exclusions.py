"""``.skaz/excluded.json``: fragments kept out of processing, and the user's restore decisions.

The source Markdown always keeps every fragment (evidence, decision 41); this
file only says which ``seg`` ids processing must skip. A restore is
remembered by the hash of the fragment text, so re-running the detector on
the same text never excludes it again — while an edited paragraph (different
hash) is checked afresh.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

EXCLUDED_FILE = "excluded.json"


class FragmentLocation(BaseModel):
    """Where a fragment is: paragraph ``index`` (article/text), ``page`` (PDF) or ``start_ms`` (speech)."""

    model_config = ConfigDict(extra="ignore")
    index: int | None = None
    page: int | None = None
    start_ms: int | None = None


class ExcludedFragment(BaseModel):
    model_config = ConfigDict(extra="allow")
    seg: int = Field(ge=1)
    #: ``block_hash`` of the fragment text when it was excluded.
    text_hash: str
    reason: str
    rules: list[str]
    score: float
    found: str
    location: FragmentLocation
    detected_at: str


class RestoredFragment(BaseModel):
    model_config = ConfigDict(extra="allow")
    seg: int = Field(ge=1)
    text_hash: str
    restored_at: str


class ExclusionFile(BaseModel):
    model_config = ConfigDict(extra="allow")
    format: int = 1
    excluded: list[ExcludedFragment] = Field(default_factory=list)
    restored: list[RestoredFragment] = Field(default_factory=list)
    #: The feed entry raised for these exclusions (dismissed when nothing is excluded any more).
    notification_id: str | None = None

    def restored_hashes(self) -> frozenset[str]:
        return frozenset(item.text_hash for item in self.restored)

    def excluded_segs(self) -> frozenset[int]:
        return frozenset(item.seg for item in self.excluded)
