"""Parsing the structured answers of the ingest model (untrusted until checked)."""
from __future__ import annotations

import json
import re
from typing import Any, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

_FENCE = re.compile(r"^```[A-Za-z]*\s*\n(.*)\n```\s*$", re.DOTALL)


class AnswerInvalid(ValueError):
    """The answer is not JSON of the expected shape; the message is short and code-written."""


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class CiteOut(_Model):
    seg: int
    quote: str

    @field_validator("seg", mode="before")
    @classmethod
    def _seg(cls, value: Any) -> Any:
        if isinstance(value, str) and value.removeprefix("seg-").isdigit():
            return int(value.removeprefix("seg-"))
        return value


class BlockOut(_Model):
    kind: Literal["from_source", "connection", "explanation"]
    text: str
    cites: list[CiteOut] = Field(default_factory=list)
    links: list[str] = Field(default_factory=list)


class SectionOut(_Model):
    title: str
    blocks: list[BlockOut]


class NotesOut(_Model):
    sections: list[SectionOut]
    more: bool = False


class ConceptOut(_Model):
    title_in_wiki_language: str
    original: str | None = None
    aliases: list[str] = Field(default_factory=list)
    definition_blocks: list[BlockOut]
    related: list[str] = Field(default_factory=list)


class ConceptsOut(_Model):
    concepts: list[ConceptOut]
    more: bool = False


class MatchOut(_Model):
    choice: int


def _json(text: str) -> Any:
    stripped = text.strip()
    fenced = _FENCE.match(stripped)
    if fenced:
        stripped = fenced.group(1)
    try:
        return json.loads(stripped)
    except json.JSONDecodeError as error:
        raise AnswerInvalid(f"not JSON at line {error.lineno} column {error.colno}") from error


M = TypeVar("M", bound=BaseModel)


def parse_answer(text: str, model: type[M]) -> M:
    try:
        return model.model_validate(_json(text))
    except ValidationError as error:
        first = error.errors()[0]
        where = ".".join(str(part) for part in first["loc"]) or "answer"
        raise AnswerInvalid(f"{where}: {first['msg']}") from error
