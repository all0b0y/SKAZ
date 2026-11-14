"""FX-3: Discuss an Explore finding in a chat (owned by slice F3).

The chat a Discuss click opens is bound to its finding and opens clean: the card — and, once the
paper is one of the user's materials, its full text — reaches the agent as service context of
every question (``chats.context.ContextBuilder``), never as a fake user message.
"""
from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from ...native_io import disk_call
from ..agents.prompting import untrusted_block
from ..api.schemas_chats import KbDiscussFinding
from ..api.schemas_explore import KbDiscussion, KbFinding
from ..chats.model import MessageInput
from ..chats.store import ChatRepository
from ..store.database import KnowledgeDatabase
from .store import ExploreStore, FindingRow, _finding


def finding_for_chat(db: KnowledgeDatabase, chat_id: str) -> FindingRow | None:
    """Return the Explore finding whose ``discuss_chat_id`` is ``chat_id``, if any."""
    with db.read() as connection:
        row = connection.execute(
            "SELECT * FROM explore_findings WHERE json_extract(details_json, '$.discuss_chat_id') = ?"
            " ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (chat_id,),
        ).fetchone()
    return None if row is None else _finding(row)


@dataclass(frozen=True)
class DiscussState:
    """The finding a chat discusses, with the paper's material resolved across sibling findings."""

    finding: FindingRow
    material_id: str | None


def discuss_state(db: KnowledgeDatabase, chat_id: str) -> DiscussState | None:
    """What ``ContextBuilder`` asks each turn: the bound finding and its current material — the
    finding's own, or one a sibling finding of the same work imported (``materials_of_works``)."""
    row = finding_for_chat(db, chat_id)
    if row is None:
        return None
    material_id = row.material_id or ExploreStore(db).materials_of_works([row.work_id]).get(row.work_id)
    return DiscussState(row, material_id)


def _badge(row: FindingRow, material_id: str | None) -> KbDiscussFinding:
    work = row.details.get("work") or {}
    importing = bool(row.details.get("importing")) and material_id is None
    return KbDiscussFinding(finding_id=row.id, title=str(work.get("title") or ""),
                            material_id=material_id, importing=importing)


def discuss_badges(db: KnowledgeDatabase, chat_ids: Sequence[str]) -> dict[str, KbDiscussFinding]:
    """chat id → its Discuss badge (``api/chats.py``): one query for a whole page of chats."""
    if not chat_ids:
        return {}
    marks = ",".join("?" for _ in chat_ids)
    with db.read() as connection:
        rows = connection.execute(
            "SELECT * FROM explore_findings"
            f" WHERE json_extract(details_json, '$.discuss_chat_id') IN ({marks})"
            " ORDER BY created_at DESC, rowid DESC",
            tuple(chat_ids),
        ).fetchall()
    findings = [_finding(row) for row in rows]
    materials = ExploreStore(db).materials_of_works([row.work_id for row in findings])
    badges: dict[str, KbDiscussFinding] = {}
    for row in findings:
        chat_id = str(row.details.get("discuss_chat_id"))
        if chat_id not in badges:  # newest first: the newest finding bound to a chat wins
            badges[chat_id] = _badge(row, row.material_id or materials.get(row.work_id))
    return badges


def discuss_badge(db: KnowledgeDatabase, chat_id: str) -> KbDiscussFinding | None:
    """The Discuss badge of one chat (``None`` for an ordinary chat)."""
    return discuss_badges(db, [chat_id]).get(chat_id)


def card_text(finding: KbFinding | FindingRow) -> str:
    """Format a finding's metadata card as plain data (wrapped in ``untrusted_block`` by callers)."""
    if isinstance(finding, FindingRow):
        work_raw = finding.details.get("work") or {}
        title = str(work_raw.get("title") or "")
        authors = [str(a) for a in (work_raw.get("authors") or ())[:8]]
        pub = work_raw.get("publication") or {}
        year = pub.get("year") if isinstance(pub, dict) else None
        venue = work_raw.get("venue")
        doi = work_raw.get("doi")
        read_url = finding.details.get("read_url")
        new_line = next(
            (str(t.get("text")) for t in finding.theses if t.get("label") == "new" and t.get("text")), None
        )
        abstract = str(work_raw.get("abstract") or "").strip()
    else:
        work = finding.work
        title = work.title
        authors = list(work.authors[:8])
        year = work.publication.year
        venue = work.venue
        doi = work.doi
        read_url = finding.read_url
        new_line = finding.new_line
        abstract = (work.abstract or "").strip() if finding.has_abstract else ""
    card = f"Title: {title}\nAuthors: {', '.join(authors)}\n"
    if year:
        card += f"Year: {year}\n"
    if venue:
        card += f"Published in: {venue}\n"
    if read_url or doi:
        card += f"Link: {read_url or 'https://doi.org/' + str(doi)}\n"
    if new_line:
        card += f"New for me compared with my wiki: {new_line}\n"
    card += "\nAbstract:\n" + (abstract or "(none)")
    return card


def card_message(finding: KbFinding) -> MessageInput:
    """Kept for ``ReadingDesk._card_message``; FX-3 chats no longer send the card as a message."""
    ask = (
        "Let's discuss this paper. Start with two or three sentences on what it is about and what is new "
        "for me. Answer only from this card; when a question needs the paper's text (methods, numbers, "
        "tables), say so and suggest adding the paper to my materials."
    )
    return MessageInput(text=ask + "\n\n" + untrusted_block("paper card", card_text(finding)))


def _bound_chat(db: KnowledgeDatabase, chat_id: str | None) -> str | None:
    """``chat_id`` when a chat with it still exists, else ``None`` (the user may have deleted it)."""
    if chat_id is None or ChatRepository(db).get(chat_id) is None:
        return None
    return chat_id


def _bind_material_folder(kb: Any, chat_id: str, material_id: str) -> None:
    """The paper's folder joins the chat's folders, as an attached material's folder would."""
    record = kb.material_repo.get(material_id)
    repo = ChatRepository(kb.db)
    chat = repo.get(chat_id)
    if record is None or chat is None or record.folder_id in chat.folder_ids:
        return
    repo.update(chat_id, folder_ids=(*chat.folder_ids, record.folder_id))


async def discuss_finding(desk: Any, finding: KbFinding) -> KbDiscussion:
    """Open or return the Discuss chat for ``finding`` (FX-3 = A).

    The chat opens clean — no card is sent in the user's name; every question carries the card (or
    the material's full text once the paper is in the library) as service context. A chat whose
    stored id no longer exists (the user deleted it) is created again.
    """
    store: ExploreStore = desk.store
    material_id = finding.material_id
    if material_id is None:
        material_id = (await disk_call(store.materials_of_works, [finding.work.id])).get(finding.work.id)
    chat_id = await disk_call(_bound_chat, desk.kb.db, finding.discuss_chat_id)
    if chat_id is not None:
        return KbDiscussion(finding_id=finding.id, chat_id=chat_id, material_id=material_id)
    view = await desk.chats.create(title=finding.work.title[:120])
    chat_id = str(view.chat.id)
    await disk_call(store.update_details, finding.id, {"discuss_chat_id": chat_id})
    if material_id is not None:
        await disk_call(_bind_material_folder, desk.kb, chat_id, material_id)
    return KbDiscussion(finding_id=finding.id, chat_id=chat_id, material_id=material_id)


__all__ = [
    "card_message",
    "card_text",
    "discuss_badge",
    "discuss_badges",
    "discuss_finding",
    "discuss_state",
    "finding_for_chat",
    "json",
]
