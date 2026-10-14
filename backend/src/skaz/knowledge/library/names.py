"""Human names for folders, materials and pages (FILESYSTEM-LIBRARY-SPEC 14–15, 34).

Names are rejected with a reason, never silently rewritten. Surrounding
whitespace is trimmed and the name is stored NFC. Collisions are decided by
``name_key`` (NFC + casefold), matching the default case- and
normalisation-insensitive macOS volume.
"""
from __future__ import annotations

import unicodedata
from collections.abc import Iterable

from ..errors import NameRejected
from ..markdown.text import name_key

#: Path separators, characters macOS/Windows/Obsidian refuse, and the wikilink
#: syntax characters that would break ``[[path#^block|label]]`` citations.
FORBIDDEN_CHARACTERS = frozenset('/\\:*?"<>|#^[]')
#: Bytes of the NFD (on-disk) form; leaves room for ``.md`` under the 255-byte limit.
MAX_NAME_BYTES = 200


def _reject(reason: str) -> NameRejected:
    return NameRejected(f"{reason} Choose another name.")


def validate_name(raw: str, *, reserved: Iterable[str] = ()) -> str:
    name = unicodedata.normalize("NFC", raw).strip()
    if not name:
        raise _reject("The name is empty.")
    if name.startswith("."):
        raise _reject("A name can't start with a dot.")
    bad = sorted({char for char in name if char in FORBIDDEN_CHARACTERS})
    if bad:
        raise _reject("A name can't contain " + " ".join(bad) + ".")
    if any(unicodedata.category(char) in ("Cc", "Cf", "Zl", "Zp") for char in name):
        raise _reject("A name can't contain control or invisible characters.")
    if len(unicodedata.normalize("NFD", name).encode("utf-8")) > MAX_NAME_BYTES:
        raise _reject("The name is too long.")
    if name_key(name) in {name_key(item) for item in reserved}:
        raise _reject("This name is reserved by SKAZ.")
    return name
