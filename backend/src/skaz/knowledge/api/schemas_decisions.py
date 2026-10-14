"""Pydantic models of ``/kb/decisions`` (area D1).

Same rules as ``schemas.py``: ``Kb`` prefix, no defaults on response models.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

KbDecisionProvider = Literal["off", "openrouter_jev", "local"]
KbLocalDecisionState = Literal["not_downloaded", "downloading", "failed", "ready", "running"]
KbLocalDecisionFailure = Literal["no_space", "no_network", "checksum", "start_failed"]


class KbLocalDecisions(BaseModel):
    state: KbLocalDecisionState
    #: 0..1 while downloading; ``null`` otherwise.
    progress: float | None
    downloaded_bytes: int
    total_bytes: int
    #: Set when ``state`` is ``failed``.
    reason: KbLocalDecisionFailure | None
    #: Plain-English explanation for ``failed``.
    message: str | None
    #: Free disk space the download still needs.
    required_bytes: int
    model_id: str
    model_title: str
    model_license: str
    model_url: str
    server_build: str
    server_license: str


class KbDecisionStats(BaseModel):
    #: Questions the decision layer answered itself.
    decided: int
    #: Questions it could not answer confidently; each went to the writing model.
    undecided: int


class KbDecisions(BaseModel):
    provider: KbDecisionProvider
    #: The user allowed sending wiki text to OpenRouter for decisions.
    cloud_consent: bool
    #: An OpenRouter key is stored (presence only).
    openrouter_key: bool
    cloud_model: str
    local: KbLocalDecisions
    stats: KbDecisionStats


class KbDecisionProviderUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: KbDecisionProvider
    #: ``null`` keeps the stored consent. ``openrouter_jev`` requires it to be (or become) true.
    cloud_consent: bool | None = Field(default=None)


class KbDecisionTest(BaseModel):
    provider: KbDecisionProvider
    #: False: the decider answered ``Undecided`` — see ``reason``.
    decided: bool
    answer: str | None
    probability: float | None
    reason: str | None
    elapsed_ms: int
