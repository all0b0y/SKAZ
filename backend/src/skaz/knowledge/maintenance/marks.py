"""N1 marks: only what code can prove, each with its reason, its evidence and the actions that make sense.

* new version — "v3 is out (2026)", from arXiv version history (only when the material's link names the
  user's version) or Crossref "updated by"; Replace with vN (arXiv links only) / Keep, marked.
* retracted — "Retracted (2026)", OpenAlex or Crossref; Delete source… (the existing delete preview) /
  Keep, marked. A wiki statement that rests on this source alone is ``sole_source`` (dimmed).
* newer and contradicts — a disagreement the wiki already found (``wiki/discrepancy.py``) where one
  source is provably newer: the mark sits on the older source's statement, "A newer source disagrees".
* link gone — written by B5's "Check links" after a confirmed second answer; Keep.

Nothing is deleted automatically; the user deletes (N1, N4 decision 10).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from datetime import date, datetime
from typing import Any, Literal

from ..api.schemas_explore_common import KbMaterialRef, KbPublicationDate
from ..api.schemas_maintenance import KbFreshnessMark, KbMarkedStatement
from ..science.protocols import ScienceUpdate
from .store import CitedStatement, MarkRow

Action = Literal["replace_version", "delete_source", "keep_marked"]
LINK_GONE_REASON = "Original link is gone · your copy is kept"
UNKNOWN = KbPublicationDate(
    year=None, date=None, month=None, precision="unknown", origin="unknown", evidence_url=None
)


def _year(publication: Mapping[str, Any] | None) -> int | None:
    if not publication:
        return None
    year = publication.get("year")
    return year if isinstance(year, int) else None


def _with_year(text: str, year: int | None) -> str:
    return f"{text} ({year})" if year else text


def update_evidence(update: ScienceUpdate, current_version: str | None, checked_at: str) -> dict[str, Any]:
    """A ``ScienceUpdate`` (B1) as mark evidence."""
    publication = update.publication.model_dump(mode="json") if update.publication is not None else None
    year = _year(publication)
    if update.kind == "retracted":
        reason = _with_year("Retracted", year)
    elif update.version:
        reason = _with_year(f"{update.version} is out", year)
    else:
        reason = _with_year("A newer version is out", year)
    return {
        "reason": reason,
        "evidence_url": update.evidence_url,
        "evidence_label": update.evidence_label,
        "checked_at": checked_at,
        "replacement_work_id": update.replacement_work_id,
        "version": update.version,
        "current_version": current_version if update.kind == "new_version" else None,
        "publication": publication,
        "actions": list(_actions_for(update.kind, replaceable=bool(update.version and current_version))),
    }


def newer_evidence(
    newer_title: str, newer: KbPublicationDate, page_id: str, block_id: str, checked_at: str
) -> dict[str, Any]:
    return {
        "reason": _with_year("A newer source disagrees", newer.year),
        "evidence_url": None,
        "evidence_label": newer_title,
        "checked_at": checked_at,
        "replacement_work_id": None,
        "version": None,
        "current_version": None,
        "publication": newer.model_dump(mode="json"),
        "statements": [[page_id, block_id]],
        "actions": ["keep_marked"],
    }


def link_gone_evidence(url: str, checked_at: str) -> dict[str, Any]:
    return {
        "reason": LINK_GONE_REASON,
        "evidence_url": url,
        "evidence_label": None,
        "checked_at": checked_at,
        "replacement_work_id": None,
        "version": None,
        "current_version": None,
        "publication": None,
        "actions": ["keep_marked"],
    }


def _actions_for(kind: str, *, replaceable: bool) -> tuple[Action, ...]:
    if kind == "new_version":
        return ("replace_version", "keep_marked") if replaceable else ("keep_marked",)
    if kind == "retracted":
        return ("delete_source", "keep_marked")
    return ("keep_marked",)


def _bounds(publication: KbPublicationDate) -> tuple[date, date] | None:
    if publication.precision == "unknown" or publication.year is None:
        return None
    if publication.precision == "day" and publication.date is not None:
        return publication.date, publication.date
    if publication.precision == "month" and publication.month is not None:
        start = date(publication.year, publication.month, 1)
        end = date(publication.year + (publication.month == 12), publication.month % 12 + 1, 1)
        return start, date.fromordinal(end.toordinal() - 1)
    return date(publication.year, 1, 1), date(publication.year, 12, 31)


def provably_newer(newer: KbPublicationDate, older: KbPublicationDate) -> bool:
    """True only when the whole period of ``older`` ends before ``newer`` begins (unknown is never newer)."""
    a, b = _bounds(newer), _bounds(older)
    return a is not None and b is not None and b[1] < a[0]


def to_model(
    mark: MarkRow,
    statements: Sequence[CitedStatement],
    titles: Callable[[Sequence[str]], Mapping[str, str]],
) -> KbFreshnessMark:
    evidence = mark.evidence
    others = titles(sorted({mid for item in statements for mid in item.others}))
    publication = evidence.get("publication")
    return KbFreshnessMark(
        id=mark.id,
        material_id=mark.material_id,
        kind=mark.kind,  # type: ignore[arg-type]
        reason=str(evidence.get("reason") or ""),
        evidence_url=evidence.get("evidence_url"),
        evidence_label=evidence.get("evidence_label"),
        checked_at=datetime.fromisoformat(
            str(evidence.get("checked_at") or mark.created_at).replace("Z", "+00:00")
        ),
        replacement_work_id=evidence.get("replacement_work_id"),
        version=evidence.get("version"),
        current_version=evidence.get("current_version"),
        publication=KbPublicationDate.model_validate(publication) if publication else UNKNOWN,
        affected_statements=[
            KbMarkedStatement(
                page_id=item.page_id,
                title=item.title,
                block_id=item.block_id,
                sole_source=not [mid for mid in item.others if mid in others],
                also_supported_by=[
                    KbMaterialRef(material_id=mid, title=others[mid]) for mid in item.others if mid in others
                ],
            )
            for item in statements
        ],
        actions=list(evidence.get("actions") or ["keep_marked"]),
        kept_marked=mark.kept_marked,
        created_at=datetime.fromisoformat(mark.created_at.replace("Z", "+00:00")),
    )


def statement_filter(mark: MarkRow) -> list[tuple[str, str]] | None:
    """A "newer source disagrees" mark sits on its statements only; the others on every citing one."""
    raw = mark.evidence.get("statements")
    if not isinstance(raw, list):
        return None
    return [(str(item[0]), str(item[1])) for item in raw if isinstance(item, list) and len(item) == 2]
