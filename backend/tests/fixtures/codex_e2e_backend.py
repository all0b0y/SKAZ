"""Electron smoke backend: real Runtime/Codex, authored localhost Responses only.

Not imported by production. This replaces only the provider boundary in an
isolated test profile. No accounts, credentials, microphones or remote calls.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx
import uvicorn

from skaz import repository as repo
from skaz.app import create_app
from skaz.codex_schemas import CodexSettings
from skaz.config import AppConfig
from skaz.gateways.codex_rpc import CodexRpc
from skaz.gateways.codex_session import DISABLED_FEATURES
from skaz.schemas import Segment

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, required=True)
args = parser.parse_args()
config = AppConfig.from_env(args.port)
root = config.data_dir
assert "skaz-codex-e2e-" in str(root), "Disposable profile required"
binary = os.environ["SKAZ_FIXTURE_CODEX"]
sandbox = shutil.which("sandbox-exec")
assert sandbox and Path(binary).is_file()
app = create_app(config)
service = app.state.runtime.codex
requests: list[dict[str, Any]] = []
search_queries: list[str] = []


def search_response(request: httpx.Request) -> httpx.Response:
    assert request.url.host == "api.search.brave.com"
    query = request.url.params["q"]
    assert query == "approved public query"
    search_queries.append(query)
    (root / "fixture-search-requests.json").write_text(json.dumps(search_queries))
    return httpx.Response(200, json={"web": {"results": [
        {"title": "Source", "url": "https://example.org/source", "description": "AUTHORED SEARCH EVIDENCE"}
    ]}})


app.state.runtime.web_search._transport = lambda: httpx.MockTransport(search_response)


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_POST(self) -> None:
        assert self.path == "/v1/responses"
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(request)
        text = json.dumps(request["input"])
        current = text.rsplit("Current user request:\\n", 1)[-1]
        recovering = any(
            t.status == "running" and "PAUSE_FIXTURE" in t.question
            and service._meta(t.id).get("attempts", 0) > 1
            for t in service.queue.list()
        )
        pause = "PAUSE_FIXTURE" in current and not recovering
        # Only authored test content is stored; never provider credentials.
        (root / "fixture-requests.json").write_text(json.dumps(requests))
        source_ids = re.search(r'Available transcript session IDs: (\[.*?\])', text)
        assert source_ids, text[:200]
        sid = json.loads(source_ids[1].replace('\\"', '"'))[0]
        outputs = [i for i in request["input"] if i.get("type") in
                   ("function_call_output", "custom_tool_call_output")]
        item: dict[str, Any]
        if "WEB_SEARCH_FIXTURE" in current and not any(i.get("call_id") == "search" for i in outputs):
            item = {"type": "function_call", "call_id": "search", "name": "skaz_search_web",
                    "arguments": json.dumps({"query": "approved public query"})}
        elif "WEB_SEARCH_FIXTURE" in current and not any(i.get("call_id") == "followup" for i in outputs):
            item = {"type": "function_call", "call_id": "followup", "name": "skaz_search_web",
                    "arguments": json.dumps({"query": "changed follow-up query"})}
        elif "WEB_SEARCH_FIXTURE" in current:
            item = {"type": "message", "id": "answer", "role": "assistant", "phase": "final_answer",
                    "content": [{"type": "output_text",
                                 "text": "AUTHORED WEB ANSWER [Source](https://example.org/source)"}]}
        elif not outputs:
            item = {"type": "function_call", "call_id": "read", "name": "skaz_read_transcript",
                    "arguments": json.dumps({"session_id": sid})}
        elif "EDIT_NOTE" in current and not any(i.get("call_id") == "notes" for i in outputs):
            item = {"type": "function_call", "call_id": "notes", "name": "skaz_read_notes",
                    "arguments": json.dumps({"session_id": sid})}
        elif "EDIT_NOTE" in current and not any(i.get("call_id") == "edit" for i in outputs):
            note = repo.latest_note(app.state.runtime.db, sid)
            assert note is not None
            item = {"type": "function_call", "call_id": "edit", "name": "skaz_propose_note_edit",
                    "arguments": json.dumps({"session_id": sid, "note_id": note.id,
                                              "content": "AUTHORED EDIT [P1]"})}
        elif "exactly ONE note" in text:
            note_text = (
                "## Example\n\nAUTHORED EXTRA SECTION [P1]"
                if "Continue the SAME document" in current else
                "# Authored note\n\nAUTHORED E2E ANSWER [P1]\n<!-- SKAZ_NOTE_CONTINUE -->"
            )
            item = {"type": "message", "id": "answer", "role": "assistant", "phase": "final_answer",
                    "content": [{"type": "output_text", "text": note_text}]}
        else:
            item = {"type": "message", "id": "answer", "role": "assistant", "phase": "final_answer",
                    "content": [{"type": "output_text", "text": ("AUTHORED PARTIAL [P1]" if pause else
                        "AUTHORED CONTINUATION [P1]" if recovering else "AUTHORED E2E ANSWER [P1]")}]}
        events = [
            {"type": "response.created", "response": {"id": "fixture"}},
            {"type": "response.output_item.done", "item": item},
            {"type": "response.completed", "response": {"id": "fixture", "usage": {
                "input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}},
        ]
        if pause and outputs:
            events = events[:-1]  # Classified item, then disconnect before turn completion.
        body = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
env = service.connection.environment()
profile = Path(env["CODEX_HOME"])
(profile / "config.toml").write_text(
    'model="mock-model"\nmodel_provider="skaz_fixture"\n'
    'approval_policy="never"\nsandbox_mode="read-only"\nweb_search="disabled"\n'
    "[features]\n"
    + "".join(f"{name}=false\n" for name in DISABLED_FEATURES)
    + '[model_providers.skaz_fixture]\nname="Authored fixture"\n'
    f'base_url="http://127.0.0.1:{server.server_port}/v1"\n'
    'wire_api="responses"\nsupports_websockets=false\nrequires_openai_auth=false\n'
    "request_max_retries=0\nstream_max_retries=0\n"
)
policy = (
    "(version 1)(allow default)(deny network*)"
    f'(allow network-outbound (remote ip "localhost:{server.server_port}"))'
)
service.connection.rpc = lambda: CodexRpc(
    (sandbox, "-p", policy, binary, "app-server"),
    cwd=service.connection.cwd,
    env=env,
)
service.connection.view.update(
    status="connected",
    models=[
        {
            "id": "mock-model",
            "label": "LOCAL AUTHORED FIXTURE",
            "efforts": ["high"],
        }
    ],
)
service._save_settings(
    CodexSettings(
        assistant_enabled=True,
        notes_enabled=True,
        assistant_model="mock-model",
        assistant_effort="high",
        notes_model="mock-model",
        notes_effort="high",
    )
)
if not repo.list_sessions(app.state.runtime.db):
    sid = repo.create_session(app.state.runtime.db, "AUTHORED E2E SESSION").id
    repo.replace_chunk_segments(
        app.state.runtime.db,
        sid,
        0,
        [
            Segment(
                id="fixture-source",
                start_ms=0,
                end_ms=1000,
                text="AUTHORED EVIDENCE NOT REAL SPEECH",
            )
        ],
    )
uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False)
