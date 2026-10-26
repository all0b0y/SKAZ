"""N6: Claude Code in its own SKAZ folder (decision 14) with a live session per chat (contract §8).

The ``claude`` here is an authored stand-in that keeps transcripts the way the 2.1.281 binary does as
far as SKAZ relies on it (read offline from the installed binary): ``--session-id`` / ``--resume``
transcripts under ``$CLAUDE_CONFIG_DIR/projects/<sanitized cwd>/<id>.jsonl``; a session it can't
resume prints ``No conversation found with session ID: <id>`` on stderr plus a startup-failure
``result`` (``error_during_execution``, ``num_turns: 0``) before any ``system/init`` and exits 1;
``claude project purge <path> --yes`` removes a project's state or says ``No Claude Code project state
found for <path> under <dir>.`` and exits 1. Protocol only — never evidence of a real sign-in or answer.
"""
from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge.agents.claude_code import ClaudeCodeEngine
from skaz.knowledge.agents.engine import (
    NO_SESSIONS,
    AgentEvent,
    AgentTurn,
    Compacted,
    Completed,
    Failed,
    LiveSessionEngine,
    SessionBound,
    SessionPlan,
    SessionSupport,
    TextDelta,
    TurnMessage,
    session_support,
)
from skaz.knowledge.agents.history import seed_prompt
from skaz.knowledge.install.system import Located
from skaz.knowledge.install.terminal import TerminalLauncher
from tests.knowledge.agent_fakes import RecordingOpener

_FAKE = r'''
import json, os, re, shutil, sys
SCENARIO = json.load(open(%(scenario)r))
RECORD = %(record)r
args = sys.argv[1:]

def record(kind, **data):
    with open(RECORD, "a") as handle:
        handle.write(json.dumps({"kind": kind, **data}) + "\n")

def say(item):
    print(json.dumps(item), flush=True)

record("start", argv=args, cwd=os.getcwd(), env=dict(os.environ))
config = os.environ.get("CLAUDE_CONFIG_DIR")

def project(path):
    return os.path.join(config, "projects", re.sub(r"[^a-zA-Z0-9]", "-", os.path.realpath(path)))

if args == ["--version"]:
    print("2.1.281 (Claude Code)")
    sys.exit(0)
if args[:2] == ["auth", "status"]:
    signed = os.path.exists(os.path.join(config, ".signed-in")) if config else SCENARIO.get("logged_in", True)
    print(json.dumps({"loggedIn": signed}))
    sys.exit(0 if signed else 1)
if args[:2] == ["auth", "logout"]:
    if config and os.path.exists(os.path.join(config, ".signed-in")):
        os.remove(os.path.join(config, ".signed-in"))
    sys.exit(0)
if args[:2] == ["project", "purge"]:
    target = project(args[2])
    if SCENARIO.get("purge_fails") or "--yes" not in args:
        sys.stderr.write("Error: config directory is not writable\n")
        sys.exit(1)
    if not os.path.isdir(target):
        sys.stderr.write(f"No Claude Code project state found for {args[2]} under {config}.\n")
        sys.exit(1)
    shutil.rmtree(target)
    print(f"Purged 1 item(s) for {args[2]}.")
    sys.exit(0)

def flag(name):
    return args[args.index(name) + 1] if name in args else None

if "--system-prompt-file" in args:
    record("system_prompt", text=open(flag("--system-prompt-file")).read())
line = sys.stdin.readline()
record("stdin", line=line)
text = json.loads(line)["message"]["content"]
session = flag("--session-id") or flag("--resume")
if SCENARIO.get("die_before_init"):
    sys.exit(1)
if flag("--resume"):
    path = os.path.join(project(os.getcwd()), session + ".jsonl")
    if not os.path.exists(path):
        message = f"No conversation found with session ID: {session}"
        sys.stderr.write(message + "\n")
        if not SCENARIO.get("silent_resume_failure"):
            say({"type": "result", "subtype": "error_during_execution", "is_error": True, "num_turns": 0,
                 "session_id": session, "errors": [message], "result_index": 0})
        sys.exit(1)
say({"type": "system", "subtype": "init", "session_id": session or "ephemeral-1", "cwd": os.getcwd(),
     "tools": [], "mcp_servers": [], "claude_code_version": "2.1.281"})
answer = SCENARIO.get("answer", "Fine.")
for item in SCENARIO.get("before", []):
    say(item)
say({"type": "stream_event", "event": {"type": "message_start", "message": {"id": "msg_1"}},
     "parent_tool_use_id": None})
say({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
     "delta": {"type": "text_delta", "text": answer}}, "parent_tool_use_id": None})
if session and "--no-session-persistence" not in args:
    folder = project(os.getcwd())
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, session + ".jsonl"), "a") as handle:
        handle.write(json.dumps({"type": "user", "content": text}) + "\n")
        handle.write(json.dumps({"type": "assistant", "content": answer}) + "\n")
say({"type": "result", "subtype": "success", "is_error": False, "result": answer,
     "usage": {"input_tokens": 10, "output_tokens": 2}, "session_id": session or "ephemeral-1"})
sys.exit(0)
'''

