"""N3 boundaries; B7 implements both. Importing this module never loads the API package."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ..api.schemas_explore_common import KbContinue
    from ..api.schemas_repeats import KbMaterialRepeats, KbRepeatCheck, KbRepeatCheckStart


class RepeatsService(Protocol):
    async def material(self, material_id: str) -> KbMaterialRepeats: ...
    async def start(self, body: KbRepeatCheckStart) -> KbRepeatCheck: ...
    async def check(self, check_id: str) -> KbRepeatCheck: ...
    async def pause(self, check_id: str) -> KbRepeatCheck: ...
    async def resume(self, check_id: str, body: KbContinue) -> KbRepeatCheck: ...


class RepeatSummaries(Protocol):
    """B4 fills the repeat columns of ``KbAreaMaterial`` from this. Blocking; callers use ``disk_call``."""

    def summaries(self, material_ids: Sequence[str]) -> Mapping[str, KbMaterialRepeats]: ...
