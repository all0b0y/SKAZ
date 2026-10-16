"""Codex version gate: a minimum version plus a shape check of the replies SKAZ reads.

Authored fixtures only: a fake `codex` executable that prints a version and a fake
RPC returning canned replies. This proves the gate's logic, not that a real Codex
release works; that is checked separately with free local calls.
"""
from __future__ import annotations

import stat
from pathlib import Path
from typing import Any

import pytest

from skaz.gateways import codex_connection
from skaz.gateways.codex_connection import CodexConnection, parse_codex_version
from skaz.gateways.codex_locate import CodexLocation

ACCOUNT = {"account": {"type": "chatgpt", "email": "fixture@example.invalid"}}
MODELS = {
    "data": [
        {"model": "gpt-a", "displayName": "GPT A", "hidden": False,
         "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "high"}]},
        {"model": "gpt-hidden", "displayName": "Hidden", "hidden": True,
         "supportedReasoningEfforts": []},
    ],
    "nextCursor": None,
}


class _Rpc:
    def __init__(self, replies: dict[str, Any]) -> None:
        self.replies = replies
        self.requests: list[str] = []

    async def __aenter__(self) -> _Rpc:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def request(self, method: str, params: dict[str, Any]) -> Any:
        self.requests.append(method)
        return self.replies[method]


def _connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, version: str,
    replies: dict[str, Any] | None = None,
) -> tuple[CodexConnection, _Rpc]:
    binary = tmp_path / "bin" / "codex"
    binary.parent.mkdir(parents=True)
    binary.write_text(f'#!/bin/sh\necho "{version}"\n')
    binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(codex_connection, "locate_codex",
                        lambda: CodexLocation(binary=str(binary), node_dir=None))
    connection = CodexConnection(tmp_path / "account")
    rpc = _Rpc(replies if replies is not None else {"account/read": ACCOUNT, "model/list": MODELS})
    connection.rpc = lambda: rpc  # type: ignore[assignment,method-assign,return-value]
    return connection, rpc


@pytest.mark.parametrize(("text", "parsed"), [
    ("codex-cli 0.149.1", (0, 149, 1)),
    ("codex-cli 0.160.0", (0, 160, 0)),
    ("codex-cli 1.2.3-alpha.4", (1, 2, 3)),
    ("codex-cli 0.160", None),
    ("something else", None),
    ("", None),
])
def test_parse_codex_version(text: str, parsed: tuple[int, int, int] | None) -> None:
    assert parse_codex_version(text) == parsed


@pytest.mark.asyncio
@pytest.mark.parametrize("version", ["codex-cli 0.149.1", "codex-cli 0.160.0", "codex-cli 1.0.0"])
async def test_minimum_or_newer_version_connects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, version: str,
) -> None:
    connection, rpc = _connection(tmp_path, monkeypatch, version)
    view = await connection.check()
    assert view["status"] == "connected", view
    assert view["version"] == version
    assert view["error"] is None
    assert view["models"] == [{"id": "gpt-a", "label": "GPT A", "efforts": ["low", "high"]}]
    assert rpc.requests == ["account/read", "model/list"]


@pytest.mark.asyncio
async def test_older_version_is_outdated_with_the_required_minimum(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, rpc = _connection(tmp_path, monkeypatch, "codex-cli 0.148.9")
    view = await connection.check()
    assert view["status"] == "incompatible"
    assert view["error"] == "Codex 0.148.9 is outdated — version 0.149.1 or newer is required."
    assert view["path"] is not None
    assert rpc.requests == []  # an outdated binary is never spoken to


@pytest.mark.asyncio
async def test_unrecognised_version_output_is_reported_verbatim(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, rpc = _connection(tmp_path, monkeypatch, "weird build")
    view = await connection.check()
    assert view["status"] == "incompatible"
    assert view["error"] == "Unrecognised Codex version output: weird build"
    assert rpc.requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "reply"), [
    ("account/read", {"user": None}),
    ("account/read", {"account": {"kind": "chatgpt"}}),
    ("model/list", {"items": []}),
    ("model/list", {"data": [{"model": "gpt-a", "displayName": "GPT A"}], "nextCursor": None}),
    ("model/list", {"data": [{"model": "gpt-a", "displayName": "GPT A",
                              "supportedReasoningEfforts": ["low"]}], "nextCursor": None}),
    ("model/list", {"data": [], "nextCursor": 5}),
])
async def test_unexpected_reply_shape_is_incompatible_not_a_generic_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, method: str, reply: Any,
) -> None:
    replies = {"account/read": ACCOUNT, "model/list": MODELS, method: reply}
    connection, _rpc = _connection(tmp_path, monkeypatch, "codex-cli 0.160.0", replies)
    view = await connection.check()
    assert view["status"] == "incompatible", view
    assert view["error"] == (
        f"Codex 0.160.0 replied to {method} in an unexpected format; SKAZ cannot use this version."
    )
    assert view["models"] == []


@pytest.mark.asyncio
async def test_signed_out_reply_still_passes_the_shape_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    replies = {"account/read": {"account": None, "requiresOpenaiAuth": True}, "model/list": MODELS}
    connection, rpc = _connection(tmp_path, monkeypatch, "codex-cli 0.160.0", replies)
    view = await connection.check()
    assert view["status"] == "signed_out"
    assert rpc.requests == ["account/read"]
