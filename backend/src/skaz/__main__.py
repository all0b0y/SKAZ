"""Entry point: ``uv run --project backend python -m skaz --port N``.

The desktop process picks a free port, passes the per-run token in
``SKAZ_TOKEN`` and the storage location in ``SKAZ_DATA_DIR``, then
polls ``GET /health`` before exposing the connection to the renderer.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import signal
import socket
import sys
import threading
from types import FrameType

import uvicorn

from . import parent_watchdog
from .app import create_app
from .config import AppConfig
from .knowledge.processes import CHILDREN
from .routes.live import MAX_MESSAGE_BYTES

#: Uvicorn waits this long for requests still in flight, then cancels them and runs the app's own
#: shutdown (``app.py`` lifespan). Unbounded (uvicorn's default), one request waiting on an agent
#: command kept that shutdown from starting before Electron's SIGKILL (decision 11). Counted in
#: Electron's grace together with ``knowledge.shutdown.DEADLINE_S`` (``tests/knowledge/test_shutdown.py``).
REQUESTS_GRACE_S = 1
#: ``uvicorn.main.STARTUP_FAILURE``: what ``uvicorn.run`` exits with when the server never started.
STARTUP_FAILURE = 3


class _Server(uvicorn.Server):
    """Stops agent processes the moment the backend is asked to stop.

    Agent commands (Hermes, Claude Code, OpenCode, installers, version checks) run in their own
    session, so nothing reaches them once Electron SIGKILLs the backend; and a request waiting on one
    keeps uvicorn from reaching the app's shutdown. They get SIGTERM here, before uvicorn waits for
    requests; the lifespan's ``close_knowledge`` SIGKILLs whatever is left. A thread sends it: the
    signal handler runs on the event loop's thread, which may hold the registry's lock.
    """

    def handle_exit(self, sig: int, frame: FrameType | None) -> None:
        if not self.should_exit:
            threading.Thread(target=CHILDREN.signal_all, args=(signal.SIGTERM,), name="skaz-stop-children",
                             daemon=True).start()
        super().handle_exit(sig, frame)


def _free_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((host, 0))
        return int(probe.getsockname()[1])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="skaz", description="SKAZ local backend")
    parser.add_argument("--port", type=int, default=0, help="TCP port on 127.0.0.1; 0 picks a free one")
    parser.add_argument("--log-level", default="info")
    arguments = parser.parse_args(argv)

    logging.basicConfig(level=arguments.log_level.upper(), format="%(levelname)s %(name)s: %(message)s")
    config = AppConfig.from_env(arguments.port or _free_port("127.0.0.1"))
    app = create_app(config)

    parent_watchdog.start()
    # The parent process reads this line to learn where the backend listens.
    print(json.dumps({"event": "listening", "host": config.host, "port": config.port}), flush=True)
    server = _Server(uvicorn.Config(
        app, host=config.host, port=config.port, log_level=arguments.log_level, access_log=False,
        ws="websockets", ws_max_size=MAX_MESSAGE_BYTES, ws_max_queue=8,
        ws_per_message_deflate=False, timeout_graceful_shutdown=REQUESTS_GRACE_S,
    ))
    with contextlib.suppress(KeyboardInterrupt):
        server.run()
    return 0 if server.started else STARTUP_FAILURE


if __name__ == "__main__":
    sys.exit(main())
