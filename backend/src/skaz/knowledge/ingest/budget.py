"""C1-d: the wiki budget of one material — characters sent to and received from the model.

The user chose characters (2026-10-20): every agent shows them, tokens not. The budget covers the
whole processing of one material (Notes, Concepts, matching, recognition check and the follow-up
overview/connections jobs that inherit its execution root). Reaching it pauses the job; finished
verified work stays in the checkpoints and Continue resumes with another portion of the budget.

SKAZ counts only what it sends and receives itself; it is not a guaranteed limit of the attempts
an agent or provider makes internally, and never a percentage of a subscription.
"""
from __future__ import annotations

import sqlite3
from collections.abc import Iterable

#: ``JobRecord.error_code`` of a job paused at its wiki budget (Continue, not Retry).
BUDGET_REACHED = "BUDGET_REACHED"
PAUSED_LABEL = "Paused · budget reached"
#: Jobs that (re)build a material's pages; other kinds of the same root are its follow-up work.
_MATERIAL_KINDS = ("ingest", "refresh")


def characters_label(count: int) -> str:
    """``2M`` / ``1.2M`` / ``50K`` / ``900`` — the budget in the units the user reads."""
    for size, suffix in ((1_000_000, "M"), (1_000, "K")):
        if count >= size:
            value = f"{count / size:.1f}".rstrip("0").rstrip(".")
            return f"{value}{suffix}"
    return str(count)


def paused_text(budget: int) -> str:
    label = characters_label(budget)
    return (f"Paused: this material used its wiki budget of {label} characters. The finished work is "
            f"kept; Continue picks up from it with another {label}.")


def too_small_text(budget: int) -> str:
    return (f"One step of this material needs more than its whole wiki budget "
            f"({characters_label(budget)} characters). Raise “Wiki budget per material” in "
            "Settings → Models, then retry.")


class BudgetReached(Exception):
    """Raised at the model seam instead of sending (or while an answer streams) once the budget of
    the material's execution root is used up. ``progressed``: this portion of the budget already
    paid for finished work, so pausing moves forward; otherwise one step alone is too big."""

    def __init__(self, budget: int, spent: int, *, progressed: bool) -> None:
        super().__init__(paused_text(budget))
        self.budget = budget
        self.spent = spent
        self.progressed = progressed

    @property
    def message(self) -> str:
        return paused_text(self.budget) if self.progressed else too_small_text(self.budget)


def paused_follow_ups(connection: sqlite3.Connection,
                      material_ids: Iterable[str]) -> dict[str, list[sqlite3.Row]]:
    """Material → its follow-up jobs (overview, connections…) paused at the budget after its latest
    ingest finished. Only the latest job of each kind counts: a continued run supersedes it."""
    ids = list(dict.fromkeys(material_ids))
    result: dict[str, list[sqlite3.Row]] = {}
    if not ids:
        return result
    kinds = ",".join("?" * len(_MATERIAL_KINDS))
    for start in range(0, len(ids), 400):
        chunk = ids[start:start + 400]
        marks = ",".join("?" * len(chunk))
        latest: dict[str, tuple[int, str]] = {}
        for row in connection.execute(
            f"SELECT target_id, state, rowid AS seq FROM jobs WHERE kind IN ({kinds}) "
            f"AND target_id IN ({marks}) ORDER BY rowid DESC", (*_MATERIAL_KINDS, *chunk),
        ):
            latest.setdefault(row["target_id"], (int(row["seq"]), row["state"]))
        seen: set[tuple[str, str]] = set()
        for row in connection.execute(
            "SELECT j.id AS id, j.kind AS kind, j.state AS state, j.error AS error, j.rowid AS seq, "
            "d.error_code AS error_code, json_extract(e.data, '$.material_id') AS material_id "
            "FROM jobs j JOIN wiki_execution e ON e.job_id = j.id LEFT JOIN ingest_jobs d ON d.job_id = j.id "
            f"WHERE json_extract(e.data, '$.material_id') IN ({marks}) AND j.kind NOT IN ({kinds}) "
            "ORDER BY j.rowid DESC", (*chunk, *_MATERIAL_KINDS),
        ):
            material_id = row["material_id"]
            head = latest.get(material_id)
            if head is None or head[1] != "done" or int(row["seq"]) < head[0]:
                continue
            if (material_id, row["kind"]) in seen:
                continue  # an older run of this kind, superseded by the latest one
            seen.add((material_id, row["kind"]))
            if row["state"] == "paused":
                result.setdefault(material_id, []).append(row)
    return result
