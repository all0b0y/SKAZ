"""Authored stdio boundary fixture; never calls a model or network."""
from __future__ import annotations

import json
import os
import sys

pending: list[int] = []


def send(value: dict[str, object]) -> None:
    print(json.dumps(value), flush=True)


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        send({"id": request["id"], "result": {"userAgent": "authored-fixture"}})
    elif method == "account/read":
        send({"method": "fixture/progress", "params": {"stage": "reading"}})
        send({"id": request["id"], "result": {"account": None}})
    elif method == "fixture/failure":
        failure = request["params"]["kind"]
        if failure == "eof":
            sys.exit(0)
        if failure == "malformed":
            print("PRIVATE INVALID PAYLOAD", flush=True)
        elif failure == "oversized":
            print("x" * 4096, flush=True)
        elif failure == "flood":
            for _ in range(8):
                send({"method": "fixture/progress", "params": {}})
        elif failure == "boolean-id":
            send({"id": True, "result": {}})
        elif failure == "bad-params":
            send({"method": "fixture/progress", "params": "PRIVATE INVALID PAYLOAD"})
        elif failure == "rpc":
            send({"id": request["id"], "error": {
                "code": -32000, "message": "PRIVATE ERROR PAYLOAD",
            }})
    elif method == "fixture/reverse":
        pending.append(request["id"])
        if len(pending) == 2:
            for identity in reversed(pending):
                send({"id": identity, "result": identity})
            pending.clear()
    elif method == "fixture/action":
        # A server request may reuse the ID of an outstanding client request.
        send({"id": request["id"], "method": request["params"].get("method", "item/tool/call"),
              "params": {}})
    elif method == "fixture/tool":
        send({"id": request["id"], "method": "item/tool/call", "params": request["params"]})
    elif "error" in request:
        send({"id": request["id"], "result": request["error"]})
    elif "result" in request:
        send({"id": request["id"], "result": request["result"]})
    elif method == "fixture/env":
        send({"id": request["id"], "result": os.environ.get("SKAZ_TEST_PARENT_SECRET")})
    elif method == "fixture/pid":
        send({"id": request["id"], "result": os.getpid()})
    elif method == "fixture/stderr":
        sys.stderr.write("PRIVATE STDERR PAYLOAD" * 10000)
        sys.stderr.flush()
        send({"id": request["id"], "result": "ok"})
