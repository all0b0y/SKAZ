"""Local search plans over stored own topics. Building a preview never runs a model or a provider."""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence

from ..api.contract_routes import ContractFailure
from ..api.schemas_explore import KbSearchPlan, KbSearchPlanItem, KbSearchPlanRequest
from ..areas.mapping import _term as clean_term
from ..errors import NotFound
from ..store.database import KnowledgeDatabase

PLAN_LIMIT = 8
TERM_LIMIT = 6
TERM_CHARS = 72


def terms_of(values: Sequence[str]) -> list[str]:
    """Canonical, bounded topic words, retaining their order (never material or chat bodies)."""
    cleaned = [clean_term(value)[:TERM_CHARS] for value in values if value.strip()]
    seen: set[str] = set()
    result: list[str] = []
    for item in cleaned:
        if item and item.casefold() not in seen:
            seen.add(item.casefold())
            result.append(item)
    return result


class SearchPlanner:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    def scope(self, area_id: str) -> list[str]:
        with self.db.read() as db:
            rows = db.execute(
                "WITH RECURSIVE scope(id) AS ("
                " SELECT id FROM explore_areas WHERE id=? AND level='custom'"
                " UNION SELECT a.id FROM explore_areas a JOIN scope s ON a.parent_id=s.id"
                " WHERE a.level='custom') SELECT id FROM scope",
                (area_id,),
            ).fetchall()
        if not rows:
            raise NotFound("This topic wasn't found.")
        return [str(row[0]) for row in rows]

    def materials(self, area_ids: Sequence[str]) -> list[str]:
        scope = list(dict.fromkeys(sid for aid in area_ids for sid in self.scope(aid)))
        if not scope:
            return []
        marks = ",".join("?" for _ in scope)
        with self.db.read() as db:
            rows = db.execute(
                "SELECT am.material_id FROM explore_area_materials am JOIN materials m ON m.id=am.material_id"
                f" WHERE am.area_id IN ({marks}) ORDER BY m.created_at DESC,m.id DESC",
                scope,
            ).fetchall()
        return [str(r[0]) for r in rows]

    def name(self, area_id: str) -> str:
        self.scope(area_id)
        with self.db.read() as db:
            return str(db.execute("SELECT name FROM explore_areas WHERE id=?", (area_id,)).fetchone()[0])

    def hidden_ids(self, area_id: str) -> list[str]:
        # A rename invalidates the old mapping immediately. Pending/no-match never use old labels.
        self.scope(area_id)
        with self.db.read() as db:
            rows = db.execute(
                "SELECT t.topic_id FROM explore_area_topics t JOIN explore_areas a ON a.id=t.area_id"
                " WHERE a.id=? AND a.mapping_state='mapped' AND a.mapped_name=a.name ORDER BY t.topic_id",
                (area_id,),
            ).fetchall()
        return [str(row[0]) for row in rows][:3]

    def _terms(self, area_id: str) -> list[str]:
        scope = self.scope(area_id)
        marks = ",".join("?" for _ in scope)
        with self.db.read() as db:
            rows = db.execute(
                "SELECT p.title, count(DISTINCT am.material_id) AS n FROM explore_area_materials am"
                " JOIN materials m ON m.id=am.material_id JOIN page_sources ps ON ps.material_id=m.id"
                " JOIN pages p ON p.id=ps.page_id"
                f" WHERE am.area_id IN ({marks}) AND p.kind='concept'"
                " GROUP BY p.title ORDER BY n DESC, p.title COLLATE NOCASE LIMIT 12",
                scope,
            ).fetchall()
        return terms_of([self.name(area_id)[:TERM_CHARS], *[str(r[0])[:TERM_CHARS] for r in rows]])[
            :TERM_LIMIT
        ]

    def _largest(self) -> list[str]:
        with self.db.read() as db:
            rows = db.execute(
                "SELECT id,parent_id,name,hidden FROM explore_areas WHERE level='custom'"
            ).fetchall()
            assigned = db.execute(
                "SELECT am.area_id, count(*) FROM explore_area_materials am"
                " JOIN materials m ON m.id=am.material_id GROUP BY am.area_id"
            ).fetchall()
        parents = {str(r["id"]): r["parent_id"] for r in rows}
        counts: Counter[str] = Counter()
        for aid, count in assigned:
            seen: set[str] = set()
            while aid in parents and aid not in seen:
                seen.add(aid)
                counts[aid] += count
                aid = parents[aid]
        roots = [r for r in rows if r["parent_id"] is None and not r["hidden"] and counts[r["id"]] > 0]
        roots.sort(key=lambda r: (-counts[r["id"]], str(r["name"]).casefold(), str(r["id"])))
        return [str(r["id"]) for r in roots[:PLAN_LIMIT]]

    def build(self, body: KbSearchPlanRequest) -> KbSearchPlan:
        query = body.query.strip()
        # This is a local preview; the background query agent derives the actual outbound keywords.
        term = query
        if len(term) > TERM_CHARS:
            term = term[:TERM_CHARS].rsplit(" ", 1)[0] or term[:TERM_CHARS]
        if body.area_id:
            chosen = [body.area_id]
        elif query:
            chosen = []  # typed text is a precise query, even with the All your topics default selected
        elif body.all_topics:
            chosen = self._largest()
        else:
            chosen = []
        items = [
            KbSearchPlanItem(area_id=aid, label=self.name(aid), terms=[term] if query else self._terms(aid))
            for aid in chosen
        ]
        if query and not chosen:
            items = [KbSearchPlanItem(area_id=None, label=query, terms=[term])]
        return KbSearchPlan(
            items=items, ready=bool(items), reason=None if items else "Choose a topic or type a query."
        )

    def validate(self, items: Sequence[KbSearchPlanItem]) -> list[KbSearchPlanItem]:
        if not items or len(items) > PLAN_LIMIT:
            raise ContractFailure(422, "invalid_request")
        result = []
        for item in items:
            terms = terms_of(item.terms)
            if not terms:
                raise ContractFailure(422, "invalid_request")
            if item.area_id:
                self.scope(item.area_id)
            result.append(item.model_copy(update={"terms": terms}))
        return result
