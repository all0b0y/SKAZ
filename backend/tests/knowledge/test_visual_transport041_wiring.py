"""Failing-before / passing-after production wiring tests for V4 visual transport."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import shutil
import stat
import sys
import threading
from pathlib import Path
from typing import Any, Literal, Never

import httpx
import pytest
from fastapi import FastAPI

from skaz.gateways.codex_rpc import CodexRpc
from skaz.knowledge.agents.claude_code import ClaudeCodeEngine
from skaz.knowledge.agents.codex import CodexEngine
from skaz.knowledge.agents.engine import AgentTurn, Completed, EngineId, ModelOption, TurnMessage, collect
from skaz.knowledge.agents.fake import FakeEngine, ScriptItem
from skaz.knowledge.agents.hermes import HermesEngine
from skaz.knowledge.agents.opencode import OpenCodeEngine
from skaz.knowledge.agents.registry import EngineRegistry
from skaz.knowledge.install.system import Located
from skaz.knowledge.install.terminal import TerminalLauncher
from skaz.knowledge.library.library import INBOX_ID, MaterialFiles
from skaz.knowledge.markdown.source import FragmentInput, Origin
from skaz.knowledge.permissions.search_rules import ChatRules, SearchRulesStore
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources.intake import SourceRejected
from skaz.knowledge.sources.visual import LinkedFramePolicy, RetrievedFrame, VisualSourceUnsupported
from skaz.media_source import VideoSource
from skaz.runtime import Runtime
from skaz.visual_transport041 import (
    TEXT_ONLY_DISCLOSURE,
    AdapterTransportProbe,
    AuthorizedVisualPayload,
    VisualSourceLocator,
)
from skaz.visual_transport041 import runtime as visual_runtime
from skaz.visual_transport041.payloads import build_claude_user_message
from tests.knowledge.chat_support import connect, text
from tests.knowledge.ingest_support import settle
from tests.knowledge.pdf_fixtures import line, make_pdf
from tests.knowledge.test_source_visual import make_png

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _write_fake_executable(path: Path, script: str) -> Located:
    path.write_text(f"#!{sys.executable}\n{script}", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return Located(path, str(path.parent))


def _frame_fixture(engine: EngineId, model: str, timestamp_ms: int, number: int) -> AuthorizedVisualPayload:
    pixels = make_png(3, 3, color=(number, 0, 0))
    return AuthorizedVisualPayload(
        visual_id=f"vis-mat-{number}-t{timestamp_ms}",
        locator=VisualSourceLocator(
            material_id=f"mat-{number}", source_kind="video_link", timestamp_ms=timestamp_ms,
            label=f"Lecture {number}", source_url=f"https://vimeo.com/{number}1111111",
        ),
        media_type="image/png", approved_bytes=pixels, byte_size=len(pixels),
        sha256=hashlib.sha256(pixels).hexdigest(), engine=engine, model_id=model,
    )


def _assert_frame_items(items: list[dict[str, Any]]) -> None:
    assert [item["type"] for item in items] == ["text", "image", "text", "image"]
    for number, time, ms, caption, image in [
        (1, "00:11.120", "11120", items[0], items[1]),
        (2, "00:22.380", "22380", items[2], items[3]),
    ]:
        url, material = f"https://vimeo.com/{number}1111111", f"mat-{number}"
        assert all(value in caption["text"] for value in (url, material, time, ms))
        base64_data = image.get("data") or image.get("source", {}).get("data")
        if base64_data is None:
            prefix, base64_data = image["url"].split(",", 1)
            assert prefix == "data:image/png;base64"
        assert base64.b64decode(base64_data) == make_png(3, 3, color=(number, 0, 0))


# ---------------------------------------------------------------------------
# 1. Real adapter routing & outbound wire-frame fixtures (no live providers)
# ---------------------------------------------------------------------------


_CODEX_VISUAL_SERVER = r"""
import json, sys

LOG = sys.argv[1]
def send(msg):
    print(json.dumps(msg), flush=True)
def log(entry):
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")

for raw in sys.stdin:
    req = json.loads(raw)
    log(req)
    mid = req.get("id")
    method = req.get("method")
    params = req.get("params") or {}
    if method == "initialize":
        send({"id": mid, "result": {"userAgent": "codex-fixture"}})
    elif method == "model/list":
        send({"id": mid, "result": {
            "data": [
                {
                    "model": "gpt-vision",
                    "displayName": "GPT Vision",
                    "inputModalities": ["text", "image"],
                    "supportedReasoningEfforts": [{"reasoningEffort": "medium"}],
                    "defaultReasoningEffort": "medium",
                },
                {
                    "model": "gpt-text",
                    "displayName": "GPT Text",
                    "inputModalities": ["text"],
                    "supportedReasoningEfforts": [{"reasoningEffort": "medium"}],
                    "defaultReasoningEffort": "medium",
                },
                {
                    "model": "gpt-undeclared",
                    "displayName": "GPT Undeclared",
                    "supportedReasoningEfforts": [{"reasoningEffort": "medium"}],
                    "defaultReasoningEffort": "medium",
                },
            ],
            "nextCursor": None,
        }})
    elif method == "thread/start":
        send({"id": mid, "result": {"thread": {"id": "thr-v4"}}})
    elif method == "turn/start":
        send({"id": mid, "result": {"turn": {"id": "trn-v4"}}})
        ids = {"threadId": "thr-v4", "turnId": "trn-v4"}
        item = {"id": "a1", "type": "agentMessage", "phase": "final_answer", "text": ""}
        send({"method": "item/started", "params": {**ids, "item": item}})
        send({"method": "item/agentMessage/delta",
              "params": {**ids, "itemId": "a1", "delta": "Codex saw image."}})
        send({"method": "item/completed", "params": {**ids, "item": {**item, "text": "Codex saw image."}}})
        send({"method": "turn/completed", "params": {
            "threadId": "thr-v4", "turn": {"id": "trn-v4", "status": "completed", "items": [], "error": None},
        }})
"""


class _FakeCodexConn:
    def __init__(self, tmp_path: Path) -> None:
        self.cwd = tmp_path
        self.binary: str | None = sys.executable
        self.script = tmp_path / "codex_visual_srv.py"
        self.script.write_text(_CODEX_VISUAL_SERVER, encoding="utf-8")
        self.log = tmp_path / "codex_visual.jsonl"

    async def check(self) -> dict[str, Any]:
        return {"status": "connected", "version": "codex-cli 0.160.0", "path": str(self.script)}

    def rpc(self, *, max_message_bytes: int = 4 * 1024 * 1024) -> CodexRpc:
        return CodexRpc(
            (sys.executable, str(self.script), str(self.log)),
            cwd=self.cwd,
            env={},
            max_message_bytes=max_message_bytes,
        )

    def received(self, method: str) -> list[dict[str, Any]]:
        if not self.log.exists():
            return []
        return [
            json.loads(line)
            for line in self.log.read_text(encoding="utf-8").splitlines()
            if json.loads(line).get("method") == method
        ]


@pytest.mark.asyncio
async def test_codex_adapter_parses_modalities_and_sends_image_frame(tmp_path: Path) -> None:
    conn = _FakeCodexConn(tmp_path)
    engine = CodexEngine(conn, None, run_timeout_s=10)
    models = {m.id: m for m in await engine.models()}
    assert models["gpt-vision"].supports_image is True
    assert models["gpt-vision"].input_modalities == ("text", "image")
    assert models["gpt-text"].supports_image is False
    assert models["gpt-undeclared"].supports_image is None

    payload = AuthorizedVisualPayload(
        visual_id="vis-1",
        locator=VisualSourceLocator(material_id="mat-1", source_kind="image", label="chart.png"),
        media_type="image/png",
        approved_bytes=PNG_1X1,
        byte_size=len(PNG_1X1),
        sha256=__import__("hashlib").sha256(PNG_1X1).hexdigest(),
        engine="codex",
        model_id="gpt-vision",
    )
    turn = AgentTurn(
        run_id="r-codex-img",
        messages=(TurnMessage("user", "What is in this chart?"),),
        instructions="Answer concisely.",
        tools=None,
        model="gpt-vision",
        visuals=(payload, _frame_fixture("codex", "gpt-vision", 11_120, 1),
                 _frame_fixture("codex", "gpt-vision", 22_380, 2)),
    )
    res = await collect(engine.run(turn))
    assert isinstance(res.terminal, Completed)
    assert res.text == "Codex saw image."
    turn_starts = conn.received("turn/start")
    assert len(turn_starts) == 1
    items = turn_starts[0]["params"]["input"]
    assert items[0]["type"] == "text"
    assert items[1] == {
        "type": "image",
        "url": f"data:image/png;base64,{base64.b64encode(PNG_1X1).decode('ascii')}",
    }
    _assert_frame_items(items[2:])


@pytest.mark.asyncio
async def test_claude_code_adapter_sends_stream_json_image_block(tmp_path: Path) -> None:
    record = tmp_path / "claude_stdin.jsonl"
    fake_cli = _write_fake_executable(
        tmp_path / "claude",
        f"""
