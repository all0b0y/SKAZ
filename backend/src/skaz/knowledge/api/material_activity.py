"""Material usage: fail closed without a ready library; no automatic deletions."""
from typing import TYPE_CHECKING, Annotated, Any, cast

from fastapi import APIRouter, Depends, Request

from ...native_io import disk_call
if TYPE_CHECKING:
    from ..library.activity import MaterialActivity
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


def get_service(request: Request) -> MaterialActivity:
    return cast("MaterialActivity", service_for(request, "material_activity"))


ServiceDep = Annotated[Any, Depends(get_service)]


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
