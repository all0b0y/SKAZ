"""EX2: the user's own two-level topics and the topic of each wiki material (blocking; ``disk_call``).

A topic is an ``explore_areas`` row with ``level='custom'``; a subtopic has the topic as ``parent_id``. A
wiki material has at most one topic (``explore_area_materials``): the wiki agent's label (``agent``) or the
user's move (``user``, which an agent label never overwrites). A page belongs to the topics of the materials
it cites. Each topic carries a hidden OpenAlex label (``explore_area_topics`` + ``mapping_state`` /
``mapped_name``) that never leaves the backend; a rename or merge sets it back to ``pending``.
"""

from __future__ import annotations

import re
import sqlite3
import unicodedata
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from ..api.contract_routes import ContractFailure
from ..api.schemas_areas import KbMaterialTopic
from ..errors import NotFound
from ..ids import new_id, utc_now_ms
from ..library.layout import STUDY_KINDS
from ..service import KnowledgeService

#: Topic names the agent writes are cut here (a tile title, and a search term of at most 72 characters).
MAX_TOPIC_NAME = 60
MappingState = Literal["pending", "mapped", "no_match"]
Origin = Literal["agent", "user"]
_SPACES = re.compile(r"\s+")
_STRIP = " \t\"'`«»“”‘’.,;:!?·•-–—›>/\\|*_#"


def clean_name(raw: str) -> str:
    """A topic name as stored: one line, no control characters, no wrapping quotes or path marks."""
    text = "".join(" " if unicodedata.category(char)[0] == "C" else char for char in raw)
    text = _SPACES.sub(" ", text).strip(_STRIP).strip()
    if len(text) > MAX_TOPIC_NAME:
        text = text[:MAX_TOPIC_NAME].rsplit(" ", 1)[0].strip(_STRIP) or text[:MAX_TOPIC_NAME]
    return text


def name_key(name: str) -> str:
    return clean_name(name).casefold()


@dataclass(frozen=True)
class OwnTopic:
    id: str
    parent_id: str | None
    name: str
    hidden: bool
    pinned: bool
    mapping_state: MappingState
    mapped_name: str | None

    @property
    def mapping_current(self) -> bool:
        """The hidden label was made for the topic's present name (a rename makes it stale)."""
        return self.mapping_state != "pending" and self.mapped_name == self.name


def _topic(row: sqlite3.Row) -> OwnTopic:
    return OwnTopic(
        id=str(row["id"]),
        parent_id=str(row["parent_id"]) if row["parent_id"] is not None else None,
        name=str(row["name"]),
        hidden=bool(row["hidden"]),
        pinned=bool(row["pinned"]),
        mapping_state=row["mapping_state"],
        mapped_name=row["mapped_name"],
    )


_STUDY = ",".join("?" for _ in STUDY_KINDS)
#: Materials that are in the wiki: cited by a page that is not a study page (decks, tests).
_WIKI_MATERIALS = (
    "SELECT DISTINCT ps.material_id AS material_id FROM page_sources ps "
    "JOIN pages p ON p.id = ps.page_id JOIN materials m ON m.id = ps.material_id "
    f"WHERE p.kind NOT IN ({_STUDY})"
)


