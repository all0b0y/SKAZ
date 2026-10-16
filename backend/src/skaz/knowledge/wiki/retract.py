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

from ..ingest.pages import block_prefix
from ..markdown.page import Block, PageDocument, Part
from ..markdown.text import quote_in_fragment
from .graph import NAV_IDS

#: Paragraphs of a folder overview ("What was covered") summarise several materials at once.
OVERVIEW_PREFIX = "c-ov-"
#: Code-written lists of links: an item to a removed page is taken out of the list.
LIST_BLOCKS = frozenset({*NAV_IDS, "c-ov-concepts", "c-ov-materials"})
_LINK = re.compile(r"\[\[([^\]|#\n]*)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]")
_NUMBERED = re.compile(r"^\s*\d+\.\s+")


def _confirms_alone(part: Block) -> bool:
    """Whether what remains after dropping one source can stand as the same claim."""
    return part.kind == "from_source" and not part.id.startswith(OVERVIEW_PREFIX)


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
        if not others or not _confirms_alone(part):
            result.removed.append(part.id)
            continue
        body = _without_links(part.body, rel_dir)
        parts.append(Block.create(part.id, part.kind, body, cites=others, owner="agent"))
        result.kept.append(part.id)
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
