"""What a material repeats (N3 decision 3g): ``GET /kb/materials/{id}/repeats`` and ``RepeatSummaries``.

No model call. Two kinds of evidence, both ids only:

* **N2 markers** — the statements the material's repeats were merged into (``wiki.overlap``: confirmed
  by the decision layer when the material was added). A material added with N2 is *checked* even when it
  repeated nothing.
* **Older-material checks** — verdicts the user's "Check older materials" run stored in
  ``material_repeat_checks``. Evidence is trusted only while it still holds: the statement is still on its
  page with the same text and the statement it repeats still cites another material.

A material added before N2 shipped, and not checked since, is ``not_checked``: no percent and no marks,
never a guessed zero. ``percent`` counts statements of the material, as the overlap line does.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from ..api.schemas_explore_common import KbExplorePageRef, KbMaterialRef
from ..api.schemas_repeats import KbMaterialRepeats, KbParagraphRepeat
from ..errors import NotFound
from ..ingest.pages import block_prefix
from ..service import KnowledgeService
from ..wiki.overlap import OverlapStatement, material_statements, merged_into
from ..wiki.statements import statement_text
from .store import Evidence, RepeatStore

#: Per library: when SKAZ 0.4.0 first opened it (user decision, option A). Repeat marks (N2) shipped in
#: 0.3.2, but a library keeps no record of the version a material was added with, so a material from before
#: this moment and without marks is "not checked" — never a false "0% repeats". Later ones carry N2's marks.
MARKS_FROM_KEY = "repeats.marks_from.{library_id}"


def stamp_marks_from(kb: KnowledgeService) -> datetime | None:
    """Record the boundary for the open library the first time 0.4.0 sees it; return it (None: no library)."""
    view = kb.view()
    if view.state == "not_configured":
        return None
    library = kb.require()
    key = MARKS_FROM_KEY.format(library_id=library.library_id)
    raw = kb.settings.get(key)
    if isinstance(raw, str):
        try:
            return datetime.fromisoformat(raw)
        except ValueError:
            pass
    now = datetime.now(UTC)
    kb.settings.set(key, now.isoformat())
    return now


def text_hash(text: str) -> str:
    return hashlib.sha1(statement_text(text).encode("utf-8")).hexdigest()[:16]


def author_of(block_id: str, material_ids: Sequence[str]) -> str | None:
    """The material that wrote a statement: its block id carries the material's prefix."""
    return next((mid for mid in material_ids if block_id.startswith(block_prefix(mid))), None)


@dataclass(frozen=True)
class _Repeat:
    """A statement of the material that repeats another source's statement."""

    page_id: str
    block_id: str
    #: The statement it repeats.
    other_page_id: str
    other_block_id: str
    other_authors: tuple[str, ...]


def percent_of(repeated: int, total: int) -> int | None:
    if not total:
        return None
    value = round(100 * repeated / total)
    return max(value, 1) if repeated else value


