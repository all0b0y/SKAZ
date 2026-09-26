"""Real pinned Codex, local Responses fixture; no subscription or speech claim.

Run explicitly: backend/.venv/bin/python -m pytest scripts/codex-e2e/test_tool_host.py -q
macOS sandbox denies all network except this authored HTTP responder.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from audiohelper.gateways.codex_rpc import CodexRpc
from audiohelper.gateways.codex_session import (
    DISABLED_FEATURES,
    CodexSession,
    ToolDefinition,
)


@pytest.mark.parametrize("case", ["read", "isolation"])
def test_luna_tool_host(tmp_path: Path, case: str) -> None:
    asyncio.run(probe(tmp_path, case))


async def probe(root: Path, case: str) -> None:
    binary, sandbox = shutil.which("codex"), shutil.which("sandbox-exec")
    assert binary and sandbox, "Explicit integration gate requires Codex and macOS sandbox-exec"
    requests: list[dict[str, Any]] = []
    calls: list[dict[str, Any]] = []
    script = 'text(await tools.skaz_read_transcript({session_id:"allowed"}))'
    if case == "isolation":
        script = '''
text({process:typeof process,require:typeof require,fetch:typeof fetch});
for (const name of ["shell", "shell_command", "exec_command", "apply_patch", "spawn_agent", "web_search", "read_file"]) {
  text({name, available:typeof tools[name]});
}
try { await import("node:fs"); text("UNSAFE_IMPORT"); } catch (_) { text("IMPORT_DENIED"); }
text(await tools.skaz_read_transcript({session_id:"other"}));
'''

    class Fixture(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass

        def do_POST(self) -> None:
            assert self.path == "/v1/responses"
            requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            item = ({"type": "custom_tool_call", "call_id": "host-call", "name": "exec",
                     "namespace": "functions", "input": script}
                    if len(requests) == 1 else
                    {"type": "message", "id": "answer", "role": "assistant",
                     "content": [{"type": "output_text", "text": "AUTHORED COMPLETION"}]})
            events = [
                {"type": "response.created", "response": {"id": "fixture-response"}},
                {"type": "response.output_item.done", "item": item},
                {"type": "response.completed", "response": {"id": "fixture-response", "usage": {
                    "input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}},
            ]
            body = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        home, profile, work = [root / name for name in ("home", "profile", "work")]
        for path in (home, profile, work):
            path.mkdir()
        (profile / "config.toml").write_text(
            'model_provider="skaz_fixture"\napproval_policy="never"\n'
            'sandbox_mode="read-only"\nweb_search="disabled"\n[features]\n'
            + "".join(f"{name}=false\n" for name in DISABLED_FEATURES)
            + '[model_providers.skaz_fixture]\nname="Authored fixture"\n'
            + f'base_url="http://127.0.0.1:{server.server_port}/v1"\n'
            + 'wire_api="responses"\nsupports_websockets=false\nrequires_openai_auth=false\n'
            + 'request_max_retries=0\nstream_max_retries=0\n'
        )
        env = {"HOME": str(home), "CODEX_HOME": str(profile), "TMPDIR": str(root),
               "PATH": os.pathsep.join([str(Path(shutil.which("node") or "/usr/bin/node").parent),
                                        "/usr/bin", "/bin", "/usr/sbin", "/sbin"])}
        policy = ('(version 1)(allow default)(deny network*)'
                  f'(allow network-outbound (remote ip "localhost:{server.server_port}"))')

        async def read(arguments: dict[str, Any]) -> str:
            calls.append(arguments)
            if arguments != {"session_id": "allowed"}:
                raise ValueError("Session outside scope")
            return "AUTHORED TRANSCRIPT EVIDENCE"

        tool = ToolDefinition("skaz_read_transcript", "Read authorized transcript only", {
            "type": "object", "properties": {"session_id": {"type": "string"}},
            "required": ["session_id"], "additionalProperties": False,
        }, read)
        async with CodexRpc((sandbox, "-p", policy, binary, "app-server"), cwd=work, env=env) as rpc:
            assert (await rpc.request("account/read", {"refreshToken": False}))["account"] is None
            session = CodexSession(rpc, cwd=work, model="gpt-5.6-luna", effort="medium",
                                   tools=[tool], turn_timeout=30)
            result = await session.ask("Authored fixture request")
            assert result.status == "completed"
        assert len(requests) == 2
        outputs = [x for x in requests[1]["input"] if x.get("type") == "custom_tool_call_output"]
        output = json.dumps(outputs, ensure_ascii=False)
        assert "code-mode host is disabled" not in output
        if case == "read":
            assert calls == [{"session_id": "allowed"}]
            assert "AUTHORED TRANSCRIPT EVIDENCE" in output
        else:
            assert calls == [{"session_id": "other"}]
            assert "Tool unavailable or request refused" in output
            assert "AUTHORED TRANSCRIPT EVIDENCE" not in output
            assert "IMPORT_DENIED" in output and "UNSAFE_IMPORT" not in output
            # JSON text blocks may be nested/escaped; decode the tool output before checking.
            text = str(outputs[0]["output"])
            for name in ("process", "require", "fetch"):
                assert f'"{name}":"undefined"' in text, text
            for name in ("shell", "shell_command", "exec_command", "apply_patch", "spawn_agent", "web_search", "read_file"):
                assert f'"name":"{name}","available":"undefined"' in text, text
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
