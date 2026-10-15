"""Taking statements of one material out of a page (pure functions, no I/O).

Rules (decision 7, decisions 6/22):

* The user's words — ``user``/``user_edited`` blocks, agent blocks edited
  outside SKAZ, unmarked paragraphs — are never changed or dropped.
* An agent statement that rests only on the material goes (W1 marks a
  material's statements by the block-id prefix, explanations included).
* An agent statement that other sources confirm stays, without this
  material's citation (marker and wikilink both), as the agent's text.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Collection
from dataclasses import dataclass, field, replace

from ..ingest.pages import block_prefix
from ..markdown.page import Block, PageDocument, Part
from ..markdown.text import quote_in_fragment
from .graph import NAV_IDS


@dataclass
class Retraction:
    removed: list[str] = field(default_factory=list)
    #: Statements kept without this material's citation (confirmed by other sources).
    kept: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.removed or self.kept)


def _agent(part: Part) -> bool:
    return isinstance(part, Block) and part.owner == "agent" and part.hash_matches()


def _without_links(body: str, rel_dir: str | None) -> str:
    if not rel_dir:
        return body
    link = re.compile(r"[ \t]?\[\[" + re.escape(rel_dir) + r"/[^\]|#\n]*#\^seg-\d+\|[^\]\n]*\]\]")
    return link.sub("", body).strip()


def retract_material(
    document: PageDocument, material_id: str, rel_dir: str | None, *, also: Collection[str] = ()
) -> tuple[PageDocument, Retraction]:
    """Remove the material's agent statements; keep multi-source ones without its citation.

    ``also``: block ids to remove as well (agent blocks only, e.g. a disagreement note about a removed side).
    """
    prefix = block_prefix(material_id)
    result = Retraction()
    parts: list[Part] = []
    for part in document.parts:
        if not _agent(part) or not isinstance(part, Block) or part.id in NAV_IDS:
            parts.append(part)
            continue
        others = tuple(cite for cite in part.cites if cite.material_id != material_id)
        if part.id in also or (part.id.startswith(prefix) and not others):
            result.removed.append(part.id)
            continue
        if len(others) == len(part.cites) and not part.id.startswith(prefix):
            parts.append(part)
            continue
        if not others:
            result.removed.append(part.id)
            continue
        body = _without_links(part.body, rel_dir)
        parts.append(Block.create(part.id, part.kind, body, cites=others, owner="agent"))
        result.kept.append(part.id)
    return replace(document, parts=parts), result


def retract_unquoted(
    document: PageDocument,
    material_id: str,
    text_of: Callable[[int], str | None],
    *,
    also: Collection[str] = (),
) -> tuple[PageDocument, Retraction]:
    """Remove agent statements whose quote from ``material_id`` is no longer verbatim (after a correction)."""
    result = Retraction()
    parts: list[Part] = []
    for part in document.parts:
        if _agent(part) and isinstance(part, Block) and part.id not in NAV_IDS:
            broken = part.id in also
            for cite in part.cites:
                if broken or cite.material_id != material_id or not cite.quote:
                    continue
                text = text_of(cite.seg)
                if text is not None and not quote_in_fragment(cite.quote, text):
                    broken = True
            if broken:
                result.removed.append(part.id)
                continue
        parts.append(part)
    return replace(document, parts=parts), result
