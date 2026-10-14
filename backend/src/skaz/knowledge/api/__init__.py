"""``/kb/*`` routers. Areas append their router to ``ROUTERS``; ``app.py`` mounts them all as protected."""
from __future__ import annotations

from fastapi import APIRouter

# One import per line so areas append without conflicting.
from . import folders, ingest, library, materials, notifications, search, sources, wiki

#: Mounted with the bearer-token dependency. Append-only: one line per area.
ROUTERS: tuple[APIRouter, ...] = (
    library.router,
    folders.router,
    materials.router,
    wiki.router,
    search.router,
    notifications.router,
    ingest.router,
    sources.router,
)
