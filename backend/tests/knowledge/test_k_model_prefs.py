"""Agents, providers and models shown in the picker; favourites; human model names (0.3.1 K2/K4)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import EngineId, ModelOption
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.hub import build_agents_hub
from skaz.knowledge.agents.model_prefs import (
    DEFAULT_VISIBLE_PER_PROVIDER,
    Change,
    ModelPrefs,
    PrefsError,
    display,
    display_parts,
    hermes_provider,
)
from tests.knowledge.test_agent_install import FakeExecutor


@pytest.mark.parametrize(
    ("model", "name", "tag"),
    [
        ("claude-opus-5-5", "Opus 5.5", None),
        ("claude-haiku-4-5-20251001", "Haiku 4.5", None),
        ("gpt-6.1-sol", "GPT-6.1-sol", None),
        ("anthropic/claude-sonnet-5[1m]", "Sonnet 5", "1M"),
        ("gemini-2.5-pro", "Gemini 2.5 Pro", None),
        ("glm-5.2-fast", "GLM 5.2", "Fast"),
        ("deepseek-v4.1-flash", "DeepSeek V4.1", "Flash"),
        ("qwen3-235b-a22b-instruct-2507-UD-Q4_K_XL", "Qwen3 235B A22B", "Q4"),
        ("minimax-m3-preview", "MiniMax M3", "Preview"),
    ],
)
def test_names_follow_hermes_desktop(model: str, name: str, tag: str | None) -> None:
    assert display_parts(model) == (name, tag)


def test_hermes_choice_ids_keep_their_provider() -> None:
    assert hermes_provider("openai-codex:gpt-6.1-sol") == ("openai-codex", "gpt-6.1-sol")
    assert hermes_provider("custom:ollama:llama3:8b") == ("custom:ollama", "llama3:8b")
    assert hermes_provider("openrouter:meta/llama-4:free") == ("openrouter", "meta/llama-4:free")
    shown = display(
        "hermes", ModelOption("openai-codex:gpt-6.1-sol", "OpenAI Codex · gpt-6.1-sol"), "Hermes Agent"
    )
    assert (shown.provider, shown.provider_label, shown.name) == (
        "openai-codex",
        "ChatGPT",  # Accounts & keys v3: the provider is named as on its chip
        "GPT-6.1-sol",
    )
    unknown = display("hermes", ModelOption("acme:big-model", "Acme Labs · big-model"), "Hermes Agent")
    assert (unknown.provider_label, unknown.name) == ("Acme Labs", "Big Model")
    codex = display("codex", ModelOption("gpt-5.5", "GPT-5.5"), "Codex")
    assert (codex.provider, codex.provider_label, codex.name) == ("codex", "Codex", "GPT-5.5")


class Settings:
    def __init__(self) -> None:
        self.data: dict[str, Any] = {}

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self.data[key] = value


def hermes_models(count: int, provider: str = "openrouter") -> list[ModelOption]:
    return [ModelOption(f"{provider}:model-{i}", f"OpenRouter · model-{i}") for i in range(count)]


def test_first_fifty_per_provider_are_shown_and_choices_win() -> None:
    prefs = ModelPrefs(Settings())
    options = [*hermes_models(60), *hermes_models(3, "anthropic")]
    agent = prefs.agent("hermes", options, "Hermes Agent")
    shown = [row.option.id for row in agent.models if row.visible]
    assert len(shown) == DEFAULT_VISIBLE_PER_PROVIDER + 3
    assert "openrouter:model-50" not in shown and "anthropic:model-2" in shown
    assert [(p.id, p.shown, p.total) for p in agent.providers] == [
        ("openrouter", 50, 60),
        ("anthropic", 3, 3),
    ]
    prefs.apply(
        [
            Change("model", "hermes", model="openrouter:model-55", value=True),
            Change("model", "hermes", model="openrouter:model-1", value=False),
        ],
        default_engine="codex",
        models={"hermes": options},
        names={"hermes": "Hermes Agent"},
    )
    again = {row.option.id: row for row in prefs.agent("hermes", options, "Hermes Agent").models}
    assert again["openrouter:model-55"].visible and not again["openrouter:model-55"].default_visible
    assert not again["openrouter:model-1"].visible
    # A model that appears after the user curated the list follows the default rule (top 50 → shown).
    newer = [ModelOption("openrouter:brand-new", "OpenRouter · brand-new"), *options]
    assert {row.option.id: row.visible for row in prefs.agent("hermes", newer, "Hermes Agent").models}[
        "openrouter:brand-new"
    ]


def test_defaults_hide_all_providers_agents_and_favourites() -> None:
    settings = Settings()
    prefs = ModelPrefs(settings)
    options = hermes_models(4)
    common: dict[str, Any] = {
        "default_engine": "codex",
        "models": {"hermes": options},
        "names": {"hermes": "Hermes Agent"},
    }
    prefs.apply([Change("hide_all", "hermes", provider="openrouter")], **common)
    assert not any(row.visible for row in prefs.agent("hermes", options, "Hermes Agent").models)
    prefs.apply([Change("defaults", "hermes", provider="openrouter")], **common)
    assert all(row.visible for row in prefs.agent("hermes", options, "Hermes Agent").models)
    prefs.apply(
        [
            Change("provider", "hermes", provider="openrouter", value=False),
            Change("agent", "hermes", value=False),
        ],
        **common,
    )
    agent = prefs.agent("hermes", options, "Hermes Agent")
    assert not agent.visible and not agent.providers[0].visible
    with pytest.raises(PrefsError):
        prefs.apply([Change("agent", "codex", value=False)], **common)
    prefs.apply(
        [
            Change("favorite", "hermes", model="openrouter:model-2"),
            Change("favorite", "codex", model="gpt-5.5"),
            Change("favorite", "hermes", model="openrouter:model-0"),
        ],
        **common,
    )
    assert prefs.favorites() == [
        ("hermes", "openrouter:model-2"),
        ("codex", "gpt-5.5"),
        ("hermes", "openrouter:model-0"),
    ]
    prefs.apply([Change("favorite", "codex", model="gpt-5.5", value=False)], **common)
    assert prefs.favorites() == [("hermes", "openrouter:model-2"), ("hermes", "openrouter:model-0")]


async def test_api_lists_and_changes_models(
    kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path
) -> None:
    runtime = kb_app.state.runtime
    engines: dict[EngineId, Any] = {
        "codex": FakeEngine("codex", models=[ModelOption("gpt-5.5", "GPT-5.5", ("low", "high"), "high")]),
        "claude_code": FakeEngine("claude_code", models=[ModelOption("claude-opus-5-5", "Opus 5.5")]),
        "hermes": FakeEngine("hermes", models=hermes_models(2)),
    }
    runtime.kb_agents = build_agents_hub(
        tmp_path / "d",
        settings=runtime.kb.settings,
        codex=None,  # type: ignore[arg-type]
        engines=engines,
        executor=FakeExecutor([([], 0)]),
        locate_cli=lambda name: None,
        user_home=tmp_path / "h",
    )
    body = (await kb_client.get("/kb/agents")).json()
    hermes = next(a for a in body["agents"] if a["id"] == "hermes")
    assert hermes["visible"] and hermes["providers"] == [
        {"id": "openrouter", "label": "OpenRouter", "visible": True, "shown": 2, "total": 2}
    ]
    assert hermes["models"][0]["name"] == "Model 0" and hermes["models"][0]["provider_label"] == "OpenRouter"
    assert body["favorites"] == []
    changed = await kb_client.patch(
        "/kb/agents/models",
        json={
            "changes": [
                {"kind": "favorite", "engine": "hermes", "model": "openrouter:model-1"},
                {"kind": "model", "engine": "hermes", "model": "openrouter:model-0", "value": False},
                {"kind": "agent", "engine": "claude_code", "value": False},
            ]
        },
    )
    assert changed.status_code == 200
    after = changed.json()
    assert after["favorites"] == [{"engine": "hermes", "model": "openrouter:model-1"}]
    hermes = next(a for a in after["agents"] if a["id"] == "hermes")
    assert [m["visible"] for m in hermes["models"]] == [False, True] and hermes["models"][1]["favorite"]
    assert not next(a for a in after["agents"] if a["id"] == "claude_code")["visible"]
    default = await kb_client.patch(
        "/kb/agents/models", json={"changes": [{"kind": "agent", "engine": "codex", "value": False}]}
    )
    assert default.status_code == 409
    # Choosing a hidden agent as the default shows it again.
    put = await kb_client.put("/kb/agents/default", json={"engine": "claude_code"})
    assert next(a for a in put.json()["agents"] if a["id"] == "claude_code")["visible"]


def test_an_agent_without_models_has_no_sections() -> None:
    assert ModelPrefs(Settings()).agent("codex", (), "Codex").providers == ()
