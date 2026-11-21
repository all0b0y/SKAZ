"""Invoked only from the offline vendor executables. Use the SKAZ URL/token their adapter provided."""

import json
import urllib.parse
import urllib.request
from typing import Any


def call_local_mcp(server: dict[str, Any], call: dict[str, Any]) -> dict[str, Any]:
    address = urllib.parse.urlsplit(server["url"])
    assert address.hostname == "127.0.0.1" and address.path == "/kb/mcp"
    headers = server["headers"]
    if isinstance(headers, list):
        headers = {item["name"]: item["value"] for item in headers}
    headers = {
        **headers,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
    }
    request = urllib.request.Request(
        server["url"],
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": call,
            }
        ).encode(),
        headers,
    )
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with client.open(request, timeout=15) as response:
        raw = response.read().decode()
        if response.headers.get_content_type() == "text/event-stream":
            raw = next(line[6:] for line in raw.splitlines() if line.startswith("data: "))
    return dict(json.loads(raw))
