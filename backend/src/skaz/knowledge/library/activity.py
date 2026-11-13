"""E4 usage and atomic creation of a topic with its first material (local only)."""
from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta

from ..api.contract_routes import ContractFailure
from ..api.schemas_areas import KbMaterialTopic
from ..api.schemas_material_activity import KbMaterialTopicCreate, KbUnusedExploreMaterials
from ..areas.topics import clean_name, name_key
from ..errors import NotFound
from ..ids import new_id
from ..service import KnowledgeService
from .library import EXPLORE_FOLDER_ID


def _date(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


class MaterialActivity:
    def __init__(self, kb: KnowledgeService, *, clock: Callable[[], datetime] | None = None) -> None:
        self.kb = kb
        self.clock = clock or (lambda: datetime.now(UTC))

    def _library_id(self) -> str:
        if self.kb.view().state != "ready":
            raise ContractFailure(503, "not_ready")
        return self.kb.require().library_id

    def unused(self) -> KbUnusedExploreMaterials:
        with self.kb.writing():
            library_id = self._library_id()
            now = self.clock()
            cutoff = now - timedelta(days=30)
            with self.kb.db.read() as conn:
                rows = conn.execute(
                    "SELECT m.id, m.created_at, a.opened_at, a.keep_until FROM materials m "
                    "LEFT JOIN material_activity a ON a.material_id=m.id AND a.library_id=? "
                    "WHERE m.folder_id=? AND m.status='ready' "
                    "AND NOT EXISTS (SELECT 1 FROM page_sources ps WHERE ps.material_id=m.id) "
                    "AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.target_id=m.id "
                    "AND j.state IN ('queued','running','paused')) ORDER BY m.id",
                    (library_id, EXPLORE_FOLDER_ID),
                ).fetchall()
            ids: list[str] = []
            for row in rows:
                try:
                    if (_date(row['created_at']) <= cutoff
                            and (not row['opened_at'] or _date(row['opened_at']) <= cutoff)
                            and (not row['keep_until'] or _date(row['keep_until']) <= now)):
                        ids.append(row['id'])
                except ValueError:
                    continue  # An invalid historical date is never evidence for removing a paper.
            return KbUnusedExploreMaterials(material_ids=ids)

    def opened(self, material_id: str) -> None:
        with self.kb.writing():
            library_id = self._library_id()
            if self.kb.material_repo.get(material_id) is None:
                raise NotFound("Material not found.")
            with self.kb.db.write() as conn:
                conn.execute(
                    "INSERT INTO material_activity(library_id,material_id,opened_at) VALUES (?,?,?) "
                    "ON CONFLICT(library_id,material_id) DO UPDATE SET opened_at=excluded.opened_at",
                    (library_id, material_id, self.clock().isoformat()),
                )

    def keep(self, material_ids: Sequence[str]) -> None:
        with self.kb.writing():
            library_id = self._library_id()
            eligible = set(self.unused().material_ids)
            until = (self.clock() + timedelta(days=30)).isoformat()
            with self.kb.db.write() as conn:
                conn.executemany(
                    "INSERT INTO material_activity(library_id,material_id,keep_until) VALUES (?,?,?) "
                    "ON CONFLICT(library_id,material_id) DO UPDATE SET keep_until=excluded.keep_until",
                    [(library_id, mid, until) for mid in set(material_ids) & eligible],
                )

    def new_topic(self, material_id: str, body: KbMaterialTopicCreate) -> KbMaterialTopic:
        with self.kb.writing():
            self._library_id()
            cleaned = clean_name(body.name)
            if not cleaned:
                raise ContractFailure(422, "invalid_request")
            with self.kb.db.write() as conn:
                if conn.execute("SELECT 1 FROM materials WHERE id=?", (material_id,)).fetchone() is None:
                    raise NotFound("Material not found.")
                if body.parent_id is not None:
                    parent = conn.execute(
                        "SELECT parent_id FROM explore_areas WHERE id=? AND level='custom'",
                        (body.parent_id,),
                    ).fetchone()
                    if parent is None:
                        raise NotFound("Topic not found.")
                    if parent[0] is not None:
                        raise ContractFailure(422, "invalid_request")
                siblings = conn.execute(
                    "SELECT name FROM explore_areas WHERE level='custom' AND parent_id IS ?",
                    (body.parent_id,),
                ).fetchall()
                if any(name_key(row[0]) == name_key(cleaned) for row in siblings):
                    raise ContractFailure(409, "conflict")
                tid = new_id("topic")
                conn.execute(
                    "INSERT INTO explore_areas(id,parent_id,taxonomy_id,level,original_name,name,"
                    "hidden,pinned,mapping_state,mapped_name) VALUES (?, ?, NULL, 'custom', ?, ?,"
                    "0, 0, 'pending', NULL)", (tid, body.parent_id, cleaned, cleaned),
                )
                conn.execute(
                    "INSERT INTO explore_area_materials(material_id,area_id,origin,labelled_at) "
                    "VALUES (?,?,'user',?) ON CONFLICT(material_id) DO UPDATE SET "
                    "area_id=excluded.area_id,origin='user',labelled_at=excluded.labelled_at",
                    (material_id, tid, self.clock().isoformat()),
                )
            return KbMaterialTopic(material_id=material_id, area_id=tid, origin="user")
