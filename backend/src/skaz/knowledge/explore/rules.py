"""Funnel step 2: rules in code (N4 decision 5). No request, no model, no budget.

* Already in the library — the N2 duplicate rule (``sources/duplicates.py``): same DOI or address.
* Date window — the user's window, or the default: Continues look back to when the source was added
  (at least 12 months, never before the source was published); Branches and Search look back 12 months.
* N7 search rules — a work whose every page is on a Never site, or (with «only these sites») none of
  whose pages is on an allowed site, is left out.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal

from ..api.schemas_explore_common import KbDateWindow, KbPublicationDate
from ..api.schemas_science import KbScienceWork
from ..permissions.search_rules import ActiveRules, covered, host_of
from ..service import KnowledgeService
from ..sources.duplicates import doi_of, find_duplicate
from ..store.records import MaterialRecord

RuleReason = Literal["in_library", "found_before", "outside_dates", "search_rules"]
DEFAULT_LOOKBACK = timedelta(days=365)
_ARXIV = re.compile(r"arxiv\.org/(?:abs|pdf|html)/([^?#\s]+?)(?:v\d+)?(?:\.pdf)?/?$", re.IGNORECASE)


@dataclass(frozen=True)
class Seed:
    """A library source as the science bases know it (Continues / Branches start from these)."""

    material_id: str
    title: str
    added: date
    doi: str | None
    arxiv_id: str | None


def seed_of(record: MaterialRecord) -> Seed | None:
    """The DOI or arXiv id a material's origin names; ``None`` when it names neither."""
    origin = record.origin or {}
    urls = [value for value in (origin.get("url"), origin.get("final_url")) if isinstance(value, str)]
    extra_doi = origin.get("doi")
    if isinstance(extra_doi, str):
        urls.insert(0, "https://doi.org/" + extra_doi)
    doi = next((found for url in urls if (found := doi_of(url))), None)
    arxiv = next((match.group(1) for url in urls if (match := _ARXIV.search(url))), None)
    if doi is None and arxiv is None:
        return None
    return Seed(record.id, record.title, _day(record.created_at), doi, arxiv)


def _day(stamp: str) -> date:
    try:
        return date.fromisoformat(stamp[:10])
    except ValueError:
        return date.today()


def continues_since(seeds: Sequence[Seed], published: Mapping[str, KbPublicationDate], today: date) -> date:
    """The default window of Continues: see the module note."""
    starts: list[date] = []
    for seed in seeds:
        start = min(seed.added, today - DEFAULT_LOOKBACK)
        when = published.get(seed.material_id)
        if when is not None and when.year is not None:
            start = max(start, when.date or date(when.year, when.month or 1, 1))
        starts.append(start)
    return min(starts) if starts else today - DEFAULT_LOOKBACK


def default_window(today: date) -> KbDateWindow:
    return KbDateWindow(from_date=today - DEFAULT_LOOKBACK)


def work_urls(work: KbScienceWork) -> list[str]:
    urls: list[str] = []
    if work.doi:
        urls.append("https://doi.org/" + work.doi)
    if work.arxiv_id:
        urls += [f"https://arxiv.org/abs/{work.arxiv_id}", f"https://arxiv.org/pdf/{work.arxiv_id}"]
    urls += [location.url for location in work.locations]
    return urls


def in_library(kb: KnowledgeService, work: KbScienceWork) -> str | None:
    """The material that already is this work, by the N2 rule; ``None`` otherwise."""
    duplicate = find_duplicate(kb, urls=work_urls(work))
    return None if duplicate is None else duplicate.material_id


def in_window(work: KbScienceWork, window: KbDateWindow | None, *, explicit: bool) -> bool:
    """An unknown publication date is never guessed: it stays in, unless the user's own window asks to
    exclude unknown dates."""
    if window is None:
        return True
    published = work.publication
    if published.precision == "unknown" or published.year is None:
        return not (explicit and window.unknown == "exclude")
    first = published.date or date(published.year, published.month or 1, 1)
    last = published.date or _period_end(published.year, published.month)
    if window.from_date is not None and last < window.from_date:
        return False
    return not (window.to_date is not None and first > window.to_date)


def _period_end(year: int, month: int | None) -> date:
    if month is None:
        return date(year, 12, 31)
    following = date(year + (month == 12), 1 if month == 12 else month + 1, 1)
    return following - timedelta(days=1)


def blocked_by_rules(work: KbScienceWork, rules: ActiveRules | None) -> bool:
    if rules is None or not rules.hard:
        return False
    hosts = [host for host in (host_of(url) for url in _page_urls(work)) if host]
    if rules.only and not any(covered(host, rules.only) for host in hosts):
        return True
    return bool(hosts) and all(covered(host, rules.never) for host in hosts)


def _page_urls(work: KbScienceWork) -> Iterable[str]:
    yield from (location.url for location in work.locations)
    if work.arxiv_id:
        yield f"https://arxiv.org/abs/{work.arxiv_id}"
