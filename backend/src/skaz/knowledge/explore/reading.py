"""EX3: add a finding to Materials or discuss its card in an ordinary chat."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal, Protocol

from ...native_io import disk_call
from ..agents.prompting import untrusted_block
from ..api.contract_routes import ContractFailure
from ..api.schemas_explore import (
    KbDiscussion,
    KbFinding,
    KbFindingImported,
)
from ..api.schemas_science import KbScienceText
from ..chats.model import MessageInput
from ..errors import KnowledgeError
from ..library.library import INBOX_ID
from ..markdown.source import Origin
from ..science.protocols import (
    ScienceClient,
    ScienceConsentRequired,
    ScienceDailyLimit,
    ScienceStop,
)
from ..service import KnowledgeService
from ..sources.duplicates import find_duplicate
from ..sources.fragments import sanitize_title
from ..sources.intake import Prepared, prepare_text
from ..sources.service import IntakeResult
from .rules import work_urls
from .store import ExploreStore

FULL_TEXT_KINDS = frozenset({"tei", "arxiv_html", "open_page"})


class Chats(Protocol):
    """The part of ``ChatService`` Exploring uses."""

    async def create(self, *, title: str | None = None) -> Any: ...
    async def send(self, chat_id: str, given: MessageInput) -> Any: ...


class Sources(Protocol):
    """The existing intake (``SourceService``): stores a prepared text, starts ingest with ``to_wiki``."""

    async def add_prepared(self, prepared: Prepared, folder_id: str, *, to_wiki: bool) -> IntakeResult: ...


def science_failure(stop: ScienceStop) -> ContractFailure:
    if isinstance(stop, ScienceConsentRequired):
        return ContractFailure(403, "consent_required")
    if isinstance(stop, ScienceDailyLimit):
        return ContractFailure(429, "openalex_daily_limit")
    return ContractFailure(502, "provider_unavailable")


class ReadingDesk:
    def __init__(
        self, kb: KnowledgeService, *, chats: Chats, sources: Sources, move_mark: Callable[[str, str], object]
    ) -> None:
        self.kb = kb
        self.store = ExploreStore(kb.db)
        self.chats = chats
        self.sources = sources
        #: ``runtime.kb_areas.move_finding_mark_to_material`` (B4): one mark per material.
        self.move_mark = move_mark

    async def _text(self, finding: KbFinding, science: ScienceClient) -> KbScienceText:
        try:
            text = await science.read_text(finding.work.id, run_id=finding.run_id)
        except ScienceStop as stop:
            raise science_failure(stop) from stop
        available = "full_text" if text.kind in FULL_TEXT_KINDS and text.text.strip() else "abstract_only"
        await disk_call(self.store.update_details, finding.id, {"text_available": available})
        return text

    async def add_to_materials(self, finding: KbFinding, science: ScienceClient) -> KbFindingImported:
        """EX3 (UX-11): the paper goes to «From Explore» without the wiki; full text when a free one answers,
        else the abstract (labelled so). The wiki comes later, by the material's own «Add to wiki»."""
        if finding.material_id is not None:
            content: Literal["full_text", "abstract_only"] = (
                "full_text" if finding.text_available == "full_text" else "abstract_only"
            )
            return KbFindingImported(
                finding_id=finding.id, material_id=finding.material_id, content=content, to_wiki=False
            )
        text = await self._text(finding, science)
        full = text.kind in FULL_TEXT_KINDS and bool(text.text.strip())
        body_text = text.text.strip() if full else (finding.work.abstract or "").strip()
        if not body_text:
            raise ContractFailure(409, "conflict")
        folder = await disk_call(self.kb.explore_folder)
        return await self._import(
            finding,
            "full_text" if full else "abstract_only",
            body_text,
            source_url=text.source_url,
            folder_id=folder.id,
            to_wiki=False,
        )

    async def discuss(self, finding: KbFinding) -> KbDiscussion:
        """EX3 (UX-7a): an ordinary chat on the paper's card — nothing is downloaded. The agent answers from
        the card and says plainly where it ends (the full text needs «Add to materials»)."""
        if finding.discuss_chat_id:
            return KbDiscussion(finding_id=finding.id, chat_id=finding.discuss_chat_id)
        view = await self.chats.create(title=finding.work.title[:120])
        chat_id = str(view.chat.id)
        await disk_call(self.store.update_details, finding.id, {"discuss_chat_id": chat_id})
        await self.chats.send(chat_id, self._card_message(finding))
        return KbDiscussion(finding_id=finding.id, chat_id=chat_id)

    @staticmethod
    def _card_message(finding: KbFinding) -> MessageInput:
        work = finding.work
        card = f"Title: {work.title}\nAuthors: {', '.join(work.authors[:8])}\n"
        if work.publication.year:
            card += f"Year: {work.publication.year}\n"
        if work.venue:
            card += f"Published in: {work.venue}\n"
        if finding.read_url or work.doi:
            card += f"Link: {finding.read_url or 'https://doi.org/' + str(work.doi)}\n"
        if finding.new_line:
            card += f"New for me compared with my wiki: {finding.new_line}\n"
        card += "\nAbstract:\n" + ((work.abstract or "").strip() if finding.has_abstract else "(none)")
        ask = (
            "Let's discuss this paper. Start with two or three sentences on what it is about and what is new "
            "for me. Answer only from this card; when a question needs the paper's text (methods, numbers, "
            "tables), say so and suggest adding the paper to my materials."
        )
        return MessageInput(text=ask + "\n\n" + untrusted_block("paper card", card))

    async def _import(
        self,
        finding: KbFinding,
        content: Literal["full_text", "abstract_only"],
        text: str,
        source_url: str | None = None,
        *,
        folder_id: str = INBOX_ID,
        to_wiki: bool = True,
    ) -> KbFindingImported:
        work = finding.work
        urls = work_urls(work) + ([source_url] if source_url else [])
        duplicate = await disk_call(find_duplicate, self.kb, urls=urls)
        if duplicate is not None:
            material_id = duplicate.material_id
        else:
            address = (
                ("https://doi.org/" + work.doi)
                if work.doi
                else (f"https://arxiv.org/abs/{work.arxiv_id}" if work.arxiv_id else source_url)
            )
            origin = Origin.model_validate(
                {
                    "type": "url",
                    "url": address,
                    "final_url": source_url,
                    "doi": work.doi,
                    "arxiv_id": work.arxiv_id,
                    "explore_finding_id": finding.id,
                    "content": content,
                    # Science works carry their place (B4): the material is in its area at once, not
                    # only after a wiki model run that may queue, pause or fail (review R1-09).
                    "area_id": finding.area_id,
                    "topic_ids": list(work.topic_ids),
                }
            )
            title = work.title if content == "full_text" else f"{work.title} (abstract only)"
            prepared = prepare_text(text, origin=origin, title=sanitize_title(title), fallback="Paper")
            if prepared.failure:
                raise KnowledgeError(prepared.failure)
            result = await self.sources.add_prepared(prepared, folder_id, to_wiki=to_wiki)
            material_id = result.material_id
        await disk_call(self.store.set_material, finding.id, material_id)
        await disk_call(self.store.update_details, finding.id, {"imported_content": content})
        await disk_call(self.move_mark, finding.id, material_id)
        return KbFindingImported(
            finding_id=finding.id, material_id=material_id, content=content, to_wiki=to_wiki
        )
