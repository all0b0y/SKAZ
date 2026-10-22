"""A fake ``opencode`` executable for the OpenCode adapter tests.

A real executable Python script (the adapter spawns real processes), driven by a JSON scenario
and appending what it received — argv, cwd, environment, ACP messages, the per-run config file —
to a JSONL record. Its answers come from the offline probe of the installed OpenCode 1.17.18
(``fixtures/agents/opencode_acp_probe.json``) or are built from the shapes in that binary's ACP
source (``tool_call``/``tool_call_update`` from ``Dn``/``xo``/``To``, ``session/request_permission``
options ``once``/``always``/``reject``). It proves the SKAZ side of the seam only, never a model.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from skaz.knowledge.install.system import Located

FIXTURES = Path(__file__).parent / "fixtures" / "agents"

_OPENCODE = r"""
import json, os, sys, time
SCENARIO = json.load(open(%(scenario)r))
RECORD = %(record)r

def record(kind, **data):
    with open(RECORD, "a") as handle:
        handle.write(json.dumps({"kind": kind, **data}) + "\n")

args = sys.argv[1:]
run_config = os.environ.get("OPENCODE_CONFIG")
record("start", argv=args, cwd=os.getcwd(), env=dict(os.environ), pid=os.getpid(),
       run_config=open(run_config).read() if run_config and os.path.exists(run_config) else None)
if args == ["--version"]:
    print(SCENARIO.get("version_output", "1.17.18"))
    sys.exit(0)
if args == ["debug", "agent", "skaz"]:
    print(json.dumps(SCENARIO["debug_agent"], indent=2))
    sys.exit(0)
LOGGED_OUT = %(scenario)r + ".logged-out"
if args == ["auth", "list"]:
    sys.stdout.write("" if os.path.exists(LOGGED_OUT) else SCENARIO.get("auth_list", ""))
    sys.exit(0)
if args[:2] == ["auth", "logout"]:  # `opencode auth logout <provider>` (checked with OpenCode 1.17.18)
    open(LOGGED_OUT, "a").write(" ".join(args[2:]) + "\n")
    sys.exit(0)
if args == ["auth", "login"]:
    sys.exit(0)
if args == ["models", "--verbose"]:
    sys.stdout.write(SCENARIO.get("models_verbose", ""))
    sys.exit(SCENARIO.get("models_exit", 0))
if args[:2] == ["session", "delete"]:
    record("session_delete", id=args[2], data=os.environ.get("XDG_DATA_HOME"))
    sys.exit(SCENARIO.get("delete_exit", 0))
assert args == ["acp"], args
state = {"options": json.loads(json.dumps(SCENARIO["session_new"]["configOptions"]))}
waiting = {}

def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()

def update(session, body):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": body}})

next_id = 1000
while True:
    raw = sys.stdin.readline()
    if not raw:
        break
    message = json.loads(raw)
    record("received", message=message)
    method, ident, params = message.get("method"), message.get("id"), message.get("params") or {}
    if method is None:
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": ident, "result": SCENARIO["initialize"]})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": ident, "result": {**SCENARIO["session_new"],
                                                         "configOptions": state["options"]}})
    elif method == "session/set_config_option":
        if params["configId"] == "model":
            state["options"] = json.loads(json.dumps(SCENARIO["set_model"]["configOptions"]))
            for option in state["options"]:
                if option["id"] == "model":
                    option["currentValue"] = params["value"]
            send({"jsonrpc": "2.0", "id": ident, "result": {"configOptions": state["options"]}})
            continue
        effort = next((o for o in state["options"] if o["id"] == "effort"), None)
        values = [o["value"] for o in (effort or {}).get("options", [])]
        if params["configId"] == "effort" and params["value"] in values:
            effort["currentValue"] = params["value"]
            send({"jsonrpc": "2.0", "id": ident, "result": {"configOptions": state["options"]}})
        else:
            send({"jsonrpc": "2.0", "id": ident, "error": SCENARIO["set_effort_error"]})
    elif method == "session/cancel":
        for pending in list(waiting):
            send({"jsonrpc": "2.0", "id": pending, "result": {"stopReason": "cancelled"}})
            waiting.pop(pending)
    elif method == "session/prompt":
        session = params["sessionId"]
        for body in SCENARIO.get("updates", []):
            if body == "PERMISSION":
                next_id += 1
                send({"jsonrpc": "2.0", "id": next_id, "method": "session/request_permission", "params": {
                    "sessionId": session,
                    "toolCall": {"toolCallId": "call-perm", "title": "rm -rf ~", "kind": "execute"},
                    "options": [{"optionId": "once", "kind": "allow_once", "name": "Allow once"},
                                {"optionId": "always", "kind": "allow_always", "name": "Always allow"},
                                {"optionId": "reject", "kind": "reject_once", "name": "Reject"}]}})
                record("permission_reply", message=json.loads(sys.stdin.readline()))
                continue
            update(session, body)
        if SCENARIO.get("hang"):
            waiting[ident] = session
            continue
        if "prompt_error" in SCENARIO:
            send({"jsonrpc": "2.0", "id": ident, "error": SCENARIO["prompt_error"]})
        else:
            send({"jsonrpc": "2.0", "id": ident, "result": SCENARIO.get("prompt_result", {
                "stopReason": "end_turn", "usage": {"inputTokens": 12, "outputTokens": 5, "totalTokens": 17},
                "_meta": {}})})
"""


class FakeOpenCode:
    def __init__(self, directory: Path, scenario: dict[str, Any]) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        self.scenario_path = directory / "opencode-scenario.json"
        self.record_path = directory / "opencode-record.jsonl"
        self.binary = directory / "opencode"
        self.scenario_path.write_text(json.dumps(scenario), encoding="utf-8")
        body = _OPENCODE % {"scenario": str(self.scenario_path), "record": str(self.record_path)}
        self.binary.write_text(f"#!{sys.executable}\n{body}", encoding="utf-8")
        self.binary.chmod(0o755)

    def locate(self, name: str) -> Located | None:
        return Located(self.binary, "/usr/bin:/bin") if name == "opencode" else None

    def records(self, kind: str | None = None) -> list[dict[str, Any]]:
        if not self.record_path.exists():
            return []
        items = [json.loads(line) for line in self.record_path.read_text(encoding="utf-8").splitlines()]
        return [item for item in items if kind is None or item["kind"] == kind]

    def received(self, method: str) -> list[dict[str, Any]]:
        return [item["message"] for item in self.records("received")
                if item["message"].get("method") == method]


def opencode_probe() -> dict[str, Any]:
    probe: dict[str, Any] = json.loads((FIXTURES / "opencode_acp_probe.json").read_text(encoding="utf-8"))
    return probe