HISTORY = (TurnMessage("user", "Что такое энтропия? KIWI-WORD"),
           TurnMessage("assistant", "Мера беспорядка.", engine="codex"))


class FakeClaude:
    def __init__(self, directory: Path, scenario: dict[str, Any] | None = None) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        self.scenario_path = directory / "scenario.json"
        self.record_path = directory / "record.jsonl"
        self.binary = directory / "claude"
        self.set(scenario or {})
        body = _FAKE % {"scenario": str(self.scenario_path), "record": str(self.record_path)}
        self.binary.write_text(f"#!{sys.executable}\n{body}", encoding="utf-8")
        self.binary.chmod(0o755)

    def set(self, scenario: dict[str, Any]) -> None:
        self.scenario_path.write_text(json.dumps(scenario), encoding="utf-8")

    def locate(self, name: str) -> Located | None:
        return Located(self.binary, "/usr/bin:/bin") if name == "claude" else None

    def records(self, kind: str) -> list[dict[str, Any]]:
        if not self.record_path.exists():
            return []
        items = [json.loads(line) for line in self.record_path.read_text(encoding="utf-8").splitlines()]
        return [item for item in items if item["kind"] == kind]

    def runs(self) -> list[dict[str, Any]]:
        return [item for item in self.records("start") if "-p" in item["argv"]]


@pytest.fixture
def fake(tmp_path: Path) -> FakeClaude:
    return FakeClaude(tmp_path / "bin")


def engine_for(tmp_path: Path, fake: FakeClaude, **extra: Any) -> ClaudeCodeEngine:
    return ClaudeCodeEngine(tmp_path / "data" / "agents" / "claude-code", locate_cli=fake.locate,
                            launcher=TerminalLauncher(tmp_path / "launch", opener=extra.pop("opener",
                                                                                             RecordingOpener())),
                            **extra)


def chat_turn(text: str, plan: SessionPlan | None, *, run_id: str = "run-1",
              instructions: str = "Answer briefly.", history: tuple[TurnMessage, ...] = HISTORY,
              summary: str | None = None) -> AgentTurn:
    return AgentTurn(run_id=run_id, messages=(*history, TurnMessage("user", text)), instructions=instructions,
                     tools=None, model="sonnet", effort="low", history_summary=summary, session=plan)


async def drain(engine: ClaudeCodeEngine, turn: AgentTurn) -> list[AgentEvent]:
    return [event async for event in engine.run(turn)]


def flag(argv: list[str], name: str) -> str:
    return argv[argv.index(name) + 1]


def sent(fake: FakeClaude, index: int = -1) -> str:
    return str(json.loads(fake.records("stdin")[index]["line"])["message"]["content"])


def files_with(root: Path, needle: str) -> list[Path]:
    return [path for path in root.rglob("*") if path.is_file() and needle in path.read_text(errors="replace")]


async def started(engine: ClaudeCodeEngine, text: str = "Первый вопрос", **extra: Any) -> str:
    events = await drain(engine, chat_turn(text, SessionPlan("start"), **extra))
    bound = [event for event in events if isinstance(event, SessionBound)]
    assert len(bound) == 1 and isinstance(events[-1], Completed)
    return bound[0].session_id