import json, sys
args = sys.argv[1:]
if args == ["--version"]:
    print("2.1.281")
    sys.exit(0)
if args == ["auth", "status"]:
    print(json.dumps({{"loggedIn": True}}))
    sys.exit(0)
raw = sys.stdin.readline()
with open({str(record)!r}, "a", encoding="utf-8") as fh:
    fh.write(raw)
print(json.dumps({{"type": "system", "subtype": "init", "session_id": "s-1"}}), flush=True)
event = {{"type": "content_block_delta", "delta": {{"type": "text_delta", "text": "Claude saw image."}}}}
print(json.dumps({{"type": "stream_event", "event": event, "parent_tool_use_id": None}}), flush=True)
print(json.dumps({{"type": "result", "subtype": "success", "is_error": False, "usage": {{}}}}), flush=True)
""",
    )
    engine = ClaudeCodeEngine(
        tmp_path / "work",
        locate_cli=lambda _name: fake_cli,
        launcher=TerminalLauncher(tmp_path / "launch"),
    )
    models = {m.id: m for m in await engine.models()}
    assert models["sonnet"].supports_image is True
    assert models["opus"].supports_image is True

    payload = AuthorizedVisualPayload(
        visual_id="vis-2",
        locator=VisualSourceLocator(material_id="mat-2", source_kind="image", label="photo.png"),
        media_type="image/png",
        approved_bytes=PNG_1X1,
        byte_size=len(PNG_1X1),
        sha256=__import__("hashlib").sha256(PNG_1X1).hexdigest(),
        engine="claude_code",
        model_id="sonnet",
    )
    turn = AgentTurn(
        run_id="r-claude-img",
        messages=(TurnMessage("user", "Describe the photo"),),
        instructions="Be concise.",
        tools=None,
        model="sonnet",
        visuals=(payload, _frame_fixture("claude_code", "sonnet", 11_120, 1),
                 _frame_fixture("claude_code", "sonnet", 22_380, 2)),
    )
    res = await collect(engine.run(turn))
    assert isinstance(res.terminal, Completed)
    assert res.text == "Claude saw image."
    sent = json.loads(record.read_text(encoding="utf-8").splitlines()[0])
    content = sent["message"]["content"]
    assert isinstance(content, list)
    assert content[0]["type"] == "text"
    assert content[1] == {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": base64.b64encode(PNG_1X1).decode("ascii"),
        },
    }
    _assert_frame_items(content[2:])


@pytest.mark.asyncio
async def test_hermes_and_opencode_acp_adapters_capture_capabilities_and_send_image_blocks(
    tmp_path: Path,
) -> None:
    hermes_record = tmp_path / "hermes_acp.jsonl"
    hermes_cli = _write_fake_executable(
        tmp_path / "hermes",
        f"""
import json, sys
args = sys.argv[1:]
if args == ["--version"]:
    print("Hermes Agent v0.22.0")
    sys.exit(0)
assert args == ["acp"]
for raw in sys.stdin:
    msg = json.loads(raw)
    with open({str(hermes_record)!r}, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(msg) + "\\n")
    mid = msg.get("id")
    m = msg.get("method")
    p = msg.get("params") or {{}}
    if m == "initialize":
        print(json.dumps({{"jsonrpc": "2.0", "id": mid, "result": {{
            "protocolVersion": 1,
            "agentCapabilities": {{"promptCapabilities": {{"image": True}}}},
            "authMethods": [{{"id": "openrouter"}}],
        }}}}), flush=True)
    elif m == "session/new":
        print(json.dumps({{"jsonrpc": "2.0", "id": mid, "result": {{
            "sessionId": "h-ses-1",
            "models": {{
                "currentModelId": "openrouter:vision-1",
                "availableModels": [
                    {{"modelId": "openrouter:vision-1", "name": "Vision 1",
                      "inputModalities": ["text", "image"]}},
                    {{"modelId": "custom:undeclared", "name": "Undeclared"}},
                ],
            }},
        }}}}), flush=True)
    elif m == "session/prompt":
        prompt = p.get("prompt") or []
        text = "No tools available." if prompt and prompt[0].get("text") == "/tools" else "Hermes saw image."
        update = {{"sessionUpdate": "agent_message_chunk", "content": {{"type": "text", "text": text}}}}
        print(json.dumps({{
            "jsonrpc": "2.0", "method": "session/update",
            "params": {{"sessionId": "h-ses-1", "update": update}},
        }}), flush=True)
        print(json.dumps({{"jsonrpc": "2.0", "id": mid, "result": {{"stopReason": "end_turn"}}}}), flush=True)
""",
    )
    hermes_root = tmp_path / "hermes_root"
    hermes = HermesEngine(
        hermes_root, locate_cli=lambda _n: hermes_cli, user_home=tmp_path / "uhome", first_run_gate=False
    )
    (hermes.home / "config.yaml").parent.mkdir(parents=True, exist_ok=True)
    (hermes.home / "config.yaml").write_text("model: openrouter:vision-1\n", encoding="utf-8")

    h_models = {m.id: m for m in await hermes.models()}
    assert h_models["openrouter:vision-1"].supports_image is True
    assert h_models["custom:undeclared"].supports_image is None
    probe = await hermes.probe_visual_transport()
    assert probe.transport_supports_image is True

    h_payload = AuthorizedVisualPayload(
        visual_id="vis-h",
        locator=VisualSourceLocator(material_id="mat-h", source_kind="image", label="h.png"),
        media_type="image/png",
        approved_bytes=PNG_1X1,
        byte_size=len(PNG_1X1),
        sha256=__import__("hashlib").sha256(PNG_1X1).hexdigest(),
        engine="hermes",
        model_id="openrouter:vision-1",
    )
    h_res = await collect(
        hermes.run(
            AgentTurn(
                run_id="r-hermes",
                messages=(TurnMessage("user", "Inspect chart"),),
                instructions="Short.",
                tools=None,
                model="openrouter:vision-1",
                visuals=(h_payload, _frame_fixture("hermes", "openrouter:vision-1", 11_120, 1),
                         _frame_fixture("hermes", "openrouter:vision-1", 22_380, 2)),
            )
        )
    )
    assert isinstance(h_res.terminal, Completed)
    assert h_res.text == "Hermes saw image."
    h_prompts = [
        json.loads(line)["params"]["prompt"]
        for line in hermes_record.read_text(encoding="utf-8").splitlines()
        if json.loads(line).get("method") == "session/prompt"
        and json.loads(line)["params"]["prompt"][0].get("text") != "/tools"
    ]
    assert len(h_prompts) == 1
    assert h_prompts[0][1] == {
        "type": "image",
        "data": base64.b64encode(PNG_1X1).decode("ascii"),
        "mimeType": "image/png",
    }
    _assert_frame_items(h_prompts[0][2:])

    # Add a signed-in text-only Anthropic model to the OpenCode protocol fixture.
    probe_json = json.loads(
        (Path(__file__).parent / "fixtures" / "agents" / "opencode_acp_probe.json").read_text()
    )
    probe_json["models_verbose"] += (
        "\nanthropic/claude-text-only\n"
        + json.dumps(
            {
                "id": "claude-text-only",
                "providerID": "anthropic",
                "name": "Claude Text Only",
                "status": "active",
                "cost": {"input": 1, "output": 5},
                "capabilities": {
                    "input": {"text": True, "audio": False, "image": False, "video": False, "pdf": False},
                    "output": {"text": True},
                },
            }
        )
        + "\n"
    )
    oc_record = tmp_path / "oc_acp.jsonl"
    oc_cli = _write_fake_executable(
        tmp_path / "opencode",
        f"""
