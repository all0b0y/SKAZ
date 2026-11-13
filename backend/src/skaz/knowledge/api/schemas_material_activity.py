"""Explicit material usage and nonempty topic creation contracts."""
from typing import Annotated

from pydantic import BaseModel, Field

from .schemas_areas import KbMaterialTopic as KbMaterialTopic
from .schemas_explore_common import KbAcknowledged as KbAcknowledged
from .schemas_explore_common import KbContractRequest, KbEntityId


class KbUnusedExploreMaterials(BaseModel):
    material_ids: list[str]


class KbKeepExploreMaterials(KbContractRequest):
    material_ids: list[KbEntityId] = Field(min_length=1, max_length=1000)


class KbMaterialTopicCreate(KbContractRequest):
    name: Annotated[str, Field(min_length=1, max_length=200)]
    parent_id: KbEntityId | None = None
