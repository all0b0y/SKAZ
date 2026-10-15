"""What processing and the agents may see of a material: everything but its excluded fragments.

``.skaz/excluded.json`` (S1, decision 41) names the fragments kept out of
processing; fragments the user restored are no longer listed there. This
module is the one reader the agent tools and other context builders use, so
an excluded fragment never reaches an agent (poisoning layer 3): not when it
reads a material, not in search hits, not as a quote.

The file is re-read only when it changed (size and modification time). An
unreadable file hides the material's text rather than guessing (fail closed).
"""
from __future__ import annotations

import threading
from collections.abc import Sequence
from pathlib import Path
from typing import Protocol, TypeVar

from pydantic import ValidationError

from ...errors import LibraryUnavailable
from ...library.fsio import read_json
from ...library.layout import SERVICE_DIR
from ...service import KnowledgeService
from .exclusions import EXCLUDED_FILE, ExclusionFile


class _HasSeg(Protocol):
    @property
    def seg(self) -> int: ...


T = TypeVar("T", bound=_HasSeg)
UNREADABLE = "SKAZ can't read this material's list of excluded fragments, so its text isn't shown."
_CACHE_LIMIT = 512


class ExclusionsUnreadable(Exception):
    """The exclusion list exists but can't be read: nothing of the material may be shown."""


_lock = threading.Lock()
_cache: dict[Path, tuple[tuple[int, int], frozenset[int]]] = {}


def read_excluded(material_dir: Path) -> frozenset[int]:
    """Excluded ``seg`` numbers of the material in ``material_dir`` (restored ones are not listed)."""
    path = material_dir / SERVICE_DIR / EXCLUDED_FILE
    try:
        info = path.stat()
    except FileNotFoundError:
        return frozenset()
    except OSError as error:
        raise ExclusionsUnreadable(UNREADABLE) from error
    stamp = (info.st_mtime_ns, info.st_size)
    with _lock:
        cached = _cache.get(path)
    if cached is not None and cached[0] == stamp:
        return cached[1]
    try:
        segs = ExclusionFile.model_validate(read_json(path)).excluded_segs()
    except FileNotFoundError:
        return frozenset()
    except (OSError, ValueError, UnicodeDecodeError, ValidationError) as error:
        raise ExclusionsUnreadable(UNREADABLE) from error
    with _lock:
        if len(_cache) >= _CACHE_LIMIT:
            _cache.clear()
        _cache[path] = (stamp, segs)
    return segs


def excluded_segs(kb: KnowledgeService, material_id: str) -> frozenset[int]:
    """Excluded fragments of an indexed material. No library or no such material: nothing to hide
    (there is no text to show either)."""
    record = kb.material_repo.get(material_id)
    if record is None:
        return frozenset()
    try:
        library = kb.require()
    except LibraryUnavailable as error:
        # The index still has the text, but the exclusion list can't be checked now.
        raise ExclusionsUnreadable(UNREADABLE) from error
    return read_excluded(library.root / record.rel_dir)


def visible(kb: KnowledgeService, material_id: str, fragments: Sequence[T]) -> list[T]:
    """``fragments`` (anything with ``.seg``) without the material's excluded ones."""
    hidden = excluded_segs(kb, material_id)
    return [fragment for fragment in fragments if fragment.seg not in hidden]
