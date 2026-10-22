"""The isolated ``thread/start`` parameters every Codex agent thread is opened with.

Features that could reach files, a shell, the web or subagents are switched off;
the knowledge agents (``knowledge/agents/codex.py``) and the connection check use it.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from copy import deepcopy
from pathlib import Path
from typing import Any

DISABLED_FEATURES = (
    "shell_tool", "unified_exec", "shell_snapshot", "multi_agent", "multi_agent_v2",
    "apps", "plugins", "hooks", "browser_use", "browser_use_external", "computer_use",
    "image_generation", "memories", "skill_mcp_dependency_install", "view_image",
    # Model metadata can require the isolated JS tool bridge even when the
    # optional code_mode feature is off. Disabling its host breaks Luna's
    # registered tools. This bridge has no Node/filesystem/network; execution
    # environments remain empty and shell/web/subagent tools stay disabled.
    "code_mode", "workspace_dependencies",
)


def dynamic_tool(name: str, description: str, input_schema: Mapping[str, Any]) -> dict[str, Any]:
    """One ``dynamicTools`` entry of ``thread/start``."""
    return {"type": "function", "name": name, "description": description,
            "inputSchema": deepcopy(dict(input_schema))}


def thread_start_params(
    *, cwd: Path, model: str | None, base_instructions: str, dynamic_tools: list[dict[str, Any]],
    disabled_features: Iterable[str] = DISABLED_FEATURES,
) -> dict[str, Any]:
    """Isolated ephemeral thread: no environments (files/shell), no approvals, no web, features off."""
    return {
        "cwd": str(cwd), **({"model": model} if model else {}), "ephemeral": True,
        "environments": [], "approvalPolicy": "never",
        "config": {"web_search": "disabled", **{f"features.{name}": False for name in disabled_features}},
        "baseInstructions": base_instructions,
        "dynamicTools": dynamic_tools,
    }


def search_thread_params(
    *, cwd: Path, base_instructions: str, disabled_features: Iterable[str] = DISABLED_FEATURES,
) -> dict[str, Any]:
    """W-3b's clean search run: a fresh ephemeral thread with Codex's own web search on and nothing
    else — no environments (files/shell), read-only sandbox, no approvals, no SKAZ tools, features off.
    ``sandbox`` + ``environments: []`` verified on codex-cli 0.160.0 (``thread/start`` answers
    ``sandbox: {type: readOnly, networkAccess: false}``)."""
    return {
        "cwd": str(cwd), "ephemeral": True, "environments": [], "approvalPolicy": "never",
        "sandbox": "read-only",
        "config": {"web_search": "live", **{f"features.{name}": False for name in disabled_features}},
        "baseInstructions": base_instructions,
        "dynamicTools": [],
    }
