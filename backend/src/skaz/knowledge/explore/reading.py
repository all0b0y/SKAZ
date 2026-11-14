"""EX3: add a finding to Materials or discuss its card in an ordinary chat."""
from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from dataclasses import replace
from typing import Any, Protocol, cast
from weakref import WeakValueDictionary

from ...native_io import disk_call
from ..api.contract_routes import ContractFailure
from ..api.schemas_explore import (
    KbDiscussion,
    KbFinding,
    KbFindingImported,
    KbImportedContent,
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
    SciencePdfReader,
    ScienceStop,
    ScienceUnavailable,
)
from ..service import KnowledgeService
from ..sources.duplicates import find_duplicate
from ..sources.fragments import sanitize_title
from ..sources.intake import Original, Prepared, prepare_pdf, prepare_text
from ..sources.service import IntakeResult
from .discuss import card_message, discuss_finding
from .rules import work_urls
from .store import ExploreStore

FULL_TEXT_KINDS = frozenset({"tei", "arxiv_html", "open_page"})
#: A stub abstract some sources send in place of a real one («Research article: <title>»).
_STUB_PREFIXES = ("research article:", "preprint:", "article:")
_SUBSTANTIVE = re.compile(
    r"\b(we|our|this (?:paper|study|work|article)|propos\w*|present\w*|investigat\w*|"
    r"evaluat\w*|demonstrat\w*|results? (?:show|suggest|indicate)|experiment\w*)\b", re.IGNORECASE,
)


