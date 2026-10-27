"""Taking statements of one material out of a page (pure functions, no I/O).

Rules (decision 7, decisions 6/22):

* The user's words — ``user``/``user_edited`` blocks, agent blocks edited
  outside SKAZ, unmarked paragraphs — are never changed or dropped.
* An agent statement that rests only on the material goes (W1 marks a
  material's statements by the block-id prefix, explanations included).
* An agent statement that other sources confirm stays, without this
  material's citation (marker and wikilink both), as the agent's text — but
  only a plain "from source" statement, where several citations confirm one
  claim. A synthesis over several materials (a folder overview paragraph, an
  agent connection or explanation) is not true of the rest alone: it goes
  with the material, so a kept text never cites an unrelated source (QA C18).
* Links to pages that are removed with the material go too
  (``strip_links``): list items of the code-written navigation lose the
  item; a trailing pointer link of a statement is dropped, an inline one
  becomes its label.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Collection
from dataclasses import dataclass, field, replace

from ..ingest.merged import merged_of, take_material
from ..ingest.pages import block_prefix, confirms_alone, without_citation_links
from ..markdown.page import Block, PageDocument, Part
from ..markdown.text import quote_in_fragment
from .graph import NAV_IDS

#: Code-written lists of links: an item to a removed page is taken out of the list.
LIST_BLOCKS = frozenset({*NAV_IDS, "c-ov-concepts", "c-ov-materials"})
_LINK = re.compile(r"\[\[([^\]|#\n]*)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]")
_NUMBERED = re.compile(r"^\s*\d+\.\s+")


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
        if part.id in also:
            result.removed.append(part.id)
            continue
        # A merged repeat (N2) comes apart exactly: the material's merged paragraph comes off another
        # source's statement; when the statement is the material's own, the repeats come back in their
        # own words (never the material's words under their citation).
        unmerged = take_material(part, material_id, author=part.id.startswith(prefix))
        restored = list(unmerged.restored) if unmerged is not None else []
        block = unmerged.block if unmerged is not None else part
        result.kept.extend(item.id for item in restored)
        others = tuple(cite for cite in block.cites if cite.material_id != material_id)
        if block.id.startswith(prefix) and not others:
            result.removed.append(block.id)
        elif len(others) == len(block.cites) and not block.id.startswith(prefix):
            parts.append(block)
            if unmerged is not None:
                result.kept.append(block.id)
        elif not others or not confirms_alone(block):
            result.removed.append(block.id)
        else:
            body = without_citation_links(block.body, rel_dir)
            parts.append(Block.create(block.id, block.kind, body, cites=others, owner="agent",
                                      attrs=block.attrs))
            result.kept.append(block.id)
        parts.extend(restored)
    return replace(document, parts=parts), result


def _targets(body: str, gone: Collection[str]) -> list[re.Match[str]]:
    return [match for match in _LINK.finditer(body) if match.group(1).strip() in gone]


def _split_outside_links(body: str, separator: str) -> list[str]:
    """``body`` split on ``separator`` where it is not inside ``[[…]]`` (titles may hold commas)."""
    items: list[str] = []
    depth = 0
    start = 0
    index = 0
    while index < len(body):
        if body.startswith("[[", index):
            depth += 1
            index += 2
            continue
        if body.startswith("]]", index) and depth:
            depth -= 1
            index += 2
            continue
        if depth == 0 and body[index] == separator:
            items.append(body[start:index])
            start = index + 1
        index += 1
    items.append(body[start:])
    return [item for item in items if item.strip()]


def _strip_list(body: str, gone: Collection[str]) -> str:
    """A list block without its items that link to a removed page; numbered lists are renumbered."""
    outside = _LINK.sub("", body)
    separator = ";" if ";" in outside else ","
    items = _split_outside_links(body, separator)
    kept = [item.strip() for item in items if not _targets(item, gone)]
    if any(_NUMBERED.match(item) for item in kept):
        kept = [f"{number}. {_NUMBERED.sub('', item)}" for number, item in enumerate(kept, start=1)]
    return f"{separator} ".join(kept)


def _strip_inline(body: str, gone: Collection[str]) -> str:
    def replace_link(match: re.Match[str]) -> str:
        if match.group(1).strip() not in gone:
            return match.group(0)
        trailing = not _LINK.sub("", body[match.end():]).strip(" \t.;,")
        return "" if trailing else (match.group(2) or match.group(1).rsplit("/", 1)[-1])

    return re.sub(r"[ \t]{2,}", " ", _LINK.sub(replace_link, body)).strip()


def strip_links(document: PageDocument, gone: Collection[str]) -> tuple[PageDocument, list[str]]:
    """The page without agent links to removed pages (``gone``: their paths without ``.md``).

    Returns the new document and the ids of the blocks that changed or went (an emptied list
    block goes). The user's words keep their links: a dead link in a note is theirs to edit.
    """
    if not gone:
        return document, []
    changed: list[str] = []
    parts: list[Part] = []
    for part in document.parts:
        if not _agent(part) or not isinstance(part, Block) or not _targets(part.body, gone):
            parts.append(part)
            continue
        changed.append(part.id)
        body = _strip_list(part.body, gone) if part.id in LIST_BLOCKS else _strip_inline(part.body, gone)
        if body.strip():
            parts.append(Block.create(part.id, part.kind, body, cites=part.cites, owner="agent"))
    return replace(document, parts=parts), changed


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
            if part.id in also:
                result.removed.append(part.id)
                continue
            if _breaks(part, material_id, text_of):
                # A merged repeat (N2): the broken source's share comes apart, the rest stays.
                author = part.id.startswith(block_prefix(material_id))
                unmerged = take_material(part, material_id, author=author)
                if unmerged is None or unmerged.restored or _breaks(unmerged.block, material_id, text_of):
                    result.removed.append(part.id)
                    if unmerged is not None:
                        result.kept.extend(item.id for item in unmerged.restored)
                        parts.extend(unmerged.restored)
                    continue
                # The broken source's merged paragraph is what was taken down (its refresh writes it again).
                result.removed.extend(item.block_id for item in merged_of(part)
                                      if material_id in item.material_ids)
                part = unmerged.block
        parts.append(part)
    return replace(document, parts=parts), result


def _breaks(block: Block, material_id: str, text_of: Callable[[int], str | None]) -> bool:
    for cite in block.cites:
        if cite.material_id != material_id or not cite.quote:
            continue
        text = text_of(cite.seg)
        if text is not None and not quote_in_fragment(cite.quote, text):
            return True
    return False
