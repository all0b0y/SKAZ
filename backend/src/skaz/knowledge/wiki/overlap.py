"""How much of a material the wiki already had (N2 decision 1(1), the quiet line at the material).

Computed by code from the wiki as it is now — no agent call, nothing stored: "About N% of this is
already in your wiki: <pages> · what's new: <sections>".

* A **statement of the material** is a cited plain statement (``from_source``) on a concept page
  that cites the material.
* It is a **repeat** when another source said it first and this material's repeat was merged into
  it (N2 decision 3): the block is not the material's own (its id does not carry the material's
  prefix) and it still cites another material too. Once the other source is gone, it is simply the
  material's statement again.
* N = repeats / statements of the material, rounded (at least 1% when there is any repeat).
* **Sections** are the headings of the material's Notes page. A statement belongs to the section
  whose blocks cite one of its fragments (else whose fragment range holds it). A section *repeats
  the wiki* when every statement in it is a repeat; it is *new* when any is not. Statements that
  fall in no section still count in N.

``section_overlap`` / ``MaterialOverlap.repeated_sections`` answer "which sections of material X
repeat the wiki" for Explore (N4) as well.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from ..ingest.pages import block_prefix
from ..service import KnowledgeService


@dataclass(frozen=True)
class OverlapPage:
    id: str
    title: str
    #: Statements of the material this page already had.
    repeated: int


@dataclass(frozen=True)
class SectionOverlap:
    title: str
    repeated: int
    total: int

    @property
    def repeats_wiki(self) -> bool:
        return self.total > 0 and self.repeated == self.total


@dataclass(frozen=True)
class MaterialOverlap:
    material_id: str
    repeated: int
    total: int
    pages: tuple[OverlapPage, ...] = ()
    sections: tuple[SectionOverlap, ...] = field(default_factory=tuple)

    @property
    def percent(self) -> int:
        if not self.total:
            return 0
        value = round(100 * self.repeated / self.total)
        return max(value, 1) if self.repeated else value

    @property
    def repeated_sections(self) -> tuple[SectionOverlap, ...]:
        return tuple(section for section in self.sections if section.repeats_wiki)

    @property
    def new_sections(self) -> tuple[SectionOverlap, ...]:
        return tuple(section for section in self.sections if section.total > section.repeated)


@dataclass
class _Statement:
    page_id: str
    page_title: str
    block_id: str
    materials: set[str] = field(default_factory=set)
    segs: list[int] = field(default_factory=list)


def _statements(kb: KnowledgeService, material_id: str) -> list[_Statement]:
    with kb.db.read() as connection:
        rows = connection.execute(
            "SELECT c.page_id, c.block_id, c.material_id, c.seg, p.title FROM citations c "
            "JOIN blocks b ON b.page_id = c.page_id AND b.block_id = c.block_id "
            "JOIN pages p ON p.id = c.page_id "
            "WHERE p.kind = 'concept' AND b.kind = 'from_source' AND b.marked = 1 "
            "AND (c.page_id, c.block_id) IN (SELECT page_id, block_id FROM citations WHERE material_id = ?) "
            "ORDER BY p.title, b.ordinal, c.ordinal",
            (material_id,),
        ).fetchall()
    found: dict[tuple[str, str], _Statement] = {}
    for page_id, block_id, cited, seg, title in rows:
        item = found.setdefault((page_id, block_id), _Statement(page_id, title, block_id))
        item.materials.add(cited)
        if cited == material_id:
            item.segs.append(int(seg))
    return list(found.values())


def _is_repeat(item: _Statement, material_id: str) -> bool:
    return not item.block_id.startswith(block_prefix(material_id)) and len(item.materials) > 1


def _note_sections(kb: KnowledgeService, material_id: str) -> list[tuple[str, set[int]]]:
    """The Notes page's sections in order, each with the fragments its blocks cite."""
    with kb.db.read() as connection:
        rows = connection.execute(
            "SELECT b.section, c.seg FROM pages p "
            "JOIN page_sources s ON s.page_id = p.id AND s.material_id = ? "
            "JOIN blocks b ON b.page_id = p.id "
            "JOIN citations c ON c.page_id = b.page_id AND c.block_id = b.block_id AND c.material_id = ? "
            "WHERE p.kind = 'note' ORDER BY p.id, b.ordinal, c.ordinal",
            (material_id, material_id),
        ).fetchall()
    sections: dict[str, set[int]] = {}
    for section, seg in rows:
        sections.setdefault(section or "", set()).add(int(seg))
    return [(title, segs) for title, segs in sections.items() if title]


def _section_of(segs: list[int], sections: list[tuple[str, set[int]]]) -> int | None:
    for index, (_title, cited) in enumerate(sections):
        if cited.intersection(segs):
            return index
    for index, (_title, cited) in enumerate(sections):
        if any(min(cited) <= seg <= max(cited) for seg in segs):
            return index
    return None


def section_overlap(kb: KnowledgeService, material_id: str,
                    statements: list[_Statement] | None = None) -> tuple[SectionOverlap, ...]:
    """Each section of the material's Notes with how many of its statements the wiki already had."""
    items = statements if statements is not None else _statements(kb, material_id)
    sections = _note_sections(kb, material_id)
    repeated = [0] * len(sections)
    total = [0] * len(sections)
    for item in items:
        index = _section_of(item.segs, sections)
        if index is None:
            continue
        total[index] += 1
        repeated[index] += _is_repeat(item, material_id)
    return tuple(SectionOverlap(title, repeated[index], total[index])
                 for index, (title, _segs) in enumerate(sections) if total[index])


def material_overlap(kb: KnowledgeService, material_id: str) -> MaterialOverlap | None:
    """What of the material the wiki already had; ``None`` when none of its statements is in the wiki."""
    items = _statements(kb, material_id)
    if not items:
        return None
    repeats = [item for item in items if _is_repeat(item, material_id)]
    by_page: dict[str, list[_Statement]] = defaultdict(list)
    for item in repeats:
        by_page[item.page_id].append(item)
    pages = sorted(
        (OverlapPage(page_id, found[0].page_title, len(found)) for page_id, found in by_page.items()),
        key=lambda page: (-page.repeated, page.title),
    )
    return MaterialOverlap(material_id, len(repeats), len(items), tuple(pages),
                           section_overlap(kb, material_id, items))
