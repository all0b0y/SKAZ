"""Page file plumbing shared by the W2 operations (all run under the wiki write lock).

Every rewrite re-reads the file first (``read_page`` marks blocks edited
outside SKAZ as the user's), builds the new document from what is on disk now
and replaces the file only if it still holds the bytes that were read; a
concurrent edit makes SKAZ read again rather than overwrite it.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from ..errors import KnowledgeError, NotFound
from ..index import indexer
from ..index.scanner import read_page
from ..library.library import Library
from ..markdown.page import Block, PageDocument, RawText, UserParagraph, parse_page, render_page
from ..service import KnowledgeService
from ..store.database import KnowledgeDatabase

MAX_WRITE_ATTEMPTS = 3


class PageChanging(KnowledgeError):
    status_code = 409


def page_path(kb: KnowledgeService, page_id: str) -> tuple[Library, Path]:
    record = kb.page_repo.get(page_id)
    if record is None:
        raise NotFound("Page not found.")
    library = kb.require()
    path = library.root / record.rel_path
    if not path.is_file():
        raise NotFound("The page file is missing. Rescan the library.")
    return library, path


def rewrite(library: Library, path: Path, build: Callable[[PageDocument], PageDocument | None]) -> bool:
    """Apply ``build`` to the current file; ``False`` when it had nothing to change."""
    for _attempt in range(MAX_WRITE_ATTEMPTS):
        read_page(library, path)  # marks externally edited blocks as the user's first
        data = path.read_bytes()
        document = parse_page(data.decode("utf-8"))
        updated = build(document)
        if updated is None:
            return False
        text = render_page(updated)
        if text.encode("utf-8") == data:
            return False
        if library.rewrite_page(path, data, text):
            return True
    raise PageChanging(f"“{path.stem}” kept changing while SKAZ was writing it. Retry when it is saved.")


def reindex(kb: KnowledgeService, library: Library, path: Path) -> None:
    indexer.put_page(kb.db, read_page(library, path))


def forget_page(db: KnowledgeDatabase, page_id: str) -> None:
    with db.write() as connection:
        connection.execute("DELETE FROM pages WHERE id = ?", (page_id,))
        connection.execute("DELETE FROM wiki_checked WHERE page_id = ?", (page_id,))


def forget_material(db: KnowledgeDatabase, material_id: str) -> None:
    with db.write() as connection:
        connection.execute("DELETE FROM materials WHERE id = ?", (material_id,))
        connection.execute("DELETE FROM corrections WHERE material_id = ?", (material_id,))


def is_user_part(part: object) -> bool:
    """The user's words: their blocks (``user``/``user_edited``, or an agent block edited outside) and
    any unmarked paragraph."""
    if isinstance(part, Block):
        return part.owner != "agent" or not part.hash_matches()
    return isinstance(part, RawText) and bool(part.text.strip())


def user_parts(document: PageDocument) -> int:
    """How many of the user's notes/edited statements the page holds."""
    return sum(
        1 for entry in document.entries() if isinstance(entry.item, UserParagraph) or is_user_part(entry.item)
    )
