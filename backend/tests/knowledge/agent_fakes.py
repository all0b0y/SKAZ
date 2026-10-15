"""Fake ``claude`` / ``hermes`` executables for the agent adapter tests.

Each fake is a real executable Python script (the adapters spawn real
processes), driven by a JSON scenario and appending what it received —
argv, cwd, environment, stdin, files — to a JSONL record. The messages it
prints come from offline probes of the installed CLIs (``fixtures/agents``)
or are built from the vendors' documented message shapes; either way these
fakes prove the SKAZ side of the seam only, never the quality of an agent.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from skaz.knowledge.install.system import Located

FIXTURES = Path(__file__).parent / "fixtures" / "agents"

_COMMON = r"""
import json, os, signal, sys, time
SCENARIO = json.load(open(%(scenario)r))
RECORD = %(record)r

def record(kind, **data):
    with open(RECORD, "a") as handle:
        handle.write(json.dumps({"kind": kind, **data}) + "\n")

record("start", argv=sys.argv[1:], cwd=os.getcwd(), env=dict(os.environ), pid=os.getpid())

def stubborn():
    # Like a CLI busy in a long answer: ignores SIGINT/SIGTERM and has a child of its own.
    import subprocess
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    child = subprocess.Popen([sys.executable, "-c", "import signal, time; "
                              "signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(600)"])
    record("stubborn", pid=os.getpid(), child=child.pid)
"""

_CLAUDE = (
    _COMMON
    + r"""
args = sys.argv[1:]
if args == ["--version"]:
    print(SCENARIO.get("version", "2.1.281 (Claude Code)"))
    sys.exit(0)
if args[:2] == ["auth", "status"]:
    print(json.dumps({"loggedIn": SCENARIO.get("logged_in", True), "authMethod": "claude.ai"}))
    sys.exit(0 if SCENARIO.get("logged_in", True) else 1)
if "--system-prompt-file" in args:
    record("system_prompt", text=open(args[args.index("--system-prompt-file") + 1]).read())
if "--mcp-config" in args:
    path = args[args.index("--mcp-config") + 1]
    record("mcp_config", path=path, mode=oct(os.stat(path).st_mode & 0o777), content=json.load(open(path)))
os.write(1, b"")
line = sys.stdin.readline()
record("stdin", line=line, rest=sys.stdin.read())

def on_sigint(signum, frame):
    record("sigint")
    print(json.dumps({"type": "result", "subtype": "error_during_execution", "is_error": True,
                      "errors": ["interrupted"], "terminal_reason": "aborted_streaming"}), flush=True)
    sys.exit(130)

signal.signal(signal.SIGINT, on_sigint)
if SCENARIO.get("stubborn"):
    stubborn()
for item in SCENARIO.get("stream", []):
    print(json.dumps(item), flush=True)
if SCENARIO.get("hang"):
    while True:
        time.sleep(0.05)
sys.exit(SCENARIO.get("exit", 0))
"""
)

_HERMES = (
    _COMMON
    + r"""
args = sys.argv[1:]
LAUNCHER = SCENARIO.get("launcher")
if LAUNCHER:
    # Hermes' boot as in its source: the tool store is HERMES_RUNTIME_DIR (pm/environments.py:117), else
    # <HERMES_HOME>/tools for a home outside ~/.hermes (hermes_constants.py:231, environments.py:140); a
    # missing store is built and the install's launcher re-minted onto its Python (venv_sync.py:429).
    # "rogue" ignores the override for the listed commands (a Hermes that broke the contract).
    import shlex
    rogue = args[:1] in [[name] for name in LAUNCHER.get("rogue", [])]
    store = os.environ.get("HERMES_RUNTIME_DIR")
    if rogue or not store:
        store = os.path.join(os.environ["HERMES_HOME"], "tools")
    python = os.path.join(store, "python-3.14", "bin", "python3")
    if not os.path.isfile(os.path.join(store, "facts.json")):
        os.makedirs(os.path.dirname(python), exist_ok=True)
        open(os.path.join(store, "facts.json"), "w").write("{}")
    script = "import sys\nsys.path.insert(0, %%r)\nfrom hermes_cli.main import main\n" %% LAUNCHER["root"]
    body = "#!/bin/sh\nexec " + shlex.join([python, "-I", "-c", script]) + ' "$@"\n'
    target = os.path.join(LAUNCHER["root"], ".hermes", "bin", "hermes")
    if open(target).read() != body:
        record("launcher_minted", store=store)
        open(target, "w").write(body)
if args == ["--version"]:
    print(SCENARIO.get("version_output", "Hermes Agent v0.21.5+6627.g4bb9e57 (2026.9.24)"))
    sys.exit(0)
if args == ["model"]:
    sys.exit(0)
if args[:1] == ["sessions"]:  # documented session management: `hermes sessions delete <id> --yes`, `prune`
    record("sessions", args=args[1:], home=os.environ.get("HERMES_HOME"))
    sys.exit(SCENARIO.get("sessions_exit", 0))
