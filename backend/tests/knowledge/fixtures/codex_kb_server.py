"""Authored no-network Codex App Server stand-in for the knowledge Codex adapter tests.

Usage: ``python codex_kb_server.py <log.jsonl>``. Every message received is
appended to the log. The turn's behaviour is picked by ``case:<name>`` in the
user input text. Not a model: it proves protocol handling, not answer quality.
"""
from __future__ import annotations

import json
import os
import re
import sys

LOG = sys.argv[1]
THREAD = f"thread-{os.getpid()}"
TURN = "turn-1"
mode = "stream"
USAGE = {"totalTokens": 150, "inputTokens": 120, "cachedInputTokens": 0, "cacheWriteInputTokens": 0,
         "outputTokens": 30, "reasoningOutputTokens": 5}


def send(value: dict[str, object]) -> None:
    print(json.dumps(value), flush=True)


def log(value: object) -> None:
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False) + "\n")


def event(method: str, **params: object) -> None:
    payload: dict[str, object] = {"threadId": THREAD, **params}
    if method != "turn/completed":
        payload.setdefault("turnId", TURN)
    send({"method": method, "params": payload})


def complete(status: str = "completed", error: object = None) -> None:
    event("turn/completed", turn={"id": TURN, "status": status, "items": [], "error": error})


def answer(item_id: str, text: str) -> None:
    event("item/started", item={"id": item_id, "type": "agentMessage", "phase": "final_answer", "text": ""})
    event("item/agentMessage/delta", itemId=item_id, delta=text)
    event("item/completed", item={"id": item_id, "type": "agentMessage", "phase": "final_answer",
                                  "text": text})


def start_turn() -> None:
    if mode == "stream":
        event("item/started", item={"id": "c1", "type": "agentMessage", "phase": "commentary", "text": ""})
        event("item/agentMessage/delta", itemId="c1", delta="Thinking aloud")
        event("item/completed", item={"id": "c1", "type": "agentMessage", "phase": "commentary",
                                      "text": "Thinking aloud"})
        event("item/completed", item={"id": "r1", "type": "reasoning", "text": "PRIVATE REASONING"})
        event("item/started", item={"id": "a1", "type": "agentMessage", "phase": "final_answer", "text": ""})
        event("item/agentMessage/delta", itemId="a1", delta="Hello")
        event("item/agentMessage/delta", itemId="a1", delta=" world")
        event("item/completed", item={"id": "a1", "type": "agentMessage", "phase": "final_answer",
                                      "text": "Hello world"})
        event("item/started", item={"id": "a2", "type": "agentMessage", "phase": None, "text": ""})
        event("item/agentMessage/delta", itemId="a2", delta="Sec")
        event("item/completed", item={"id": "a2", "type": "agentMessage", "phase": None,
                                      "text": "Second part"})
        event("thread/tokenUsage/updated", tokenUsage={
            "total": USAGE, "last": USAGE,
            "modelContextWindow": None})
        complete()
    elif mode in ("tool", "tool_error"):
        arguments = {} if mode == "tool" else {"material_id": "mat-nope", "seg": 1}
        name = "skaz_list_folders" if mode == "tool" else "skaz_get_fragment"
        send({"id": "tool-1", "method": "item/tool/call", "params": {
            "threadId": THREAD, "turnId": TURN, "callId": "call-1", "namespace": None,
            "tool": name, "arguments": arguments}})
    elif mode == "wait_tool":  # a SKAZ tool that waits for the user (0.3.1 P: the deadline stands still)
        send({"id": "tool-1", "method": "item/tool/call", "params": {
            "threadId": THREAD, "turnId": TURN, "callId": "call-1", "namespace": None,
            "tool": "skaz_test_wait", "arguments": {}}})
    elif mode == "approval":  # despite approvalPolicy never (0.3.1 A-1)
        # Shape: CommandExecutionRequestApprovalParams.json of codex-cli 0.160.0.
        send({"id": "approval-1", "method": "item/commandExecution/requestApproval", "params": {
            "threadId": THREAD, "turnId": TURN, "itemId": "cmd-1", "startedAtMs": 1,
            "command": "rm -rf ~/secret",
            "cwd": "/tmp", "reason": "PRIVATE REASON"}})
    elif mode == "ingest":
        send({"id": "tool-x", "method": "item/tool/call", "params": {
            "threadId": THREAD, "turnId": TURN, "callId": "call-x", "namespace": None,
            "tool": "skaz_list_folders", "arguments": {}}})
    elif mode == "limit":
        send({"method": "account/rateLimits/updated", "params": {"rateLimits": {
            "limitId": "codex",
            "primary": {"usedPercent": 100, "windowDurationMins": 300, "resetsAt": 1790000000},
            "secondary": {"usedPercent": 40, "windowDurationMins": 10080, "resetsAt": 1790500000}}}})
        event("error", error={"message": "PRIVATE PROVIDER TEXT", "codexErrorInfo": "usageLimitExceeded"},
              willRetry=False)
        complete("failed", {"message": "PRIVATE PROVIDER TEXT", "codexErrorInfo": "usageLimitExceeded"})
    elif mode in ("limit_read", "limit_unknown"):
        complete("failed", {"message": "PRIVATE PROVIDER TEXT", "codexErrorInfo": "rateLimitExceeded"})
    elif mode == "auth":
        complete("failed", {"message": "PRIVATE", "codexErrorInfo": "unauthorized"})
    elif mode == "hang":
        event("item/started", item={"id": "h1", "type": "agentMessage", "phase": "final_answer", "text": ""})
        event("item/agentMessage/delta", itemId="h1", delta="Working")
    elif mode == "crash":
        sys.exit(9)
    elif mode == "websearch":  # W-3b: the clean search run (ThreadItem webSearch of codex-cli 0.160.0)
        event("item/started", item={"id": "w1", "type": "webSearch", "query": "", "action": None})
        event("item/completed", item={"id": "w1", "type": "webSearch", "query": "entropy definition",
                                      "action": {"type": "search", "query": "entropy definition"},
                                      "results": [{"title": "Entropy — Britannica",
                                                   "url": "https://www.britannica.com/science/entropy"}]})
        answer("s1", "- [Entropy — Wikipedia](https://en.wikipedia.org/wiki/Entropy)\n"
                     "- Entropy (Stanford Encyclopedia): https://plato.stanford.edu/entries/entropy/\n"
                     "- [Bad](javascript:alert(1))")
        complete()


