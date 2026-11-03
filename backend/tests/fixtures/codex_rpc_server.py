"""Authored stdio boundary fixture; never calls a model or network."""
from __future__ import annotations

import json
import os
import sys

pending: list[int] = []
#: ``fixture/stubborn``: ignore SIGTERM and stdin EOF, like a native child that outlives its shim.
stubborn = False


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
    elif method == "fixture/burst":
        # A long answer streamed fast: many deltas written at once, then the reply.
        out = "".join(json.dumps({"method": "item/agentMessage/delta", "params": {"delta": "x"}}) + "\n"
                      for _ in range(request["params"]["count"]))
        sys.stdout.write(out)
        sys.stdout.flush()
        send({"id": request["id"], "result": "done"})
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
        send({"id": request["id"], "result": "SKAZ_TEST_PARENT_SECRET" in os.environ})
    elif method == "fixture/pid":
        send({"id": request["id"], "result": os.getpid()})
    elif method == "fixture/stubborn":
        # The npm ``codex`` shim runs the native binary as a child: start one, then stop listening
        # to SIGTERM and stdin EOF, so only a signal to the whole group ends both.
        import signal
        import subprocess
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        stubborn = True
        send({"id": request["id"], "result": child.pid})
    elif method == "fixture/stderr":
        sys.stderr.write("PRIVATE STDERR PAYLOAD" * 10000)
        sys.stderr.flush()
        send({"id": request["id"], "result": "ok"})

if stubborn:
    import time
    time.sleep(120)
# Reached only on stdin EOF: a clean exit, as Codex does when its client closes the pipe.
marker = os.environ.get("SKAZ_TEST_CLEAN_EXIT")
if marker:
    with open(marker, "w") as handle:
        handle.write("clean")
