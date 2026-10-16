"""Authored protocol peer, never connects to a model or search provider."""

import json
import sys


def send(value: dict[str, object]) -> None:
    print(json.dumps(value), flush=True)


def search(identity: str, query: str) -> None:
    send(
        {
            "id": identity,
            "method": "item/tool/call",
            "params": {
                "threadId": "fixture",
                "turnId": "turn",
                "callId": identity,
                "tool": "skaz_search_web",
                "arguments": {"query": query},
            },
        }
    )


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        send({"id": request["id"], "result": {}})
    elif method == "thread/start":
        assert request["params"]["config"]["web_search"] == "disabled"
        names = [t["name"] for t in request["params"]["dynamicTools"]]
        assert "skaz_search_web" in names and "web_search" not in names
        send({"id": request["id"], "result": {"thread": {"id": "fixture"}}})
    elif method == "turn/start":
        send({"id": request["id"], "result": {"turn": {"id": "turn", "status": "inProgress"}}})
        search("search1", "approved public query")
    elif method == "turn/interrupt":
        send({"id": request["id"], "result": {}})
        send(
            {
                "method": "turn/completed",
                "params": {
                    "threadId": "fixture",
                    "turn": {"id": "turn", "status": "interrupted"},
                },
            }
        )
    elif request.get("id") == "search1":
        assert request["result"]["success"]
        result = json.loads(request["result"]["contentItems"][0]["text"])
        assert result["results"][0]["url"] == "https://example.org/source"
        search("search2", "changed follow-up query")
    elif request.get("id") == "search2":
        assert request["result"]["success"]
        result = json.loads(request["result"]["contentItems"][0]["text"])
        assert result["status"] == "declined"
        send(
            {
                "method": "item/completed",
                "params": {
                    "threadId": "fixture",
                    "turnId": "turn",
                    "item": {
                        "id": "answer",
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": "External evidence [Source](https://example.org/source); follow-up declined.",
                    },
                },
            }
        )
        send(
            {
                "method": "turn/completed",
                "params": {
                    "threadId": "fixture",
                    "turn": {"id": "turn", "status": "completed"},
                },
            }
        )
