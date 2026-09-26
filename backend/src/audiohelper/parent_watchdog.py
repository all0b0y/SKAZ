"""Stop the backend when the desktop process that launched it is gone.

The desktop app normally stops the backend on quit, but a crashed, force-quit or
killed Electron cannot. An orphan keeps the database and the Codex queue owner
lock open, so the next launch cannot take ownership. The watchdog asks uvicorn
for its ordinary graceful shutdown (SIGTERM), which runs the lifespan cleanup,
and hard-exits only if that shutdown itself hangs.
"""

from __future__ import annotations

import logging
import os
import signal
import threading
import time

logger = logging.getLogger(__name__)

PARENT_PID_ENV = "AUDIOHELPER_PARENT_PID"
POLL_SECONDS = 1.0
SHUTDOWN_GRACE_SECONDS = 10.0


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _declared_parent() -> int | None:
    raw = os.environ.get(PARENT_PID_ENV, "").strip()
    if not raw:
        return None
    try:
        pid = int(raw)
    except ValueError:
        logger.warning("Ignoring invalid %s=%r", PARENT_PID_ENV, raw)
        return None
    return pid if pid > 1 else None


def parent_gone(original_ppid: int, declared: int | None) -> bool:
    """True once the launching process no longer exists.

    ``declared`` is the desktop process id passed through the environment; it
    covers launches through an intermediate such as ``uv run``, whose own
    process can outlive a crashed desktop app.
    """
    if os.getppid() != original_ppid:
        return True
    return declared is not None and not _pid_alive(declared)


def start() -> threading.Thread | None:
    original = os.getppid()
    declared = _declared_parent()
    if original <= 1 and declared is None:
        return None  # Already detached (launched by init/launchd): nothing to watch.

    def watch() -> None:
        while not parent_gone(original, declared):
            time.sleep(POLL_SECONDS)
        logger.warning("Desktop process exited; shutting the backend down.")
        os.kill(os.getpid(), signal.SIGTERM)
        time.sleep(SHUTDOWN_GRACE_SECONDS)
        os._exit(1)

    thread = threading.Thread(target=watch, name="parent-watchdog", daemon=True)
    thread.start()
    return thread
