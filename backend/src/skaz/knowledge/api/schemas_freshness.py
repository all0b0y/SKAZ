"""Real publication dates, library filtering and explicit link checks (B5)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from .schemas_areas import KbAreaMaterial
from .schemas_explore_common import KbContractRequest, KbDateWindow, KbExploreJob, KbPublicationDate


class KbMaterialPublication(BaseModel):
    material_id: str
    publication: KbPublicationDate


class KbLibraryDateQuery(KbContractRequest):
    dates: KbDateWindow
    folder_id: str | None = None
    cursor: str | None = None
    limit: int = Field(default=50, ge=1, le=100)


class KbDatedMaterials(BaseModel):
    materials: list[KbAreaMaterial]
    unknown_date: list[KbAreaMaterial]
    next_cursor: str | None


class KbLinkCheckStart(KbContractRequest):
    material_ids: list[str] = Field(default_factory=list, max_length=100)
    folder_id: str | None = None

    @model_validator(mode="after")
    def exactly_one_scope(self) -> KbLinkCheckStart:
        if bool(self.material_ids) == bool(self.folder_id):
            raise ValueError("Give material_ids or folder_id, exclusively")
        return self


class KbLinkObservation(BaseModel):
    material_id: str
    url: str
    outcome: Literal["ok", "suspected_gone", "confirmed_gone", "could_not_check"]
    reason: Literal["http_404", "http_410", "no_domain", "http_403", "http_429", "timeout", "other"] | None
    status_code: int | None
    checked_at: datetime
    first_gone_at: datetime | None
    confirm_after: datetime | None


class KbLinkCheck(KbExploreJob):
    observations: list[KbLinkObservation]
