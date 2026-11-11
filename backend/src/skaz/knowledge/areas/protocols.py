"""Areas boundaries; B4 implements all three. Importing this module never loads the API package."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ..api.schemas_areas import (
        KbAcknowledged,
        KbArea,
        KbAreaCreate,
        KbAreaMap,
        KbAreaMaterials,
        KbAreaUpdate,
        KbFactualSignal,
        KbReadMark,
        KbReadMarkUpdate,
        KbReadMarkValue,
        KbSignalEntity,
        KbSignals,
    )


@dataclass(frozen=True)
class SignalDraft:
    """A fact, never an inference (decision 3e′). ``evidence_id`` names the record that proves it."""

    subject: KbSignalEntity
    predicate: str
    object: KbSignalEntity
    origin: str
    evidence_id: str
    value: str | None = None
    supersedes_id: str | None = None


class AreasService(Protocol):
    """What the map, area, read-mark and signal routes need."""

    async def map(self, parent_id: str | None = None, include_hidden: bool = False) -> KbAreaMap: ...
    async def create(self, body: KbAreaCreate) -> KbArea: ...
    async def update(self, area_id: str, body: KbAreaUpdate) -> KbArea: ...
    async def delete(self, area_id: str) -> KbAcknowledged:
        """Custom areas only; a taxonomy area answers ``conflict`` (hide it instead)."""
        ...
    async def opened(self, area_id: str) -> KbAcknowledged:
        """Records the ``area_opened`` fact behind "recent activity"."""
        ...
    async def materials(
        self, area_id: str, cursor: str | None = None, limit: int = 30
    ) -> KbAreaMaterials: ...
    async def read_mark(self, material_id: str) -> KbReadMark: ...
    async def set_read_mark(self, material_id: str, body: KbReadMarkUpdate) -> KbReadMark: ...
    async def remove_read_mark(self, material_id: str) -> KbReadMark: ...
    async def set_finding_mark(self, finding_id: str, body: KbReadMarkUpdate) -> KbReadMark: ...
    async def remove_finding_mark(self, finding_id: str) -> KbReadMark: ...
    async def signals(self, cursor: str | None = None, limit: int = 50) -> KbSignals: ...


class SignalRecorder(Protocol):
    """B2, B3 and S0 append facts through this. Blocking; callers use ``disk_call``."""

    def record(self, draft: SignalDraft) -> KbFactualSignal: ...


class AreaDirectory(Protocol):
    """How other slices read the map without its tables. Blocking; callers use ``disk_call``."""

    def area_for_topics(self, topic_ids: Sequence[str]) -> str | None: ...
    def area_path(self, area_id: str) -> Sequence[str]: ...
    def topics(self, area_id: str) -> Sequence[str]:
        """The area's science scope: a domain/field/subfield's own taxonomy id (``fields-17``, a hierarchy
        filter over everything below it), a topic's id, or the ids a custom area collects."""
        ...
    def materials(self, area_id: str) -> Sequence[str]: ...
    def pinned(self) -> Sequence[str]: ...
    def recently_active(self, limit: int = 10) -> Sequence[str]: ...
    def read_marks(self, material_ids: Sequence[str]) -> Mapping[str, KbReadMarkValue]: ...
