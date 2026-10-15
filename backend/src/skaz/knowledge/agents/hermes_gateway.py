"""Hermes 0.22's background gateway process of SKAZ's own Hermes folder (decision B18).

From Hermes 0.22 ``hermes acp`` is a viewer: the first one starts a gateway daemon for its
``HERMES_HOME`` (``hermes_cli/gateway_runtime_start.py`` ``spawn_unmanaged_gateway``:
``python -m hermes_cli.main --profile default gateway run --quiet --idle-exit``, in a session of
its own) that outlives it until it is idle. SKAZ stops the one of its own folder
(``<data_dir>/agents/hermes-home``) when it quits, and registers it with the other children
(``processes.CHILDREN``) once it has seen it.

Which process that is, is proved the way Hermes proves it (``gateway/status.py``
``get_running_pid`` with a ``pid_path``), read only, never another folder:

* ``<home>/gateway.lock`` is held (an ``flock`` probe; Hermes' ``is_gateway_runtime_lock_active``
  probes the same way) — a free lock means no gateway of this folder runs;
* the record the holder wrote into that lock under the lock (``gateway/runtime_ownership.py``
  ``ProfileOwnership.reserve``) and ``<home>/gateway.pid`` (``status.write_pid_file``) both are
  ``kind: hermes-gateway`` records of the same pid naming this folder as ``hermes_home``;
* that pid is alive, started when the record says (``start_time``: ``/proc`` ticks on Linux,
  ``psutil`` create time in centiseconds elsewhere — ``status._get_process_start_time``; compared
  with ``ps -o lstart=`` to the second here), and its command line is a ``gateway run`` that names
  no other profile or ``HERMES_HOME``.

Each signal re-proves all of it first: a pid that ended may be reused. ``SIGTERM`` is delivered as
``SIGINT``, which Hermes takes as a planned stop and exits cleanly
(``gateway/run_bootstrap.py`` ``_start_gateway_make_shutdown_signal_handler``: a ``SIGTERM``
without ``hermes gateway stop``'s marker reads as an external kill); ``SIGKILL`` goes to the
daemon's process group (its MCP servers).
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

GATEWAY_KIND = "hermes-gateway"
LOCK_FILE = "gateway.lock"
PID_FILE = "gateway.pid"
#: ``ps -o lstart`` is to the second; Hermes' fingerprint to the centisecond.
_START_TOLERANCE_S = 2.0


def _canonical(path: str | Path) -> str:
    return os.path.normcase(str(Path(path).expanduser().resolve(strict=False)))


def _same_home(left: object, home: Path) -> bool:
    """``gateway/status.py`` ``_same_hermes_home``."""
    return isinstance(left, str) and bool(left.strip()) and _canonical(left) == _canonical(home)


def _record(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _lock_held(path: Path) -> bool:
    """True when some process holds ``path``'s ``flock`` (a won probe is released at once)."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | os.O_NONBLOCK)
    except OSError:
        return False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        except OSError:
            return False
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return False  # another user's process is never SKAZ's
    return True


def _ps(pid: int, field: str) -> str | None:
    try:
        result = subprocess.run(["ps", "-p", str(pid), "-o", f"{field}="], capture_output=True, text=True,
                                timeout=2, env={"PATH": "/bin:/usr/bin", "LC_ALL": "C"}, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    text = result.stdout.strip()
    return text if result.returncode == 0 and text else None


def _started_as_recorded(pid: int, recorded: object) -> bool:
    """The live process started when the record says (Hermes' pid-reuse guard)."""
    if recorded is None:
        return True  # Hermes could not read it either (``start_time: null``); the other proofs stand
    if isinstance(recorded, bool) or not isinstance(recorded, int | float):
        return False
    with contextlib.suppress(OSError, IndexError, ValueError):
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        return int(stat.rsplit(")", 1)[1].split()[19]) == int(recorded)  # field 22, after "(comm)"
    started = _ps(pid, "lstart")
    if started is None:
        return False
    try:
        epoch = time.mktime(time.strptime(" ".join(started.split()), "%a %b %d %H:%M:%S %Y"))
    except ValueError:
        return False
    return abs(epoch - float(recorded) / 100) <= _START_TOLERANCE_S


def gateway_command(command: str, home: Path) -> bool:
    """A ``gateway run`` command line naming no other profile than ``default`` and no other home."""
    tokens = command.split()
    lowered = [token.lower() for token in tokens]
    if not any(lowered[i:i + 2] == ["gateway", "run"] for i in range(len(lowered))):
        return False
    for i, token in enumerate(lowered):
        if token.startswith("--profile="):
            profile: str | None = token.partition("=")[2]
        elif token in ("-p", "--profile"):
            profile = lowered[i + 1] if i + 1 < len(lowered) else None
        else:
            profile = None
        if profile is not None and profile != "default":
            return False
        named = tokens[i].partition("=")[2].strip("'\"")
        if token.startswith("hermes_home=") and not _same_home(named, home):
            return False
    return True


def _proved(home: Path) -> int | None:
    """The pid of the gateway of ``home``, proved as described above, else None."""
    if not _lock_held(home / LOCK_FILE):
        return None
    holder, claim = _record(home / LOCK_FILE), _record(home / PID_FILE)
    if holder is None or claim is None:
        return None
    for record in (holder, claim):
        if record.get("kind") != GATEWAY_KIND or not _same_home(record.get("hermes_home"), home):
            return None
    pid = claim.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1 or pid == os.getpid():
        return None
    if holder.get("pid") != pid or not _alive(pid) or not _started_as_recorded(pid, claim.get("start_time")):
        return None
    command = _ps(pid, "command")
    return pid if command is not None and gateway_command(command, home) else None


@dataclass(frozen=True)
class GatewayDaemon:
    """The running gateway of SKAZ's Hermes folder, as registered in ``processes.CHILDREN``."""

    home: Path
    pid: int

    @property
    def returncode(self) -> int | None:
        """None while the pid is alive (cheap; :meth:`deliver` proves who it is before a signal)."""
        return None if _alive(self.pid) else 0

    def deliver(self, sig: int) -> bool:
        """Send ``sig`` if this is still the gateway of ``home``; True when sent."""
        if _proved(self.home) != self.pid:
            return False
        if sig == signal.SIGTERM:
            sig = signal.SIGINT  # Hermes' planned stop
        try:
            if sig == signal.SIGKILL and os.getpgid(self.pid) == self.pid:
                os.killpg(self.pid, sig)
            else:
                os.kill(self.pid, sig)
        except (ProcessLookupError, PermissionError):
            return False
        return True


def find_gateway(home: Path) -> GatewayDaemon | None:
    """The running gateway of ``home`` (blocking: file reads and ``ps``; call it off the loop)."""
    pid = _proved(home)
    return GatewayDaemon(home, pid) if pid is not None else None
