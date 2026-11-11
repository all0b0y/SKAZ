"""Areas and read-marks persistence and ``AreaDirectory`` implementation (B4)."""

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
)
from ..api.schemas_explore_common import KbAcknowledged, KbPublicationDate, KbReadMarkValue
from ..errors import NotFound
from ..ids import new_id, utc_now_ms
from ..library.layout import STUDY_KINDS
from ..service import KnowledgeService
from .protocols import SignalDraft
from .signals import SignalStore

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
                collected: set[str] = {area_id}
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
        if not topic_ids:
            return None
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
        direct = self._topics_by_area(areas)
        if area.level in ("topic", "custom"):
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

    def materials(self, area_id: str) -> Sequence[str]:
        areas = self.all_area_rows()
        if area_id not in areas:
            return ()
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
        name = body.name.strip()
        topics = [t.strip() for t in dict.fromkeys(body.topic_ids) if t.strip()]
        if not name or not topics:
            raise ContractFailure(422, "invalid_request")
        area_id = new_id("area")
        with self.db.write() as conn:
            conn.execute(
                "INSERT INTO explore_areas("
                "id, parent_id, taxonomy_id, level, original_name, name, hidden, pinned"
                ") VALUES (?, NULL, NULL, 'custom', ?, ?, 0, 0)",
                (area_id, name, name),
            )
            for tid in topics:
                conn.execute(
                    "INSERT OR IGNORE INTO explore_area_topics(area_id, topic_id) VALUES (?, ?)",
                    (area_id, tid),
                )
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
        new_name = body.name.strip() if body.name is not None else current.name
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
        with self.db.write() as conn:
            conn.execute("DELETE FROM explore_areas WHERE id = ?", (area_id,))
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
    ) -> KbAreaMap:
        if parent_id is not None:
            self.get_area_row(parent_id)
        areas_by_id, total_pages, total_sources, subtrees = self._build_all_areas(
            publication_dates=publication_dates or {},
            new_findings_by_area=new_findings_by_area or {},
        )
        rows_by_id = self.all_area_rows()

        # Breadcrumbs from root down to parent_id
        breadcrumbs: list[KbArea] = []
        curr = parent_id
        seen: set[str] = set()
        while curr is not None and curr in areas_by_id and curr not in seen:
            seen.add(curr)
            breadcrumbs.append(areas_by_id[curr])
            curr = rows_by_id[curr].parent_id
        breadcrumbs.reverse()

        # Direct children of parent_id
        direct_areas = [
            areas_by_id[row.id]
            for row in rows_by_id.values()
            if row.parent_id == parent_id and (include_hidden or not row.hidden)
        ]

        # Worth closing: gaps and thin areas anywhere below parent_id
        if parent_id is None:
            candidate_ids = [
                rid for rid, r in rows_by_id.items() if not r.hidden and r.level != "custom"
            ]
        else:
            subtree = subtrees.get(parent_id, {parent_id}) - {parent_id}
            candidate_ids = [
                rid
                for rid in rows_by_id
                if rid in subtree and not rows_by_id[rid].hidden and rows_by_id[rid].level != "custom"
            ]

        gap_areas = [
            areas_by_id[rid]
            for rid in candidate_ids
            if areas_by_id[rid].gap_reason is not None
        ]
        # Prefer deepest gap areas so an ancestor doesn't shadow its specific topic gap
        gap_id_set = {a.id for a in gap_areas}
        filtered_gaps = [
            a
            for a in gap_areas
            if not any(
                other_id != a.id and other_id in subtrees.get(a.id, set())
                for other_id in gap_id_set
            )
        ]
        filtered_gaps.sort(key=lambda a: (0 if a.pages == 0 else 1, a.pages))

        return KbAreaMap(
            parent_id=parent_id,
            breadcrumbs=breadcrumbs,
            areas=direct_areas,
            total_pages=total_pages,
            total_sources=total_sources,
            worth_closing=filtered_gaps,
        )

    def _build_all_areas(
        self,
        *,
        publication_dates: Mapping[str, KbPublicationDate],
        new_findings_by_area: Mapping[str, int],
    ) -> tuple[dict[str, KbArea], int, int, dict[str, set[str]]]:
        rows_by_id = self.all_area_rows()
        subtrees = self._subtree_map(rows_by_id)
        direct_topics = self._topics_by_area(rows_by_id)
        stored_children_totals = self._children_totals()

        placeholders_study = ",".join("?" for _ in STUDY_KINDS)
        with self.db.read() as conn:
            total_pages = int(
                conn.execute(
                    f"SELECT COUNT(*) FROM pages WHERE kind NOT IN ({placeholders_study})",
                    tuple(STUDY_KINDS),
                ).fetchone()[0]
            )
            total_sources = int(conn.execute("SELECT COUNT(*) FROM materials").fetchone()[0])

            # Wiki pages per direct area_id
            area_direct_pages: dict[str, set[str]] = defaultdict(set)
            for row in conn.execute(
                "SELECT eap.area_id, eap.page_id FROM explore_area_pages eap "
                "JOIN pages p ON p.id = eap.page_id "
                f"WHERE p.kind NOT IN ({placeholders_study})",
                tuple(STUDY_KINDS),
            ):
                area_direct_pages[str(row["area_id"])].add(str(row["page_id"]))

            # Page -> cited material_ids
            page_materials: dict[str, set[str]] = defaultdict(set)
            for row in conn.execute(
                "SELECT ps.page_id, ps.material_id FROM page_sources ps "
                "JOIN pages p ON p.id = ps.page_id "
                "JOIN materials m ON m.id = ps.material_id "
                f"WHERE p.kind NOT IN ({placeholders_study})",
                tuple(STUDY_KINDS),
            ):
                page_materials[str(row["page_id"])].add(str(row["material_id"]))

            # Materials and their origin topics/areas
            all_materials: dict[str, tuple[set[str], set[str]]] = {}
            for row in conn.execute("SELECT id, origin FROM materials"):
                mid = str(row["id"])
                origin_obj = json.loads(row["origin"]) if row["origin"] else None
                all_materials[mid] = _origin_topics_and_areas(origin_obj)

            # Also count wiki pages whose cited materials carry a topic in an area
            topic_to_area_ids: dict[str, set[str]] = defaultdict(set)
            for aid, area_row in rows_by_id.items():
                if area_row.taxonomy_id:
                    topic_to_area_ids[area_row.taxonomy_id].add(aid)
                for tid in direct_topics.get(aid, ()):
                    topic_to_area_ids[tid].add(aid)
            for pid, mids in page_materials.items():
                for mid in mids:
                    m_topics, m_areas = all_materials.get(mid, (set(), set()))
                    for tid in m_topics:
                        for aid in topic_to_area_ids.get(tid, ()):
                            area_direct_pages[aid].add(pid)
                    for aid in m_areas:
                        if aid in rows_by_id:
                            area_direct_pages[aid].add(pid)

            # Read marks on materials
            marked_material_set: set[str] = {
                str(r["target_id"])
                for r in conn.execute(
                    "SELECT target_id FROM explore_read_marks WHERE target_kind = 'material'"
                )
            }

            # Latest activity per area and per material
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

        # Compute pages and materials sets per area (subtree-aggregated)
        pages_by_area: dict[str, set[str]] = {}
        materials_by_area: dict[str, set[str]] = {}
        for aid in rows_by_id:
            sub_ids = subtrees.get(aid, {aid})
            pset: set[str] = set()
            sub_topics: set[str] = set()
            for sid in sub_ids:
                pset.update(area_direct_pages.get(sid, set()))
                sub_topics.update(direct_topics.get(sid, ()))
                srow = rows_by_id.get(sid)
                if srow and srow.taxonomy_id:
                    sub_topics.add(srow.taxonomy_id)
            pages_by_area[aid] = pset

            mset: set[str] = set()
            for pid in pset:
                mset.update(page_materials.get(pid, set()))
            for mid, (m_topics, m_areas) in all_materials.items():
                if (m_topics & sub_topics) or (m_areas & sub_ids):
                    mset.add(mid)
            materials_by_area[aid] = mset

        # Direct children map
        direct_children: dict[str | None, list[AreaRow]] = defaultdict(list)
        for row in rows_by_id.values():
            direct_children[row.parent_id].append(row)

        # First pass metrics
        partial: dict[str, dict[str, Any]] = {}
        for aid, row in rows_by_id.items():
            sub_ids = subtrees.get(aid, {aid})
            pset = pages_by_area[aid]
            mset = materials_by_area[aid]
            page_count = len(pset)
            source_count = len(mset)

            years: list[int] = [
                yr
                for mid in mset
                if mid in publication_dates and (yr := publication_dates[mid].year) is not None
            ]
            newest_year = max(years) if years else None

            activity_candidates: list[str] = [
                area_signal_time[sid] for sid in sub_ids if sid in area_signal_time
            ] + [
                material_signal_time[mid] for mid in mset if mid in material_signal_time
            ]
            latest_activity_str = max(activity_candidates) if activity_candidates else None

            findings_count = sum(new_findings_by_area.get(sid, 0) for sid in sub_ids)
            marked_count = len(mset & marked_material_set)
            wiki_share = (
                round(min(1.0, max(0.0, page_count / total_pages)), 4)
                if total_pages > 0
                else 0.0
            )
            depth: Literal["empty", "thin", "medium", "dense"] = (
                "empty"
                if page_count == 0
                else "thin"
                if page_count < 10
                else "medium"
                if page_count < 40
                else "dense"
            )

            if row.level in ("topic", "custom"):
                has_children = False
                children_covered = 0
                children_total = 0
            else:
                has_children = True
                visible_children = [c for c in direct_children.get(aid, []) if not c.hidden]
                children_covered = sum(
                    1 for c in visible_children if len(pages_by_area.get(c.id, set())) > 0
                )
                children_total = max(
                    stored_children_totals.get(aid, 0),
                    len(visible_children),
                )

            topic_list = (
                list(direct_topics.get(aid, []))
                if row.level in ("topic", "custom")
                else []
            )

            partial[aid] = {
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
                "sources": source_count,
                "newest_source_year": newest_year,
                "recent_activity_at": (
                    datetime.fromisoformat(latest_activity_str) if latest_activity_str else None
                ),
                "new_findings": findings_count,
                "marked_materials": marked_count,
                "wiki_share": wiki_share,
                "depth": depth,
                "gap_reason": None,
            }

        # Second pass: gap_reason using sibling coverage
        for aid, row in rows_by_id.items():
            info = partial[aid]
            if row.level == "custom" or row.hidden:
                continue
            siblings = [
                c
                for c in direct_children.get(row.parent_id, [])
                if c.id != aid and not c.hidden and c.level != "custom"
            ]
            covered_siblings = [
                c for c in siblings if partial[c.id]["pages"] > 0
            ]
            if info["depth"] == "empty":
                if covered_siblings:
                    best = max(covered_siblings, key=lambda c: int(partial[c.id]["pages"]))
                    info["gap_reason"] = f"Next to {best.name} · no pages yet"
            elif info["depth"] == "thin" and (info["pages"] <= 4 or info["sources"] <= 1):
                srcs = int(info["sources"])
                src_word = "source" if srcs == 1 else "sources"
                yr = info["newest_source_year"]
                yr_suffix = f", {yr}" if yr is not None else ""
                info["gap_reason"] = f"thin · {srcs} {src_word}{yr_suffix}"

        built = {aid: KbArea.model_validate(data) for aid, data in partial.items()}
        return built, total_pages, total_sources, subtrees