for line in sys.stdin:
    message = json.loads(line)
    log(message)
    method = message.get("method")
    if "method" not in message:  # a response to our server request (tool call)
        if message.get("id") == "tool-1":
            ok = message["result"]["success"]
            answer("t1", f"Tool answered: {ok}")
            complete()
        elif message.get("id") == "approval-1":
            answer("t3", f"Refused: {message['error']['message']}")
            complete()
        elif message.get("id") == "tool-x":
            answer("t2", "No tools")
            complete()
        continue
    if "id" not in message:
        continue  # the "initialized" notification
    identity = message["id"]
    if method == "initialize":
        send({"id": identity, "result": {"userAgent": "fixture"}})
    elif method == "thread/start":
        send({"id": identity, "result": {"thread": {"id": THREAD}}})
    elif method == "turn/start":
        text = message["params"]["input"][0]["text"]
        found = re.findall(r"case:([a-z_]+)", text)
        mode = found[-1] if found else "stream"
        send({"id": identity, "result": {"turn": {"id": TURN, "status": "inProgress"}}})
        start_turn()
    elif method == "turn/interrupt":
        send({"id": identity, "result": {}})
        complete("interrupted")
    elif method == "account/rateLimits/read":
        if mode == "limit_unknown":
            send({"id": identity, "error": {"code": -32603, "message": "PRIVATE"}})
        else:
            send({"id": identity, "result": {"rateLimits": {
                "primary": {"usedPercent": 100, "windowDurationMins": 60, "resetsAt": 1791000000},
                "secondary": None}, "rateLimitsByLimitId": None}})
    elif method == "model/list":
        send({"id": identity, "result": {"nextCursor": None, "data": [
            {"id": "m1", "model": "gpt-fixture", "displayName": "Fixture", "hidden": False,
             "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "high"}],
             "defaultReasoningEffort": "low"},
            {"id": "m2", "model": "gpt-hidden", "displayName": "Hidden", "hidden": True,
             "supportedReasoningEfforts": [], "defaultReasoningEffort": "low"},
        ]}})
    else:
        send({"id": identity, "error": {"code": -32601, "message": "unknown"}})
