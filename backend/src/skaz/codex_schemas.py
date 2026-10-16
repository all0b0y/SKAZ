"""UI contracts for Codex; no secret-bearing settings or arbitrary process arguments."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

PURPOSE_FLAGS = ("assistant_enabled", "notes_enabled")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CodexSettings(StrictModel):
    """Assistant and Notes each choose Codex or their API profile on their own.

    With Codex off, ``*_api_agent`` runs the purpose's API profile as a tool-driven
    agent; otherwise the API profile answers in one pass.

    The single legacy ``enabled`` flag is accepted on input only: it fills a
    per-purpose flag that the document does not state, and is never returned.
    """

    assistant_enabled: bool = False
    notes_enabled: bool = False
    assistant_model: str = Field(default="", max_length=256)
    assistant_effort: str = Field(default="", max_length=32)
    notes_model: str = Field(default="", max_length=256)
    notes_effort: str = Field(default="", max_length=32)
    ask_before_large: bool = True
    #: When the purpose uses its API profile (Codex off), run it as the same tool-driven
    #: agent Codex is: it reads the library through SKAZ tools instead of one fixed pass.
    assistant_api_agent: bool = False
    notes_api_agent: bool = False

    @model_validator(mode="before")
    @classmethod
    def _legacy_enabled(cls, data: Any) -> Any:
        if not isinstance(data, dict) or "enabled" not in data:
            return data
        data = dict(data)
        legacy = data.pop("enabled")
        if type(legacy) is not bool:
            raise ValueError("enabled must be a boolean")
        for flag in PURPOSE_FLAGS:
            data.setdefault(flag, legacy)
        return data


class CreateChat(StrictModel):
    session_id: str = Field(min_length=1, max_length=128)
    scope: Literal["session", "group", "all"] = "session"


class UpdateChat(StrictModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    selected: Literal[True] | None = None
    # Only a chat without messages accepts another scope.
    scope: Literal["session", "group", "all"] | None = None


class SendMessage(StrictModel):
    question: str = Field(min_length=1, max_length=16000)
    confirmed_large: bool = False


class GenerateNote(StrictModel):
    language: str = Field(default="ru", max_length=80)
    detail: str = Field(default="standard", max_length=2000)


class Consent(StrictModel):
    consent: bool = False


class Confirmation(StrictModel):
    confirmed: bool = False
