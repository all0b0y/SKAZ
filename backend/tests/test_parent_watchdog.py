"""A backend whose desktop parent has died must not keep running.

An orphaned backend keeps the Codex queue ownership lock and the database open,
so the next desktop launch cannot own them. Real subprocesses, no mocks.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

PARENT = r"""
import os, subprocess, sys
child = subprocess.Popen(
    [sys.executable, "-m", "audiohelper", "--port", "0", "--log-level", "warning"],
    env={**os.environ, "AUDIOHELPER_PARENT_PID": str(os.getpid())},
    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
)
sys.stdout.write(f"{child.pid}\n")
sys.stdout.flush()
child.stdout.readline()  # the backend announced where it listens
os._exit(0)  # the parent dies without stopping its child, like a crashed Electron
"""


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_backend_exits_after_its_parent_dies(tmp_path: Path) -> None:
    env = {
        **os.environ,
        "AUDIOHELPER_TOKEN": "t" * 32,
        "AUDIOHELPER_DATA_DIR": str(tmp_path / "data"),
        "AUDIOHELPER_DOCUMENTS_DIR": str(tmp_path / "docs"),
        "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring",
    }
    parent = subprocess.run(
        [sys.executable, "-c", PARENT], env=env, capture_output=True, text=True, timeout=60,
    )
    child = int(parent.stdout.split()[0])
    try:
        deadline = time.monotonic() + 20
        while _alive(child) and time.monotonic() < deadline:
            time.sleep(0.2)
        assert not _alive(child), "backend kept running after its parent died"
    finally:
        if _alive(child):
            os.kill(child, 9)