class TopicStore:
    def __init__(self, kb: KnowledgeService) -> None:
        self.kb = kb
        self.db = kb.db

    # -- topics -----------------------------------------------------------------

    def topics(self, *, include_hidden: bool = True) -> list[OwnTopic]:
        sql = "SELECT * FROM explore_areas WHERE level = 'custom'"
        if not include_hidden:
            sql += " AND hidden = 0"
        with self.db.read() as conn:
            rows = conn.execute(sql + " ORDER BY rowid ASC").fetchall()
        return [_topic(row) for row in rows]

    def topic(self, area_id: str) -> OwnTopic:
        with self.db.read() as conn:
            row = conn.execute(
                "SELECT * FROM explore_areas WHERE id = ? AND level = 'custom'", (area_id,)
            ).fetchone()
        if row is None:
            with self.db.read() as conn:
                exists = conn.execute("SELECT 1 FROM explore_areas WHERE id = ?", (area_id,)).fetchone()
            if exists is not None:
                raise ContractFailure(409, "conflict")  # an OpenAlex area of a build before EX2
            raise NotFound("Topic not found.")
        return _topic(row)

    def paths(self) -> list[tuple[str, str | None]]:
        """Existing visible paths for the labelling prompt: each topic, then each of its subtopics."""
        topics = self.topics(include_hidden=False)
        by_id = {topic.id: topic for topic in topics}
        paths: list[tuple[str, str | None]] = []
        for topic in topics:
            if topic.parent_id is None:
                paths.append((topic.name, None))
        for topic in topics:
            parent = by_id.get(topic.parent_id) if topic.parent_id else None
            if parent is not None:
                paths.append((parent.name, topic.name))
        return sorted(paths, key=lambda path: (path[0].casefold(), (path[1] or "").casefold()))

    def _find(self, conn: sqlite3.Connection, name: str, parent_id: str | None) -> str | None:
        key = name_key(name)
        if parent_id is None:
            rows = conn.execute(
                "SELECT id, name FROM explore_areas WHERE level = 'custom' AND parent_id IS NULL "
                "ORDER BY rowid"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, name FROM explore_areas WHERE level = 'custom' AND parent_id = ? ORDER BY rowid",
                (parent_id,),
            ).fetchall()
        return next((str(row["id"]) for row in rows if name_key(str(row["name"])) == key), None)

    @staticmethod
    def _insert(conn: sqlite3.Connection, name: str, parent_id: str | None) -> str:
        topic_id = new_id("topic")
        conn.execute(
            "INSERT INTO explore_areas(id, parent_id, taxonomy_id, level, original_name, name, hidden,"
            " pinned, mapping_state, mapped_name)"
            " VALUES (?, ?, NULL, 'custom', ?, ?, 0, 0, 'pending', NULL)",
            (topic_id, parent_id, name, name),
        )
        return topic_id

    def ensure_path(self, topic: str, subtopic: str | None) -> tuple[str, list[str]]:
        """The id of ``topic › subtopic`` (names matched case-insensitively), creating what is missing.
        Returns ``(leaf id, ids of the topics created)``; an unusable name raises ``ValueError``."""
        top_name = clean_name(topic)
        sub_name = clean_name(subtopic) if subtopic else ""
        if not top_name:
            raise ValueError("empty topic")
        created: list[str] = []
        with self.db.write() as conn:
            top_id = self._find(conn, top_name, None)
            if top_id is None:
                top_id = self._insert(conn, top_name, None)
                created.append(top_id)
            if not sub_name or name_key(sub_name) == name_key(top_name):
                return top_id, created
            sub_id = self._find(conn, sub_name, top_id)
            if sub_id is None:
                sub_id = self._insert(conn, sub_name, top_id)
                created.append(sub_id)
            return sub_id, created

    def create(self, name: str, parent_id: str | None) -> str:
        cleaned = clean_name(name)
        if not cleaned:
            raise ContractFailure(422, "invalid_request")
        if parent_id is not None and self.topic(parent_id).parent_id is not None:
            raise ContractFailure(422, "invalid_request")  # two levels: topic › subtopic
        with self.db.write() as conn:
            if self._find(conn, cleaned, parent_id) is not None:
                raise ContractFailure(409, "conflict")
            return self._insert(conn, cleaned, parent_id)

    def create_mapped(self, name: str, topic_ids: Sequence[str]) -> str:
        """A topic made from OpenAlex topics (the pre-EX2 custom area): its label is those ids."""
        topic_id = self.create(name, None)
        self.store_mapping(topic_id, clean_name(name), topic_ids)
        return topic_id

    def rename(self, area_id: str, name: str) -> bool:
        """Returns whether the name changed (the hidden label is then made again)."""
        current = self.topic(area_id)
        cleaned = clean_name(name)
        if not cleaned:
            raise ContractFailure(422, "invalid_request")
        if cleaned == current.name:
            return False
        with self.db.write() as conn:
            other = self._find(conn, cleaned, current.parent_id)
            if other is not None and other != area_id:
                raise ContractFailure(409, "conflict")  # merge it instead
            conn.execute(
                "UPDATE explore_areas SET name = ?, mapping_state = 'pending' WHERE id = ?",
                (cleaned, area_id),
            )
        return True

    def merge(self, source_id: str, into_id: str) -> None:
        """Materials and subtopics of ``source_id`` move to ``into_id``; the source is removed."""
        source = self.topic(source_id)
        into = self.topic(into_id)
        if source.id == into.id or into.parent_id == source.id:
            raise ContractFailure(422, "invalid_request")
        with self.db.write() as conn:
            children = [
                _topic(row)
                for row in conn.execute(
                    "SELECT * FROM explore_areas WHERE parent_id = ? AND level = 'custom' ORDER BY rowid",
                    (source.id,),
                ).fetchall()
            ]
            for child in children:
                if into.parent_id is not None:
                    # Two levels at most: a subtopic of a merged topic joins the target subtopic.
                    self._move_labels(conn, child.id, into.id)
                    conn.execute("DELETE FROM explore_areas WHERE id = ?", (child.id,))
                    continue
                same = self._find(conn, child.name, into.id)
                if same is not None:
                    self._move_labels(conn, child.id, same)
                    conn.execute("DELETE FROM explore_areas WHERE id = ?", (child.id,))
                else:
                    conn.execute("UPDATE explore_areas SET parent_id = ? WHERE id = ?", (into.id, child.id))
            self._move_labels(conn, source.id, into.id)
            conn.execute(
                "UPDATE explore_areas SET mapping_state = 'pending', pinned = MAX(pinned, ?) WHERE id = ?",
                (int(source.pinned), into.id),
            )
            conn.execute("DELETE FROM explore_areas WHERE id = ?", (source.id,))

    @staticmethod
    def _move_labels(conn: sqlite3.Connection, from_id: str, to_id: str) -> None:
        conn.execute("UPDATE explore_area_materials SET area_id = ? WHERE area_id = ?", (to_id, from_id))

    def delete(self, area_id: str) -> None:
        """The topic and its subtopics go; their materials become unsorted (the labels go with them)."""
        self.topic(area_id)
        with self.db.write() as conn:
            ids = [area_id] + [
                str(row["id"])
                for row in conn.execute("SELECT id FROM explore_areas WHERE parent_id = ?", (area_id,))
            ]
            marks = ",".join("?" for _ in ids)
            conn.execute(f"DELETE FROM explore_area_materials WHERE area_id IN ({marks})", ids)
            conn.execute(f"DELETE FROM explore_area_topics WHERE area_id IN ({marks})", ids)
            conn.execute(f"DELETE FROM explore_areas WHERE id IN ({marks}) AND id != ?", (*ids, area_id))
            conn.execute("DELETE FROM explore_areas WHERE id = ?", (area_id,))

    def descendants(self, area_id: str) -> list[str]:
        """The topic and its subtopics."""
        with self.db.read() as conn:
            rows = conn.execute(
                "SELECT id FROM explore_areas WHERE parent_id = ? AND level = 'custom' ORDER BY rowid",
                (area_id,),
            ).fetchall()
        return [area_id, *(str(row["id"]) for row in rows)]

    # -- material labels ----------------------------------------------------------

    def wiki_material_ids(self) -> list[str]:
        with self.db.read() as conn:
            rows = conn.execute(
                f"SELECT w.material_id FROM ({_WIKI_MATERIALS}) w JOIN materials m ON m.id = w.material_id "
                "ORDER BY m.title COLLATE NOCASE, m.id",
                tuple(STUDY_KINDS),
            ).fetchall()
        return [str(row["material_id"]) for row in rows]

    def unsorted_material_ids(self) -> list[str]:
        """Wiki materials without a topic, in title order (the order the sorting job takes them)."""
        with self.db.read() as conn:
            labelled = {
                str(row[0])
                for row in conn.execute(
                    "SELECT l.material_id FROM explore_area_materials l "
                    "JOIN explore_areas a ON a.id = l.area_id"
                )
            }
        return [mid for mid in self.wiki_material_ids() if mid not in labelled]

    def labels(self) -> dict[str, tuple[str, Origin]]:
        """material id → (topic id, origin), for every stored label of an existing topic."""
        with self.db.read() as conn:
            rows = conn.execute(
                "SELECT l.material_id, l.area_id, l.origin FROM explore_area_materials l "
                "JOIN explore_areas a ON a.id = l.area_id"
            ).fetchall()
        return {str(row[0]): (str(row[1]), row[2]) for row in rows}

    def label(self, material_id: str, area_id: str, origin: Origin) -> bool:
        """Store the material's topic. An agent label never replaces the user's choice."""
        with self.db.write() as conn:
            current = conn.execute(
                "SELECT l.origin FROM explore_area_materials l JOIN explore_areas a ON a.id = l.area_id "
                "WHERE l.material_id = ?",
                (material_id,),
            ).fetchone()
            if current is not None and current[0] == "user" and origin == "agent":
                return False
            conn.execute(
                "INSERT INTO explore_area_materials(material_id, area_id, origin, labelled_at) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(material_id) DO UPDATE SET area_id = excluded.area_id, "
                "origin = excluded.origin, labelled_at = excluded.labelled_at",
                (material_id, area_id, origin, utc_now_ms()),
            )
        return True

    def move(self, material_id: str, area_id: str) -> KbMaterialTopic:
        if self.kb.material_repo.get(material_id) is None:
            raise NotFound("Material not found.")
        self.topic(area_id)
        self.label(material_id, area_id, "user")
        return KbMaterialTopic(material_id=material_id, area_id=area_id, origin="user")

    def material_topic(self, material_id: str) -> KbMaterialTopic:
        found = self.labels().get(material_id)
        if found is None:
            return KbMaterialTopic(material_id=material_id, area_id=None, origin=None)
        return KbMaterialTopic(material_id=material_id, area_id=found[0], origin=found[1])

    def concept_titles(self, material_ids: Sequence[str], limit: int) -> dict[str, list[str]]:
        """Titles of the concept pages citing each material (alphabetical, at most ``limit``)."""
        if not material_ids:
            return {}
        marks = ",".join("?" for _ in material_ids)
        titles: dict[str, list[str]] = defaultdict(list)
        with self.db.read() as conn:
            for row in conn.execute(
                "SELECT DISTINCT ps.material_id, p.title FROM page_sources ps "
                "JOIN pages p ON p.id = ps.page_id "
                f"WHERE ps.material_id IN ({marks}) AND p.kind = 'concept' ORDER BY p.title COLLATE NOCASE",
                tuple(material_ids),
            ):
                bucket = titles[str(row[0])]
                if len(bucket) < limit:
                    bucket.append(str(row[1]))
        return dict(titles)

    def top_concepts(self, area_id: str, limit: int = 5) -> list[str]:
        """The topic's main concepts: concept pages citing most of its materials (subtopics included)."""
        ids = self.descendants(area_id)
        marks = ",".join("?" for _ in ids)
        with self.db.read() as conn:
            rows = conn.execute(
                "SELECT p.title, COUNT(DISTINCT ps.material_id) AS n FROM explore_area_materials l "
                "JOIN page_sources ps ON ps.material_id = l.material_id JOIN pages p ON p.id = ps.page_id "
                f"WHERE l.area_id IN ({marks}) AND p.kind = 'concept' "
                "GROUP BY p.id ORDER BY n DESC, p.title COLLATE NOCASE LIMIT ?",
                (*ids, limit),
            ).fetchall()
        return [str(row[0]) for row in rows]

    # -- hidden OpenAlex label ----------------------------------------------------------

    def pending_mapping(self) -> list[OwnTopic]:
        return [topic for topic in self.topics() if not topic.mapping_current]

    def store_mapping(self, area_id: str, name: str, topic_ids: Sequence[str] | None) -> bool:
        """Keep the label made for ``name`` (``None``/empty = no match); a topic renamed meanwhile keeps
        waiting for its own label. Returns whether it was stored."""
        ids = list(dict.fromkeys(tid for tid in (topic_ids or ()) if tid))
        state: MappingState = "mapped" if ids else "no_match"
        with self.db.write() as conn:
            changed = conn.execute(
                "UPDATE explore_areas SET mapping_state = ?, mapped_name = ? "
                "WHERE id = ? AND level = 'custom' AND name = ?",
                (state, name, area_id, name),
            ).rowcount
            if not changed:
                return False
            conn.execute("DELETE FROM explore_area_topics WHERE area_id = ?", (area_id,))
            for tid in ids:
                conn.execute(
                    "INSERT INTO explore_area_topics(area_id, topic_id) VALUES (?, ?)", (area_id, tid)
                )
        return True

    def hidden_ids(self, area_id: str) -> list[str]:
        """The topic's OpenAlex ids for a search filter; empty while unmapped, stale or without a match."""
        try:
            topic = self.topic(area_id)
        except (NotFound, ContractFailure):
            return []
        if topic.mapping_state != "mapped" or not topic.mapping_current:
            return []
        with self.db.read() as conn:
            rows = conn.execute(
                "SELECT topic_id FROM explore_area_topics WHERE area_id = ? ORDER BY rowid", (area_id,)
            ).fetchall()
        return [str(row[0]) for row in rows]
