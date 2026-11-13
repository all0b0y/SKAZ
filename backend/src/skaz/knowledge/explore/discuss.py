"""FX-3: Discuss an Explore finding in a chat (owned by slice F3)."""
from __future__ import annotations

import json
from typing import Any

from ...native_io import disk_call
from ..agents.prompting import untrusted_block
from ..api.schemas_explore import KbDiscussion, KbFinding
from ..chats.model import MessageInput
from ..store.database import KnowledgeDatabase
from .store import FindingRow, _finding


def finding_for_chat(db: KnowledgeDatabase, chat_id: str) -> FindingRow | None:
    """Return the Explore finding whose ``discuss_chat_id`` is ``chat_id``, if any."""
    with db.read() as connection:
        row = connection.execute(
            "SELECT * FROM explore_findings WHERE json_extract(details_json, '$.discuss_chat_id') = ?"
            " ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (chat_id,),
        ).fetchone()
    return None if row is None else _finding(row)


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
    ask = (
        "Let's discuss this paper. Start with two or three sentences on what it is about and what is new "
        "for me. Answer only from this card; when a question needs the paper's text (methods, numbers, "
        "tables), say so and suggest adding the paper to my materials."
    )
    return MessageInput(text=ask + "\n\n" + untrusted_block("paper card", card_text(finding)))


async def discuss_finding(desk: Any, finding: KbFinding) -> KbDiscussion:
    """Open or return the Discuss chat for ``finding``."""
    if finding.discuss_chat_id:
        return KbDiscussion(
            finding_id=finding.id, chat_id=finding.discuss_chat_id, material_id=finding.material_id
        )
    view = await desk.chats.create(title=finding.work.title[:120])
    chat_id = str(view.chat.id)
    await disk_call(desk.store.update_details, finding.id, {"discuss_chat_id": chat_id})
    await desk.chats.send(chat_id, card_message(finding))
    return KbDiscussion(finding_id=finding.id, chat_id=chat_id, material_id=finding.material_id)


__all__ = ["card_message", "card_text", "discuss_finding", "finding_for_chat", "json"]
