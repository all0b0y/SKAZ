"""No-network authored App Server peer for Runtime contract integration tests."""
import json
import os
import re
import sys
import time
from pathlib import Path


def send(value: dict[str, object]) -> None:
    print(json.dumps(value), flush=True)


hold = False
turns = 0
# Authored replies per turn, for exercising the one bounded correction. The default
# keeps the old single reply, shaped as a note when a note was requested.
scripted = json.loads(os.environ.get("FIXTURE_ANSWERS", "[]"))
note_requested = False

for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        send({"id": request["id"], "result": {}})
    elif method == "thread/start":
        send({"id": request["id"], "result": {"thread": {"id": "fixture"}}})
    elif method == "turn/start":
        if release := os.environ.get("FIXTURE_RELEASE"):
            deadline = time.monotonic() + 5
            while not Path(release).exists():
                assert time.monotonic() < deadline, "Fixture release timed out"
                time.sleep(0.01)
        prompt = request["params"]["input"][0]["text"]
        hold = "WAIT_FOR_STOP" in prompt
        turns += 1
        send({"id": request["id"], "result": {"turn": {"id": f"turn{turns}", "status": "inProgress"}}})
        match = re.search(r"Available transcript session IDs: (.+)\n", prompt)
        if match is None:
            # A follow-up turn in the same thread (the correction): no reading, just a reply.
            note_requested = note_requested or "level-1 heading" in prompt
            request = {"id": "read", "result": {"success": True}}
        else:
            note_requested = note_requested or "level-1 heading" in prompt
            sid = json.loads(match[1])[0]
            send({"id": "read", "method": "item/tool/call", "params": {
                "threadId": "fixture", "turnId": f"turn{turns}", "callId": f"read{turns}",
                "tool": "skaz_read_transcript", "arguments": {"session_id": sid},
            }})
            continue
    elif method == "turn/interrupt":
        send({"id": request["id"], "result": {}})
        send({"method": "turn/completed", "params": {
            "threadId": "fixture", "turn": {"id": f"turn{turns}", "status": "interrupted"},
        }})
        continue
    if request.get("id") == "read":
        assert request["result"]["success"] is True
        if scripted:
            text = scripted[min(turns, len(scripted)) - 1]
        elif note_requested:
            text = "# Authored note\n\nAuthored fixture answer [P1]"
        else:
            text = "Authored fixture answer [P1]"
        send({"method": "item/completed", "params": {
            "threadId": "fixture", "turnId": f"turn{turns}", "item": {
                "id": f"answer{turns}", "type": "agentMessage", "phase": "final_answer",
                "text": text,
            },
        }})
        if not hold:
            send({"method": "turn/completed", "params": {
                "threadId": "fixture", "turn": {"id": f"turn{turns}", "status": "completed"},
            }})
