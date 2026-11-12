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
        KbAreaMerge,
        KbAreaUpdate,
        KbFactualSignal,
        KbMaterialTopic,
        KbMaterialTopicSet,
        KbReadMark,
        KbReadMarkUpdate,
        KbReadMarkValue,
        KbSignalEntity,
        KbSignals,
        KbTopicLabelling,
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
    # EX2 (X1): own topics.
    async def sort_topics(self) -> KbTopicLabelling:
        """Start/continue labelling unsorted wiki materials (the user's click; paid on the wiki engine)."""
        ...
    async def merge(self, area_id: str, body: KbAreaMerge) -> KbArea: ...
    async def set_material_topic(self, material_id: str, body: KbMaterialTopicSet) -> KbMaterialTopic: ...


class SignalRecorder(Protocol):
    """B2, B3 and S0 append facts through this. Blocking; callers use ``disk_call``."""

    def record(self, draft: SignalDraft) -> KbFactualSignal: ...


class AreaDirectory(Protocol):
    """How other slices read the map without its tables. Blocking; callers use ``disk_call``."""

    def area_for_topics(self, topic_ids: Sequence[str]) -> str | None: ...
    def area_path(self, area_id: str) -> Sequence[str]: ...
    def topics(self, area_id: str) -> Sequence[str]:
        """The area's science scope. EX2 own topic: its hidden OpenAlex label and its subtopics' (empty while
        not mapped, stale after a rename, or with no match → search by text only). OpenAlex rows of older
        builds: a domain/field/subfield's own taxonomy id, or a topic's id."""
        ...
    def materials(self, area_id: str) -> Sequence[str]: ...
    def pinned(self) -> Sequence[str]: ...
    def recently_active(self, limit: int = 10) -> Sequence[str]: ...
    def read_marks(self, material_ids: Sequence[str]) -> Mapping[str, KbReadMarkValue]: ...


class TopicDirectory(Protocol):
    """EX2: what a search plan reads about the user's own topics (``kb_areas.store`` implements it, next to
    ``AreaDirectory``). Blocking; callers use ``disk_call``. ``AreaDirectory.topics`` gives the hidden ids."""

    def largest_topics(self, limit: int = 8) -> Sequence[str]:
        """The visible top-level own topics with materials, largest first ("All your topics")."""
        ...
    def top_concepts(self, area_id: str, limit: int = 5) -> Sequence[str]:
        """The topic's main concept titles (concept pages citing most of its materials)."""
        ...