import json, sys
PROBE = {probe_json!r}
args = sys.argv[1:]
if args == ["--version"]:
    print("1.17.18")
    sys.exit(0)
if args == ["debug", "agent", "skaz"]:
    print(json.dumps(PROBE["debug_agent_skaz"]))
    sys.exit(0)
if args == ["auth", "list"]:
    sys.stdout.write(PROBE["auth_list_anthropic"])
    sys.exit(0)
if args == ["models", "--verbose"]:
    sys.stdout.write(PROBE["models_verbose"])
    sys.exit(0)
assert args == ["acp"]
for raw in sys.stdin:
    msg = json.loads(raw)
    with open({str(oc_record)!r}, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(msg) + "\\n")
    mid = msg.get("id")
    m = msg.get("method")
    p = msg.get("params") or {{}}
    if m == "initialize":
        print(json.dumps({{"jsonrpc": "2.0", "id": mid, "result": PROBE["initialize"]}}), flush=True)
    elif m == "session/new":
        print(json.dumps({{"jsonrpc": "2.0", "id": mid, "result": PROBE["session_new"]}}), flush=True)
    elif m == "session/set_config_option":
        print(json.dumps({{"jsonrpc": "2.0", "id": mid, "result": PROBE["set_model"]}}), flush=True)
    elif m == "session/prompt":
        update = {{
            "sessionUpdate": "agent_message_chunk",
            "content": {{"type": "text", "text": "OpenCode saw image."}},
        }}
        print(json.dumps({{
            "jsonrpc": "2.0", "method": "session/update",
            "params": {{"sessionId": "ses_ea4bdff1bffeMbK3Xru1K6Whlz", "update": update}},
        }}), flush=True)
        print(json.dumps({{"jsonrpc": "2.0", "id": mid, "result": {{"stopReason": "end_turn"}}}}), flush=True)