# -- the folder and the sign-in (decision 14) -----------------------------------------------------


async def test_claude_code_declares_live_sessions_without_revert(tmp_path: Path, fake: FakeClaude) -> None:
    engine = engine_for(tmp_path, fake)
    assert isinstance(engine, LiveSessionEngine)
    assert session_support(engine) == SessionSupport(live=True, revert=False)


async def test_status_reads_the_sign_in_of_skaz_own_folder_only(tmp_path: Path, fake: FakeClaude) -> None:
    engine = engine_for(tmp_path, fake)
    status = await engine.status()
    assert not status.signed_in and status.reason == "Sign in to Claude Code in SKAZ."
    checks = [item for item in fake.records("start") if item["argv"][:2] == ["auth", "status"]]
    config = engine.config_dir
    assert config is not None and checks[0]["env"]["CLAUDE_CONFIG_DIR"] == str(config)
    assert config.is_relative_to(tmp_path / "data") and stat.S_IMODE(config.stat().st_mode) == 0o700
    (config / ".signed-in").write_text("")  # what `claude auth login` leaves, in this stand-in
    assert (await engine.status()).ready


async def test_sign_in_opens_claude_auth_login_in_terminal_with_skaz_folder(tmp_path: Path,
                                                                           fake: FakeClaude) -> None:
    opener = RecordingOpener()
    engine = engine_for(tmp_path, fake, opener=opener)
    await engine.login()
    script = Path(opener.calls[0][3]).read_text(encoding="utf-8")
    assert f"export CLAUDE_CONFIG_DIR={engine.config_dir}" in script
    assert f"{fake.binary} auth login" in script and "token" not in script.lower()
    assert engine.login_progress() == "waiting"
    assert fake.records("start") == []  # Terminal runs the sign-in; SKAZ sees nothing of it


async def test_sign_out_is_claude_auth_logout_in_skaz_folder(tmp_path: Path, fake: FakeClaude) -> None:
    engine = engine_for(tmp_path, fake)
    assert engine.config_dir is not None
    engine.config_dir.mkdir(parents=True)
    (engine.config_dir / ".signed-in").write_text("")
    await engine.logout()
    logout = [item for item in fake.records("start") if item["argv"] == ["auth", "logout"]]
    assert logout and logout[0]["env"]["CLAUDE_CONFIG_DIR"] == str(engine.config_dir)
    assert not (await engine.status()).signed_in


async def test_the_fallback_switch_is_the_old_stateless_claude_code(tmp_path: Path, fake: FakeClaude) -> None:
    engine = engine_for(tmp_path, fake, own_folder=False)
    assert session_support(engine) == NO_SESSIONS and engine.config_dir is None
    assert (await engine.status()).signed_in  # the stand-in's "Mac's own sign-in"
    events = await drain(engine, chat_turn("Вопрос", SessionPlan("start")))
    assert not any(isinstance(event, SessionBound) for event in events) and isinstance(events[-1], Completed)
    run = fake.runs()[-1]
    assert "CLAUDE_CONFIG_DIR" not in run["env"] and "--no-session-persistence" in run["argv"]
    assert "--session-id" not in run["argv"] and Path(run["cwd"]).name == "work"
    with pytest.raises(ValueError, match="sign-in of this Mac"):
        await engine.logout()


# -- live sessions (contract §8) -------------------------------------------------------------------


