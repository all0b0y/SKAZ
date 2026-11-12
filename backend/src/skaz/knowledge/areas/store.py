"""Areas and read-marks persistence and ``AreaDirectory`` implementation (B4; EX2 own topics).

EX2: the map, the directory and area CRUD work on the user's own topics (``level='custom'``, see ``topics``).
OpenAlex rows of builds before EX2 stay readable for old findings and signals, never on the map.
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, cast

from ..api.contract_routes import ContractFailure
from ..api.schemas_areas import (
    KbArea,
    KbAreaCreate,
    KbAreaMap,
    KbAreaUpdate,
    KbReadMark,
    KbReadMarkUpdate,
    KbSignalEntity,
    KbTopicLabelling,
)
from ..api.schemas_explore_common import KbAcknowledged, KbPublicationDate, KbReadMarkValue
from ..errors import NotFound
from ..ids import new_id, utc_now_ms
from ..library.layout import STUDY_KINDS
from ..service import KnowledgeService
from .protocols import SignalDraft
from .signals import SignalStore
from .topics import TopicStore

if TYPE_CHECKING:
    from ..science.protocols import TaxonomyNode

AreaLevel = Literal["domain", "field", "subfield", "topic", "custom"]
_VALID_ID = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")
_CHILDREN_TOTAL_KEY = "explore.areas.children_total"
_LOCAL_USER = KbSignalEntity(kind="user", id="local-user")


def _sanitize_area_id(taxonomy_id: str, level: str) -> str:
    if _VALID_ID.match(taxonomy_id):
        return taxonomy_id
    cleaned = re.sub(r"^https?://openalex\.org/", "", taxonomy_id.strip())
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", cleaned).strip("-")
    if not cleaned:
        cleaned = new_id(level)
    return cleaned[:128]


@dataclass(frozen=True)
class AreaRow:
    id: str
    parent_id: str | None
    taxonomy_id: str | None
    level: AreaLevel
    original_name: str
    name: str
    hidden: bool
    pinned: bool


def _row_to_area(row: sqlite3.Row) -> AreaRow:
    return AreaRow(
        id=str(row["id"]),
        parent_id=str(row["parent_id"]) if row["parent_id"] is not None else None,
        taxonomy_id=str(row["taxonomy_id"]) if row["taxonomy_id"] is not None else None,
        level=cast(AreaLevel, str(row["level"])),
        original_name=str(row["original_name"]),
        name=str(row["name"]),
        hidden=bool(row["hidden"]),
        pinned=bool(row["pinned"]),
    )


def _origin_topics_and_areas(origin: dict[str, Any] | None) -> tuple[set[str], set[str]]:
    if not isinstance(origin, dict):
        return set(), set()
    topics: set[str] = set()
    areas: set[str] = set()
    for key in ("topic_id", "openalex_topic_id"):
        val = origin.get(key)
        if isinstance(val, str) and val.strip():
            topics.add(val.strip())
    raw_topics = origin.get("topic_ids")
    if isinstance(raw_topics, list):
        for item in raw_topics:
            if isinstance(item, str) and item.strip():
                topics.add(item.strip())
    area_id = origin.get("area_id")
    if isinstance(area_id, str) and area_id.strip():
        areas.add(area_id.strip())
    return topics, areas


class AreasStore:
    """Implements ``AreaDirectory`` and backs ``AreasService``."""

    def __init__(self, kb: KnowledgeService, signals: SignalStore) -> None:
        self.kb = kb
        self.db = kb.db
        self.signals = signals
        self.topic_store = TopicStore(kb)

    # -- taxonomy & area rows ------------------------------------------------

    def _children_totals(self) -> dict[str, int]:
        raw = self.kb.settings.get(_CHILDREN_TOTAL_KEY, {})
        if not isinstance(raw, dict):
            return {}
        return {str(k): int(v) for k, v in raw.items() if isinstance(k, str) and isinstance(v, int)}

    def _save_children_totals(self, updates: Mapping[str, int]) -> None:
        if not updates:
            return
        current = self._children_totals()
        current.update(updates)
        self.kb.settings.set(_CHILDREN_TOTAL_KEY, current)

    def sync_taxonomy_nodes(
        self, parent_area_id: str | None, nodes: Sequence[TaxonomyNode]
    ) -> list[str]:
        if not nodes:
            return []
        synced_ids: list[str] = []
        totals_update: dict[str, int] = {}
        with self.db.write() as conn:
            for node in nodes:
                existing = conn.execute(
                    "SELECT id FROM explore_areas WHERE taxonomy_id = ? OR id = ?",
                    (node.taxonomy_id, _sanitize_area_id(node.taxonomy_id, node.level)),
                ).fetchone()
                if existing is not None:
                    area_id = str(existing["id"])
                    conn.execute(
                        "UPDATE explore_areas SET parent_id = ?, taxonomy_id = ?, level = ?, "
                        "original_name = ? WHERE id = ?",
                        (parent_area_id, node.taxonomy_id, node.level, node.name, area_id),
                    )
                else:
                    area_id = _sanitize_area_id(node.taxonomy_id, node.level)
                    conn.execute(
                        "INSERT INTO explore_areas("
                        "id, parent_id, taxonomy_id, level, original_name, name, hidden, pinned"
                        ") VALUES (?, ?, ?, ?, ?, ?, 0, 0)",
                        (area_id, parent_area_id, node.taxonomy_id, node.level, node.name, node.name),
                    )
                if node.level == "topic":
                    conn.execute(
                        "INSERT OR IGNORE INTO explore_area_topics(area_id, topic_id) VALUES (?, ?)",
                        (area_id, node.taxonomy_id),
                    )
                totals_update[area_id] = max(0, int(node.children_total))
                synced_ids.append(area_id)
        self._save_children_totals(totals_update)
        return synced_ids

    def all_area_rows(self) -> dict[str, AreaRow]:
        with self.db.read() as conn:
            rows = conn.execute("SELECT * FROM explore_areas ORDER BY rowid ASC").fetchall()
        return {str(row["id"]): _row_to_area(row) for row in rows}

    def get_area_row(self, area_id: str) -> AreaRow:
        with self.db.read() as conn:
            row = conn.execute("SELECT * FROM explore_areas WHERE id = ?", (area_id,)).fetchone()
        if row is None:
            raise NotFound("Area not found.")
        return _row_to_area(row)

    def children_of(self, parent_id: str | None, *, include_hidden: bool = False) -> list[AreaRow]:
        with self.db.read() as conn:
            if parent_id is None:
                sql = "SELECT * FROM explore_areas WHERE parent_id IS NULL"
                params: tuple[object, ...] = ()
            else:
                sql = "SELECT * FROM explore_areas WHERE parent_id = ?"
                params = (parent_id,)
            if not include_hidden:
                sql += " AND hidden = 0"
            sql += " ORDER BY rowid ASC"
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_area(row) for row in rows]

    def assign_page(self, area_id: str, page_id: str, *, replace_area_id: str | None = None) -> None:
        with self.db.write() as conn:
            if replace_area_id is not None and replace_area_id != area_id:
                conn.execute(
                    "DELETE FROM explore_area_pages WHERE area_id = ? AND page_id = ?",
                    (replace_area_id, page_id),
                )
            conn.execute(
                "INSERT OR IGNORE INTO explore_area_pages(area_id, page_id) VALUES (?, ?)",
                (area_id, page_id),
            )

    def unplaced_wiki_page_ids(self) -> list[str]:
        placeholders = ",".join("?" for _ in STUDY_KINDS)
        with self.db.read() as conn:
            rows = conn.execute(
                f"SELECT p.id FROM pages p WHERE p.kind NOT IN ({placeholders}) "
                "AND NOT EXISTS (SELECT 1 FROM explore_area_pages eap WHERE eap.page_id = p.id) "
                "ORDER BY p.title COLLATE NOCASE",
                tuple(STUDY_KINDS),
            ).fetchall()
        return [str(row["id"]) for row in rows]

    def direct_wiki_page_ids(self, area_id: str) -> list[str]:
        placeholders = ",".join("?" for _ in STUDY_KINDS)
        with self.db.read() as conn:
            rows = conn.execute(
                "SELECT p.id FROM explore_area_pages eap "
                "JOIN pages p ON p.id = eap.page_id "
                f"WHERE eap.area_id = ? AND p.kind NOT IN ({placeholders}) "
                "ORDER BY p.title COLLATE NOCASE",
                (area_id, *STUDY_KINDS),
            ).fetchall()
        return [str(row["id"]) for row in rows]

    def place_pages_from_source_topics(self) -> None:
        """Assign wiki pages whose cited materials already carry an OpenAlex topic or area id."""
        areas = self.all_area_rows()
        if not areas:
            return
        subtrees = self._subtree_map(areas)
        placeholders_study = ",".join("?" for _ in STUDY_KINDS)
        with self.db.read() as conn:
            rows = conn.execute(
                "SELECT ps.page_id, m.origin FROM page_sources ps "
                "JOIN pages p ON p.id = ps.page_id "
                "JOIN materials m ON m.id = ps.material_id "
                f"WHERE p.kind NOT IN ({placeholders_study})",
                tuple(STUDY_KINDS),
            ).fetchall()
            current_rows = conn.execute(
                "SELECT area_id, page_id FROM explore_area_pages"
            ).fetchall()

        current_by_page: dict[str, set[str]] = defaultdict(set)
        for row in current_rows:
            current_by_page[str(row["page_id"])].add(str(row["area_id"]))

        for row in rows:
            page_id = str(row["page_id"])
            origin_obj = json.loads(row["origin"]) if row["origin"] else None
            m_topics, m_areas = _origin_topics_and_areas(origin_obj)
            target_id = self.area_for_topics(tuple(m_topics))
            if target_id is None:
                for aid in m_areas:
                    if aid in areas:
                        target_id = aid
                        break
            if target_id is None:
                continue
            existing_areas = current_by_page.get(page_id, set())
            # Replace any ancestor area that contains target_id in its subtree
            to_replace = [
                anc_id
                for anc_id in existing_areas
                if anc_id != target_id and target_id in subtrees.get(anc_id, set())
            ]
            if not existing_areas or to_replace:
                with self.db.write() as conn:
                    for anc_id in to_replace:
                        conn.execute(
                            "DELETE FROM explore_area_pages WHERE area_id = ? AND page_id = ?",
                            (anc_id, page_id),
                        )
                    conn.execute(
                        "INSERT OR IGNORE INTO explore_area_pages(area_id, page_id) VALUES (?, ?)",
                        (target_id, page_id),
                    )
                for anc_id in to_replace:
                    existing_areas.discard(anc_id)
                existing_areas.add(target_id)
                current_by_page[page_id] = existing_areas

    def wiki_page_counts_for_materials(self, material_ids: Sequence[str]) -> dict[str, int]:
        if not material_ids:
            return {}
        marks = ",".join("?" for _ in material_ids)
        placeholders_study = ",".join("?" for _ in STUDY_KINDS)
        with self.db.read() as conn:
            rows = conn.execute(
                "SELECT ps.material_id, COUNT(DISTINCT p.id) AS cnt "
                "FROM page_sources ps JOIN pages p ON p.id = ps.page_id "
                f"WHERE ps.material_id IN ({marks}) AND p.kind NOT IN ({placeholders_study}) "
                "GROUP BY ps.material_id",
                (*material_ids, *STUDY_KINDS),
            ).fetchall()
        return {str(r["material_id"]): int(r["cnt"]) for r in rows}

    def concept_counts_for_materials(self, material_ids: Sequence[str]) -> dict[str, int]:
        """EX3 (UX-15): concept pages each material gave the wiki (a leaf topic's tiles)."""
        if not material_ids:
            return {}
        marks = ",".join("?" for _ in material_ids)
        with self.db.read() as conn:
            rows = conn.execute(
                "SELECT ps.material_id, COUNT(DISTINCT p.id) AS cnt "
                "FROM page_sources ps JOIN pages p ON p.id = ps.page_id "
                f"WHERE ps.material_id IN ({marks}) AND p.kind = 'concept' GROUP BY ps.material_id",
                tuple(material_ids),
            ).fetchall()
        return {str(r["material_id"]): int(r["cnt"]) for r in rows}

    # -- subtree & topic helpers ---------------------------------------------

    def _subtree_map(self, areas: Mapping[str, AreaRow]) -> dict[str, set[str]]:
        children_map: dict[str, list[str]] = defaultdict(list)
        for area in areas.values():
            if area.parent_id is not None and area.parent_id in areas:
                children_map[area.parent_id].append(area.id)

        direct_topics: dict[str, list[str]] = defaultdict(list)
        with self.db.read() as conn:
            for row in conn.execute("SELECT area_id, topic_id FROM explore_area_topics ORDER BY rowid ASC"):
                direct_topics[str(row["area_id"])].append(str(row["topic_id"]))

        topic_to_taxonomy_areas: dict[str, set[str]] = defaultdict(set)
        for area in areas.values():
            if area.level != "custom":
                if area.taxonomy_id:
                    topic_to_taxonomy_areas[area.taxonomy_id].add(area.id)
                for tid in direct_topics.get(area.id, ()):
                    topic_to_taxonomy_areas[tid].add(area.id)

        def collect_descendants(root_id: str) -> set[str]:
            visited: set[str] = {root_id}
            stack = [root_id]
            while stack:
                curr = stack.pop()
                for child_id in children_map.get(curr, ()):
                    if child_id not in visited:
                        visited.add(child_id)
                        stack.append(child_id)
            return visited

        subtrees: dict[str, set[str]] = {}
        for area_id, area in areas.items():
            if area.level != "custom":
                subtrees[area_id] = collect_descendants(area_id)

        for area_id, area in areas.items():
            if area.level == "custom":
                collected: set[str] = {area_id} | {
                    child.id for child in areas.values() if child.parent_id == area_id
                }
                for tid in direct_topics.get(area_id, ()):
                    for matched_id in topic_to_taxonomy_areas.get(tid, ()):
                        collected.update(subtrees.get(matched_id, {matched_id}))
                subtrees[area_id] = collected
        return subtrees

    def _topics_by_area(self, areas: Mapping[str, AreaRow]) -> dict[str, list[str]]:
        direct: dict[str, list[str]] = defaultdict(list)
        with self.db.read() as conn:
            for row in conn.execute("SELECT area_id, topic_id FROM explore_area_topics ORDER BY rowid ASC"):
                aid = str(row["area_id"])
                tid = str(row["topic_id"])
                if tid not in direct[aid]:
                    direct[aid].append(tid)
        for area in areas.values():
            if area.level == "topic" and area.taxonomy_id and area.taxonomy_id not in direct[area.id]:
                direct[area.id].append(area.taxonomy_id)
        return direct

    # -- AreaDirectory Protocol ----------------------------------------------

    def area_for_topics(self, topic_ids: Sequence[str]) -> str | None:
        """EX2: the own topic whose hidden label holds one of ``topic_ids`` (a subtopic before its topic);
        else an OpenAlex row of an older build."""
        if not topic_ids:
            return None
        own = [topic for topic in self.topic_store.topics(include_hidden=False) if topic.mapping_current]
        own.sort(key=lambda topic: topic.parent_id is None)  # subtopics first: the narrower match
        labels = {topic.id: set(self.topic_store.hidden_ids(topic.id)) for topic in own}
        for tid in topic_ids:
            for topic in own:
                if tid in labels[topic.id]:
                    return topic.id
        areas = self.all_area_rows()
        direct = self._topics_by_area(areas)
        topic_lookup: dict[str, list[AreaRow]] = defaultdict(list)
        for area in areas.values():
            if area.taxonomy_id:
                topic_lookup[area.taxonomy_id].append(area)
            for tid in direct.get(area.id, ()):
                if area not in topic_lookup[tid]:
                    topic_lookup[tid].append(area)

        for tid in topic_ids:
            candidates = topic_lookup.get(tid, [])
            for candidate in candidates:
                if candidate.level == "topic":
                    return candidate.id
            for candidate in candidates:
                if candidate.level != "custom":
                    return candidate.id
            if candidates:
                return candidates[0].id
        return None

    def area_path(self, area_id: str) -> Sequence[str]:
        areas = self.all_area_rows()
        if area_id not in areas:
            return ()
        names: list[str] = []
        seen: set[str] = set()
        curr: str | None = area_id
        while curr is not None and curr in areas and curr not in seen:
            seen.add(curr)
            row = areas[curr]
            names.append(row.name)
            curr = row.parent_id
        names.reverse()
        return tuple(names)

    def topics(self, area_id: str) -> Sequence[str]:
        areas = self.all_area_rows()
        if area_id not in areas:
            return ()
        area = areas[area_id]
        if area.level == "custom":
            # EX2: the hidden OpenAlex label of the topic and its subtopics (empty while not mapped).
            ids: list[str] = []
            for sub_id in self.topic_store.descendants(area_id):
                ids += [tid for tid in self.topic_store.hidden_ids(sub_id) if tid not in ids]
            return tuple(ids)
        direct = self._topics_by_area(areas)
        if area.level == "topic":
            return tuple(direct.get(area_id, []))
        if area.taxonomy_id:
            # A domain/field/subfield is its own hierarchy id: the science query covers every topic below
            # it, not only the leaves this map happened to load (review R1-05).
            return (area.taxonomy_id,)
        subtrees = self._subtree_map(areas)
        result: list[str] = []
        for sub_id in sorted(subtrees.get(area_id, {area_id}), key=lambda x: list(areas).index(x)):
            for tid in direct.get(sub_id, ()):
                if tid not in result:
                    result.append(tid)
        return tuple(result)

    def largest_topics(self, limit: int = 8) -> Sequence[str]:
        if limit <= 0:
            return ()
        labels = self.topic_store.labels()
        wiki = set(self.topic_store.wiki_material_ids())
        counts: dict[str, int] = defaultdict(int)
        topics = self.topic_store.topics(include_hidden=True)
        parent_of = {topic.id: topic.parent_id for topic in topics}
        for mid, (aid, _origin) in labels.items():
            if mid in wiki and aid in parent_of:
                counts[parent_of[aid] or aid] += 1
        visible = [t for t in topics if t.parent_id is None and not t.hidden and counts.get(t.id)]
        visible.sort(key=lambda t: (-counts[t.id], t.name.casefold()))
        return tuple(t.id for t in visible[:limit])

    def top_concepts(self, area_id: str, limit: int = 5) -> Sequence[str]:
        if area_id not in self.all_area_rows():
            return ()
        return tuple(self.topic_store.top_concepts(area_id, limit))

    def scope_ids(self, area_id: str) -> tuple[str, ...]:
        """The areas a tile counts: a taxonomy area and everything below it, or what a custom area collects
        (the same sets ``build_map`` sums over). An unknown id is only itself."""
        areas = self.all_area_rows()
        if area_id not in areas:
            return (area_id,)
        order = list(areas)
        inside = self._subtree_map(areas).get(area_id, {area_id})
        return tuple(sorted(inside, key=order.index))

    def materials(self, area_id: str) -> Sequence[str]:
        areas = self.all_area_rows()
        if area_id not in areas:
            return ()
        if areas[area_id].level == "custom":
            # EX2: the materials labelled with the topic or one of its subtopics, in title order.
            inside = set(self.topic_store.descendants(area_id))
            labelled = {mid for mid, (aid, _origin) in self.topic_store.labels().items() if aid in inside}
            records = sorted(
                (record for record in self.kb.material_repo.list_all() if record.id in labelled),
                key=lambda record: (record.title.casefold(), record.id),
            )
            return tuple(record.id for record in records)
        subtrees = self._subtree_map(areas)
        direct_topics = self._topics_by_area(areas)
        subtree_ids = subtrees.get(area_id, {area_id})
        subtree_topics: set[str] = set()
        for sub_id in subtree_ids:
            subtree_topics.update(direct_topics.get(sub_id, ()))
            sub_area = areas.get(sub_id)
            if sub_area and sub_area.taxonomy_id:
                subtree_topics.add(sub_area.taxonomy_id)

        placeholders_study = ",".join("?" for _ in STUDY_KINDS)
        placeholders_areas = ",".join("?" for _ in subtree_ids)
        cited_material_ids: set[str] = set()
        with self.db.read() as conn:
            if subtree_ids:
                rows = conn.execute(
                    "SELECT DISTINCT ps.material_id FROM explore_area_pages eap "
                    "JOIN pages p ON p.id = eap.page_id "
                    "JOIN page_sources ps ON ps.page_id = p.id "
                    f"WHERE eap.area_id IN ({placeholders_areas}) "
                    f"AND p.kind NOT IN ({placeholders_study})",
                    (*subtree_ids, *STUDY_KINDS),
                ).fetchall()
                cited_material_ids = {str(r["material_id"]) for r in rows}

        matched_ids: list[str] = []
        for mat in self.kb.material_repo.list_all():
            if mat.id in cited_material_ids:
                matched_ids.append(mat.id)
                continue
            mat_topics, mat_areas = _origin_topics_and_areas(mat.origin)
            if (mat_topics & subtree_topics) or (mat_areas & subtree_ids):
                matched_ids.append(mat.id)
        return tuple(matched_ids)

    def pinned(self) -> Sequence[str]:
        with self.db.read() as conn:
            rows = conn.execute(
                "SELECT id FROM explore_areas WHERE pinned = 1 AND hidden = 0 ORDER BY rowid ASC"
            ).fetchall()
        return tuple(str(r["id"]) for r in rows)

    def recently_active(self, limit: int = 10) -> Sequence[str]:
        if limit <= 0:
            return ()
        areas = self.all_area_rows()
        visible_ids = {aid for aid, a in areas.items() if not a.hidden}
        if not visible_ids:
            return ()

        material_to_areas: dict[str, list[str]] = defaultdict(list)
        for aid in visible_ids:
            for mid in self.materials(aid):
                material_to_areas[mid].append(aid)

        ordered: list[str] = []
        seen: set[str] = set()
        with self.db.read() as conn:
            rows = conn.execute(
                "SELECT object_kind, object_id, predicate FROM explore_signals "
                "WHERE (object_kind = 'area' AND predicate IN ('area_opened', 'area_pinned')) "
                "OR (object_kind = 'material' AND predicate = 'read_mark_set') "
                "ORDER BY occurred_at DESC, rowid DESC"
            ).fetchall()

        for row in rows:
            kind = str(row["object_kind"])
            oid = str(row["object_id"])
            candidates = [oid] if kind == "area" else material_to_areas.get(oid, [])
            for aid in candidates:
                if aid in visible_ids and aid not in seen:
                    seen.add(aid)
                    ordered.append(aid)
                    if len(ordered) >= limit:
                        return tuple(ordered)
        return tuple(ordered)

    def read_marks(self, material_ids: Sequence[str]) -> Mapping[str, KbReadMarkValue]:
        if not material_ids:
            return {}
        marks = ",".join("?" for _ in material_ids)
        with self.db.read() as conn:
            rows = conn.execute(
                f"SELECT target_id, value FROM explore_read_marks "
                f"WHERE target_kind = 'material' AND target_id IN ({marks})",
                tuple(material_ids),
            ).fetchall()
        return {str(r["target_id"]): cast(KbReadMarkValue, str(r["value"])) for r in rows}

    # -- Area CRUD & opened --------------------------------------------------

    def create_custom(
        self,
        body: KbAreaCreate,
        *,
        publication_dates: Mapping[str, KbPublicationDate] | None = None,
        new_findings_by_area: Mapping[str, int] | None = None,
    ) -> KbArea:
        """EX2: an own topic by name (a subtopic with ``parent_id``). OpenAlex ``topic_ids`` (the pre-EX2
        custom area) become its hidden label at once; otherwise the label is made in the background."""
        topics = [t.strip() for t in dict.fromkeys(body.topic_ids) if t.strip()]
        if topics:
            if body.parent_id is not None:
                raise ContractFailure(422, "invalid_request")
            area_id = self.topic_store.create_mapped(body.name, topics)
        else:
            area_id = self.topic_store.create(body.name, body.parent_id)
        return self.get_area(
            area_id,
            publication_dates=publication_dates,
            new_findings_by_area=new_findings_by_area,
        )

    def update_area(
        self,
        area_id: str,
        body: KbAreaUpdate,
        *,
        publication_dates: Mapping[str, KbPublicationDate] | None = None,
        new_findings_by_area: Mapping[str, int] | None = None,
    ) -> KbArea:
        current = self.get_area_row(area_id)
        if current.level == "custom" and body.name is not None:
            self.topic_store.rename(area_id, body.name)  # conflicts and the stale hidden label
            current = self.get_area_row(area_id)
        new_name = body.name.strip() if body.name is not None and current.level != "custom" else current.name
        if not new_name:
            raise ContractFailure(422, "invalid_request")
        new_hidden = body.hidden if body.hidden is not None else current.hidden
        new_pinned = body.pinned if body.pinned is not None else current.pinned

        with self.db.write() as conn:
            conn.execute(
                "UPDATE explore_areas SET name = ?, hidden = ?, pinned = ? WHERE id = ?",
                (new_name, int(new_hidden), int(new_pinned), area_id),
            )

        if body.pinned is True and not current.pinned:
            prev_id = self.signals.latest_id_for_object("area", area_id, ("area_pinned",))
            self.signals.record(
                SignalDraft(
                    subject=_LOCAL_USER,
                    predicate="area_pinned",
                    object=KbSignalEntity(kind="area", id=area_id),
                    origin="user_action",
                    value="true",
                    evidence_id=area_id,
                    supersedes_id=prev_id,
                )
            )
        if body.hidden is True and not current.hidden:
            prev_id = self.signals.latest_id_for_object("area", area_id, ("area_hidden",))
            self.signals.record(
                SignalDraft(
                    subject=_LOCAL_USER,
                    predicate="area_hidden",
                    object=KbSignalEntity(kind="area", id=area_id),
                    origin="user_action",
                    value="true",
                    evidence_id=area_id,
                    supersedes_id=prev_id,
                )
            )

        return self.get_area(
            area_id,
            publication_dates=publication_dates,
            new_findings_by_area=new_findings_by_area,
        )

    def delete_area(self, area_id: str) -> KbAcknowledged:
        current = self.get_area_row(area_id)
        if current.level != "custom":
            raise ContractFailure(409, "conflict")
        self.topic_store.delete(area_id)  # its subtopics too; their materials become unsorted
        return KbAcknowledged()

    def record_opened(self, area_id: str) -> KbAcknowledged:
        self.get_area_row(area_id)
        prev_id = self.signals.latest_id_for_object("area", area_id, ("area_opened",))
        self.signals.record(
            SignalDraft(
                subject=_LOCAL_USER,
                predicate="area_opened",
                object=KbSignalEntity(kind="area", id=area_id),
                origin="user_action",
                value=None,
                evidence_id=area_id,
                supersedes_id=prev_id,
            )
        )
        return KbAcknowledged()

    # -- Read marks ----------------------------------------------------------

    def _require_material(self, material_id: str) -> None:
        if self.kb.material_repo.get(material_id) is None:
            raise NotFound("Material not found.")

    def get_material_read_mark(self, material_id: str) -> KbReadMark:
        self._require_material(material_id)
        with self.db.read() as conn:
            row = conn.execute(
                "SELECT value, updated_at FROM explore_read_marks "
                "WHERE target_kind = 'material' AND target_id = ?",
                (material_id,),
            ).fetchone()
        if row is None:
            return KbReadMark(material_id=material_id, finding_id=None, value=None, updated_at=None)
        return KbReadMark.model_validate(
            {
                "material_id": material_id,
                "finding_id": None,
                "value": row["value"],
                "updated_at": row["updated_at"],
            }
        )

    def set_material_read_mark(self, material_id: str, body: KbReadMarkUpdate) -> KbReadMark:
        self._require_material(material_id)
        now = utc_now_ms()
        with self.db.write() as conn:
            conn.execute(
                "INSERT INTO explore_read_marks(target_kind, target_id, value, updated_at) "
                "VALUES ('material', ?, ?, ?) "
                "ON CONFLICT(target_kind, target_id) DO UPDATE SET "
                "value = excluded.value, updated_at = excluded.updated_at",
                (material_id, body.value, now),
            )
        prev_id = self.signals.latest_id_for_object(
            "material", material_id, ("read_mark_set", "read_mark_removed")
        )
        self.signals.record(
            SignalDraft(
                subject=_LOCAL_USER,
                predicate="read_mark_set",
                object=KbSignalEntity(kind="material", id=material_id),
                origin="user_action",
                value=body.value,
                evidence_id=f"read-mark-{material_id}",
                supersedes_id=prev_id,
            )
        )
        return KbReadMark.model_validate(
            {"material_id": material_id, "finding_id": None, "value": body.value, "updated_at": now}
        )

    def remove_material_read_mark(self, material_id: str) -> KbReadMark:
        self._require_material(material_id)
        with self.db.write() as conn:
            existed = conn.execute(
                "SELECT 1 FROM explore_read_marks WHERE target_kind = 'material' AND target_id = ?",
                (material_id,),
            ).fetchone()
            conn.execute(
                "DELETE FROM explore_read_marks WHERE target_kind = 'material' AND target_id = ?",
                (material_id,),
            )
        if existed is not None:
            prev_id = self.signals.latest_id_for_object(
                "material", material_id, ("read_mark_set", "read_mark_removed")
            )
            self.signals.record(
                SignalDraft(
                    subject=_LOCAL_USER,
                    predicate="read_mark_removed",
                    object=KbSignalEntity(kind="material", id=material_id),
                    origin="user_action",
                    value=None,
                    evidence_id=f"read-mark-{material_id}",
                    supersedes_id=prev_id,
                )
            )
        return KbReadMark(material_id=material_id, finding_id=None, value=None, updated_at=None)

    def get_finding_read_mark(self, finding_id: str) -> KbReadMark:
        with self.db.read() as conn:
            row = conn.execute(
                "SELECT value, updated_at FROM explore_read_marks "
                "WHERE target_kind = 'finding' AND target_id = ?",
                (finding_id,),
            ).fetchone()
        if row is None:
            return KbReadMark(material_id=None, finding_id=finding_id, value=None, updated_at=None)
        return KbReadMark.model_validate(
            {
                "material_id": None,
                "finding_id": finding_id,
                "value": row["value"],
                "updated_at": row["updated_at"],
            }
        )

    def set_finding_read_mark(self, finding_id: str, body: KbReadMarkUpdate) -> KbReadMark:
        now = utc_now_ms()
        with self.db.write() as conn:
            conn.execute(
                "INSERT INTO explore_read_marks(target_kind, target_id, value, updated_at) "
                "VALUES ('finding', ?, ?, ?) "
                "ON CONFLICT(target_kind, target_id) DO UPDATE SET "
                "value = excluded.value, updated_at = excluded.updated_at",
                (finding_id, body.value, now),
            )
        prev_id = self.signals.latest_id_for_object(
            "finding", finding_id, ("read_mark_set", "read_mark_removed")
        )
        self.signals.record(
            SignalDraft(
                subject=_LOCAL_USER,
                predicate="read_mark_set",
                object=KbSignalEntity(kind="finding", id=finding_id),
                origin="user_action",
                value=body.value,
                evidence_id=f"read-mark-{finding_id}",
                supersedes_id=prev_id,
            )
        )
        return KbReadMark.model_validate(
            {"material_id": None, "finding_id": finding_id, "value": body.value, "updated_at": now}
        )

    def remove_finding_read_mark(
        self, finding_id: str, *, require_existing_mark: bool = False
    ) -> KbReadMark:
        with self.db.write() as conn:
            existed = conn.execute(
                "SELECT 1 FROM explore_read_marks WHERE target_kind = 'finding' AND target_id = ?",
                (finding_id,),
            ).fetchone()
            if existed is None and require_existing_mark:
                raise NotFound("Finding not found.")
            conn.execute(
                "DELETE FROM explore_read_marks WHERE target_kind = 'finding' AND target_id = ?",
                (finding_id,),
            )
        if existed is not None:
            prev_id = self.signals.latest_id_for_object(
                "finding", finding_id, ("read_mark_set", "read_mark_removed")
            )
            self.signals.record(
                SignalDraft(
                    subject=_LOCAL_USER,
                    predicate="read_mark_removed",
                    object=KbSignalEntity(kind="finding", id=finding_id),
                    origin="user_action",
                    value=None,
                    evidence_id=f"read-mark-{finding_id}",
                    supersedes_id=prev_id,
                )
            )
        return KbReadMark(material_id=None, finding_id=finding_id, value=None, updated_at=None)

    def move_finding_mark_to_material(self, finding_id: str, material_id: str) -> KbReadMark | None:
        """Open question 5: a finding's mark moves to the material it becomes (one mark per material)."""
        self._require_material(material_id)
        with self.db.read() as conn:
            row = conn.execute(
                "SELECT value FROM explore_read_marks "
                "WHERE target_kind = 'finding' AND target_id = ?",
                (finding_id,),
            ).fetchone()
        if row is None:
            return None
        value = cast(KbReadMarkValue, str(row["value"]))
        self.remove_finding_read_mark(finding_id)
        return self.set_material_read_mark(material_id, KbReadMarkUpdate(value=value))

    # -- Map & KbArea construction -------------------------------------------

    def get_area(
        self,
        area_id: str,
        *,
        publication_dates: Mapping[str, KbPublicationDate] | None = None,
        new_findings_by_area: Mapping[str, int] | None = None,
    ) -> KbArea:
        self.get_area_row(area_id)
        built = self._build_all_areas(
            publication_dates=publication_dates or {},
            new_findings_by_area=new_findings_by_area or {},
        )
        return built[0][area_id]

    def build_map(
        self,
        parent_id: str | None = None,
        *,
        include_hidden: bool = False,
        publication_dates: Mapping[str, KbPublicationDate] | None = None,
        new_findings_by_area: Mapping[str, int] | None = None,
        labelling: KbTopicLabelling | None = None,
    ) -> KbAreaMap:
        """EX2: the user's own topics from stored labels (no model, no network). ``parent_id=None`` lists the
        top-level topics; a topic's id lists its subtopics. OpenAlex rows of older builds are off the map."""
        if parent_id is not None:
            self.get_area_row(parent_id)
        areas_by_id, total_pages, total_sources, _subtrees = self._build_all_areas(
            publication_dates=publication_dates or {},
            new_findings_by_area=new_findings_by_area or {},
        )
        rows_by_id = self.all_area_rows()

        breadcrumbs: list[KbArea] = []
        curr = parent_id
        seen: set[str] = set()
        while curr is not None and curr in areas_by_id and curr not in seen:
            seen.add(curr)
            breadcrumbs.append(areas_by_id[curr])
            curr = rows_by_id[curr].parent_id
        breadcrumbs.reverse()

        direct_areas = sorted(
            (
                areas_by_id[row.id]
                for row in rows_by_id.values()
                if row.parent_id == parent_id and row.level == "custom" and (include_hidden or not row.hidden)
            ),
            key=lambda area: (-area.materials, area.name.casefold()),
        )
        return KbAreaMap(
            parent_id=parent_id,
            breadcrumbs=breadcrumbs,
            areas=direct_areas,
            total_pages=total_pages,
            total_sources=total_sources,
            worth_closing=[],  # EX2: removed with the OpenAlex domains map
            unsorted_materials=len(self.topic_store.unsorted_material_ids()),
            labelling=labelling
            or KbTopicLabelling(
                state="not_ready", job_id=None, done=0, total=0, reason_code="not_ready", engine=None
            ),
        )

    def _custom_descendants(self, rows_by_id: Mapping[str, AreaRow]) -> dict[str, set[str]]:
        children: dict[str, list[str]] = defaultdict(list)
        for row in rows_by_id.values():
            if row.parent_id is not None and row.level == "custom":
                children[row.parent_id].append(row.id)
        result: dict[str, set[str]] = {}
        for aid, row in rows_by_id.items():
            if row.level != "custom":
                continue
            found, stack = {aid}, [aid]
            while stack:
                for child in children.get(stack.pop(), ()):
                    if child not in found:
                        found.add(child)
                        stack.append(child)
            result[aid] = found
        return result

    def _build_all_areas(
        self,
        *,
        publication_dates: Mapping[str, KbPublicationDate],
        new_findings_by_area: Mapping[str, int],
    ) -> tuple[dict[str, KbArea], int, int, dict[str, set[str]]]:
        rows_by_id = self.all_area_rows()
        subtrees = self._subtree_map(rows_by_id)
        own_subtrees = self._custom_descendants(rows_by_id)
        direct_topics = self._topics_by_area(rows_by_id)
        stored_children_totals = self._children_totals()
        labels = self.topic_store.labels()
        labelled: dict[str, set[str]] = defaultdict(set)
        for mid, (aid, _origin) in labels.items():
            labelled[aid].add(mid)

        placeholders_study = ",".join("?" for _ in STUDY_KINDS)
        with self.db.read() as conn:
            total_pages = int(
                conn.execute(
                    f"SELECT COUNT(*) FROM pages WHERE kind NOT IN ({placeholders_study})",
                    tuple(STUDY_KINDS),
                ).fetchone()[0]
            )
            # Material -> the wiki pages citing it (a page belongs to the topics of its materials).
            material_pages: dict[str, set[str]] = defaultdict(set)
            #: EX3 (UX-13): the map's tile size — concept pages only (a note per material would skew it).
            material_concepts: dict[str, set[str]] = defaultdict(set)
            for row in conn.execute(
                "SELECT ps.page_id, ps.material_id, p.kind FROM page_sources ps "
                "JOIN pages p ON p.id = ps.page_id "
                "JOIN materials m ON m.id = ps.material_id "
                f"WHERE p.kind NOT IN ({placeholders_study})",
                tuple(STUDY_KINDS),
            ):
                material_pages[str(row["material_id"])].add(str(row["page_id"]))
                if row["kind"] == "concept":
                    material_concepts[str(row["material_id"])].add(str(row["page_id"]))
            wiki_materials = set(material_pages)

            # Origins only for OpenAlex rows of builds before EX2 (never on the map).
            all_materials: dict[str, tuple[set[str], set[str]]] = {}
            if any(row.level != "custom" for row in rows_by_id.values()):
                for row in conn.execute("SELECT id, origin FROM materials"):
                    origin_obj = json.loads(row["origin"]) if row["origin"] else None
                    all_materials[str(row["id"])] = _origin_topics_and_areas(origin_obj)

            marked_material_set: set[str] = {
                str(r["target_id"])
                for r in conn.execute(
                    "SELECT target_id FROM explore_read_marks WHERE target_kind = 'material'"
                )
            }
            area_signal_time: dict[str, str] = {}
            material_signal_time: dict[str, str] = {}
            for row in conn.execute(
                "SELECT object_kind, object_id, MAX(occurred_at) AS latest FROM explore_signals "
                "WHERE (object_kind = 'area' AND predicate IN ('area_opened', 'area_pinned')) "
                "OR (object_kind = 'material' AND predicate = 'read_mark_set') "
                "GROUP BY object_kind, object_id"
            ):
                if row["object_kind"] == "area":
                    area_signal_time[str(row["object_id"])] = str(row["latest"])
                elif row["object_kind"] == "material":
                    material_signal_time[str(row["object_id"])] = str(row["latest"])

        materials_by_area: dict[str, set[str]] = {}
        scope_by_area: dict[str, set[str]] = {}
        for aid, row in rows_by_id.items():
            if row.level == "custom":
                sub_ids = own_subtrees.get(aid, {aid})
                mset = set().union(*(labelled.get(sid, set()) for sid in sub_ids))
            else:
                sub_ids = subtrees.get(aid, {aid})
                sub_topics: set[str] = set()
                for sid in sub_ids:
                    sub_topics.update(direct_topics.get(sid, ()))
                    srow = rows_by_id.get(sid)
                    if srow and srow.taxonomy_id:
                        sub_topics.add(srow.taxonomy_id)
                mset = {
                    mid
                    for mid, (m_topics, m_areas) in all_materials.items()
                    if (m_topics & sub_topics) or (m_areas & sub_ids)
                }
            materials_by_area[aid] = mset
            scope_by_area[aid] = sub_ids

        direct_children: dict[str | None, list[AreaRow]] = defaultdict(list)
        for row in rows_by_id.values():
            direct_children[row.parent_id].append(row)

        built: dict[str, KbArea] = {}
        total_wiki = len(wiki_materials)
        for aid, row in rows_by_id.items():
            sub_ids = scope_by_area[aid]
            mset = materials_by_area[aid]
            in_wiki = mset & wiki_materials
            pset: set[str] = set().union(*(material_pages.get(mid, set()) for mid in mset))
            page_count = len(pset)
            concept_count = len(set().union(*(material_concepts.get(mid, set()) for mid in mset)))
            years = [
                yr
                for mid in mset
                if mid in publication_dates and (yr := publication_dates[mid].year) is not None
            ]
            activity = [area_signal_time[sid] for sid in sub_ids if sid in area_signal_time] + [
                material_signal_time[mid] for mid in mset if mid in material_signal_time
            ]
            latest_activity = max(activity) if activity else None
            depth: Literal["empty", "thin", "medium", "dense"] = (
                "empty" if page_count == 0 else "thin" if page_count < 10 else "medium" if page_count < 40
                else "dense"
            )
            if row.level == "custom":
                visible_children = [c for c in direct_children.get(aid, []) if not c.hidden]
                has_children = bool(visible_children)
                children_covered = sum(1 for c in visible_children if materials_by_area.get(c.id))
                children_total = len(visible_children)
                topic_list: list[str] = []  # the hidden OpenAlex label never leaves the backend
            elif row.level == "topic":
                has_children, children_covered, children_total = False, 0, 0
                topic_list = list(direct_topics.get(aid, []))
            else:
                has_children = True
                visible_children = [c for c in direct_children.get(aid, []) if not c.hidden]
                children_covered = sum(1 for c in visible_children if materials_by_area.get(c.id))
                children_total = max(stored_children_totals.get(aid, 0), len(visible_children))
                topic_list = []
            built[aid] = KbArea.model_validate(
                {
                    "id": aid,
                    "parent_id": row.parent_id,
                    "taxonomy_id": row.taxonomy_id,
                    "level": row.level,
                    "name": row.name,
                    "original_name": row.original_name,
                    "hidden": row.hidden,
                    "pinned": row.pinned,
                    "topic_ids": topic_list,
                    "has_children": has_children,
                    "children_covered": children_covered,
                    "children_total": children_total,
                    "pages": page_count,
                    "concepts": concept_count,
                    "sources": len(mset),
                    "newest_source_year": max(years) if years else None,
                    "recent_activity_at": (
                        datetime.fromisoformat(latest_activity) if latest_activity else None
                    ),
                    "new_findings": sum(new_findings_by_area.get(sid, 0) for sid in sub_ids),
                    "marked_materials": len(mset & marked_material_set),
                    "materials": len(in_wiki),
                    "wiki_share": round(min(1.0, len(in_wiki) / total_wiki), 4) if total_wiki else 0.0,
                    "depth": depth,
                    "gap_reason": None,
                }
            )
        return built, total_pages, total_wiki, subtrees
