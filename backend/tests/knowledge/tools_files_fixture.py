"""A loopback MCP application with observable effects and deterministic redirect/resource replies."""

from __future__ import annotations

import base64
import json
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

FILE_NAME = "Итог.txt"
FILE_BYTES = "Конспект с буквой ё.\n".encode()
SKILL_BYTES = (
    b"---\nname: Lecture brief\ndescription: Make a lecture brief\n---\n"
    b"Use the fixture glossary ZEPHYR-704. See scripts/format.py.\n"
)


@dataclass
class External:
    url: str = ""
    calls: list[dict[str, Any]] = field(default_factory=list)
    requests: list[str] = field(default_factory=list)
    mode: str = "file"
    tool_name: str = "save_note"

    def result(self, body: dict[str, Any]) -> dict[str, Any]:
        method = body["method"]
        if method == "initialize":
            return {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "Local notes", "version": "1"},
            }
        if method == "tools/list":
            return {
                "tools": [
                    {
                        "name": self.tool_name,
                        "description": "Create a note",
                        "inputSchema": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["title"],
                            "properties": {"title": {"type": "string"}},
                        },
                    }
                ]
            }
        if method == "tools/call":
            self.calls.append(body["params"])
            content = (
                {
                    "type": "resource",
                    "resource": {
                        "uri": "file:///result.txt",
                        "name": FILE_NAME,
                        "mimeType": "text/plain",
                        "blob": base64.b64encode(FILE_BYTES).decode(),
                    },
                }
                if self.mode == "file"
                else {"type": "text", "text": "https://outside.invalid/result"}
            )
            return {"content": [content]}
        return {}


@pytest.fixture
def external() -> Iterator[External]:
    fixture = External()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: object) -> None:
            pass

        def reply(self, code: int, data: bytes = b"", **headers: str) -> None:
            self.send_response(code)
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self) -> None:
            fixture.requests.append(self.path)
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path.endswith("/redirect"):
                self.reply(307, Location="/mcp")
            elif self.path.endswith("/blocked"):
                # Unsupported scheme. The fixture cannot cause a network request to an outside host.
                self.reply(307, Location="file:///fixture")
            elif "id" not in body:
                self.reply(202)
            else:
                result = {"jsonrpc": "2.0", "id": body["id"], "result": fixture.result(body)}
                self.reply(200, json.dumps(result).encode(), **{"Content-Type": "application/json"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    fixture.url = f"http://127.0.0.1:{server.server_port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield fixture
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