async def test_start_persists_a_new_session_seeded_with_the_history(tmp_path: Path, fake: FakeClaude) -> None:
    engine = engine_for(tmp_path, fake)
    events = await drain(engine, chat_turn("Первый вопрос", SessionPlan("start"), summary="Earlier: units."))
    bound = [event for event in events if isinstance(event, SessionBound)]
    session = bound[0].session_id
    assert bound == [SessionBound("run-1", session, "run-1")]
    assert events.index(bound[0]) < events.index(TextDelta("run-1", "Fine."))  # before any answer text
    run = fake.runs()[-1]
    argv = run["argv"]
    assert flag(argv, "--session-id") == session and "--no-session-persistence" not in argv
    assert "--resume" not in argv
    assert Path(run["cwd"]) == engine.folder.session_dir(session)
    # The one seed serializer (decision 13), with the long-chat summary only here.
    assert sent(fake) == seed_prompt(chat_turn("Первый вопрос", None).messages, "Earlier: units.")
    # Claude's own memory stays off: «Я» is SKAZ's.
    assert run["env"]["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] == "1"
    assert run["env"]["CLAUDE_CODE_DISABLE_CLAUDE_MDS"] == "1"
    assert engine.config_dir is not None and files_with(engine.config_dir / "projects", "KIWI-WORD")


async def test_continue_resumes_with_only_the_new_message_and_the_start_instructions(tmp_path: Path,
                                                                                    fake: FakeClaude) -> None:
    engine = engine_for(tmp_path, fake)
    session = await started(engine, instructions="Instructions at start.")
    events = await drain(engine, chat_turn("Второй вопрос", SessionPlan("continue", session), run_id="run-2",
                                           instructions="Changed instructions.", summary="ignored"))
    assert events[0] == SessionBound("run-2", session, "run-2") and isinstance(events[-1], Completed)
    run = fake.runs()[-1]
    assert flag(run["argv"], "--resume") == session and "--session-id" not in run["argv"]
    assert "--no-session-persistence" not in run["argv"]
    assert Path(run["cwd"]) == engine.folder.session_dir(session)
    assert sent(fake) == "Второй вопрос"  # history and summary stay in the session
    # Instructions are fixed when the session starts (contract §2 rule 1); changes come as notes.
    assert fake.records("system_prompt")[-1]["text"] == "Instructions at start."
    assert flag(run["argv"], "--model") == "sonnet" and flag(run["argv"], "--effort") == "low"


@pytest.mark.parametrize("silent", [False, True])
async def test_a_session_claude_code_cant_resume_is_lost_before_anything_is_sent(
        tmp_path: Path, fake: FakeClaude, silent: bool) -> None:
    fake.set({"silent_resume_failure": silent})
    engine = engine_for(tmp_path, fake)
    gone = "0b7e3c1e-4c5f-4b0e-9d7a-1f2e3d4c5b6a"
    events = await drain(engine, chat_turn("Вопрос", SessionPlan("continue", gone)))
    assert len(events) == 1 and isinstance(events[0], Failed)
    failed = events[0]
    assert failed.kind == "other" and failed.session_lost and failed.unsent


async def test_revert_and_foreign_ids_are_lost_without_starting_claude(tmp_path: Path,
                                                                        fake: FakeClaude) -> None:
    engine = engine_for(tmp_path, fake)
    for plan in (SessionPlan("revert", "0b7e3c1e-4c5f-4b0e-9d7a-1f2e3d4c5b6a", "t-1"),
                 SessionPlan("continue", "../../etc")):
        (failed,) = await drain(engine, chat_turn("Вопрос", plan))
        assert isinstance(failed, Failed) and failed.session_lost and failed.unsent
    assert fake.runs() == []


async def test_a_failure_after_the_turn_was_taken_is_never_session_lost(tmp_path: Path,
                                                                         fake: FakeClaude) -> None:
    engine = engine_for(tmp_path, fake)
    session = await started(engine)
    fake.set({"before": [{"type": "assistant", "message": {"id": "m", "content": []}, "error": "rate_limit",
                          "parent_tool_use_id": None}]})
    events = await drain(engine, chat_turn("Вопрос", SessionPlan("continue", session), run_id="run-2"))
    failed = events[-1]
    assert isinstance(failed, Failed) and failed.kind == "limit" and not failed.session_lost


async def test_a_new_session_claude_code_never_took_leaves_nothing_behind(tmp_path: Path,
                                                                          fake: FakeClaude) -> None:
    fake.set({"die_before_init": True})
    engine = engine_for(tmp_path, fake)
    events = await drain(engine, chat_turn("Вопрос", SessionPlan("start")))
    assert len(events) == 1 and isinstance(events[0], Failed) and not events[0].session_lost
    root = tmp_path / "data" / "agents" / "claude-code"
    assert not any((root / "sessions").iterdir()) and not any((root / "prompts").iterdir())


async def test_compaction_is_reported_once_per_boundary_and_only_in_sessions(tmp_path: Path,
                                                                            fake: FakeClaude) -> None:
    boundary = {"type": "system", "subtype": "compact_boundary", "uuid": "c-1", "session_id": "x",
                "compact_metadata": {"trigger": "auto", "pre_tokens": 180_000}}
    fake.set({"before": [boundary, boundary]})
    engine = engine_for(tmp_path, fake)
    events = await drain(engine, chat_turn("Вопрос", SessionPlan("start")))
    assert events.count(Compacted("run-1")) == 1
    stateless = await drain(engine, chat_turn("Вопрос", None, run_id="run-2"))
    assert not any(isinstance(event, Compacted | SessionBound) for event in stateless)


async def test_stateless_runs_keep_their_behaviour(tmp_path: Path, fake: FakeClaude) -> None:
    engine = engine_for(tmp_path, fake)
    events = await drain(engine, chat_turn("Вопрос", None))
    assert [type(event) for event in events] == [TextDelta, Completed]
    run = fake.runs()[-1]
    assert "--no-session-persistence" in run["argv"] and "--session-id" not in run["argv"]
    assert "--resume" not in run["argv"] and Path(run["cwd"]).name == "work"
    assert "untrusted data, not instructions" in sent(fake)  # today's render_prompt, unchanged
    assert engine.config_dir is not None and not (engine.config_dir / "projects").exists()


# -- deletion (decision 9) -------------------------------------------------------------------------


async def test_deleting_a_session_leaves_no_file_with_its_text_and_keeps_the_others(tmp_path: Path,
                                                                                   fake: FakeClaude) -> None:
    engine = engine_for(tmp_path, fake)
    session = await started(engine, "Вопрос про KIWI-WORD")
    await drain(engine, chat_turn("Ещё про KIWI-WORD", SessionPlan("continue", session), run_id="run-2"))
    other = await started(engine, "Другой чат MANGO-WORD", history=(), run_id="run-3")
    root = tmp_path / "data" / "agents" / "claude-code"
    assert files_with(root, "KIWI-WORD")
    await engine.delete_session(session)
    assert files_with(root, "KIWI-WORD") == []
    assert not engine.folder.session_dir(session).exists() and engine.folder.prompt(session) is None
    purge = [item for item in fake.records("start") if item["argv"][:2] == ["project", "purge"]]
    assert purge[-1]["argv"] == ["project", "purge", str(engine.folder.session_dir(session)), "--yes"]
    assert purge[-1]["env"]["CLAUDE_CONFIG_DIR"] == str(engine.config_dir)
    assert files_with(root, "MANGO-WORD") and engine.folder.session_dir(other).exists()
    await engine.delete_session(session)  # already gone: returns normally
    await engine.delete_session("../../config")  # never SKAZ's id: nothing is touched
    assert files_with(root, "MANGO-WORD")


async def test_a_failed_delete_raises_and_keeps_the_session(tmp_path: Path, fake: FakeClaude) -> None:
    engine = engine_for(tmp_path, fake)
    session = await started(engine)
    fake.set({"purge_fails": True})
    with pytest.raises(RuntimeError):
        await engine.delete_session(session)
    assert engine.config_dir is not None and files_with(engine.config_dir, "KIWI-WORD")
    fake.set({})
    await engine.delete_session(session)
    assert files_with(engine.config_dir, "KIWI-WORD") == []


async def test_without_the_cli_skaz_still_removes_the_transcript(tmp_path: Path, fake: FakeClaude) -> None:
    engine = engine_for(tmp_path, fake)
    session = await started(engine)
    gone = ClaudeCodeEngine(engine.work_root, locate_cli=lambda name: None)
    await gone.delete_session(session)
    assert files_with(engine.work_root, "KIWI-WORD") == []


def test_the_user_folder_is_never_named(tmp_path: Path, fake: FakeClaude) -> None:
    engine = engine_for(tmp_path, fake)
    home_claude = Path(os.path.expanduser("~")) / ".claude"
    assert engine.config_dir is not None and not engine.config_dir.is_relative_to(home_claude)
