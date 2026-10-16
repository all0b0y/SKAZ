"""``/kb/folders``: material folders. Inbox always exists; only empty folders are deleted."""
from __future__ import annotations

from fastapi import APIRouter, Response

from ..store.records import FolderRecord
from .deps import KbDep, kb_call
from .schemas import KbFolder, KbFolderCreate, KbFolderRename

router = APIRouter(prefix="/kb/folders", tags=["kb"])


def folder_view(record: FolderRecord) -> KbFolder:
    return KbFolder(id=record.id, name=record.name, system=record.system,
                    material_count=record.material_count, created_at=record.created_at)


@router.get("")
async def list_folders(kb: KbDep) -> list[KbFolder]:
    return [folder_view(record) for record in await kb_call(kb.folders)]


@router.post("", status_code=201)
async def create_folder(body: KbFolderCreate, kb: KbDep) -> KbFolder:
    return folder_view(await kb_call(kb.create_folder, body.name))


@router.patch("/{folder_id}")
async def rename_folder(folder_id: str, body: KbFolderRename, kb: KbDep) -> KbFolder:
    return folder_view(await kb_call(kb.rename_folder, folder_id, body.name))


@router.delete("/{folder_id}", status_code=204, response_class=Response)
async def delete_folder(folder_id: str, kb: KbDep) -> Response:
    await kb_call(kb.delete_folder, folder_id)
    return Response(status_code=204)
