"""The version SKAZ reports (Settings → About, the API, the web reader's User-Agent)."""
from __future__ import annotations

import os
from importlib import metadata


def app_version() -> str:
    """The app version Electron passes (``SKAZ_APP_VERSION``), else the backend package's own."""
    value = os.environ.get("SKAZ_APP_VERSION", "").strip()
    if value:
        return value[:40]
    try:
        return metadata.version("skaz")
    except metadata.PackageNotFoundError:
        return "unknown"
