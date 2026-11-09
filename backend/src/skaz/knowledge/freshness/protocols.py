"""Freshness boundaries; B5 implements both. Importing this module never loads the API package."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ..api.schemas_explore_common import KbContinue, KbPublicationDate
    from ..api.schemas_freshness import (
        KbDatedMaterials,
        KbLibraryDateQuery,
        KbLinkCheck,
        KbLinkCheckStart,
        KbMaterialPublication,
    )


class FreshnessService(Protocol):
    async def publication(self, material_id: str) -> KbMaterialPublication: ...
    async def filter_dates(self, body: KbLibraryDateQuery) -> KbDatedMaterials: ...
    async def check_links(self, body: KbLinkCheckStart) -> KbLinkCheck: ...
    async def link_check(self, check_id: str) -> KbLinkCheck: ...
    async def pause(self, check_id: str) -> KbLinkCheck: ...
    async def resume(self, check_id: str, body: KbContinue) -> KbLinkCheck: ...


class PublicationDates(Protocol):
    """Real publication dates for B2 (date window), B4 (newest year) and B6 (newer vs older).

    An import date is never a publication date. Blocking; callers use ``disk_call``.
    """

    def dates(self, material_ids: Sequence[str]) -> Mapping[str, KbPublicationDate]: ...