assert args == ["acp"], args
if SCENARIO.get("stubborn"):
    stubborn()
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
        continue  # a reply to our permission request (recorded above)
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": ident, "result": SCENARIO["initialize"]})
    elif method == "session/new":
        if "session_new_error" in SCENARIO:
            send({"jsonrpc": "2.0", "id": ident, "error": SCENARIO["session_new_error"]})
        else:
            send({"jsonrpc": "2.0", "id": ident, "result": SCENARIO["session_new"]})
    elif method == "session/set_model":
        send({"jsonrpc": "2.0", "id": ident, "result": {}})
    elif method == "session/cancel":
        for pending, session in list(waiting.items()):
            send({"jsonrpc": "2.0", "id": pending, "result": {"stopReason": "cancelled"}})
            waiting.pop(pending)
    elif method == "session/prompt":
        session = params["sessionId"]
        text = params["prompt"][0]["text"]
        if text == "/tools":
            update(session, {"sessionUpdate": "agent_message_chunk",
                             "content": {"type": "text", "text": SCENARIO["tools_listing"]}})
            send({"jsonrpc": "2.0", "id": ident, "result": {"stopReason": "end_turn"}})
            continue
        for body in SCENARIO.get("updates", []):
            if body == "PERMISSION":
                next_id += 1
                send({"jsonrpc": "2.0", "id": next_id, "method": "session/request_permission", "params": {
                    "sessionId": session, "toolCall": {"toolCallId": "perm-check-1", "title": "rm -rf ~"},
                    "options": [{"optionId": "allow_once", "kind": "allow_once", "name": "Allow once"},
                                {"optionId": "deny", "kind": "reject_once", "name": "Deny"}]}})
                record("permission_reply", message=json.loads(sys.stdin.readline()))
                continue
            update(session, body)
        if SCENARIO.get("hang"):
            waiting[ident] = session
            continue
        if "prompt_error" in SCENARIO:
            send({"jsonrpc": "2.0", "id": ident, "error": SCENARIO["prompt_error"]})
        else:
            usage = {"inputTokens": 10, "outputTokens": 4}
            send({"jsonrpc": "2.0", "id": ident,
                  "result": SCENARIO.get("prompt_result", {"stopReason": "end_turn", "usage": usage})})
"""
)


class FakeCli:
    def __init__(self, directory: Path, name: str, scenario: dict[str, Any]) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        self.scenario_path = directory / f"{name}-scenario.json"
        self.record_path = directory / f"{name}-record.jsonl"
        self.binary = directory / name
        self.scenario_path.write_text(json.dumps(scenario), encoding="utf-8")
        template = _CLAUDE if name == "claude" else _HERMES
        body = template % {"scenario": str(self.scenario_path), "record": str(self.record_path)}
        self.binary.write_text(f"#!{sys.executable}\n{body}", encoding="utf-8")
        self.binary.chmod(0o755)

    def locate(self, name: str) -> Located | None:
        return Located(self.binary, "/usr/bin:/bin") if name == self.binary.name else None

    def records(self, kind: str | None = None) -> list[dict[str, Any]]:
        if not self.record_path.exists():
            return []
        items = [json.loads(line) for line in self.record_path.read_text(encoding="utf-8").splitlines()]
        return [item for item in items if kind is None or item["kind"] == kind]


def recorded_claude_lines(name: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in (FIXTURES / name).read_text(encoding="utf-8").splitlines() if line]


def hermes_launcher_text(python: Path, root: Path) -> str:
    """A store launcher in the shape ``hermes_cli/_launchers.py`` mints (``exec <python> -I -c <script>``)."""
    import shlex

    script = f"import sys\nsys.path.insert(0, {str(root)!r})\nfrom hermes_cli.main import main\n"
    return "#!/bin/sh\nexec " + shlex.join([str(python), "-I", "-c", script]) + ' "$@"\n'


class UserHermesInstall:
    """The user's own Hermes install in a fake home: checkout, tool store, launcher and PATH forwarder."""

    def __init__(self, home: Path) -> None:
        self.home = home
        self.root = home / ".hermes" / "hermes-agent"
        self.store = home / ".hermes" / "tools"
        self.python = self.store / "python-3.14" / "bin" / "python3"
        self.launcher = self.root / ".hermes" / "bin" / "hermes"
        self.forwarder = home / ".local" / "bin" / "hermes"
        self.python.parent.mkdir(parents=True)
        (self.store / "facts.json").write_text("{}", encoding="utf-8")
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "pyproject.toml").write_text("[project]\nname = 'hermes-agent'\n", encoding="utf-8")
        self.launcher.parent.mkdir(parents=True)
        self.launcher.write_text(hermes_launcher_text(self.python, self.root), encoding="utf-8")
        self.launcher.chmod(0o755)
        self.forwarder.parent.mkdir(parents=True)
        self.forwarder.write_text(f'#!/bin/sh\nexec {self.launcher} "$@"\n', encoding="utf-8")
        self.forwarder.chmod(0o755)
        self.original = self.snapshot()

    def snapshot(self) -> dict[str, bytes]:
        return {"launcher": self.launcher.read_bytes(), "forwarder": self.forwarder.read_bytes()}

    def scenario(self, *, rogue: tuple[str, ...] = ()) -> dict[str, Any]:
        return {"launcher": {"root": str(self.root), "rogue": list(rogue)}}


def hermes_probe() -> dict[str, Any]:
    probe: dict[str, Any] = json.loads((FIXTURES / "hermes_acp_probe.json").read_text(encoding="utf-8"))
    return probe


class RecordingMcp:
    """Stands in for area A1's per-run MCP access (``McpAccessProvider``)."""

    def __init__(self) -> None:
        self.granted: list[tuple[str, tuple[str, ...]]] = []
        self.revoked: list[str] = []

    def grant(self, run_id: str, tools: tuple[Any, ...]) -> Any:
        from skaz.knowledge.agents.mcp_access import McpAccess

        self.granted.append((run_id, tuple(tool.name for tool in tools)))
        return McpAccess("http://127.0.0.1:8765/kb/mcp", f"run-token-{run_id}")

    def revoke(self, run_id: str) -> None:
        self.revoked.append(run_id)


class RecordingOpener:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    async def __call__(self, argv: Any) -> None:
        self.calls.append(list(argv))
