"""Entry point: ``uv run --project backend python -m audiohelper --port N``.

The desktop process picks a free port, passes the per-run token in
``AUDIOHELPER_TOKEN`` and the storage location in ``AUDIOHELPER_DATA_DIR``, then
polls ``GET /health`` before exposing the connection to the renderer.
"""

from __future__ import annotations

import argparse
import json
import logging
import socket
import sys

import uvicorn

from .app import create_app
from .config import AppConfig
from .routes.live import MAX_MESSAGE_BYTES


def _free_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((host, 0))
        return int(probe.getsockname()[1])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="audiohelper", description="AudioHelper local backend")
    parser.add_argument("--port", type=int, default=0, help="TCP port on 127.0.0.1; 0 picks a free one")
    parser.add_argument("--log-level", default="info")
    arguments = parser.parse_args(argv)

    logging.basicConfig(level=arguments.log_level.upper(), format="%(levelname)s %(name)s: %(message)s")
    config = AppConfig.from_env(arguments.port or _free_port("127.0.0.1"))
    app = create_app(config)

    # The parent process reads this line to learn where the backend listens.
    print(json.dumps({"event": "listening", "host": config.host, "port": config.port}), flush=True)
    uvicorn.run(
        app, host=config.host, port=config.port, log_level=arguments.log_level, access_log=False,
        ws="websockets", ws_max_size=MAX_MESSAGE_BYTES, ws_max_queue=8,
        ws_per_message_deflate=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
