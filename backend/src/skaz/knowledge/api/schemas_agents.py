"""Pydantic models of ``/kb/agents`` (area A2). Response models have no defaults (exact TS types)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

KbEngineId = Literal["codex", "claude_code", "hermes"]
KbAgentState = Literal["ready", "not_installed", "outdated", "signed_out", "unavailable", "preparing"]
KbAgentAction = Literal["install", "update", "login", "check", "prepare"]
KbInstallAction = Literal["install", "update", "prepare"]
KbInstallState = Literal["running", "succeeded", "failed", "cancelled"]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KbAgentModel(BaseModel):
    id: str
    label: str
    #: Empty when the agent has no reasoning levels (Hermes: set in Hermes itself).
    efforts: list[str]
    default_effort: str | None


class KbAgentInstallInfo(BaseModel):
    docs_url: str
    #: For "How to install manually": paste into Terminal.
    manual_command: str
    #: When SKAZ last checked the official instructions (YYYY-MM-DD).
    checked_on: str


class KbAgentFirstRun(BaseModel):
    """Hermes prepares its own environment once (B10); nothing starts until the user asks."""

    required_bytes: int
    prepared: bool
    #: "Hermes is preparing its environment (~1.5 GB, a few minutes)."
    note: str


class KbAgent(BaseModel):
    id: KbEngineId
    name: str
    state: KbAgentState
    installed: bool
    version: str | None
    min_version: str
    signed_in: bool
    incompatible: bool
    #: Plain-English reason when not ready.
    reason: str | None
    #: What fixes it: install / update / login (Hermes: model setup) / check again.
    action: KbAgentAction | None
    models: list[KbAgentModel]
    #: The model chosen inside the agent (Hermes: in SKAZ's own Hermes folder).
    current_model: str | None
    install: KbAgentInstallInfo
    #: The running install/update/prepare task, if any.
    install_task: str | None
    checked_at: str
    #: Agents that prepare an environment on first use (Hermes); ``null`` for the others.
    first_run: KbAgentFirstRun | None


class KbAgents(BaseModel):
    agents: list[KbAgent]
    #: Engine for new chats (Settings → Models).
    default: KbEngineId


class KbAgentDefault(_Request):
    engine: KbEngineId


class KbInstallStart(_Request):
    #: ``prepare``: Hermes' one-time environment preparation (~1.5 GB), only on this explicit request.
    action: KbInstallAction = "install"


class KbInstallLine(BaseModel):
    seq: int
    text: str
    at: str


class KbInstallTask(BaseModel):
    id: str
    engine: KbEngineId
    action: KbInstallAction
    state: KbInstallState
    #: Log lines after the requested ``after`` cursor.
    lines: list[KbInstallLine]
    #: Pass as ``after`` to get only newer lines.
    cursor: int
    #: Lines dropped from the start of a very long log.
    dropped: int
    reason: str | None
    version: str | None
    install: KbAgentInstallInfo
    started_at: str
    finished_at: str | None


class KbAgentLogin(_Request):
    #: Codex only: the ChatGPT privacy consent the existing sign-in flow requires.
    consent: bool = False


class KbAgentLoginResult(BaseModel):
    engine: KbEngineId
    #: ``terminal``: the agent's own sign-in/setup opened in Terminal; ``browser``: open ``url``.
    method: Literal["terminal", "browser"]
    url: str | None
    message: str
