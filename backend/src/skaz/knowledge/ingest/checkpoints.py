"""Current-source checkpoints, separate from telemetry and never a version history.

Only structurally parsed model answers are stored; every reuse still runs the
usual source/citation/output checks. A changed source clears old answers.
Deleting a material cascades through both tables. An unresolved default model is
not cacheable: its actual configuration could change without SKAZ knowing.

The processing choice (agent · model · reasoning) is not part of the revision
(user decision 2026-10-20, C1-f item 4): after a stop, another choice continues
from the finished answers, and each answer remembers who wrote it for the job
journal. Once a material finished, another choice starts it over, as before.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any

from ..agents.engine import TurnMessage
from ..agents.registry import ENGINE_NAMES
from ..ids import utc_now
from ..store.database import KnowledgeDatabase
from .sources import IngestSource


def fingerprint(value: object) -> str:
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def step_key(instructions: str, messages: Sequence[TurnMessage], schema: Mapping[str, Any]) -> str:
    # Which engine wrote an earlier answer of the conversation is not part of the step: another
    # agent continuing it asks the same thing.
    return fingerprint({"instructions": instructions,
                        "messages": [{"role": m.role, "content": m.content} for m in messages],
                        "schema": schema})


def source_fingerprint(source: IngestSource, *, language: str, part_budget: int, rules: object) -> str:
    return fingerprint({"version": 2, "material": source.material_id, "title": source.title,
                        "fragments": [asdict(item) for item in source.fragments],
                        "excluded": sorted(source.excluded), "language": language,
                        "part_budget": part_budget, "rules": rules})


def profile_label(engine: str, model: str, effort: str | None) -> str:
    """``Codex · gpt-x · low`` — who wrote an answer, for the job journal."""
    name = ENGINE_NAMES.get(engine, engine)  # type: ignore[call-overload]
    return " · ".join(part for part in (name, model, effort) if part)


@dataclass(frozen=True)
class Saved:
    response: str
    #: ``profile_label`` of the choice that wrote it; ``None`` for answers kept before v3.
    profile: str | None


class Checkpoints:
    def __init__(self, db: KnowledgeDatabase, material_id: str, revision: str, profile: str) -> None:
        self.db = db
        self.material_id = material_id
        self.revision = revision
        self.profile = profile

    def prepare(self) -> None:
        with self.db.write() as connection:
            row = connection.execute(
                "SELECT fingerprint, finished_profile FROM wiki_checkpoints WHERE material_id = ?",
                (self.material_id,)).fetchone()
            if row is not None and row["fingerprint"] != self.revision:
                connection.execute("DELETE FROM wiki_checkpoints WHERE material_id = ?", (self.material_id,))
            elif row is not None and row["finished_profile"] not in (None, self.profile):
                # The material finished with another choice: this one writes it anew.
                connection.execute("DELETE FROM wiki_checkpoint_answers WHERE material_id = ?",
                                   (self.material_id,))
            connection.execute("INSERT OR IGNORE INTO wiki_checkpoints(material_id,fingerprint) VALUES (?,?)",
                               (self.material_id, self.revision))
            # Until this run finishes, the kept answers are the work of a stopped run.
            connection.execute("UPDATE wiki_checkpoints SET finished_profile = NULL WHERE material_id = ?",
                               (self.material_id,))

    def get(self, key: str) -> str | None:
        saved = self.entry(key)
        return saved.response if saved is not None else None

    def entry(self, key: str) -> Saved | None:
        with self.db.read() as connection:
            row = connection.execute(
                "SELECT a.response, a.profile FROM wiki_checkpoint_answers a JOIN wiki_checkpoints c "
                "ON c.material_id=a.material_id WHERE a.material_id=? AND a.step_key=? AND c.fingerprint=?",
                (self.material_id, key, self.revision),
            ).fetchone()
        return Saved(str(row["response"]), row["profile"]) if row is not None else None

    def put(self, key: str, response: str) -> None:
        with self.db.write() as connection:
            row = connection.execute("SELECT fingerprint FROM wiki_checkpoints WHERE material_id=?",
                                     (self.material_id,)).fetchone()
            if row is None or row["fingerprint"] != self.revision:
                raise RuntimeError("The wiki checkpoint changed while its source was being processed.")
            connection.execute(
                "INSERT INTO wiki_checkpoint_answers(material_id,step_key,response,created_at,profile) "
                "VALUES (?,?,?,?,?) "
                "ON CONFLICT(material_id,step_key) DO UPDATE SET response=excluded.response, "
                "created_at=excluded.created_at, profile=excluded.profile",
                (self.material_id, key, response, utc_now(), self.profile),
            )

    def finished(self) -> None:
        """The material was written with this choice: another choice later starts it over."""
        with self.db.write() as connection:
            connection.execute("UPDATE wiki_checkpoints SET finished_profile = ? WHERE material_id = ? "
                               "AND fingerprint = ?", (self.profile, self.material_id, self.revision))

    def discard(self, key: str) -> None:
        with self.db.write() as connection:
            connection.execute("DELETE FROM wiki_checkpoint_answers WHERE material_id=? AND step_key=?",
                               (self.material_id, key))

    def clear(self) -> None:
        with self.db.write() as connection:
            connection.execute("DELETE FROM wiki_checkpoint_answers WHERE material_id=?", (self.material_id,))
