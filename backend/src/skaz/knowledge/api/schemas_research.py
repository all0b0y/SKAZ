"""Research owns a chat; tool execution is gated separately from ordinary web search (B3)."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from .schemas_areas import KbAreaMap, KbSignals
from .schemas_explore import KbFindings
from .schemas_explore_common import (
    KbContractRequest,
    KbDateWindow,
    KbEntityId,
    KbExploreJob,
    KbExploreJobState,
)


class KbResearchTopic(KbContractRequest):
    """EX2: one topic on the Research task card — proposed by the chat agent, typed, or picked from the map.

    Search and the fit decision use exactly the card's topics, never the user's areas."""

    text: Annotated[str, Field(min_length=1, max_length=72)]
    source: Literal["proposed", "typed", "picked"]
    #: A topic picked from the map: its hidden OpenAlex label narrows the search.
    area_id: KbEntityId | None = None


class KbResearchCreate(KbContractRequest):
    description: Annotated[str, Field(min_length=1, max_length=4000)]
    area_id: KbEntityId | None = None
    dates: KbDateWindow | None = None
    #: EX2: the card as the user left it (proposed kept/edited, typed, picked). ``None`` = the chat agent
    #: derives the topics and the task starts with them (the in-chat tool path asks through the permission).
    topics: list[KbResearchTopic] | None = Field(default=None, min_length=1, max_length=4)
    #: EX2: the proposal's title the «+» card showed; ``None`` = the first card topic names the task.
    title: Annotated[str, Field(min_length=1, max_length=80)] | None = None


class KbResearchProposal(BaseModel):
    """EX2: what "+ New research task" shows on its card before anything starts: the chat agent's title and
    proposed topics for the description (``POST /kb/research/proposals`` with a ``KbResearchCreate`` body
    whose ``topics`` is ``None``). Nothing leaves for science sources here; the description goes only to the
    chat agent."""

    title: str
    topics: list[KbResearchTopic]


class KbResearchTask(BaseModel):
    id: KbEntityId
    title: str
    description: str
    chat_id: str
    origin_chat_id: str | None
    area_id: KbEntityId | None
    #: EX2: the topics the task searches and judges by (the card as allowed).
    topics: list[KbResearchTopic]
    run: KbExploreJob
    finding_count: int
    created_at: datetime
    updated_at: datetime


class KbResearchTasks(BaseModel):
    tasks: list[KbResearchTask]
    next_cursor: str | None


class KbResearchPermission(BaseModel):
    """The ``skaz_research_start`` card and, once allowed, the compact task pointer in the chat.

    B3 adds this model to the ``KbMessagePart`` union, so ``type`` is its discriminator.
    """

    type: Literal["research"]
    id: KbEntityId
    kind: Literal["research_start"] = "research_start"
    engine: Literal["codex", "claude_code", "hermes", "opencode"]
    chat_id: str
    arguments: KbResearchCreate
    #: What would leave this computer (decision C0-1): the search topics the agent derived from the
    #: description. The description itself never leaves; the card shows these before Allow.
    topics: list[str]
    status: Literal["pending", "allowed", "denied", "cancelled"]
    #: Allowed by the chat's "Allow in this chat" (no question was asked).
    auto: bool
    #: Cancelled: why.
    reason: str | None
    task_id: KbEntityId | None
    task_title: str | None
    task_state: KbExploreJobState | None
    created_at: datetime


class KbResearchDecide(KbContractRequest):
    decision: Literal["allow", "allow_chat", "deny"]
    #: EX2: the card as the user left it (proposed kept/edited/removed, typed, picked);
    #: ``None`` = as proposed.
    #: At least one topic to allow; 4 x 72 chars fit the one search line.
    topics: list[KbResearchTopic] | None = Field(default=None, min_length=1, max_length=4)


class KbResearchGrant(BaseModel):
    chat_id: str
    kind: Literal["research_start"] = "research_start"
    allowed: bool
    granted_at: datetime | None


class KbResearchToolResult(BaseModel):
    status: Literal["started", "denied", "cancelled"]
    task: KbResearchTask | None
    permission_id: KbEntityId


class KbExploreRead(KbContractRequest):
    area_id: KbEntityId | None = None
    task_id: KbEntityId | None = None
    cursor: str | None = None
    limit: Annotated[int, Field(ge=1, le=100)] = 30


class KbExploreSnapshot(BaseModel):
    map: KbAreaMap
    findings: KbFindings
    signals: KbSignals
    tasks: KbResearchTasks
