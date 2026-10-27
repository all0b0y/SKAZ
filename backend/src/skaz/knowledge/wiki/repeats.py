"""Repeats between sources (N2 decisions 2(2) and 3): a repeat strengthens, it is not written twice.

Who decides: the writing agent that already compares a page's new statements with the other
sources' statements for disagreements marks, in the same answer, "new statement N repeats existing
statement M" (``DISCREPANCY_SCHEMA.repeats`` — no extra agent call). The decision layer confirms
each pair (threshold B9). Only a confident "yes" merges: a "no", an unsure answer, no layer or a
failing one leave both statements as written (logged), because a merge deletes a paragraph and the
agent's word alone is not a confirmation (Q1 n2 H3). A confirmed repeat:

* adds the new material's citations (marker and wikilink) to the existing statement — it now has
  two sources ("2 sources");
* removes the new material's duplicate paragraph, so only what is new stays written as text.

Only SKAZ's own blocks are touched: an existing statement the user wrote or edited is never
changed (the repeat is then left as written). The new material's later re-ingest or delete takes
its citation off the strengthened statement again (``ingest.pages.strip_material`` /
``wiki.retract.retract_material``); the statement stays on its other sources.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Collection, Sequence
from dataclasses import replace

from ...native_io import disk_call
from ..agents.prompting import untrusted_block
from ..ingest.pages import block_prefix, spaced
from ..markdown.page import Block, Cite, PageDocument
from .context import WikiContext
from .pages_io import page_path, reindex, rewrite
from .prompts import RepeatOut
from .statements import Statement

QUESTION = (
    "Does statement B only repeat statement A — the same claim, perhaps in other words — without adding "
    "any detail, number, condition or example that A lacks?"
)
#: A citation wikilink in a block body (``[[Materials/…#^seg-N|…]]``).
_CITATION_LINK = re.compile(r"\[\[[^\]|\n]*#\^seg-\d+(?:\|[^\]\n]*)?\]\]")

Log = Callable[[str], Awaitable[None]]


def _agent(block: Block) -> bool:
    return block.owner == "agent" and block.hash_matches()


def _with_links(body: str, links: Sequence[str]) -> str:
    """``body`` with ``links`` right after its last citation link (before page links), else at the end."""
    if not links:
        return body
    added = " ".join(links)
    last = next(reversed(list(_CITATION_LINK.finditer(body))), None)
    if last is None:
        return f"{body.rstrip()} {added}"
    return f"{body[:last.end()]} {added}{body[last.end():]}"


def strengthen(document: PageDocument, kept_id: str, repeat_id: str,
               links: Callable[[Sequence[Cite]], list[str]]) -> PageDocument | None:
    """The page with ``repeat_id``'s citations added to ``kept_id`` and ``repeat_id`` gone (pure).

    ``None`` when either block is missing or not SKAZ's own any more, or the repeat has no citation
    of its material to give.
    """
    blocks = {part.id: part for part in document.blocks()}
    kept, repeat = blocks.get(kept_id), blocks.get(repeat_id)
    if kept is None or repeat is None or not _agent(kept) or not _agent(repeat):
        return None
    material_ids = {cite.material_id for cite in repeat.cites
                    if repeat_id.startswith(block_prefix(cite.material_id))}
    known = {(cite.material_id, cite.seg, cite.quote) for cite in kept.cites}
    given = [cite for cite in repeat.cites
             if cite.material_id in material_ids and (cite.material_id, cite.seg, cite.quote) not in known]
    if not material_ids:
        return None
    body = _with_links(kept.body, [link for link in links(given) if link not in kept.body])
    strengthened = Block.create(kept.id, kept.kind, body, cites=(*kept.cites, *given), owner="agent",
                                attrs=kept.attrs)
    parts = [strengthened if getattr(part, "id", None) == kept_id else part
             for part in document.parts if getattr(part, "id", None) != repeat_id]
    return replace(document, parts=spaced(parts))


class Repeats:
    def __init__(self, ctx: WikiContext) -> None:
        self.ctx = ctx

    async def apply(self, page_id: str, title: str, new: Sequence[Statement],
                    existing: Sequence[Statement], repeats: Sequence[RepeatOut], number: int, log: Log, *,
                    skip: Collection[int] = ()) -> int:
        """Confirm and merge page ``number``'s repeats; returns how many statements were strengthened.

        ``skip``: new statement numbers already reported as disagreeing (never also merged away).
        """
        merged: set[int] = set()
        for item in repeats:
            if item.page != number or item.new in skip or item.new in merged:
                continue
            if not 1 <= item.new <= len(new) or not len(new) < item.existing <= len(new) + len(existing):
                continue
            side_new, side_old = new[item.new - 1], existing[item.existing - len(new) - 1]
            if side_new.material_id == side_old.material_id:
                continue
            verdict = await self.ctx.confirm(
                "\n".join([untrusted_block("statement A", side_old.line("A")),
                           untrusted_block("statement B", side_new.line("B"))]),
                QUESTION,
            )
            if verdict.answer is False:
                await log(f"“{title}”: the decision layer found one marked repeat to add something new; "
                          "both statements stay.")
                continue
            if verdict.answer is not True:
                # Merging deletes the new paragraph, so the agent's word alone is not enough (spec N2-2:
                # the decision layer confirms the pairs); unlike a disagreement note, nothing is merged.
                await log(f"“{title}”: one marked repeat was not confirmed ({verdict.reason}); "
                          "both statements stay.")
                continue
            if await disk_call(self._strengthen, page_id, side_old.block_id, side_new.block_id):
                merged.add(item.new)
        if merged:
            await log(f"“{title}”: {len(merged)} statement(s) repeated what the wiki already said; "
                      "the new source was added to those statements instead.")
        return len(merged)

    def _strengthen(self, page_id: str, kept_id: str, repeat_id: str) -> bool:
        citations = self.ctx.citations()
        with self.ctx.write_lock:
            library, path = page_path(self.ctx.kb, page_id)
            if not rewrite(library, path, lambda document: strengthen(document, kept_id, repeat_id,
                                                                     citations.links)):
                return False
            reindex(self.ctx.kb, library, path)
        return True
