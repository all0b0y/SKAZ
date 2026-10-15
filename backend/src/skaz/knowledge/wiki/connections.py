"""Connections between concepts (decision 5, API-B2 §2.5).

Candidates for one concept page are other concept pages that mention it
(search) or share a source, other folders first, never ones already
connected. The decision layer screens each candidate pair (a confident "no"
drops it); the writing agent then states connections that rest on numbered
statements of *both* pages. SKAZ writes each one as an agent ``connection``
block with the checked citations of those statements and a link to the other
page — which is also a ``connection`` edge of the graph.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import replace
from uuid import uuid4

from ...native_io import disk_call
from ..agents.prompting import untrusted_block
from ..ingest.checks import clean_text
from ..ingest.pages import insert_into_section, spaced
from ..ingest.prompts import instructions_for
from ..markdown.page import Block, Cite, PageDocument
from ..store.records import PageRecord
from .agent import AgentCaller
from .context import WikiContext
from .pages_io import page_path, reindex, rewrite
from .prompts import CONNECTIONS_INSTRUCTIONS, CONNECTIONS_SCHEMA, ConnectionsOut, connections_prompt
from .statements import Statement, page_statements

MAX_CANDIDATES = 4
MAX_OWN = 10
MAX_THEIRS = 6
QUESTION = (
    "Are these two concepts meaningfully connected, so that a reader of one page clearly benefits from "
    "the other?"
)

Log = Callable[[str], Awaitable[None]]


class Connections:
    def __init__(self, ctx: WikiContext) -> None:
        self.ctx = ctx

    def candidates(self, page: PageRecord) -> list[PageRecord]:
        kb = self.ctx.kb
        concepts = {record.id: record for record in kb.pages(kind="concept")}
        connected = {
            edge.target if edge.source == page.id else edge.source
            for edge in self.ctx.graph.edges()
            if edge.kind == "connection" and page.id in (edge.source, edge.target)
        }
        scored: dict[str, int] = {}
        for name in dict.fromkeys((page.title, page.original or "", *page.aliases)):
            if not name.strip():
                continue
            for hit in kb.search(name, limit=20).blocks:
                if hit.page_id in concepts:
                    scored[hit.page_id] = scored.get(hit.page_id, 0) + 2
        for record in concepts.values():
            if set(record.sources) & set(page.sources):
                scored[record.id] = scored.get(record.id, 0) + 1
        result = []
        for page_id, _score in sorted(scored.items(), key=lambda item: -item[1]):
            candidate = concepts.get(page_id)
            if candidate is None or page_id == page.id or page_id in connected:
                continue
            result.append(candidate)
        result.sort(key=lambda record: bool(set(record.folders) & set(page.folders)))  # other folders first
        return result[:MAX_CANDIDATES]

    async def find_for_page(self, page_id: str, caller: AgentCaller, log: Log) -> int:
        kb = self.ctx.kb
        page = await disk_call(kb.page_repo.get, page_id)
        if page is None or page.kind != "concept":
            return 0
        own = await disk_call(page_statements, kb, page_id, limit=MAX_OWN)
        if not own:
            return 0
        candidates: list[tuple[PageRecord, list[Statement]]] = []
        for record in await disk_call(self.candidates, page):
            statements = await disk_call(page_statements, kb, record.id, limit=MAX_THEIRS)
            if not statements:
                continue
            verdict = await self.ctx.confirm(
                "\n".join(
                    [
                        untrusted_block("concept A", f"{page.title}: {own[0].text[:300]}"),
                        untrusted_block("concept B", f"{record.title}: {statements[0].text[:300]}"),
                    ]
                ),
                QUESTION,
            )
            if verdict.answer is False:
                continue
            candidates.append((record, statements))
        if not candidates:
            return 0
        prompt, owner = connections_prompt(
            page.title, own, [(record.title, items) for record, items in candidates]
        )
        language = page.language or self.ctx.settings().language
        answer = await caller.ask_json(
            instructions_for(CONNECTIONS_INSTRUCTIONS, language), prompt, CONNECTIONS_SCHEMA, ConnectionsOut
        )
        if answer is None:
            await log(f"The connection search for “{page.title}” was not in the expected format; skipped.")
            return 0
        others = [item for _record, items in candidates for item in items]
        written = 0
        for found in answer.connections:
            if not 1 <= found.page <= len(candidates):
                continue
            target, _items = candidates[found.page - 1]
            mine = [own[n - 1] for n in dict.fromkeys(found.this_side) if 1 <= n <= len(own)]
            theirs = [
                others[n - len(own) - 1]
                for n in dict.fromkeys(found.other_side)
                if owner.get(n) == found.page
            ]
            text = clean_text(found.text)
            if not mine or not theirs or not text or self.ctx.flagged(text):
                continue
            if await disk_call(self._write, page_id, target, text, mine, theirs):
                written += 1
        if written:
            await log(f"“{page.title}”: {written} connection(s) written.")
        return written

    def _write(
        self,
        page_id: str,
        target: PageRecord,
        text: str,
        mine: Sequence[Statement],
        theirs: Sequence[Statement],
    ) -> bool:
        citations = self.ctx.citations()
        cites_mine = citations.verified(cite for item in mine for cite in item.cites)
        cites_theirs = citations.verified(cite for item in theirs for cite in item.cites)
        if not cites_mine or not cites_theirs:
            return False  # one side's quote no longer holds: no connection without both sides
        cites: tuple[Cite, ...] = (*cites_mine, *cites_theirs)
        link = f"[[{target.rel_path.removesuffix('.md')}|{target.title}]]"
        body = " ".join([text, *citations.links(cites), link])
        block = Block.create(f"c-link-{uuid4().hex[:12]}", "connection", body, cites=cites)
        with self.ctx.write_lock:
            library, path = page_path(self.ctx.kb, page_id)
            if self.ctx.graph.connected(page_id, target.id):
                return False

            def build(document: PageDocument) -> PageDocument:
                parts = list(document.parts)
                insert_into_section(parts, "connection", document.meta.language or "en", [block])
                return replace(document, parts=spaced(parts))

            changed = rewrite(library, path, build)
            reindex(self.ctx.kb, library, path)
            self.ctx.graph.refresh()
            return changed