""",
    )
    oc = OpenCodeEngine(tmp_path / "oc_data", locate_cli=lambda _n: oc_cli, user_home=tmp_path / "uhome2")
    oc_models = {m.id: m for m in await oc.models()}
    assert oc_models["anthropic/claude-text-only"].supports_image is False
    assert oc_models["anthropic/claude-sonnet-4-5-20250929"].supports_image is True
    oc_probe = await oc.probe_visual_transport()
    assert oc_probe.transport_supports_image is True

    oc_payload = AuthorizedVisualPayload(
        visual_id="vis-oc",
        locator=VisualSourceLocator(material_id="mat-oc", source_kind="image", label="oc.png"),
        media_type="image/png",
        approved_bytes=PNG_1X1,
        byte_size=len(PNG_1X1),
        sha256=__import__("hashlib").sha256(PNG_1X1).hexdigest(),
        engine="opencode",
        model_id="anthropic/claude-sonnet-4-5-20250929",
    )
    oc_res = await collect(
        oc.run(
            AgentTurn(
                run_id="r-oc",
                messages=(TurnMessage("user", "Read image"),),
                instructions="Short.",
                tools=None,
                model="anthropic/claude-sonnet-4-5-20250929",
                visuals=(oc_payload,
                         _frame_fixture("opencode", "anthropic/claude-sonnet-4-5-20250929", 11_120, 1),
                         _frame_fixture("opencode", "anthropic/claude-sonnet-4-5-20250929", 22_380, 2)),
            )
        )
    )
    assert isinstance(oc_res.terminal, Completed)
    assert oc_res.text == "OpenCode saw image."
    oc_prompts = [
        json.loads(line)["params"]["prompt"]
        for line in oc_record.read_text(encoding="utf-8").splitlines()
        if json.loads(line).get("method") == "session/prompt"
    ]
    assert oc_prompts[0][1] == {
        "type": "image",
        "data": base64.b64encode(PNG_1X1).decode("ascii"),
        "mimeType": "image/png",
    }
    _assert_frame_items(oc_prompts[0][2:])


# ---------------------------------------------------------------------------
# 2. Full ChatService + /kb/chats + V3 VisualSourcePreparer wiring
# ---------------------------------------------------------------------------


class _VisualFakeEngine(FakeEngine):
    def __init__(self, engine_id: EngineId, models: tuple[ModelOption, ...]) -> None:
        def script(turn: AgentTurn) -> list[ScriptItem]:
            if (turn.response_schema or {}).get("title") == "WikiAnalysisEdit":
                return text('{"omit":[],"break_before":[]}')
            return text("OK.")

        super().__init__(engine_id, script=script, models=models)
        self.visual_transport_probe = AdapterTransportProbe(engine=engine_id, transport_supports_image=True)


def _setup_routing_matrix(runtime: Runtime) -> dict[EngineId, _VisualFakeEngine]:
    models: dict[EngineId, tuple[ModelOption, ...]] = {
        "codex": (
            ModelOption("gpt-vision", "GPT Vision", ("medium",), "medium", ("text", "image"), True),
            ModelOption("gpt-text", "GPT Text", ("medium",), "medium", ("text",), False),
        ),
        "claude_code": (
            ModelOption("sonnet", "Sonnet", ("medium",), "medium", ("text", "image"), True),
        ),
        "hermes": (ModelOption("custom:probe-model", "Custom probe", (), None, (), None),),
        "opencode": (
            ModelOption("opencode/big-pickle", "Big Pickle", (), None, ("text",), False),
            ModelOption(
                "anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5", (), None, ("text", "image"), True,
            ),
        ),
    }
    engines = {engine_id: _VisualFakeEngine(engine_id, options) for engine_id, options in models.items()}
    runtime.kb_agents.registry = EngineRegistry(engines, runtime.kb.settings, cache_s=0.0)
    return engines


@pytest.fixture
def runtime(kb_app: FastAPI) -> Runtime:
    app_runtime = kb_app.state.runtime
    assert isinstance(app_runtime, Runtime)
    return app_runtime


@pytest.mark.asyncio
async def test_preflight_send_text_only_and_revalidation_over_chat_api(
    kb_client: httpx.AsyncClient,
    runtime: Runtime,
    tmp_path: Path,
) -> None:
    await connect(kb_client, runtime)
    engines = _setup_routing_matrix(runtime)
    kb: KnowledgeService = runtime.kb

    # Seed an image, a two-page PDF with text, a scanned PDF and a local video.
    png_bytes = make_png(4, 3)
    img_path = tmp_path / "chart.png"
    img_path.write_bytes(png_bytes)
    img_mat = runtime.kb_sources.add_clipboard_image(
        png_bytes, INBOX_ID, mime_type="image/png", file_name="chart.png"
    )

    pdf_bytes = make_pdf(
        [
            b"\n".join([line("Inflation Q1", 720), line("Headline inflation rose.", 700)]),
            b"\n".join([line("Figure 2 Chart", 720), line("Inflation fell in Q3.", 700)]),
        ]
    )
    pdf_file = tmp_path / "report.pdf"
    pdf_file.write_bytes(pdf_bytes)
    pdf_mat = runtime.kb_sources.add_file(str(pdf_file), INBOX_ID, title="Inflation report")

    scanned_pdf = make_pdf([b"", b""])
    scan_file = tmp_path / "scan.pdf"
    scan_file.write_bytes(scanned_pdf)
    scan_mat = runtime.kb_sources.add_file(str(scan_file), INBOX_ID, title="Scanned report")

    local_vid = kb.create_material(
        INBOX_ID,
        "Lecture video",
        "video",
        [FragmentInput(text="At 01:00 the speaker discusses inflation.", start_ms=60_000, end_ms=65_000)],
        status="ready",
    )

    # 1. PDF visual question on unsupported model -> preflight reports UI-B with text_only_available=True
    chat_res = await kb_client.post("/kb/chats", json={"engine": "opencode", "model": "opencode/big-pickle"})
    assert chat_res.status_code == 201
    chat_id = chat_res.json()["id"]

    pre = await kb_client.post(
        "/kb/chats/visual-preflight",
        json={
            "chat_id": chat_id,
            "text": "Explain the chart on page 2",
            "attachments": [pdf_mat.material_id],
        },
    )
    assert pre.status_code == 200, pre.text
    pre_data = pre.json()
    assert pre_data["requires_visual"] is True
    assert pre_data["supported"] is False
    assert pre_data["reason_code"] == "model_no_image_input"
    assert pre_data["text_only_available"] is True
    assert any(c["model_id"] == "sonnet" for c in pre_data["compatible_models"])

    # Sending without text_only must fail closed and store NO messages
    blocked = await kb_client.post(
        f"/kb/chats/{chat_id}/messages",
        json={"text": "Explain the chart on page 2", "attachments": [pdf_mat.material_id]},
    )
    assert blocked.status_code == 422
    assert blocked.json()["code"] == "VISUAL_UNSUPPORTED"
    assert len(engines["opencode"].turns) == 0
    assert (await kb_client.get(f"/kb/chats/{chat_id}")).json()["messages"] == []

    # Explicit text_only=True succeeds with zero pixels and marks the reply
    sent_text_only = await kb_client.post(
        f"/kb/chats/{chat_id}/messages",
        json={"text": "Explain the chart on page 2", "attachments": [pdf_mat.material_id], "text_only": True},
    )
    assert sent_text_only.status_code == 202, sent_text_only.text
    assistant_msg = sent_text_only.json()["assistant"]
    assert any(
        p["type"] == "text_only" and p["label"] == TEXT_ONLY_DISCLOSURE for p in assistant_msg["parts"]
    )
    await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")
    assert len(engines["opencode"].turns) == 1
    assert engines["opencode"].turns[-1].visuals == ()

    # 2. Image material without text -> text_only_available=False, text_only=True is refused!
    pre_img = await kb_client.post(
        "/kb/chats/visual-preflight",
        json={"chat_id": chat_id, "text": "What is this?", "attachments": [img_mat.material_id]},
    )
    assert pre_img.status_code == 200
    assert pre_img.json()["text_only_available"] is False
    refused_img_txt = await kb_client.post(
        f"/kb/chats/{chat_id}/messages",
        json={"text": "What is this?", "attachments": [img_mat.material_id], "text_only": True},
    )
    assert refused_img_txt.status_code == 422

    # 3. Scanned PDF without text -> text_only_available=False on unsupported model
    pre_scan = await kb_client.post(
        "/kb/chats/visual-preflight",
        json={"chat_id": chat_id, "text": "Read page 1", "attachments": [scan_mat.material_id]},
    )
    assert pre_scan.status_code == 200
    assert pre_scan.json()["text_only_available"] is False

    # 4. Switch to verified vision model -> delivers real PNG bytes for image and PDF page 2
    patched = await kb_client.patch(
        f"/kb/chats/{chat_id}",
        json={"engine": "claude_code", "model": "sonnet"},
    )
    assert patched.status_code == 200
    await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")

    sent_img = await kb_client.post(
        f"/kb/chats/{chat_id}/messages",
        json={"text": "What is in this chart?", "attachments": [img_mat.material_id]},
    )
    assert sent_img.status_code == 202, sent_img.text
    await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")
    claude_turn = engines["claude_code"].turns[-1]
    assert len(claude_turn.visuals) == 1
    assert claude_turn.visuals[0].approved_bytes == png_bytes
    assert claude_turn.visuals[0].engine == "claude_code"
    assert claude_turn.visuals[0].model_id == "sonnet"

    # 5. Local video refuses visual frames and allows explicit text-only with a transcript.
    vid_blocked = await kb_client.post(
        f"/kb/chats/{chat_id}/messages",
        json={"text": "What slide is shown at 01:00?", "attachments": [local_vid.manifest.id]},
    )
    assert vid_blocked.status_code == 422
    assert vid_blocked.json()["reason_code"] == "local_video_no_frames"

    # 6. Revalidate permission change between preflight and send (excluding material blocks send)
    SearchRulesStore(kb.db, kb.settings).set_chat(chat_id, ChatRules(excluded=(img_mat.material_id,)))
    excluded_send = await kb_client.post(
        f"/kb/chats/{chat_id}/messages",
        json={"text": "Read this again", "attachments": [img_mat.material_id]},
    )
    assert excluded_send.status_code == 422
    assert excluded_send.json()["reason_code"] == "source_not_permitted"

    # 7. Scanned PDF requires an explicit page. Edit, regenerate and resume revalidate that choice.
    SearchRulesStore(kb.db, kb.settings).set_chat(chat_id, ChatRules())
    scan_no_page = await kb_client.post(
        "/kb/chats/visual-preflight",
        json={"chat_id": chat_id, "text": "Inspect the scanned chart", "attachments": [scan_mat.material_id]},
    )
    assert scan_no_page.status_code == 200
    assert scan_no_page.json()["supported"] is False
    assert scan_no_page.json()["text_only_available"] is False

    scan_with_page = await kb_client.post(
        f"/kb/chats/{chat_id}/messages",
        json={"text": "Inspect page 2", "attachments": [scan_mat.material_id]},
    )
    assert scan_with_page.status_code == 202, scan_with_page.text
    await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")
    assert len(engines["claude_code"].turns[-1].visuals) == 1
    assert engines["claude_code"].turns[-1].visuals[0].locator.page == 2

    user_msg_id = scan_with_page.json()["user"]["id"]
    ans_msg_id = scan_with_page.json()["assistant"]["id"]

    # Edit triggers reauthorization (switching back to unsupported model blocks edit cleanly)
    await kb_client.patch(f"/kb/chats/{chat_id}", json={"engine": "opencode", "model": "opencode/big-pickle"})
    await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")
    edit_blocked = await kb_client.post(
        f"/kb/chats/{chat_id}/messages/{user_msg_id}/edit",
        json={"text": "Inspect page 1", "attachments": [scan_mat.material_id]},
    )
    assert edit_blocked.status_code == 422

    # Regenerate / resume also revalidate
    regen_blocked = await kb_client.post(f"/kb/chats/{chat_id}/messages/{ans_msg_id}/regenerate")
    assert regen_blocked.status_code == 422

    # Switch back to vision model and edit succeeds with new page 1 image bytes
    await kb_client.patch(f"/kb/chats/{chat_id}", json={"engine": "claude_code", "model": "sonnet"})
    await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")
    edit_ok = await kb_client.post(
        f"/kb/chats/{chat_id}/messages/{user_msg_id}/edit",
        json={"text": "Inspect page 1", "attachments": [scan_mat.material_id]},
    )
    assert edit_ok.status_code == 202, edit_ok.text
    await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")
    assert engines["claude_code"].turns[-1].visuals[0].locator.page == 1

    # 8. Corrupted / mismatched image bytes fail closed via origin.sha256 check
    img_dir = runtime.kb_sources.visual._material_files(img_mat.material_id).directory
    (img_dir / ".skaz" / "original.png").write_bytes(make_png(4, 3, color=(200, 10, 10)))
    corrupt_res = await kb_client.post(
        f"/kb/chats/{chat_id}/messages",
        json={"text": "Inspect corrupted chart", "attachments": [img_mat.material_id]},
    )
    assert corrupt_res.status_code == 422

    # 9. Linked YouTube video: permitted frames succeed with PNG bytes; unpermitted refuses frames cleanly
    video_mat = kb.create_material(
        INBOX_ID,
        "Macro Lecture",
        "video_link",
        [FragmentInput(text="At 00:45 the chart compares CPI vs core.", start_ms=45_000, end_ms=52_000)],
        status="ready",
        origin=Origin(type="url", url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    )

    async def _fake_retriever(_source: VideoSource, timestamps_ms: tuple[int, ...]) -> list[RetrievedFrame]:
        return [
            RetrievedFrame(
                data=make_png(6, 4),
                actual_timestamp_ms=ts,
                requested_timestamp_ms=ts,
            )
            for ts in timestamps_ms
        ]

    runtime.kb_sources.visual.frame_retriever = _fake_retriever
    runtime.kb_sources.visual.frame_policy = {
        "youtube": LinkedFramePolicy(retrieval_permitted=True, retention_permitted=False)
    }
    vid_ok = await kb_client.post(
        f"/kb/chats/{chat_id}/messages",
        json={"text": "Describe the chart on screen at 00:45", "attachments": [video_mat.manifest.id]},
    )
    assert vid_ok.status_code == 202, vid_ok.text
    await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")
    assert len(engines["claude_code"].turns[-1].visuals) == 1
    assert engines["claude_code"].turns[-1].visuals[0].approved_bytes[:4] == b"\x89PNG"

    runtime.kb_sources.visual.frame_policy = {
        "youtube": LinkedFramePolicy(retrieval_permitted=False, retention_permitted=False)
    }
    vid_unpermitted = await kb_client.post(
        f"/kb/chats/{chat_id}/messages",
        json={"text": "Describe the chart on screen at 00:45", "attachments": [video_mat.manifest.id]},
    )
    assert vid_unpermitted.status_code == 422

    # 10. Verify zero raw PNG bytes were ever written into SQLite chat_messages
    with kb.db.read() as connection:
        rows = connection.execute(
            "SELECT parts, input FROM chat_messages WHERE chat_id = ?", (chat_id,)
        ).fetchall()
    assert len(rows) > 0
    for parts_json, input_json in rows:
        assert "iVBOR" not in (parts_json or "")
        assert "iVBOR" not in (input_json or "")
        assert "image/png" not in (parts_json or "")


@pytest.mark.asyncio
@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("second_source", ["image", "missing", "denied", "pdf"])
async def test_text_only_admission_applies_to_the_entire_selection(
    kb_client: httpx.AsyncClient,
    runtime: Runtime,
    tmp_path: Path,
    reverse: bool,
    second_source: Literal["image", "missing", "denied", "pdf"],
) -> None:
    await connect(kb_client, runtime)
    engines = _setup_routing_matrix(runtime)
    video = runtime.kb.create_material(
        INBOX_ID, "Local lecture", "video",
        [FragmentInput(text="The inflation chart is on screen.", start_ms=0, end_ms=1000)],
        status="ready",
    )
    if second_source == "image":
        other = runtime.kb_sources.add_clipboard_image(
            make_png(), INBOX_ID, mime_type="image/png", file_name="chart.png",
        ).material_id
    elif second_source == "missing":
        other = "deleted-source"
    else:
        path = tmp_path / "report.pdf"
        path.write_bytes(make_pdf([line("Inflation chart and caption", 720)]))
        other = runtime.kb_sources.add_file(str(path), INBOX_ID).material_id
    chat = await kb_client.post("/kb/chats", json={"engine": "claude_code", "model": "sonnet"})
    assert chat.status_code == 201
    chat_id = chat.json()["id"]
    if second_source == "denied":
        SearchRulesStore(runtime.kb.db, runtime.kb.settings).set_chat(chat_id, ChatRules(excluded=(other,)))
    ids = [video.manifest.id, other]
    if reverse:
        ids.reverse()
    body = {"text": "Compare the slide and the chart on page 1", "attachments": ids}
    preflight = await kb_client.post("/kb/chats/visual-preflight", json={"chat_id": chat_id, **body})
    assert preflight.status_code == 200, preflight.text
    assert preflight.json()["requires_visual"] and not preflight.json()["supported"]
    assert preflight.json()["text_only_available"] == (second_source == "pdf")
    sent = await kb_client.post(f"/kb/chats/{chat_id}/messages", json={**body, "text_only": True})
    if second_source == "pdf":
        assert sent.status_code == 202, sent.text
        assert any(part["type"] == "text_only" for part in sent.json()["assistant"]["parts"])
        await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")
        assert engines["claude_code"].turns[-1].visuals == ()
    else:
        assert sent.status_code == 422, sent.text
        assert sent.json()["code"] == "VISUAL_TEXT_ONLY_UNAVAILABLE"
        assert not engines["claude_code"].turns


@pytest.mark.asyncio
async def test_pdf_preflight_returns_typed_refusal_on_source_error(
    kb_client: httpx.AsyncClient,
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await connect(kb_client, runtime)
    engines = _setup_routing_matrix(runtime)
    source = tmp_path / "report.pdf"
    source.write_bytes(make_pdf([line("Inflation chart and caption", 720)]))
    material = runtime.kb_sources.add_file(str(source), INBOX_ID)

    def unavailable(_files: MaterialFiles, _name: str) -> Never:
        raise SourceRejected("The saved report is unavailable.")

    monkeypatch.setattr(runtime.kb_sources.visual, "_authorized_service_file", unavailable)
    chat = await kb_client.post("/kb/chats", json={"engine": "claude_code", "model": "sonnet"})
    chat_id = chat.json()["id"]
    body = {"text": "Inspect the chart on page 1", "attachments": [material.material_id]}
    preflight = await kb_client.post("/kb/chats/visual-preflight", json={"chat_id": chat_id, **body})
    assert preflight.status_code == 200, preflight.text
    outcome = preflight.json()
    assert outcome["requires_visual"] and not outcome["supported"]
    assert outcome["reason_code"] == "missing_payload"
    assert outcome["detail"] == "The saved report is unavailable."
    assert not outcome["text_only_available"]
    refused = await kb_client.post(f"/kb/chats/{chat_id}/messages", json={**body, "text_only": True})
    assert refused.status_code == 422 and refused.json()["code"] == "VISUAL_TEXT_ONLY_UNAVAILABLE"
    assert not engines["claude_code"].turns


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["image", "heic", "pdf"])
async def test_adapter_receives_pixels_from_the_verified_snapshot(
    kb_client: httpx.AsyncClient,
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    kind: Literal["image", "heic", "pdf"],
) -> None:
    await connect(kb_client, runtime)
    engines = _setup_routing_matrix(runtime)
    pixels = make_png()
    if kind == "pdf":
        source = tmp_path / "original-input.pdf"
        original = make_pdf([line("Inflation caption", 720), line("Selected chart", 720)])
        source.write_bytes(original)
        material = runtime.kb_sources.add_file(str(source), INBOX_ID)
        replaced = make_pdf([line("Replacement has no page two", 720)])
        name = "original.pdf"
    elif kind == "heic":
        fixtures = Path(__file__).resolve().parents[3] / "electron" / "nativeIntake041" / "fixtures"
        original = (fixtures / "sample-chart.heic").read_bytes()
        source = tmp_path / "sample-chart.heic"
        source.write_bytes(original)
        material = runtime.kb_sources.add_file(source, INBOX_ID)
        pixels = runtime.kb_sources.preview_trusted_image(source)
        replaced = b"Changed after the snapshot"
        name = "original.heic"
    else:
        original = pixels
        material = runtime.kb_sources.add_clipboard_image(
            original, INBOX_ID, mime_type="image/png", file_name="chart.png",
        )
        replaced = make_png(color=(160, 40, 90))
        name = "original.png"
    path = runtime.kb_sources.visual._material_files(material.material_id).directory / ".skaz" / name
    load = visual_runtime._read_verified_original
    reads: list[Path] = []
    started = threading.Event()
    release = threading.Event()
    loop_thread = threading.get_ident()

    def replace_after_read(files: MaterialFiles, path: Path, *, max_bytes: int) -> bytes:
        snapshot = load(files, path, max_bytes=max_bytes)
        reads.append(path)
        path.write_bytes(replaced)
        return snapshot

    def render_page(page_bytes: bytes, page: int) -> bytes:
        assert page == 2
        assert page_bytes.startswith(b"%PDF")
        assert threading.get_ident() != loop_thread
        started.set()
        assert release.wait(3), "The loop could not service a second request during rendering"
        return pixels

    monkeypatch.setattr(visual_runtime, "_read_verified_original", replace_after_read)
    monkeypatch.setattr(runtime.kb_sources.visual, "page_renderer", render_page)
    chat = await kb_client.post("/kb/chats", json={"engine": "claude_code", "model": "sonnet"})
    chat_id = chat.json()["id"]
    text = "Describe the chart on page 2" if kind == "pdf" else "Describe the chart"
    send = asyncio.create_task(kb_client.post(
        f"/kb/chats/{chat_id}/messages", json={"text": text, "attachments": [material.material_id]},
    ))
    try:
        if kind == "pdf":
            assert await asyncio.to_thread(started.wait, 1)
            unrelated = await asyncio.wait_for(kb_client.get(f"/kb/chats/{chat_id}"), 1)
            assert unrelated.status_code == 200
    finally:
        release.set()
    sent = await send
    assert sent.status_code == 202, sent.text
    await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")
    assert reads == [path]
    assert path.read_bytes() == replaced
    assert pixels.startswith(b"\x89PNG")
    (visual,) = engines["claude_code"].turns[-1].visuals
    assert visual.approved_bytes == pixels
    assert visual.locator.source_sha256 == hashlib.sha256(original).hexdigest()
    assert visual.locator.page == (2 if kind == "pdf" else None)
    assert (visual.engine, visual.model_id) == ("claude_code", "sonnet")


@pytest.mark.asyncio
async def test_send_refuses_a_stale_model_and_aggregate_visual_budget(
    kb_client: httpx.AsyncClient,
    runtime: Runtime,
) -> None:
    await connect(kb_client, runtime)
    engines = _setup_routing_matrix(runtime)
    engine = engines["codex"]
    engine.visual_transport_probe = AdapterTransportProbe(
        engine="codex", transport_supports_image=True, max_payload_bytes=4700,
    )
    ids = [
        runtime.kb_sources.add_clipboard_image(
            make_png(color=color), INBOX_ID, mime_type="image/png", file_name=f"chart-{idx}.png",
        ).material_id
        for idx, color in enumerate([(120, 20, 40), (20, 40, 120)])
    ]
    chat = await kb_client.post("/kb/chats", json={"engine": "codex", "model": "gpt-vision"})
    chat_id = chat.json()["id"]
    route = f"/kb/chats/{chat_id}/messages"
    body = {"text": "Compare the charts", "attachments": ids}
    stale = await kb_client.post(route, json={
        **body, "expected_target": {"engine": "codex", "model": "gpt-text"},
    })
    assert stale.status_code == 409 and stale.json()["code"] == "CHAT_TARGET_CHANGED"
    oversized = await kb_client.post(route, json=body)
    assert oversized.status_code == 422 and oversized.json()["reason_code"] == "payload_too_large"
    assert not engine.turns
    assert (await kb_client.get(f"/kb/chats/{chat_id}")).json()["messages"] == []
    single = await kb_client.post(route, json={
        **body, "attachments": ids[:1], "expected_target": {"engine": "codex", "model": "gpt-vision"},
    })
    assert single.status_code == 202, single.text
    await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")
    assert len(engine.turns[-1].visuals) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["image", "pdf"])
async def test_visual_preflight_reads_one_verified_original_per_request(
    kb_client: httpx.AsyncClient,
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    kind: Literal["image", "pdf"],
) -> None:
    await connect(kb_client, runtime)
    _setup_routing_matrix(runtime)
    if kind == "pdf":
        source = tmp_path / "report.pdf"
        source.write_bytes(make_pdf([line("Inflation chart and caption", 720)]))
        material = runtime.kb_sources.add_file(str(source), INBOX_ID)
    else:
        material = runtime.kb_sources.add_clipboard_image(
            make_png(), INBOX_ID, mime_type="image/png", file_name="chart.png",
        )

    load = visual_runtime._read_verified_original
    bytes_read: list[int] = []

    def count_read(files: MaterialFiles, path: Path, *, max_bytes: int) -> bytes:
        data = load(files, path, max_bytes=max_bytes)
        bytes_read.append(len(data))
        return data

    monkeypatch.setattr(visual_runtime, "_read_verified_original", count_read)
    for request_number in range(12):
        response = await kb_client.post("/kb/chats/visual-preflight", json={
            "engine": "claude_code",
            "model": "sonnet",
            "text": f"Describe the chart on page 1, draft {request_number}",
            "attachments": [material.material_id],
        })
        assert response.status_code == 200, response.text
        assert response.json()["supported"]
        assert len(bytes_read) == request_number + 1
    assert len(set(bytes_read)) == 1
    assert 0 < bytes_read[0] < 10_000


@pytest.mark.asyncio
async def test_scope_denied_scanned_pdf_without_visual_cue_is_refused(
    kb_client: httpx.AsyncClient,
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await connect(kb_client, runtime)
    engines = _setup_routing_matrix(runtime)
    source = tmp_path / "scan.pdf"
    source.write_bytes(make_pdf([b""]))
    material = runtime.kb_sources.add_file(str(source), INBOX_ID)
    chat = await kb_client.post("/kb/chats", json={"engine": "claude_code", "model": "sonnet"})
    assert chat.status_code == 201, chat.text
    chat_id = chat.json()["id"]
    SearchRulesStore(runtime.kb.db, runtime.kb.settings).set_chat(
        chat_id, ChatRules(excluded=(material.material_id,)),
    )

    def unexpected_read(*_args: object, **_kwargs: object) -> Never:
        pytest.fail("A scope-denied original must not be read")

    monkeypatch.setattr(visual_runtime, "_read_verified_original", unexpected_read)
    body = {"text": "Summarize this", "attachments": [material.material_id]}
    preflight = await kb_client.post("/kb/chats/visual-preflight", json={"chat_id": chat_id, **body})
    assert preflight.status_code == 200, preflight.text
    assert preflight.json()["requires_visual"]
    assert not preflight.json()["supported"]
    assert preflight.json()["reason_code"] == "source_not_permitted"
    assert not preflight.json()["text_only_available"]

    sent = await kb_client.post(f"/kb/chats/{chat_id}/messages", json=body)
    assert sent.status_code == 422, sent.text
    assert sent.json()["code"] == "VISUAL_UNSUPPORTED"
    assert sent.json()["reason_code"] == "source_not_permitted"
    text_only = await kb_client.post(f"/kb/chats/{chat_id}/messages", json={**body, "text_only": True})
    assert text_only.status_code == 422, text_only.text
    assert text_only.json()["code"] == "VISUAL_TEXT_ONLY_UNAVAILABLE"
    assert not engines["claude_code"].turns
    assert (await kb_client.get(f"/kb/chats/{chat_id}")).json()["messages"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(("scenario", "title", "text_only_available"), [
    ("page_out_of_range", "PDF page is out of range", True),
    ("page_range_required", "Specify PDF pages", False),
    ("pdf_render_unavailable", "PDF pages are unavailable", True),
    ("video_frames_unsupported", "Video frames are unavailable", True),
])
async def test_source_preflight_refusals_explain_the_actual_problem(
    kb_client: httpx.AsyncClient,
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    scenario: str,
    title: str,
    text_only_available: bool,
) -> None:
    await connect(kb_client, runtime)
    _setup_routing_matrix(runtime)
    if scenario == "video_frames_unsupported":
        video = runtime.kb.create_material(
            INBOX_ID, "Lecture link", "video_link",
            [FragmentInput(text="The chart is on screen.", start_ms=0, end_ms=1000)],
            status="ready",
            origin=Origin(type="url", url="https://www.youtube.com/watch?v=abcdefghijk"),
        )
        material_id = video.manifest.id
        query = "Describe the chart on screen at 00:00"
    else:
        source = tmp_path / "report.pdf"
        page = b"" if scenario == "page_range_required" else line("Chart caption", 720)
        source.write_bytes(make_pdf([page]))
        material_id = runtime.kb_sources.add_file(str(source), INBOX_ID).material_id
        query = {
            "page_out_of_range": "Describe the chart on page 99",
            "page_range_required": "Describe the chart",
            "pdf_render_unavailable": "Describe the chart on page 1",
        }[scenario]
        if scenario == "pdf_render_unavailable":
            from skaz.knowledge.sources.pdf import PdfRejected

            def unavailable(_data: bytes) -> Never:
                raise PdfRejected("This PDF could not be opened.")

            monkeypatch.setattr("skaz.knowledge.sources.pdf.open_pdf", unavailable)

    response = await kb_client.post("/kb/chats/visual-preflight", json={
        "engine": "claude_code", "model": "sonnet", "text": query, "attachments": [material_id],
    })
    assert response.status_code == 200, response.text
    outcome = response.json()
    assert outcome["requires_visual"] and not outcome["supported"]
    assert outcome["reason_code"] == "missing_payload"
    assert outcome["title"] == title
    assert outcome["text_only_available"] is text_only_available


@pytest.mark.asyncio
@pytest.mark.parametrize("model", [None, "gpt-text"])
async def test_plain_text_preflight_does_not_report_verified_image_support(
    kb_client: httpx.AsyncClient,
    runtime: Runtime,
    monkeypatch: pytest.MonkeyPatch,
    model: str | None,
) -> None:
    await connect(kb_client, runtime)
    engines = _setup_routing_matrix(runtime)

    async def unexpected_probe(*_args: object, **_kwargs: object) -> Never:
        pytest.fail("A plain-text turn must not probe image capability")

    monkeypatch.setattr(visual_runtime, "evaluate_target_capability", unexpected_probe)
    chat = await kb_client.post("/kb/chats", json={"engine": "codex", "model": model})
    assert chat.status_code == 201, chat.text
    chat_id = chat.json()["id"]
    preflight = await kb_client.post("/kb/chats/visual-preflight", json={
        "chat_id": chat_id, "text": "Summarize inflation",
    })
    assert preflight.status_code == 200, preflight.text
    outcome = preflight.json()
    assert not outcome["requires_visual"]
    assert outcome["state"] == "unverified"
    assert not outcome["supported"]
    assert outcome["reason_code"] is None
    assert outcome["title"] is None

    sent = await kb_client.post(f"/kb/chats/{chat_id}/messages", json={"text": "Summarize inflation"})
    assert sent.status_code == 202, sent.text
    await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")
    assert engines["codex"].turns[-1].visuals == ()


@pytest.mark.parametrize("failure", ["known", "late"])
@pytest.mark.parametrize("with_text", [True, False])
async def test_pdf_renderer_refusal_with_explicit_text_only_retry(
    kb_client: httpx.AsyncClient,
    runtime: Runtime,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
    with_text: bool,
) -> None:
    await connect(kb_client, runtime)
    engines = _setup_routing_matrix(runtime)
    chat = await kb_client.post("/kb/chats", json={"engine": "claude_code", "model": "sonnet"})
    cid = chat.json()["id"]
    path = tmp_path / "report.pdf"
    path.write_bytes(make_pdf([line("Chart caption", 690) if with_text else b""]))
    material = runtime.kb_sources.add_file(path, INBOX_ID)
    body = {"attachments": [material.material_id], "text": "Inspect the chart on page 1"}

    def unavailable(_page_bytes: bytes, number: int) -> Never:
        assert number == 1
        raise VisualSourceUnsupported("pdf_render_unavailable", "The renderer stopped.")

    if failure == "known":
        access = os.access
        monkeypatch.setattr(shutil, "which", lambda _name: None)
        monkeypatch.setattr(os, "access", lambda path, mode: path != "/usr/bin/sips" and access(path, mode))
    else:
        monkeypatch.setattr(runtime.kb_sources.visual, "page_renderer", unavailable)

    pre = await kb_client.post("/kb/chats/visual-preflight", json={"chat_id": cid, **body})
    assert pre.status_code == 200, pre.text
    assert pre.json()["supported"] is (failure == "late")
    if failure == "known":
        assert pre.json()["title"] == "PDF pages are unavailable"
        assert pre.json()["text_only_available"] is with_text

    refused = await kb_client.post(f"/kb/chats/{cid}/messages", json=body)
    assert refused.status_code == 422, refused.text
    assert refused.json()["title"] == "PDF pages are unavailable"
    assert refused.json()["text_only_available"] is with_text
    assert refused.json()["locator"]["material_id"] == material.material_id
    assert refused.json()["locator"]["page"] == 1
    assert not engines["claude_code"].turns
    assert (await kb_client.get(f"/kb/chats/{cid}")).json()["messages"] == []

    retried = await kb_client.post(f"/kb/chats/{cid}/messages", json={**body, "text_only": True})
    if with_text:
        assert retried.status_code == 202, retried.text
        assert {"type": "text_only", "label": TEXT_ONLY_DISCLOSURE} in retried.json()["assistant"]["parts"]
        await settle(lambda: runtime.kb_chats.state_of(cid) == "idle")
        (turn,) = engines["claude_code"].turns
        assert turn.visuals == ()
    else:
        assert retried.status_code == 422
        assert retried.json()["code"] == "VISUAL_TEXT_ONLY_UNAVAILABLE"
        assert not engines["claude_code"].turns


async def test_actual_pdf_pages_keep_order_labels_and_original_digest(
    kb_client: httpx.AsyncClient, runtime: Runtime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    await connect(kb_client, runtime)
    engines = _setup_routing_matrix(runtime)
    chat = await kb_client.post("/kb/chats", json={"engine": "claude_code", "model": "sonnet"})
    cid = chat.json()["id"]
    path = tmp_path / "lecture.pdf"
    data = make_pdf([line("First chart caption", 690), line("Second chart caption", 690)])
    path.write_bytes(data)
    material = runtime.kb_sources.add_file(path, INBOX_ID)
    record = runtime.kb.material_repo.get(material.material_id)
    assert record is not None
    title = record.title
    monkeypatch.setattr(
        runtime.kb_sources.visual, "page_renderer",
        lambda _data, page: make_png(3, 3, color=(page, 0, 0)),
    )
    sent = await kb_client.post(f"/kb/chats/{cid}/messages", json={
        "text": "Compare charts on pages 2 and 1", "attachments": [material.material_id],
    })
    assert sent.status_code == 202, sent.text
    await settle(lambda: runtime.kb_chats.state_of(cid) == "idle")
    (turn,) = engines["claude_code"].turns
    digest = hashlib.sha256(data).hexdigest()
    assert [(v.locator.page, v.locator.label, v.locator.source_sha256) for v in turn.visuals] == [
        (2, f"{title} · Page 2", digest), (1, f"{title} · Page 1", digest),
    ]


@pytest.mark.parametrize("retention", ["permit", "deny", "revoked", "uncited", "interrupted"])
async def test_chat_resolves_linked_frame_citations_and_retains_only_the_exact_frame(
    kb_client: httpx.AsyncClient, runtime: Runtime, retention: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    await connect(kb_client, runtime)
    engine = _setup_routing_matrix(runtime)["claude_code"]
    chat = await kb_client.post("/kb/chats", json={"engine": "claude_code", "model": "sonnet"})
    cid = chat.json()["id"]
    canonical_url = "https://vimeo.com/11111111"
    video = runtime.kb.create_material(
        INBOX_ID, "Synthetic lecture", "video_link",
        [FragmentInput(text="The chart is mentioned.", start_ms=10_000, end_ms=13_000)],
        status="ready", origin=Origin(type="url", url=canonical_url),
    )
    mid = video.manifest.id
    message_path = f"/kb/chats/{cid}/messages"
    query = "Describe the charts at 00:10 and 00:11"
    body = {"attachments": [mid], "text": query}
    source = runtime.kb_sources

    refused = await kb_client.post(message_path, json=body)
    assert refused.status_code == 422, refused.text
    assert "attach a screenshot" in refused.json()["detail"]
    assert not engine.turns
    assert source.list_retained_frames(mid) == ()

    pixels = make_png(3, 3, color=(11, 0, 0))
    other_pixels = make_png(3, 3, color=(22, 0, 0))

    def retrieve(video_source: VideoSource, times: tuple[int, ...]) -> list[RetrievedFrame]:
        assert video_source.url == canonical_url
        assert times == (10_000, 11_000)
        return [
            RetrievedFrame(data=pixels, requested_timestamp_ms=times[0], actual_timestamp_ms=11_000),
            RetrievedFrame(data=other_pixels, requested_timestamp_ms=times[1], actual_timestamp_ms=11_120),
        ]

    source.visual.frame_retriever = retrieve
    source.visual.frame_policy = LinkedFramePolicy(True, retention != "deny")

    def script(turn: AgentTurn) -> list[ScriptItem]:
        first, second = turn.visuals
        assert (first.locator.timestamp_ms, second.locator.timestamp_ms) == (11_000, 11_120)
        if retention == "revoked":
            source.visual.frame_policy = LinkedFramePolicy(False, False)
        if retention == "uncited":
            return text(f"There is a chart at 00:11.000. ⟦m:{mid}:1|The chart is mentioned.⟧ "
                        "⟦frame:vis-unknown⟧")
        result = text("The chart is red. ⟦fra", f"me:{first.visual_id}⟧ ⟦frame:vis-unknown⟧")
        if retention == "interrupted":
            from skaz.knowledge.agents.engine import Failed

            result.append(Failed(turn.run_id, "network", "Fixture stopped."))
        return result

    monkeypatch.setattr(engine, "_script", script)
    sent = await kb_client.post(message_path, json=body)
    assert sent.status_code == 202, sent.text
    await settle(lambda: runtime.kb_chats.state_of(cid) == "idle")
    (turn,) = engine.turns
    outgoing = build_claude_user_message(query, turn.visuals, model_id=turn.model)
    first_caption, first_image, second_caption, second_image = outgoing["message"]["content"][1:]
    assert first_image["source"]["data"] == base64.b64encode(pixels).decode("ascii")
    assert second_image["source"]["data"] == base64.b64encode(other_pixels).decode("ascii")
    assert "00:11.000" in first_caption["text"] and "00:11.120" in second_caption["text"]

    detail = await kb_client.get(f"/kb/chats/{cid}")
    assistant = detail.json()["messages"][-1]
    answer = "".join(part["text"] for part in assistant["parts"] if part["type"] == "text")
    assert "⟦frame:" not in answer
    if retention not in ("uncited", "interrupted"):
        assert "[Video frame at 00:11.000](https://vimeo.com/11111111#t=11s)" in answer
        assert f"⟦frame:{turn.visuals[0].visual_id}⟧" in first_caption["text"]
    records = source.list_retained_frames(mid)
    if retention != "permit":
        assert records == ()
        return
    (saved,) = records
    assert saved.locator.source_url == canonical_url
    assert saved.locator.material_id == mid
    assert saved.locator.timestamp_ms == 11_000 and saved.locator.requested_timestamp_ms == 10_000
    assert saved.sha256 == hashlib.sha256(pixels).hexdigest()
    assert saved.retained_because == ("cited",)
    assert saved.citation_refs == (assistant["id"],)
    assert source.read_retained_frame(mid, saved.frame_id).data == pixels


@pytest.mark.parametrize("condition", [
    "allowed", "expired", "evicted", "retrieval_revoked", "retention_revoked",
])
async def test_answer_pin_action_binds_the_retained_frame_to_its_answer(
    kb_client: httpx.AsyncClient, runtime: Runtime, condition: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    await connect(kb_client, runtime)
    engine = _setup_routing_matrix(runtime)["claude_code"]
    chat = await kb_client.post("/kb/chats", json={"engine": "claude_code", "model": "sonnet"})
    cid = chat.json()["id"]
    video = runtime.kb.create_material(
        INBOX_ID, "Pin fixture", "video_link", [], status="ready",
        origin=Origin(type="url", url="https://vimeo.com/22222222"),
    )
    mid = video.manifest.id
    list_path = f"/kb/chats/{cid}/answer-frames"
    empty = await kb_client.get(list_path)
    assert empty.status_code == 200 and empty.json() == []

    from skaz.visual_transport041 import video_frames

    pixels = make_png(3, 3, color=(1, 2, 3))
    second = make_png(3, 3, color=(3, 2, 1))
    fetches = 0

    def retrieve(_source: VideoSource, times: tuple[int, ...]) -> list[RetrievedFrame]:
        nonlocal fetches
        fetches += 1
        assert times == (10_000, 11_000)
        return [
            RetrievedFrame(data=pixels, actual_timestamp_ms=11_000, requested_timestamp_ms=times[0]),
            RetrievedFrame(data=second, actual_timestamp_ms=11_120, requested_timestamp_ms=times[1]),
        ]

    clock = 0.0
    monkeypatch.setattr(video_frames, "monotonic", lambda: clock)
    if condition == "evicted":
        monkeypatch.setattr(video_frames, "MAX_PIN_CACHE_BYTES", max(len(pixels), len(second)))
    src = runtime.kb_sources
    src.visual.frame_retriever = retrieve
    src.visual.frame_policy = LinkedFramePolicy(True, True)
    answer = await kb_client.post(f"/kb/chats/{cid}/messages", json={
        "attachments": [mid], "text": "Compare the charts at 00:10 and 00:11",
    })
    assert answer.status_code == 202, answer.text
    aid = answer.json()["assistant"]["id"]
    await settle(lambda: runtime.kb_chats.state_of(cid) == "idle")
    assert src.list_retained_frames(mid) == ()
    response = await kb_client.get(list_path)
    assert response.status_code == 200, response.text
    choices = response.json()
    if condition == "evicted":
        assert [item["timestamp_ms"] for item in choices] == [11_120]
        older = engine.turns[0].visuals[0].visual_id
        pin = await kb_client.post(f"/kb/chats/{cid}/messages/{aid}/frames/{older}/pin")
        assert pin.status_code == 409 and pin.json()["code"] == "FRAME_EXPIRED"
        assert src.list_retained_frames(mid) == ()
        assert fetches == 1
        return
    first, choice = choices
    assert first["timestamp_ms"] == 11_000
    assert choice == {
        "message_id": aid, "frame_id": choice["frame_id"], "material_id": mid,
        "label": "Pin fixture", "timestamp_ms": 11_120, "pinned": False,
    }
    frame_id = choice["frame_id"]
    question_id = answer.json()["user"]["id"]
    invalid = await kb_client.post(f"/kb/chats/{cid}/messages/{question_id}/frames/{frame_id}/pin")
    assert invalid.status_code == 409
    assert src.list_retained_frames(mid) == ()
    if condition == "expired":
        clock = video_frames.FRAME_PIN_TTL_SECONDS + 1
    elif condition.endswith("_revoked"):
        src.visual.frame_policy = LinkedFramePolicy(
            retrieval_permitted=condition != "retrieval_revoked",
            retention_permitted=condition != "retention_revoked",
        )

    pin_path = f"/kb/chats/{cid}/messages/{aid}/frames/{frame_id}/pin"
    pin = await kb_client.post(pin_path)
    if condition != "allowed":
        assert pin.status_code == 409, pin.text
        assert pin.json()["code"] == ("FRAME_EXPIRED" if condition == "expired" else "FRAME_UNAVAILABLE")
        assert (await kb_client.get(list_path)).json() == []
        assert src.list_retained_frames(mid) == ()
    else:
        assert pin.status_code == 200, pin.text
        assert pin.json() == {**choice, "pinned": True}
        repeated = await kb_client.post(pin_path)
        assert repeated.status_code == 200, repeated.text
        assert (await kb_client.get(list_path)).json() == [first, pin.json()]
        (saved,) = src.list_retained_frames(mid)
        assert saved.locator.source_url == "https://vimeo.com/22222222"
        assert saved.locator.timestamp_ms == 11_120 and saved.locator.requested_timestamp_ms == 11_000
        assert saved.sha256 == hashlib.sha256(second).hexdigest()
        assert saved.retained_because == ("pinned",) and not saved.citation_refs
        assert src.read_retained_frame(mid, saved.frame_id).data == second
    assert fetches == 1


def test_answer_frame_schema_and_v2_scan_capability_share_the_generated_contract(kb_app: FastAPI) -> None:
    spec = kb_app.openapi()
    schemas = spec["components"]["schemas"]
    frame = schemas["KbAnswerFrame"]
    fields = {
        "message_id": "string", "frame_id": "string", "material_id": "string",
        "label": "string", "timestamp_ms": "integer", "pinned": "boolean",
    }
    assert {name: prop["type"] for name, prop in frame["properties"].items()} == fields
    assert set(frame["required"]) == set(fields)
    saved_count = schemas["KbMaterialAdded"]["properties"]["saved_pdf_page_count"]
    assert saved_count["anyOf"] == [{"exclusiveMinimum": 0.0, "type": "integer"}, {"type": "null"}]
    assert "saved_pdf_page_count" not in schemas["KbMaterialAdded"]["required"]
    listing = "/kb/chats/{chat_id}/answer-frames"
    pinning = "/kb/chats/{chat_id}/messages/{message_id}/frames/{frame_id}/pin"
    ref = {"$ref": "#/components/schemas/KbAnswerFrame"}
    for path, verb, response in [
        (listing, "get", {"type": "array", "items": ref}),
        (pinning, "post", ref),
    ]:
        operation = spec["paths"][path][verb]
        assert "requestBody" not in operation
        payload = operation["responses"]["200"]["content"]["application/json"]["schema"]
        assert {key: value for key, value in payload.items() if key != "title"} == response

    generated = (Path(__file__).resolve().parents[3] / "frontend/src/api/kb/types.gen.ts").read_text()
    assert "  saved_pdf_page_count?: number | null;" in generated
    frame_type = generated.split("export interface KbAnswerFrame {\n", 1)[1].split("}", 1)[0]
    assert frame_type == "".join(
        f"  {name}: {'number' if kind == 'integer' else kind};\n" for name, kind in fields.items()
    )
    for route, result in [(f"GET {listing}", "KbAnswerFrame[]"), (f"POST {pinning}", "KbAnswerFrame")]:
        operation_type = generated.split(f'  "{route}": {{\n', 1)[1].split("\n  };", 1)[0]
        assert f"    body: never;\n    response: {result};\n    status: 200;" in operation_type