def is_real_abstract(abstract: str | None, title: str | None = None) -> bool:
    text = (abstract or "").strip()
    if len(text) < 80 or text.lower().startswith(_STUB_PREFIXES):
        return False
    if title and text.lower() == title.strip().lower():
        return False
    return not ("proceedings of " in text.lower() and not _SUBSTANTIVE.search(text))


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
        self._import_locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()

    async def _text(self, finding: KbFinding, science: ScienceClient) -> KbScienceText:
        try:
            text = await science.read_text(finding.work.id, run_id=finding.run_id)
        except ScienceUnavailable:
            text = KbScienceText(
                work_id=finding.work.id, kind="abstract_only", text=finding.work.abstract or "",
                source_url=None, access=finding.work.access,
            )
        except ScienceStop as stop:
            raise science_failure(stop) from stop
        available = "full_text" if text.kind in FULL_TEXT_KINDS and text.text.strip() else "abstract_only"
        await disk_call(self.store.update_details, finding.id, {"text_available": available})
        return text

    async def add_to_materials(self, finding: KbFinding, science: ScienceClient) -> KbFindingImported:
        """FX-2: PDF → open text → real abstract → link, serialized per finding."""
        lock = self._import_locks.setdefault(finding.id, asyncio.Lock())
        async with lock:
            # The request's snapshot can predate another click's completed import.
            row = await disk_call(self.store.finding, finding.id)
            material_id = (row.material_id if row is not None else None) or finding.material_id
            if material_id is not None:
                content = (row.details.get("imported_content") if row else None) or finding.imported_content
                if content not in ("pdf", "full_text", "abstract_only", "link_only"):
                    content = "full_text" if finding.text_available == "full_text" else "abstract_only"
                return KbFindingImported(
                    finding_id=finding.id, material_id=material_id,
                    content=cast(KbImportedContent, content), to_wiki=False,
                )
            try:
                await disk_call(self.store.update_details, finding.id, {"importing": True})
                return await self._add_to_materials(finding, science)
            finally:
                await disk_call(self.store.update_details, finding.id, {"importing": False})

    async def _add_to_materials(self, finding: KbFinding, science: ScienceClient) -> KbFindingImported:
        folder = await disk_call(self.kb.explore_folder)
        # Older injected readers implement text only; the production gateway also offers PDF bytes.
        if isinstance(science, SciencePdfReader):
            try:
                pdf = await science.read_pdf(finding.work.id, run_id=finding.run_id)
            except ScienceUnavailable:
                pdf = None
            except ScienceStop as stop:
                raise science_failure(stop) from stop
            if pdf is not None:
                try:
                    prepared = await disk_call(
                        prepare_pdf, pdf.body,
                        origin=self._origin(finding, "pdf", pdf.url),
                        fallback=sanitize_title(finding.work.title) or "Paper",
                        original=Original("original.pdf", data=pdf.body),
                    )
                except KnowledgeError:
                    prepared = None
                if prepared is not None and not prepared.failure:
                    prepared = replace(prepared, title=sanitize_title(finding.work.title))
                    return await self._import(
                        finding, "pdf", "", source_url=pdf.url, folder_id=folder.id,
                        to_wiki=False, prepared=prepared,
                    )
        text = await self._text(finding, science)
        body = text.text.strip()
        full = text.kind in FULL_TEXT_KINDS and bool(body)
        if (
            full and text.kind == "open_page" and len(body) < 400
            and not is_real_abstract(body, finding.work.title)
        ):
            full = False
        if full:
            content: KbImportedContent = "full_text"
        elif is_real_abstract(finding.work.abstract, finding.work.title):
            content = "abstract_only"
            body = (finding.work.abstract or "").strip()
        else:
            content = "link_only"
            body = self._link_card(finding)
        # Keep the canonical article link in every text material, including an abstract-only copy.
        url = self._address(finding, text.source_url)
        if url and url not in body:
            body += f"\n\nSource: {url}"
        return await self._import(
            finding, content, body, source_url=text.source_url or finding.read_url,
            folder_id=folder.id, to_wiki=False,
        )

    @staticmethod
    def _address(finding: KbFinding, source_url: str | None = None) -> str | None:
        work = finding.work
        return (
            f"https://doi.org/{work.doi}" if work.doi else
            f"https://arxiv.org/abs/{work.arxiv_id}" if work.arxiv_id else
            source_url or finding.read_url or next(iter(work_urls(work)), None)
        )

    @staticmethod
    def _link_card(finding: KbFinding) -> str:
        work = finding.work
        lines = [work.title, "Only the article link and metadata are saved; article text was unavailable."]
        if work.authors:
            lines.append("Authors: " + ", ".join(work.authors))
        if work.publication.year:
            lines.append(f"Year: {work.publication.year}")
        if work.venue:
            lines.append(f"Venue: {work.venue}")
        if url := ReadingDesk._address(finding):
            lines.append(f"Source: {url}")
        return "\n\n".join(lines)

    @staticmethod
    def _origin(finding: KbFinding, content: KbImportedContent, source_url: str | None) -> Origin:
        work = finding.work
        return Origin.model_validate({
            "type": "url",
            "url": ReadingDesk._address(finding, source_url),
            "final_url": source_url,
            "doi": work.doi,
            "arxiv_id": work.arxiv_id,
            "explore_finding_id": finding.id,
            "content": content,
            "area_id": finding.area_id,
            "topic_ids": list(work.topic_ids),
        })

    async def discuss(self, finding: KbFinding) -> KbDiscussion:
        """FX-3: delegated to ``discuss.py`` so F2 and F3 stay file-disjoint."""
        return await discuss_finding(self, finding)

    @staticmethod
    def _card_message(finding: KbFinding) -> MessageInput:
        return card_message(finding)

    async def _import(
        self,
        finding: KbFinding,
        content: KbImportedContent,
        text: str,
        source_url: str | None = None,
        *,
        folder_id: str = INBOX_ID,
        to_wiki: bool = True,
        prepared: Prepared | None = None,
    ) -> KbFindingImported:
        work = finding.work
        urls = work_urls(work) + ([source_url] if source_url else [])
        duplicate = await disk_call(find_duplicate, self.kb, urls=urls)
        if duplicate is not None:
            material_id = duplicate.material_id
        else:
            if prepared is None:
                suffix = {"abstract_only": " (abstract only)", "link_only": " (link only)"}.get(content, "")
                prepared = prepare_text(
                    text, origin=self._origin(finding, content, source_url),
                    title=sanitize_title(work.title + suffix), fallback="Paper",
                )
            if prepared.failure:
                raise KnowledgeError(prepared.failure)
            result = await self.sources.add_prepared(prepared, folder_id, to_wiki=to_wiki)
            material_id = result.material_id
        await disk_call(self.store.set_material, finding.id, material_id)
        await disk_call(self.store.update_details, finding.id, {
            "imported_content": content, "text_available": content, "importing": False,
        })
        await disk_call(self.move_mark, finding.id, material_id)
        return KbFindingImported(
            finding_id=finding.id, material_id=material_id, content=content, to_wiki=to_wiki
        )
