"""Authored no-network App Server fixture: immediate calls expose binding races."""
from __future__ import annotations

import json
import sys

turn = 0
mode = "normal"


def send(value: dict[str, object]) -> None:
    print(json.dumps(value), flush=True)


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        send({"id": request["id"], "result": {}})
    elif method == "thread/start":
        params = request["params"]
        assert params["environments"] == []
        assert params["ephemeral"] is True
        assert params["config"]["web_search"] == "disabled"
        send({"id": request["id"], "result": {"thread": {"id": "thread-fixture"}}})
    elif method == "turn/start":
        turn += 1
        mode = request["params"]["input"][0]["text"]
        send({"id": request["id"], "result": {"turn": {"id": f"turn-{turn}", "status": "inProgress"}}})
        if mode == "case:timeout":
            continue
        if mode == "case:stream":
            events: list[tuple[str, dict[str, object]]] = [
                ("item/started", {"item": {
                    "id": "comment", "type": "agentMessage", "phase": "commentary",
                }}),
                ("item/agentMessage/delta", {"itemId": "comment", "delta": "Working"}),
                ("item/completed", {"item": {
                    "id": "reason", "type": "reasoning", "text": "PRIVATE REASONING",
                }}),
                ("item/started", {"item": {
                    "id": "answer", "type": "agentMessage", "phase": "final_answer",
                }}),
                ("item/agentMessage/delta", {"itemId": "answer", "delta": "First"}),
                ("item/agentMessage/delta", {"itemId": "answer", "delta": " draft"}),
                ("item/completed", {"item": {
                    "id": "answer", "type": "agentMessage", "phase": "final_answer", "text": "Final",
                }}),
            ]
            for event_method, payload in events:
                send({"method": event_method, "params": {
                    "threadId": "thread-fixture", "turnId": f"turn-{turn}", **payload,
                }})
            # Deliberately stay alive: the test interrupts after the checkpoint.
            continue
        if mode == "case:failed":
            send({"method": "item/agentMessage/delta", "params": {
                "threadId": "thread-fixture", "turnId": f"turn-{turn}",
                "itemId": "partial", "delta": "Partial",
            }})
            send({"method": "turn/completed", "params": {
                "threadId": "thread-fixture", "turn": {
                    "id": f"turn-{turn}", "status": "failed", "error": {"message": "PRIVATE PROVIDER ERROR"},
                },
            }})
            continue
        send({"method": "item/tool/call", "id": "tool-call", "params": {
            "threadId": "thread-fixture", "turnId": f"turn-{turn}", "callId": "reused-per-turn",
            "tool": "skaz_read_range", "arguments": {},
        }})
    elif method == "fixture/disconnect":
        sys.exit(17)
    elif method == "turn/interrupt":
        send({"id": request["id"], "result": {}})
        send({"method": "turn/completed", "params": {
            "threadId": "thread-fixture", "turn": {"id": f"turn-{turn}", "status": "interrupted"},
        }})
    elif request.get("id") == "tool-call":
        assert request["result"]["success"] is True
        assert request["result"]["contentItems"][0]["text"] == "Authored evidence"
        for item in [
            {"id": "reason", "type": "reasoning", "text": "PRIVATE REASONING"},
            {"id": "answer", "type": "agentMessage", "text": "Fixture answer", "phase": "final_answer"},
        ]:
            send({"method": "item/completed", "params": {
                "threadId": "thread-fixture", "turnId": f"turn-{turn}", "item": item,
            }})
        send({"method": "turn/completed", "params": {
            "threadId": "thread-fixture", "turn": {"id": f"turn-{turn}", "status": "completed"},
        }})
