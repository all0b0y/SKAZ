"""Settings → Models → Recognition check (decision B20): which agent checks recordings.

``same_as_wiki`` (the default) runs the check on the agent of \"Wiki pages and notes\",
inside the ingest job; a chosen agent may also get its own model and effort; ``off``
skips the step and says so in the job journal. Kept in the ``settings`` table of
``knowledge.sqlite3`` beside the wiki settings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, cast

from ..ingest.settings import ENGINE_IDS, InvalidSetting
from ..store.repositories import SettingsRepository

ENGINE = "recognition_engine"
MODEL = "recognition_model"
EFFORT = "recognition_effort"
SAME_AS_WIKI = "same_as_wiki"
OFF = "off"
RecognitionEngine = Literal["same_as_wiki", "off", "codex", "claude_code", "hermes", "opencode"]
CHOICES: tuple[str, ...] = (SAME_AS_WIKI, OFF, *ENGINE_IDS)
#: A model id or an effort name as the agents list them (``gpt-5.5``, ``claude-opus-5-5``, ``high``).
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$")


@dataclass(frozen=True)
class RecognitionSettings:
    engine: RecognitionEngine = "same_as_wiki"
    #: Only with a chosen agent; ``None`` = that agent's default.
    model: str | None = None
    effort: str | None = None

    @property
    def off(self) -> bool:
        return self.engine == OFF

    @property
    def own_agent(self) -> str | None:
        """The agent chosen for the check, or ``None`` when it follows the wiki (or is off)."""
        return self.engine if self.engine in ENGINE_IDS else None


def read_recognition(repo: SettingsRepository) -> RecognitionSettings:
    engine = repo.get(ENGINE)
    if engine not in CHOICES:
        return RecognitionSettings()
    if engine not in ENGINE_IDS:
        return RecognitionSettings(engine=cast(RecognitionEngine, engine))
    model, effort = repo.get(MODEL), repo.get(EFFORT)
    return RecognitionSettings(
        engine=cast(RecognitionEngine, engine),
        model=model if isinstance(model, str) and _NAME.match(model) else None,
        effort=effort if isinstance(effort, str) and _NAME.match(effort) else None,
    )


def update_recognition(
    repo: SettingsRepository, *, engine: str, model: str | None = None, effort: str | None = None
) -> RecognitionSettings:
    """Replace the choice; a model or effort only goes with a chosen agent."""
    if engine not in CHOICES:
        raise InvalidSetting(
            "Unknown choice. Choose Same as wiki pages, Off, Codex, Claude Code or Hermes Agent."
        )
    if engine not in ENGINE_IDS and (model or effort):
        raise InvalidSetting("Choose an agent first: a model and effort go with a chosen agent.")
    for value in (model, effort):
        if value is not None and not _NAME.match(value):
            raise InvalidSetting("Unknown model or effort name.")
    repo.set(ENGINE, engine)
    repo.set(MODEL, model if engine in ENGINE_IDS else None)
    repo.set(EFFORT, effort if engine in ENGINE_IDS else None)
    return read_recognition(repo)
