""" "Ask the agent to recheck by the sources" (decision 22, API-B2 §2.4).

The agent rewrites one block from the fragments its citations point to (no
tools; numbered sources as untrusted data). The answer passes the same source
check as ingest (layer 4: verbatim quotes of existing fragments) and the
output guard (layer 5). Then the block becomes the agent's again — also when
the user had edited it — with the same id and kind. A failed check leaves the
block exactly as it was.

Fragments excluded as instructions for an AI (layer 3, ``excluded.json``)
are not sources here either: they are not sent to the model, and a quote
from one is not accepted (it is not among the fragments the check knows).
An exclusion list that can't be read hides that material (fail closed).
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable

from ...native_io import disk_call
from ..agents.prompting import untrusted_block
from ..errors import KnowledgeError, NotFound
from ..ingest.checks import MIN_QUOTE_CHARS, clean_text
from ..ingest.prompts import instructions_for
from ..markdown.page import Block, Cite, PageDocument, parse_page
from ..markdown.text import format_timestamp, normalize_text, quote_in_fragment
from ..sources.guard.visibility import ExclusionsUnreadable, excluded_segs
from .agent import AgentCaller, WikiJobFailed
from .context import WikiContext
from .pages_io import page_path, reindex, rewrite
from .prompts import RECHECK_INSTRUCTIONS, RECHECK_SCHEMA, RecheckOut
from .statements import statement_text

MAX_FRAGMENTS = 12
NO_SOURCES = "The sources of this statement are no longer in the library."
ONLY_EXCLUDED = (
    "The sources of this statement were excluded as instructions for an AI, so the agent can't recheck it. "
    "Restore the fragment in the material if it isn't an instruction."
)

Log = Callable[[str], Awaitable[None]]


class CannotRecheck(KnowledgeError):
    status_code = 409


class Recheck:
    def __init__(self, ctx: WikiContext) -> None:
        self.ctx = ctx

    def target(self, page_id: str, block_id: str) -> tuple[Block, str]:
        """The block (must cite sources) and the page language; raises when it can't be rechecked."""
        _library, path = page_path(self.ctx.kb, page_id)
        document = parse_page(path.read_text(encoding="utf-8"))
        block = document.block(block_id)
        if block is None:
            raise NotFound("Block not found.")
        if block.kind == "user_note":
            raise CannotRecheck("This is your own note; the agent doesn't rewrite your notes.")
        if not block.cites:
            raise CannotRecheck("This statement has no sources to recheck it against.")
        return block, document.meta.language or self.ctx.settings().language

    def _sources(self, block: Block) -> list[tuple[str, str, list[tuple[int, str, str]]]]:
        """(material id, title, [(seg, label, corrected text)]) for the cited fragments."""
        citations = self.ctx.citations()
        by_material: dict[str, list[int]] = {}
        for cite in block.cites:
            segs = by_material.setdefault(cite.material_id, [])
            if cite.seg not in segs and len(segs) < MAX_FRAGMENTS:
                segs.append(cite.seg)
        result = []
        for material_id, segs in by_material.items():
            record = self.ctx.kb.material_repo.get(material_id)
            if record is None:
                continue
            try:
                hidden = excluded_segs(self.ctx.kb, material_id)
            except ExclusionsUnreadable:
                continue  # can't tell which fragments are excluded: none of this material is shown
            fragments = []
            for fragment in self.ctx.kb.material_repo.fragments(material_id):
                if fragment.seg in segs and fragment.seg not in hidden:
                    label = (
                        format_timestamp(fragment.start_ms)
                        if fragment.start_ms is not None
                        else (f"page {fragment.page}" if fragment.page is not None else "")
                    )
                    text = citations.fragment_text(material_id, fragment.seg) or fragment.text
                    fragments.append((fragment.seg, label, text))
            if fragments:
                result.append((material_id, record.title, fragments))
        return result

    def _any_cited_present(self, block: Block) -> bool:
        """Whether some cited fragment still exists (then it is hidden, not gone)."""
        repo = self.ctx.kb.material_repo
        return any(fragment.seg == cite.seg
                   for cite in block.cites for fragment in repo.fragments(cite.material_id))

    async def run(self, page_id: str, block_id: str, caller: AgentCaller, log: Log) -> None:
        block, language = await disk_call(self.target, page_id, block_id)
        sources = await disk_call(self._sources, block)
        if not sources:
            present = await disk_call(self._any_cited_present, block)
            raise WikiJobFailed(ONLY_EXCLUDED if present else NO_SOURCES)
        lines = [untrusted_block("statement to recheck", statement_text(block.body))]
        for number, (_material_id, title, fragments) in enumerate(sources, start=1):
            body = "\n\n".join(
                f"[seg-{seg}]" + (f" ({label})" if label else "") + f" {text}"
                for seg, label, text in fragments
            )
            lines.append(untrusted_block(f"source {number}", f"[S{number}] {title}\n\n{body}"))
        prompt = "\n\n".join(
            [
                "Recheck this statement against its sources.",
                *lines,
                'Cite with "source" = S number and "seg" = fragment number.',
            ]
        )
        answer = await caller.ask_json(
            instructions_for(RECHECK_INSTRUCTIONS, language), prompt, RECHECK_SCHEMA, RecheckOut
        )
        if answer is None:
            raise WikiJobFailed(
                "The agent's answer was not in the expected format, twice. The statement was left as it was."
            )
        text = clean_text(answer.text)
        if not text or self.ctx.flagged(text):
            raise WikiJobFailed(
                "The agent's new version didn't pass the safety check. The statement was left as it was."
            )
        cites: list[Cite] = []
        texts = {
            (material_id, seg): fragment_text
            for material_id, _title, fragments in sources
            for seg, _label, fragment_text in fragments
        }
        for cite in answer.cites:
            if not 1 <= cite.source <= len(sources):
                continue
            material_id = sources[cite.source - 1][0]
            fragment_text = texts.get((material_id, cite.seg))
            quote = cite.quote.strip()
            if fragment_text is None or not quote_in_fragment(quote, fragment_text):
                continue
            if len(normalize_text(quote)) < min(MIN_QUOTE_CHARS, len(normalize_text(fragment_text))):
                continue
            if all((c.material_id, c.seg, c.quote) != (material_id, cite.seg, quote) for c in cites):
                cites.append(Cite(material_id, cite.seg, quote))
        if block.kind in ("from_source", "connection") and not cites:
            raise WikiJobFailed(
                "No quote of the agent's new version was found in the sources. The statement was "
                "left as it was."
            )
        await disk_call(self._save, page_id, block, text, tuple(cites))
        await log("The statement was rechecked against its sources and rewritten by the agent.")

    def _save(self, page_id: str, before: Block, text: str, cites: tuple[Cite, ...]) -> None:
        with self.ctx.write_lock:
            library, path = page_path(self.ctx.kb, page_id)
            citations = self.ctx.citations()
            body = " ".join([text, *citations.links(cites), *_page_links(before.body)])

            def build(document: PageDocument) -> PageDocument:
                current = document.block(before.id)
                if current is None or current.body != before.body:
                    raise WikiJobFailed(
                        "The statement changed while the agent was rechecking it; it was left as it is now."
                    )
                updated = Block.create(
                    before.id, before.kind, body, cites=cites or before.cites, owner="agent"
                )
                return document.with_block(updated)

            rewrite(library, path, build)
            reindex(self.ctx.kb, library, path)


def _page_links(body: str) -> list[str]:
    """Links to wiki pages (not to source fragments) that a connection statement carries."""
    return [match.group(0) for match in re.finditer(r"\[\[(?!Materials/)[^\]\n]*\]\]", body)]
