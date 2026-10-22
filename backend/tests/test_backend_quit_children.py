"""Quitting SKAZ leaves no agent process behind (decision 11).

Electron stops the backend with SIGTERM and SIGKILLs it 4 s later (``electron/backend.ts``
``SHUTDOWN_GRACE_MS``). Agent commands run in their own session (``start_new_session``), so they
outlive a SIGKILLed backend; only the backend's own shutdown can stop them. Uvicorn, though, first
waits for in-flight requests and only then runs the app's shutdown — a status check waiting on a
long Hermes command (its ``pm repair`` building a dependency environment with uv) kept the whole
shutdown from starting, and that command kept writing after SKAZ was gone.

Real backend process, real signals; the agent is a fake ``hermes`` that hangs and has a child of
its own, like ``hermes`` → ``uv``.
"""

from __future__ import annotations

import contextlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

#: ``electron/backend.ts`` ``SHUTDOWN_GRACE_MS``.
ELECTRON_GRACE_S = 4.0

FAKE_HERMES = r"""#!{python}
import os, subprocess, sys, time
if sys.argv[1:] != ["--version"]:
    sys.exit(1)
# Like ``hermes`` handing the work to ``uv``: a child in the same process group.
child = subprocess.Popen([sys.executable, "-c", "import time\nwhile True: time.sleep(0.2)"])
with open({pids!r}, "w") as out:
    out.write(f"{{os.getpid()}} {{child.pid}}\n")
while True:
    time.sleep(0.2)
"""


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie (exited, not yet reaped by its re-parent) counts as gone.
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout
    return bool(state.strip()) and not state.strip().startswith("Z")


def _check(port: int, token: str) -> None:
    request = urllib.request.Request(f"http://127.0.0.1:{port}/kb/agents/hermes/check", method="POST",
                                     headers={"Authorization": f"Bearer {token}"})
    with contextlib.suppress(Exception):  # the backend goes away under the request: that is the point
        urllib.request.urlopen(request, timeout=30).read()


def _wait_healthy(port: int, token: str) -> None:
    """Like Electron (``electron/backend.ts``): the port line comes before the socket listens."""
    request = urllib.request.Request(f"http://127.0.0.1:{port}/health",
                                     headers={"Authorization": f"Bearer {token}"})
    deadline = time.monotonic() + 30
    while True:
        try:
            urllib.request.urlopen(request, timeout=5).read()
            return
        except OSError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.05)


def test_quitting_stops_an_agent_command_a_status_check_is_waiting_for(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    pids_file = tmp_path / "hermes.pids"
    fake = bin_dir / "hermes"
    fake.write_text(FAKE_HERMES.format(python=sys.executable, pids=str(pids_file)), encoding="utf-8")
    fake.chmod(0o755)
    token = "t" * 32
    env = {
        **os.environ,
        "HOME": str(tmp_path / "home"),
        "PATH": f"{bin_dir}{os.pathsep}/usr/bin{os.pathsep}/bin",
        "SKAZ_USER_PATH": str(bin_dir),
        "SKAZ_TOKEN": token,
        "SKAZ_DATA_DIR": str(tmp_path / "data"),
        "SKAZ_DOCUMENTS_DIR": str(tmp_path / "docs"),
        "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring",
    }
    (tmp_path / "home").mkdir()
    backend = subprocess.Popen([sys.executable, "-m", "skaz", "--port", "0", "--log-level", "warning"],
                               env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    pids: list[int] = []
    try:
        assert backend.stdout is not None
        port = int(json.loads(backend.stdout.readline())["port"])
        _wait_healthy(port, token)
        threading.Thread(target=_check, args=(port, token), daemon=True).start()
        deadline = time.monotonic() + 30
        while not pids_file.is_file() and time.monotonic() < deadline:
            time.sleep(0.1)
        assert pids_file.is_file(), "the status check never started hermes --version"
        time.sleep(0.2)
        pids = [int(part) for part in pids_file.read_text(encoding="utf-8").split()]
        assert len(pids) == 2 and all(_alive(pid) for pid in pids)

        # Electron's quit: SIGTERM, then SIGKILL after the grace.
        backend.send_signal(signal.SIGTERM)
        try:
            backend.wait(timeout=ELECTRON_GRACE_S)
            stopped_in_time = True
        except subprocess.TimeoutExpired:
            stopped_in_time = False
            backend.kill()
            backend.wait()
        deadline = time.monotonic() + 1.0
        while any(_alive(pid) for pid in pids) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert [pid for pid in pids if _alive(pid)] == [], "agent processes outlived SKAZ"
        assert stopped_in_time, "the backend's own shutdown did not finish within Electron's grace"
    finally:
        if backend.poll() is None:
            backend.kill()
        for pid in pids:
            if _alive(pid):
                os.kill(pid, signal.SIGKILL)
