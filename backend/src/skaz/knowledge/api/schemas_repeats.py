"""N3 uses confirmed N2 evidence; historical rescans have explicit budget/checkpoints (B7)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from .schemas_explore_common import (
    KbContractRequest,
    KbEntityId,
    KbExploreJob,
    KbExplorePageRef,
    KbMaterialRef,
)


class KbParagraphRepeat(BaseModel):
    paragraph_id: str
    fragment_ids: list[int]
    wiki_refs: list[KbExplorePageRef]
    from_materials: list[KbMaterialRef]
    repeated_statements: int
    total_statements: int
    fully_repeated: bool


class KbMaterialRepeats(BaseModel):
    material_id: str
    status: Literal["checked", "not_checked"]
    percent: int | None = Field(ge=0, le=100)
    repeated: int
    total: int
    from_materials: list[KbMaterialRef]
    paragraphs: list[KbParagraphRepeat]
    checked_at: datetime | None


class KbRepeatCheckStart(KbContractRequest):
    area_id: KbEntityId


class KbRepeatCheck(KbExploreJob):
    area_id: KbEntityId
    materials_checked: int
    materials_remaining: int
