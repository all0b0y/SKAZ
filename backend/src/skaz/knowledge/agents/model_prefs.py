"""Which agents, providers and models the picker shows, and the favourites (0.3.1 K2/K4, decision Q10/Q15).

One mechanism for every agent, kept in SKAZ's settings on the backend (key ``models.visibility``):

* an agent can be hidden from the picker (it stays in Settings and its chats keep working; the
  default agent can't be hidden);
* a provider of an agent can be hidden (Hermes' providers; Codex and Claude Code are their own
  single provider);
* each model is shown or hidden: the user's explicit choice wins, otherwise the first
  ``DEFAULT_VISIBLE_PER_PROVIDER`` of its provider are shown in the order the agent lists them —
  so a model that appears after the user curated the list follows the same default rule;
* favourites are kept in the order they were added.

Model names follow Hermes desktop's ``apps/desktop/src/lib/model-status-label.ts`` (MIT, © Nous
Research; read at main a2ad0d5 2026-10-18): the provider prefix is dropped, ``claude-`` ids are
dotted ("Opus 5.5"), ``gpt-`` keeps "GPT-", words are title-cased with vendor casing, and a trailing
variant (``-fast``, ``-preview``…) or a date pin becomes a grey tag instead of part of the name.
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from ..errors import KnowledgeError
from .engine import EngineId, ModelOption
from .hermes_providers import pool_name

PREFS_KEY = "models.visibility"
DEFAULT_VISIBLE_PER_PROVIDER = 50
DEFAULT_AGENT_HIDDEN = "The default agent can't be hidden. Choose another default agent first."


class _Settings(Protocol):
    def get(self, key: str, default: Any = None) -> Any: ...

    def set(self, key: str, value: Any) -> None: ...


class PrefsError(KnowledgeError):
    status_code = 409


# -- names ----------------------------------------------------------------------------------------

_VARIANTS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"-fast$", re.I), "Fast"), (re.compile(r"-flash$", re.I), "Flash"),
    (re.compile(r"-thinking$", re.I), "Thinking"), (re.compile(r"-preview$", re.I), "Preview"),
    (re.compile(r"-latest$", re.I), "Latest"),
)
_VENDOR_CASING: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(rf"\b{word}\b"), cased) for word, cased in (
        ("Deepseek", "DeepSeek"), ("Glm", "GLM"), ("Minimax", "MiniMax"), ("Openai", "OpenAI"),
        ("Ernie", "ERNIE"), ("Mimo", "MiMo"), ("Bge", "BGE"), ("Vl", "VL"), ("It", "IT"), ("Fp8", "FP8"),
        ("Ai", "AI"),
    ))
_PARAMS = re.compile(r"\b(a?)(\d+(?:\.\d+)?)b\b", re.I)
_QUANT = re.compile(r"-(?:UD-)?(Q\d(?:_[A-Z0-9]+)*|IQ\d(?:_[A-Z0-9]+)*|F16|BF16)$", re.I)
_CONTEXT = re.compile(r"\[(\d+[mk])\]$", re.I)
_DATE_PIN = re.compile(r"-\d{8}$")


def _title(text: str) -> str:
    return re.sub(r"\b\w", lambda m: m.group(0).upper(), text).strip()


def _vendor(text: str) -> str:
    cased = _PARAMS.sub(lambda m: f"{m.group(1).upper()}{m.group(2)}B", text)
    for pattern, replacement in _VENDOR_CASING:
        cased = pattern.sub(replacement, cased)
    return cased


def _pretty(base: str) -> str:
    if re.match(r"^claude-", base, re.I):
        return _vendor(_title(re.sub(r"-", " ", re.sub(r"(\d)-(?=\d)", r"\1.", re.sub(r"^claude-", "", base,
                                                                                       flags=re.I)))))
    if re.match(r"^gpt-", base, re.I):
        return re.sub(r"^gpt-", "GPT-", base, flags=re.I)
    if re.match(r"^gemini-", base, re.I):
        return _vendor(_title(re.sub(r"^gemini-", "Gemini ", base, flags=re.I).replace("-", " ")))
    return _vendor(_title(base.replace("-", " ")))


def display_parts(model: str) -> tuple[str, str | None]:
    """``(name, tag)`` of a model id, e.g. ``claude-opus-5-5-20260101`` → ``("Opus 5.5", None)``."""
    base = model.strip().rsplit("/", 1)[-1]
    variant = quant = ""
    progress = True
    while progress:
        progress = False
        if not variant:
            for pattern, label in _VARIANTS:
                if pattern.search(base):
                    variant, base, progress = label, pattern.sub("", base), True
                    break
        if not quant:
            found = _QUANT.search(base)
            if found:
                quant = found.group(1).split("_")[0].upper()
                base = re.sub(r"-(?:Instruct|Chat)(?:-\d{4})?$", "", base[: found.start()], flags=re.I)
                progress = True
    tags = [tag for tag in (variant, quant) if tag]
    window = _CONTEXT.search(base)
    if window:
        tags.append(window.group(1).upper())
        base = base[: window.start()]
    base = _DATE_PIN.sub("", base)
    return (_pretty(base) or model.strip() or "No model"), (" ".join(tags) or None)


@dataclass(frozen=True)
class ModelDisplay:
    provider: str
    provider_label: str
    name: str
    tag: str | None


def hermes_provider(model_id: str) -> tuple[str, str]:
    """``(provider, model)`` of Hermes' ``provider:model`` choice id (``acp_adapter/model_catalog.py``
    ``encode_model_choice``; a ``custom:<name>`` endpoint keeps both parts)."""
    parts = model_id.split(":")
    if len(parts) < 2:
        return "", model_id
    if parts[0] == "custom" and len(parts) > 2:
        return f"custom:{parts[1]}", ":".join(parts[2:])
    return parts[0], ":".join(parts[1:])


def display(engine: EngineId, option: ModelOption, agent_name: str) -> ModelDisplay:
    """How the picker names a model: provider section and a human name (decision Q10)."""
    if engine == "opencode":
        # OpenCode's ``provider/model`` ids and its own model names (W-1); a name that repeats
        # across providers carries `` · <provider>`` in the label, which the section already says.
        provider = option.id.split("/", 1)[0] if "/" in option.id else "opencode"
        name = option.label.removesuffix(f" · {provider}") or option.id
        label = pool_name(provider) if provider != "opencode" else agent_name
        return ModelDisplay(provider, label, name, None)
    if engine != "hermes":
        # Codex and Claude Code give their own display names; the agent is the one provider.
        return ModelDisplay(engine, agent_name, option.label or option.id, None)
    provider, model = hermes_provider(option.id)
    label_provider = option.label.split(" · ", 1)[0].strip() if " · " in option.label else ""
    name, tag = display_parts(model or option.id)
    known = pool_name(provider) if provider else ""
    provider_label = known if known and known != provider else (label_provider or provider or "Hermes")
    return ModelDisplay(provider or "hermes", provider_label, name, tag)


# -- visibility ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class ModelView:
    option: ModelOption
    display: ModelDisplay
    visible: bool
    #: Shown by the default rule (first 50 of its provider), whatever the user chose.
    default_visible: bool
    favorite: bool


@dataclass(frozen=True)
class ProviderView:
    id: str
    label: str
    visible: bool
    shown: int
    total: int


@dataclass(frozen=True)
class AgentModels:
    visible: bool
    providers: tuple[ProviderView, ...]
    models: tuple[ModelView, ...]


ChangeKind = Literal["agent", "provider", "model", "favorite", "defaults", "hide_all"]


@dataclass(frozen=True)
class Change:
    kind: ChangeKind
    engine: EngineId
    provider: str | None = None
    model: str | None = None
    #: agent / provider / model: shown or not; favorite: on or off.
    value: bool = True


def _key(engine: str, item: str) -> str:
    return f"{engine}::{item}"


class ModelPrefs:
    """Read and change ``models.visibility`` (a JSON object in SKAZ's settings)."""

    def __init__(self, settings: _Settings) -> None:
        self.settings = settings

    def raw(self) -> dict[str, Any]:
        value = self.settings.get(PREFS_KEY) or {}
        data = value if isinstance(value, dict) else {}
        return {
            "hidden_agents": [str(x) for x in data.get("hidden_agents") or [] if isinstance(x, str)],
            "providers": {str(k): bool(v) for k, v in (data.get("providers") or {}).items()},
            "models": {str(k): bool(v) for k, v in (data.get("models") or {}).items()},
            "favorites": [str(x) for x in data.get("favorites") or [] if isinstance(x, str)],
        }

    def favorites(self, data: Mapping[str, Any] | None = None) -> list[tuple[str, str]]:
        """``(engine, model)`` in the order they were added."""
        out = []
        for item in (data if data is not None else self.raw())["favorites"]:
            engine, sep, model = item.partition("::")
            if sep and model:
                out.append((engine, model))
        return out

    def agent(self, engine: EngineId, options: Sequence[ModelOption], agent_name: str,
              data: Mapping[str, Any] | None = None) -> AgentModels:
        """``data``: :meth:`raw` read earlier (off the event loop); read here when not given."""
        data = data if data is not None else self.raw()
        favorites = set(data["favorites"])
        seen: dict[str, int] = {}
        labels: dict[str, str] = {}
        rows: list[ModelView] = []
        for option in options:
            shown = display(engine, option, agent_name)
            place = seen.get(shown.provider, 0)
            seen[shown.provider] = place + 1
            labels.setdefault(shown.provider, shown.provider_label)
            default = place < DEFAULT_VISIBLE_PER_PROVIDER
            explicit = data["models"].get(_key(engine, option.id))
            rows.append(ModelView(option, shown, default if explicit is None else explicit, default,
                                  _key(engine, option.id) in favorites))
        providers = tuple(ProviderView(
            provider, labels[provider], data["providers"].get(_key(engine, provider), True),
            sum(1 for row in rows if row.display.provider == provider and row.visible),
            sum(1 for row in rows if row.display.provider == provider)) for provider in seen)
        return AgentModels(engine not in data["hidden_agents"], providers, tuple(rows))

    def apply(self, changes: Iterable[Change], *, default_engine: EngineId,
              models: Mapping[EngineId, Sequence[ModelOption]], names: Mapping[EngineId, str]) -> None:
        data = self.raw()
        for change in changes:
            engine = change.engine
            if change.kind == "agent":
                hidden = [item for item in data["hidden_agents"] if item != engine]
                if not change.value:
                    if engine == default_engine:
                        raise PrefsError(DEFAULT_AGENT_HIDDEN)
                    hidden.append(engine)
                data["hidden_agents"] = hidden
            elif change.kind == "provider" and change.provider:
                data["providers"][_key(engine, change.provider)] = change.value
            elif change.kind == "model" and change.model:
                data["models"][_key(engine, change.model)] = change.value
            elif change.kind == "favorite" and change.model:
                key = _key(engine, change.model)
                data["favorites"] = [item for item in data["favorites"] if item != key]
                if change.value:
                    data["favorites"].append(key)
            elif change.kind in ("defaults", "hide_all"):
                for option in models.get(engine, ()):
                    section = display(engine, option, names.get(engine, "")).provider
                    if change.provider and section != change.provider:
                        continue
                    key = _key(engine, option.id)
                    if change.kind == "defaults":
                        data["models"].pop(key, None)
                    else:
                        data["models"][key] = False
        self.settings.set(PREFS_KEY, data)
