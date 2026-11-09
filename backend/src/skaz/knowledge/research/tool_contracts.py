"""Tool shapes for B3 to register after permission-backed services land; no executor here."""

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

from ..api.schemas_research import (
    KbExploreRead,
    KbExploreSnapshot,
    KbResearchCreate,
    KbResearchToolResult,
)


@dataclass(frozen=True)
class ResearchToolContract:
    name: str
    arguments: type[BaseModel]
    result: type[BaseModel]
    permission_kind: Literal["research_start"] | None
    read_only: bool


TOOL_CONTRACTS = (
    ResearchToolContract(
        "skaz_research_start", KbResearchCreate, KbResearchToolResult, "research_start", False
    ),
    ResearchToolContract("skaz_explore_read", KbExploreRead, KbExploreSnapshot, None, True),
)
