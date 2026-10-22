"""Wiki settings of the new model, kept in the ``settings`` table of ``knowledge.sqlite3``.

Keys are flat so other areas can read one of them directly (``wiki_language``).
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from ..errors import KnowledgeError
from ..store.repositories import SettingsRepository

WIKI_LANGUAGE = "wiki_language"
WIKI_ENGINE = "wiki_engine"
WIKI_MODEL = "wiki_model"
WIKI_EFFORT = "wiki_effort"
#: The last model and reasoning chosen for each agent (models screen v2): switching back restores them.
WIKI_REMEMBERED = "wiki_remembered"
AUTO_ADD_FILES_LINKS = "auto_add_files_links"
AUTO_ADD_TEXT = "auto_add_text"
BACKGROUND_CONNECTIONS = "background_connections"
AUTO_CORRECTIONS = "auto_corrections"
#: C1-d "Wiki budget per material": characters in + out of the model for one material.
WIKI_BUDGET = "wiki_budget_characters"
#: PROVISIONAL — replace with 3× the measured spend of a normal material once the user's real run
#: (Codex · GPT-6.1-Sol · Low) is counted (user decision 14, 2026-10-20). No characters of a real
#: run are recorded yet. Estimate for the baseline PDF (30 850 characters, 2 parts, 62 concepts):
#: Notes ≈ 0.1M in + out, Concepts ≈ 0.2M, connections of 62 pages ≈ 0.4M → ≈ 0.7M; × 3 ≈ 2M.
PROVISIONAL_BUDGET_CHARACTERS = 2_000_000
MIN_BUDGET_CHARACTERS = 10_000
MAX_BUDGET_CHARACTERS = 1_000_000_000
DEFAULT_LANGUAGE = "en"
ENGINE_IDS = ("codex", "claude_code", "hermes", "opencode")
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
    #: Decision 5: background "Find connections" only with the user's permission (off by default).
    background_connections: bool = False
    #: Decision 3: confident recognition corrections are applied automatically (on by default).
    auto_corrections: bool = True
    #: A wiki-only model and its supported reasoning; never the chat selection.
    model: str | None = None
    effort: str | None = None
    #: engine → (model, reasoning) last chosen for it; restored when that agent is chosen again.
    remembered: Mapping[str, tuple[str, str | None]] = field(default_factory=dict)
    #: C1-d: characters in + out one material's processing may use before it pauses for Continue.
    budget: int = PROVISIONAL_BUDGET_CHARACTERS


def _remembered(raw: Any) -> dict[str, tuple[str, str | None]]:
    out: dict[str, tuple[str, str | None]] = {}
    if not isinstance(raw, dict):
        return out
    for engine, entry in raw.items():
        if engine not in ENGINE_IDS or not isinstance(entry, dict):
            continue
        model, effort = entry.get("model"), entry.get("effort")
        if isinstance(model, str) and model:
            out[engine] = (model, effort if isinstance(effort, str) and effort else None)
    return out


def read_settings(repo: SettingsRepository) -> WikiSettings:
    language = repo.get(WIKI_LANGUAGE)
    engine = repo.get(WIKI_ENGINE)
    model = repo.get(WIKI_MODEL)
    effort = repo.get(WIKI_EFFORT)
    return WikiSettings(
        language=language if isinstance(language, str) and _LANGUAGE.match(language) else DEFAULT_LANGUAGE,
        language_chosen=isinstance(language, str) and bool(_LANGUAGE.match(language)),
        engine=engine if engine in ENGINE_IDS else None,
        model=model if isinstance(model, str) and model else None,
        effort=effort if isinstance(effort, str) and effort and model else None,
        auto_add_files_links=bool(repo.get(AUTO_ADD_FILES_LINKS, True)),
        auto_add_text=bool(repo.get(AUTO_ADD_TEXT, False)),
        background_connections=bool(repo.get(BACKGROUND_CONNECTIONS, False)),
        auto_corrections=bool(repo.get(AUTO_CORRECTIONS, True)),
        remembered=_remembered(repo.get(WIKI_REMEMBERED)),
        budget=_budget(repo.get(WIKI_BUDGET)),
    )


def _budget(raw: Any) -> int:
    # A stored positive whole number is used as it is (even below today's minimum); else the default.
    if isinstance(raw, int) and not isinstance(raw, bool) and raw > 0:
        return raw
    return PROVISIONAL_BUDGET_CHARACTERS


def update_settings(repo: SettingsRepository, *, language: str | None = None, engine: str | None = None,
                    clear_engine: bool = False, auto_add_files_links: bool | None = None,
                    auto_add_text: bool | None = None, background_connections: bool | None = None,
                    auto_corrections: bool | None = None, model: str | None = None,
                    effort: str | None = None, clear_model: bool = False,
                    clear_effort: bool = False, budget: int | None = None) -> WikiSettings:
    current = read_settings(repo)
    if budget is not None and not MIN_BUDGET_CHARACTERS <= budget <= MAX_BUDGET_CHARACTERS:
        raise InvalidSetting(f"Choose a wiki budget from {MIN_BUDGET_CHARACTERS:,} to "
                             f"{MAX_BUDGET_CHARACTERS:,} characters.")
    next_engine = None if clear_engine else (engine if engine is not None else current.engine)
    engine_changed = next_engine != current.engine
    # Another agent without a model in the request: its last choice comes back (or none).
    restored = (current.remembered.get(next_engine) if engine_changed and model is None and not clear_model
                and next_engine is not None else None)
    next_model = (None if clear_model or (engine_changed and model is None and restored is None)
                  else restored[0] if restored is not None
                  else model if model is not None else current.model)
    model_changed = next_model != current.model
    next_effort = (None if clear_effort
                   else effort if effort is not None
                   else restored[1] if restored is not None
                   else None if engine_changed or model_changed else current.effort)
    for name, value, limit in (("model", next_model, 1024), ("reasoning", next_effort, 64)):
        if value is not None and (not value or value != value.strip() or len(value) > limit
                                  or any(ord(char) < 32 or ord(char) == 127 for char in value)):
            raise InvalidSetting(f"Choose a valid wiki {name}.")
    if next_model is not None and next_engine not in ENGINE_IDS:
        raise InvalidSetting("Choose a wiki agent before choosing its model.")
    if next_effort is not None and next_model is None:
        raise InvalidSetting("Choose a wiki model before choosing its reasoning.")
    if engine is not None and engine not in ENGINE_IDS:
        raise InvalidSetting("Unknown agent. Choose Codex, Claude Code or Hermes Agent.")
    if language is not None and not _LANGUAGE.match(language):
        raise InvalidSetting("Use a language code such as en or ru.")
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
    if background_connections is not None:
        repo.set(BACKGROUND_CONNECTIONS, background_connections)
    if auto_corrections is not None:
        repo.set(AUTO_CORRECTIONS, auto_corrections)
    if budget is not None:
        repo.set(WIKI_BUDGET, budget)
    repo.set(WIKI_MODEL, next_model)
    repo.set(WIKI_EFFORT, next_effort)
    if next_engine in ENGINE_IDS:
        remembered = {engine: {"model": m, "effort": e} for engine, (m, e) in current.remembered.items()}
        if next_model is not None:
            remembered[next_engine] = {"model": next_model, "effort": next_effort}
        elif clear_model:
            remembered.pop(next_engine, None)  # "agent's own setting" is the choice now
        repo.set(WIKI_REMEMBERED, remembered)
    return read_settings(repo)
