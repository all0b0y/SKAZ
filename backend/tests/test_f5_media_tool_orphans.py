"""QA E11: ffmpeg/yt-dlp die with the backend, even when the backend is killed with SIGKILL.

The tools run in their own session (so a cancel can kill the whole group), which also means
nothing killed them when the backend itself died: a ``kill -9`` left ffmpeg running as an
orphan at 100 % CPU. The test starts a real "backend" process that runs a real short child
through ``run_tool``, SIGKILLs that backend and expects the child to be gone.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from skaz.media_tools import MediaError, run_tool

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_for(path: Path, timeout: float = 10.0) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.is_file() and path.read_text().strip():
            return path.read_text().strip()
        time.sleep(0.02)
    raise AssertionError(f"{path.name} never appeared")


def test_tool_dies_when_the_backend_is_sigkilled(tmp_path: Path) -> None:
    pid_file = tmp_path / "child.pid"
    script = textwrap.dedent(f"""
        import asyncio
        from skaz.media_tools import run_tool
        asyncio.run(run_tool(["/bin/sh", "-c", "echo $$ > {pid_file}; exec sleep 30"], timeout=60))
    """)
    backend = subprocess.Popen([sys.executable, "-c", script], stdin=subprocess.DEVNULL)
    child = 0
    try:
        child = int(_wait_for(pid_file))
        assert _alive(child)
        backend.kill()  # SIGKILL: no finally, no lifespan cleanup in the backend
        backend.wait(timeout=5)
        deadline = time.monotonic() + 5
        while _alive(child) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not _alive(child), "the media tool outlived the backend (orphan)"
    finally:
        if backend.poll() is None:
            backend.kill()
        if child and _alive(child):
            os.kill(child, signal.SIGKILL)


async def test_exit_code_output_and_stderr_pass_through_the_guard() -> None:
    assert await run_tool(["/bin/sh", "-c", "printf 'a b'; printf ' c\\n'"]) == "a b c\n"
    with pytest.raises(MediaError, match="Media tool failed"):
        await run_tool(["/bin/sh", "-c", "echo oops >&2; exit 3"])
    seen: list[str] = []

    def explain(stderr: str) -> str:
        seen.append(stderr)
        return "explained"

    with pytest.raises(MediaError, match="explained"):
        await run_tool(["/bin/sh", "-c", "echo 'ERROR: Private video' >&2; exit 1"], explain=explain)
    assert seen == ["ERROR: Private video\n"]
    # Arguments with spaces, quotes and shell syntax reach the tool verbatim (no shell parsing).
    tricky = ["$HOME", "a b", "'q'", "; rm -rf /", "*"]
    out = await run_tool([sys.executable, "-c", "import sys, json; print(json.dumps(sys.argv[1:]))", *tricky])
    assert out.strip() == '["$HOME", "a b", "\'q\'", "; rm -rf /", "*"]'


async def test_timeout_still_kills_the_whole_group(tmp_path: Path) -> None:
    pid_file = tmp_path / "child.pid"
    with pytest.raises(MediaError, match="timed out"):
        await run_tool(["/bin/sh", "-c", f"sleep 30 & echo $! > {pid_file}; wait"], timeout=0.5)
    grandchild = int(pid_file.read_text())
    deadline = time.monotonic() + 3
    while _alive(grandchild) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _alive(grandchild)
