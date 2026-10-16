"""Library layout and root choice.

::

    <root>/.skaz/library.json                 marker: library id + format version
    <root>/.skaz/staging/                     staging for atomic creation (same volume; iCloud
                                              never syncs a folder named ``tmp``)
    <root>/Materials/<Folder>/.skaz/folder.json
    <root>/Materials/<Folder>/<Title>/<Title>.md
    <root>/Materials/<Folder>/<Title>/.skaz/material.json
    <root>/Wiki/{Concepts,Notes,Folders,Analyses}/<Title>.md
    <root>/Wiki/index.md, <root>/Wiki/log.md
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict

from .fsio import read_json, visible_entries

SERVICE_DIR = ".skaz"
MARKER_PATH = Path(SERVICE_DIR) / "library.json"
#: Where new objects are built before one rename publishes them. Not "tmp": iCloud Drive
#: (a library in ~/Documents) never syncs a folder named "tmp" or "*.nosync", and macOS
#: refuses to move a folder between a synced and a never-synced place (EDEADLK,
#: "Resource deadlock avoided") — every import and delete failed there.
STAGING_PATH = Path(SERVICE_DIR) / "staging"
#: The staging folder of earlier builds; emptied and removed when the library opens.
LEGACY_STAGING_PATH = Path(SERVICE_DIR) / "tmp"
MATERIALS_DIR = "Materials"
WIKI_DIR = "Wiki"
FOLDER_MARKER = Path(SERVICE_DIR) / "folder.json"
MATERIAL_MANIFEST = Path(SERVICE_DIR) / "material.json"
WIKI_SUBDIRS: dict[str, str] = {
    "concept": "Concepts", "note": "Notes", "folder": "Folders", "analysis": "Analyses",
}
DEFAULT_NAME = "SKAZ"
FALLBACK_NAME = "SKAZ Library"
LIBRARY_FORMAT_VERSION = 1


class LibraryMarker(BaseModel):
    model_config = ConfigDict(extra="allow")
    format: Literal["skaz-library"] = "skaz-library"
    version: Literal[1] = 1
    library_id: str
    created_at: str


class FolderMarker(BaseModel):
    model_config = ConfigDict(extra="allow")
    format: Literal[1] = 1
    id: str
    system: bool = False
    created_at: str


def read_marker(root: Path) -> LibraryMarker | None:
    """The marker, or ``None`` when absent/damaged. ``OSError`` other than absence propagates."""
    try:
        return LibraryMarker.model_validate(read_json(root / MARKER_PATH))
    except FileNotFoundError:
        return None
    except (ValueError, UnicodeDecodeError):
        return None


def resolve_library_root(base: Path) -> Path:
    """Where the library lives for a chosen place (default: the Documents folder).

    ``base`` itself when it already is a SKAZ library; otherwise ``base/SKAZ``
    unless that exists with other content and no marker (an older SKAZ
    library, B4), in which case ``base/SKAZ Library`` — old data is never reused.
    """
    if read_marker(base) is not None:
        return base
    if base.name in (DEFAULT_NAME, FALLBACK_NAME) and (not base.exists() or not visible_entries(base)):
        return base  # the user picked the SKAZ folder itself: no SKAZ/SKAZ
    primary = base / DEFAULT_NAME
    if not primary.exists() or read_marker(primary) is not None or not visible_entries(primary):
        return primary
    return base / FALLBACK_NAME
