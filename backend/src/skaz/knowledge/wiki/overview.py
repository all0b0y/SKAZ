"""Folder overview pages ``Wiki/Folders/<Folder>.md`` (decision 10, API-B2 §2.5).

After a material of a folder is added to the wiki, its overview is rewritten:
"What was covered" (the writing agent, no tools, statements numbered from the
folder's Notes pages — every paragraph keeps the checked citations of the
statements it rests on), "Key concepts" and "Materials in order" (written by
code from the index). The user's notes on the page stay where they are.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from uuid import uuid4

from ...native_io import disk_call
from ..errors import NameTaken
from ..ids import new_id
from ..index import indexer
from ..index.scanner import read_page
from ..ingest.checks import clean_text
from ..ingest.pages import NoteSection, build_note
from ..ingest.prompts import instructions_for
from ..library.library import INBOX_ID
from ..markdown.page import Block, PageDocument, PageMeta
from ..store.records import PageRecord
from .agent import AgentCaller
from .context import WikiContext
from .pages_io import reindex, rewrite
from .prompts import OVERVIEW_INSTRUCTIONS, OVERVIEW_SCHEMA, OverviewOut, overview_prompt
from .statements import Statement, page_statements

LABELS = {
    "en": {"covered": "What was covered", "concepts": "Key concepts", "materials": "Materials in order"},
    "ru": {"covered": "Что прошли", "concepts": "Ключевые понятия", "materials": "Материалы по порядку"},
}
CONCEPTS_ID = "c-ov-concepts"
MATERIALS_ID = "c-ov-materials"
MAX_STATEMENTS_PER_MATERIAL = 15
MAX_CHARS = 24_000
MAX_CONCEPTS = 15
MAX_CITES = 6

Log = Callable[[str], Awaitable[None]]


class FolderOverviews:
    def __init__(self, ctx: WikiContext) -> None:
        self.ctx = ctx

    def _note_of(self, material_id: str) -> PageRecord | None:
        return next((page for page in self.ctx.kb.pages(kind="note") if page.sources == (material_id,)), None)

    def _inputs(self, folder_id: str) -> list[tuple[str, str, PageRecord | None, list[Statement]]]:
        """(material id, title, its Notes page, statements) in the order the materials were added."""
        kb = self.ctx.kb
        result = []
        budget = MAX_CHARS
        for material in sorted(kb.materials(folder_id=folder_id), key=lambda record: record.created_at):
            note = self._note_of(material.id)
            statements: list[Statement] = []
            if note is not None:
                for item in page_statements(kb, note.id, limit=MAX_STATEMENTS_PER_MATERIAL):
                    if budget - len(item.text) < 0:
                        break
                    budget -= len(item.text)
                    statements.append(item)
            result.append((material.id, material.title, note, statements))
        return result

    async def write(self, folder_id: str, caller: AgentCaller, log: Log) -> str | None:
        kb = self.ctx.kb
        if folder_id == INBOX_ID:
            return None
        folder = await disk_call(kb.folder_repo.get, folder_id)
        if folder is None:
            return None
        inputs = await disk_call(self._inputs, folder_id)
        numbered = [item for _id, _title, _note, statements in inputs for item in statements]
        if not numbered:
            await log(f"“{folder.name}” has no notes in the wiki yet; no overview was written.")
            return None
        language = self.ctx.settings().language
        prompt = overview_prompt(
            folder.name, [(title, statements) for _id, title, _note, statements in inputs]
        )
        answer = await caller.ask_json(
            instructions_for(OVERVIEW_INSTRUCTIONS, language, skills=self.ctx.skills()),
            prompt, OVERVIEW_SCHEMA, OverviewOut,
        )
        if answer is None:
            await log(
                f"The overview of “{folder.name}” was not in the expected format; it was left as it was."
            )
            return None
        citations = self.ctx.citations()
        covered: list[Block] = []
        sources: dict[str, None] = {}
        for paragraph in answer.blocks:
            text = clean_text(paragraph.text)
            used = [numbered[n - 1] for n in dict.fromkeys(paragraph.statements) if 1 <= n <= len(numbered)]
            if not text or not used or self.ctx.flagged(text):
                continue
            cites = citations.verified(cite for item in used for cite in item.cites)[:MAX_CITES]
            if not cites:
                continue
            for cite in cites:
                sources.setdefault(cite.material_id, None)
            body = " ".join([text, *citations.links(cites)])
            covered.append(Block.create(f"c-ov-{uuid4().hex[:12]}", "from_source", body, cites=cites))
        if not covered:
            await log(
                f"No paragraph of the overview of “{folder.name}” passed the source check; it was left as "
                "it was."
            )
            return None
        labels = LABELS.get(language, LABELS["en"])
        sections = [NoteSection(labels["covered"], tuple(covered))]
        concepts = await disk_call(self._concepts_block, folder_id)
        if concepts is not None:
            sections.append(NoteSection(labels["concepts"], (concepts,)))
        sections.append(NoteSection(labels["materials"], (self._materials_block(inputs),)))
        meta = PageMeta(
            skaz_id=new_id("pg"),
            kind="folder",
            title=folder.name,
            folders=(folder_id,),
            sources=tuple(sources),
            language=language,
        )
        return await disk_call(self._save, folder_id, meta, sections)

    def _concepts_block(self, folder_id: str) -> Block | None:
        pages = self.ctx.kb.pages(kind="concept", folder_id=folder_id)
        pages.sort(key=lambda page: (-len(page.sources), page.title.casefold()))
        if not pages:
            return None
        links = ", ".join(
            f"[[{page.rel_path.removesuffix('.md')}|{page.title}]]" for page in pages[:MAX_CONCEPTS]
        )
        return Block.create(CONCEPTS_ID, "connection", links)

    @staticmethod
    def _materials_block(inputs: list[tuple[str, str, PageRecord | None, list[Statement]]]) -> Block:
        items = []
        for number, (_material_id, title, note, _statements) in enumerate(inputs, start=1):
            link = f"[[{note.rel_path.removesuffix('.md')}|{title}]]" if note is not None else title
            items.append(f"{number}. {link}")
        return Block.create(MATERIALS_ID, "connection", "; ".join(items))

    def _save(self, folder_id: str, meta: PageMeta, sections: list[NoteSection]) -> str | None:
        kb = self.ctx.kb
        with self.ctx.write_lock:
            library = kb.require()
            existing = next((page for page in kb.pages(kind="folder") if folder_id in page.folders), None)
            if existing is not None:
                path = library.root / existing.rel_path

                def build(document: PageDocument) -> PageDocument:
                    return build_note(document, meta, sections)

                rewrite(library, path, build)
                reindex(kb, library, path)
                return existing.id
            document = build_note(None, meta, sections)
            try:
                path = library.create_page(document)
            except NameTaken:
                return None
            indexer.put_page(kb.db, read_page(library, path))
            return meta.skaz_id
