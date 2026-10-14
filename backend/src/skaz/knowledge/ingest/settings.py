"""Wiki settings of the new model, kept in the ``settings`` table of ``knowledge.sqlite3``.

Keys are flat so other areas can read one of them directly (``wiki_language``).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from ..errors import KnowledgeError
from ..store.repositories import SettingsRepository

WIKI_LANGUAGE = "wiki_language"
WIKI_ENGINE = "wiki_engine"
AUTO_ADD_FILES_LINKS = "auto_add_files_links"
AUTO_ADD_TEXT = "auto_add_text"
DEFAULT_LANGUAGE = "en"
ENGINE_IDS = ("codex", "claude_code", "hermes")
_LANGUAGE = re.compile(r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$")


class InvalidSetting(KnowledgeError):
    status_code = 422


@dataclass(frozen=True)
class WikiSettings:
    #: One language for the whole wiki (decision 9). ``en`` until onboarding asks.
    language: str
    #: False while the language is the built-in default nobody chose yet.
    language_chosen: bool
    #: Engine that writes the wiki; ``None`` = the app's default engine.
    engine: str | None
    #: Decision 15: files and links go to the wiki by default, pasted text does not.
    auto_add_files_links: bool
    auto_add_text: bool


def read_settings(repo: SettingsRepository) -> WikiSettings:
    language = repo.get(WIKI_LANGUAGE)
    engine = repo.get(WIKI_ENGINE)
    return WikiSettings(
        language=language if isinstance(language, str) and _LANGUAGE.match(language) else DEFAULT_LANGUAGE,
        language_chosen=isinstance(language, str) and bool(_LANGUAGE.match(language)),
        engine=engine if engine in ENGINE_IDS else None,
        auto_add_files_links=bool(repo.get(AUTO_ADD_FILES_LINKS, True)),
        auto_add_text=bool(repo.get(AUTO_ADD_TEXT, False)),
    )


def update_settings(repo: SettingsRepository, *, language: str | None = None, engine: str | None = None,
                    clear_engine: bool = False, auto_add_files_links: bool | None = None,
                    auto_add_text: bool | None = None) -> WikiSettings:
    if language is not None:
        if not _LANGUAGE.match(language):
            raise InvalidSetting("Use a language code such as en or ru.")
        repo.set(WIKI_LANGUAGE, language)
    if clear_engine:
        repo.set(WIKI_ENGINE, None)
    elif engine is not None:
        if engine not in ENGINE_IDS:
            raise InvalidSetting("Unknown agent. Choose Codex, Claude Code or Hermes Agent.")
        repo.set(WIKI_ENGINE, engine)
    if auto_add_files_links is not None:
        repo.set(AUTO_ADD_FILES_LINKS, auto_add_files_links)
    if auto_add_text is not None:
        repo.set(AUTO_ADD_TEXT, auto_add_text)
    return read_settings(repo)
