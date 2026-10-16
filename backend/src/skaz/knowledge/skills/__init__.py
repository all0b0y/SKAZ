"""SKAZ's own skills folder (0.3.1 H): the catalog of skills SKAZ gives to its agents.

Only the files in this package folder count — never ``~/.claude``, ``~/.codex``,
``~/.hermes`` or Hermes' ``skills.external_dirs``. Each skill is a pinned copy of
an upstream ``SKILL.md`` (unchanged, with its LICENSE and a NOTICE) that is
updated only with SKAZ releases.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from ..errors import KnowledgeError

SKILLS_DIR = Path(__file__).resolve().parent
HUMANIZER = "humanizer"


class UnknownSkill(KnowledgeError):
    status_code = 404


@dataclass(frozen=True)
class SkazSkill:
    id: str
    name: str
    version: str
    license: str
    source_url: str
    #: The upstream commit the copy was taken from (its tag is ``v<version>``).
    commit: str
    path: Path
    text: str


@dataclass(frozen=True)
class _Pinned:
    id: str
    name: str
    version: str
    license: str
    source_url: str
    commit: str


_PINNED: tuple[_Pinned, ...] = (
    _Pinned(HUMANIZER, "Humanizer", "3.1.0", "MIT", "https://github.com/blader/humanizer",
            "225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8"),
)


@lru_cache(maxsize=1)
def catalog() -> tuple[SkazSkill, ...]:
    """Every skill of SKAZ's folder, read once (the files ship with the app and don't change)."""
    out: list[SkazSkill] = []
    for pinned in _PINNED:
        path = SKILLS_DIR / pinned.id / "SKILL.md"
        out.append(SkazSkill(pinned.id, pinned.name, pinned.version, pinned.license, pinned.source_url,
                             pinned.commit, path, path.read_text(encoding="utf-8")))
    return tuple(out)


def skill(skill_id: str) -> SkazSkill:
    for item in catalog():
        if item.id == skill_id:
            return item
    raise UnknownSkill("Unknown skill.")
