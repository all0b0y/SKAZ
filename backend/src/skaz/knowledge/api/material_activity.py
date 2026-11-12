"""Material usage: fail closed without a ready library; no automatic deletions."""
from collections.abc import Sequence
from typing import Annotated, Protocol, cast

from fastapi import APIRouter, Depends, Request

from ...native_io import disk_call
from .areas import EntityPath
from .contract_routes import ERROR_RESPONSES, ContractRoute, service_for
from .schemas_material_activity import (
    KbAcknowledged,
    KbKeepExploreMaterials,
    KbMaterialTopic,
    KbMaterialTopicCreate,
    KbUnusedExploreMaterials,
)

router = APIRouter(prefix="/kb", tags=["kb-materials-activity"], route_class=ContractRoute,
                   responses=ERROR_RESPONSES)


class MaterialActivityService(Protocol):
    def unused(self) -> KbUnusedExploreMaterials: ...
    def keep(self, material_ids: Sequence[str]) -> None: ...
    def opened(self, material_id: str) -> None: ...
    def new_topic(self, material_id: str, body: KbMaterialTopicCreate) -> KbMaterialTopic: ...


def get_service(request: Request) -> MaterialActivityService:
    return cast(MaterialActivityService, service_for(request, "material_activity"))


ServiceDep = Annotated[MaterialActivityService, Depends(get_service)]


@router.get("/materials-activity/explore-unused", response_model=KbUnusedExploreMaterials)
async def unused(service: ServiceDep) -> KbUnusedExploreMaterials:
    return await disk_call(service.unused)


@router.post("/materials-activity/explore-unused/keep", response_model=KbAcknowledged)
async def keep(body: KbKeepExploreMaterials, service: ServiceDep) -> KbAcknowledged:
    await disk_call(service.keep, body.material_ids)
    return KbAcknowledged(ok=True)


@router.post("/materials/{material_id}/opened", response_model=KbAcknowledged)
async def opened(material_id: EntityPath, service: ServiceDep) -> KbAcknowledged:
    await disk_call(service.opened, material_id)
    return KbAcknowledged(ok=True)


@router.post("/materials/{material_id}/new-topic", response_model=KbMaterialTopic)
async def new_topic(material_id: EntityPath, body: KbMaterialTopicCreate,
                    service: ServiceDep) -> KbMaterialTopic:
    return await disk_call(service.new_topic, material_id, body)
