"""``/kb/library``: where the library is and whether it can be used."""
from __future__ import annotations

from fastapi import APIRouter

from ..service import LibraryView
from .deps import KbDep, kb_call
from .schemas import KbLibrary, KbLibraryConnect

router = APIRouter(prefix="/kb/library", tags=["kb"])


def _view(view: LibraryView) -> KbLibrary:
    return KbLibrary(state=view.state, root=view.root, suggested_root=view.suggested_root, reason=view.reason,
                     library_id=view.library_id)


@router.get("")
async def read_library(kb: KbDep) -> KbLibrary:
    return _view(await kb_call(kb.view))


@router.post("")
async def connect_library(body: KbLibraryConnect, kb: KbDep) -> KbLibrary:
    """Create (or open) the library at the confirmed place. The only call that creates the root."""
    return _view(await kb_call(kb.connect, body.path))


@router.post("/retry")
async def retry_library(kb: KbDep) -> KbLibrary:
    """Try the connected root again after it was unavailable (disk back, permission granted)."""
    return _view(await kb_call(kb.retry))