class RepeatReader:
    """Implements ``RepeatSummaries`` and the material route's reading side. Blocking."""

    def __init__(self, kb: KnowledgeService, store: RepeatStore, *, n2_from: datetime | None = None) -> None:
        self._kb = kb
        self._store = store
        self._n2_from = n2_from

    # -- public ---------------------------------------------------------------------------

    def material(self, material_id: str) -> KbMaterialRepeats:
        return self._build([material_id], detailed=True)[material_id]

    def summaries(self, material_ids: Sequence[str]) -> Mapping[str, KbMaterialRepeats]:
        return self._build(list(dict.fromkeys(material_ids)), detailed=False)

    def is_older(self, material_id: str) -> bool:
        """Added before N2: its statements carry no repeat marks, so only a check can tell."""
        record = self._kb.material_repo.get(material_id)
        if record is None:
            raise NotFound("This material wasn't found.")
        return self._older(record.created_at)

    def needs_check(self, material_ids: Sequence[str]) -> list[str]:
        """Those of ``material_ids`` that are ``not_checked``, in the given order."""
        return [mid for mid, result in self._build(list(dict.fromkeys(material_ids)), detailed=False).items()
                if result.status == "not_checked"]

    # -- building -------------------------------------------------------------------------

    def _older(self, created_at: str) -> bool:
        try:
            created = datetime.fromisoformat(created_at)
        except ValueError:
            return True
        if created.tzinfo is None:
            created = created.replace(tzinfo=UTC)
        boundary = self._n2_from or stamp_marks_from(self._kb)
        if boundary is None:
            return True
        if boundary.tzinfo is None:
            boundary = boundary.replace(tzinfo=UTC)
        return created < boundary

    def _build(self, material_ids: list[str], *, detailed: bool) -> dict[str, KbMaterialRepeats]:
        evidence = self._store.evidence(material_ids)
        built: dict[str, KbMaterialRepeats] = {}
        titles: dict[str, str] = {}
        for material_id in material_ids:
            record = self._kb.material_repo.get(material_id)
            if record is None:
                if detailed:
                    raise NotFound("This material wasn't found.")
                continue
            items = material_statements(self._kb, material_id)
            merged = merged_into(self._kb, material_id, items)
            repeats = self._marker_repeats(material_id, items, merged)
            stored = evidence.get(material_id)
            if stored is not None and stored.status == "checked":  # a run still in progress shows nothing
                repeats += self._stored_repeats(material_id, items, stored)
            checked = (
                (stored is not None and stored.status == "checked") or bool(repeats)
                or not self._older(record.created_at)
            )
            built[material_id] = self._result(material_id, items, repeats, checked, stored, detailed, titles)
        return built

    @staticmethod
    def _marker_repeats(material_id: str, items: list[OverlapStatement],
                        merged: set[tuple[str, str]]) -> list[_Repeat]:
        found = []
        for item in items:
            if (item.page_id, item.block_id) not in merged:
                continue
            others = [mid for mid in sorted(item.materials) if mid != material_id]
            authors = author_of(item.block_id, others)
            found.append(_Repeat(item.page_id, item.block_id, item.page_id, item.block_id,
                                 (authors,) if authors else tuple(others[:1])))
        return found

    def _stored_repeats(self, material_id: str, items: list[OverlapStatement],
                        stored: Evidence | None) -> list[_Repeat]:
        if stored is None:
            return []
        own = {(item.page_id, item.block_id) for item in items
               if item.block_id.startswith(block_prefix(material_id)) and item.materials == {material_id}}
        found = []
        for judged in stored.judged.values():
            if judged.verdict != "repeat" or judged.match is None or judged.key not in own:
                continue
            if judged.text_hash != self._current_hash(judged.page_id, judged.block_id):
                continue  # edited since it was compared
            cited = self._citing(judged.match.page_id, judged.match.block_id)
            others = [mid for mid in cited if mid != material_id]
            if not others:
                continue  # what it repeated is gone
            authors = author_of(judged.match.block_id, others)
            found.append(_Repeat(judged.page_id, judged.block_id, judged.match.page_id, judged.match.block_id,
                                 (authors,) if authors else tuple(others[:1])))
        return found

    def _current_hash(self, page_id: str, block_id: str) -> str | None:
        with self._kb.db.read() as connection:
            row = connection.execute(
                "SELECT text FROM blocks WHERE page_id = ? AND block_id = ?", (page_id, block_id)).fetchone()
        return text_hash(row[0]) if row else None

    def _citing(self, page_id: str, block_id: str) -> list[str]:
        with self._kb.db.read() as connection:
            rows = connection.execute(
                "SELECT DISTINCT material_id FROM citations WHERE page_id = ? AND block_id = ? "
                "ORDER BY material_id",
                (page_id, block_id)).fetchall()
        return [row[0] for row in rows]

    def _title(self, material_id: str, titles: dict[str, str]) -> str:
        if material_id not in titles:
            record = self._kb.material_repo.get(material_id)
            titles[material_id] = record.title if record else "A deleted material"
        return titles[material_id]

    def _result(self, material_id: str, items: list[OverlapStatement], repeats: list[_Repeat], checked: bool,
                stored: Evidence | None, detailed: bool, titles: dict[str, str]) -> KbMaterialRepeats:
        total = len(items)
        if not checked:
            return KbMaterialRepeats(material_id=material_id, status="not_checked", percent=None, repeated=0,
                                     total=total, from_materials=[], paragraphs=[], checked_at=None)
        counts: dict[str, int] = defaultdict(int)
        for repeat in repeats:
            for author in repeat.other_authors:
                counts[author] += 1
        sources = [KbMaterialRef(material_id=mid, title=self._title(mid, titles))
                   for mid in sorted(counts, key=lambda mid: (-counts[mid], self._title(mid, titles)))]
        return KbMaterialRepeats(
            material_id=material_id, status="checked", percent=percent_of(len(repeats), total),
            repeated=len(repeats), total=total, from_materials=sources,
            paragraphs=self._paragraphs(material_id, items, repeats, titles) if detailed else [],
            checked_at=stored.checked_at if stored is not None else None)

    # -- paragraphs -----------------------------------------------------------------------

    def _note_paragraphs(self, material_id: str) -> list[tuple[str, list[int]]]:
        """The material's Notes paragraphs in order, each with the fragments it cites."""
        with self._kb.db.read() as connection:
            rows = connection.execute(
                "SELECT b.block_id, c.seg FROM pages p "
                "JOIN page_sources s ON s.page_id = p.id AND s.material_id = ? "
                "JOIN blocks b ON b.page_id = p.id AND b.marked = 1 "
                "JOIN citations c ON c.page_id = b.page_id AND c.block_id = b.block_id AND c.material_id = ? "
                "WHERE p.kind = 'note' ORDER BY p.id, b.ordinal, c.ordinal",
                (material_id, material_id)).fetchall()
        order: dict[str, set[int]] = {}
        for block_id, seg in rows:
            order.setdefault(block_id, set()).add(int(seg))
        return [(block_id, sorted(segs)) for block_id, segs in order.items()]

    def _paragraphs(self, material_id: str, items: list[OverlapStatement], repeats: list[_Repeat],
                    titles: dict[str, str]) -> list[KbParagraphRepeat]:
        by_key = {(repeat.page_id, repeat.block_id): repeat for repeat in repeats}
        page_titles: dict[str, str] = {}
        found: list[KbParagraphRepeat] = []
        for block_id, segs in self._note_paragraphs(material_id):
            inside = [item for item in items if set(item.segs) & set(segs)]
            hits = [by_key[(item.page_id, item.block_id)] for item in inside
                    if (item.page_id, item.block_id) in by_key]
            if not hits:
                continue
            refs: list[KbExplorePageRef] = []
            authors: dict[str, None] = {}
            for hit in hits:
                if hit.other_page_id not in page_titles:
                    page = self._kb.page_repo.get(hit.other_page_id)
                    page_titles[hit.other_page_id] = page.title if page else ""
                ref = KbExplorePageRef(page_id=hit.other_page_id, title=page_titles[hit.other_page_id],
                                       block_id=hit.other_block_id)
                if ref not in refs:
                    refs.append(ref)
                authors.update(dict.fromkeys(hit.other_authors))
            found.append(KbParagraphRepeat(
                paragraph_id=block_id, fragment_ids=segs, wiki_refs=refs,
                from_materials=[KbMaterialRef(material_id=mid, title=self._title(mid, titles))
                                for mid in authors],
                repeated_statements=len(hits), total_statements=len(inside),
                fully_repeated=len(hits) == len(inside)))
        return found
