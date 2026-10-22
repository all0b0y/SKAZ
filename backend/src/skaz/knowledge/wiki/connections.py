"""Connections between concepts (decision 5, API-B2 §2.5; C1-a: in batches, only for new/changed data).

Candidates for one concept page are other concept pages that mention it
(search) or share a source, other folders first, never ones already
connected. Planning is code: each candidate pair is one unordered pair of pages
with the first statements of *both* pages (``MAX_SIDE`` each, so the input of a
pair is the same whichever page asked), fingerprinted together with the rules,
the wiki profile and the decision layer. A pair whose exact input was already
checked without a connection is not asked again (``wiki_connection_checks``); a
positive result is the connection block itself, so a connected pair is no
candidate. The fingerprint holds only what was checked: "no connection between
these statements", never "none between the pages".

A pair already decided — a remembered "no" for the same input, a pair given up after
``MAX_ATTEMPTS`` answers not in the expected format for that input, a connection the user
deleted — takes no candidate slot: the page's next candidate is taken instead (user decisions
2026-10-21, 2–4). A deleted connection (in SKAZ or in Obsidian) is never suggested again, whatever
the statements; only deleting a page forgets it. A manual edit of a page puts it in the queue
(``wiki_connection_pending``) at once (decision 5).

The decision layer screens each remaining pair (a confident "no" drops it and is
remembered); the writing agent then gets the rest in batches — every page once
with statements numbered across the batch, then the numbered pairs — bounded by
the prompt size and the expected answer size, never by a number of files. A pair
too large for any batch goes alone; no pair is dropped. Each stated connection
rests on numbered statements of both pages of its pair; SKAZ writes it as an
agent ``connection`` block on the pair's first page with the checked citations of
those statements and a link to the other page — also a ``connection`` edge.

A batch is settled before the next one is sent: its connections written, its
other pairs remembered as checked. A model failure ends the job with the agent's
reason (no other model); the pages of the run stay pending
(``wiki_connection_pending``) and the next run continues them — finished pairs are
reused, not paid for again.

One page's connections from one answer are written in one ``disk_call`` (one
rewrite, one reindex, one graph refresh): a cancel — the app quitting at its
deadline — never leaves part of an update, since ``disk_call`` lets a started
write finish (``native_io.drain_on_cancel``) and nothing is written between calls.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass, replace
from typing import Any, NamedTuple
from uuid import uuid4

from ...native_io import disk_call
from ..agents.prompting import untrusted_block
from ..ids import utc_now
from ..ingest.checkpoints import fingerprint
from ..ingest.checks import clean_text
from ..ingest.pages import insert_into_section, spaced
from ..ingest.prompts import instructions_for
from ..markdown.page import Block, Cite, PageDocument
from ..store.database import KnowledgeDatabase
from ..store.records import PageRecord
from .agent import AgentCaller
from .context import WikiContext
from .graph import link_targets
from .pages_io import page_path, reindex, rewrite
from .prompts import (
    CONNECTIONS_INSTRUCTIONS,
    CONNECTIONS_SCHEMA,
    ConnectionsOut,
    connections_prompt,
)
from .statements import Statement, page_statements

MAX_CANDIDATES = 4
#: Statements of each page of a pair (the same for both pages: a pair's input doesn't depend on
#: which page asked, so a check is reused from either side).
MAX_SIDE = 10
#: Bound of one batch prompt in characters: about the largest per-page prompt before batching
#: (10 own + 4 × 6 candidate statements of up to 600 characters). A larger single pair goes alone.
MAX_BATCH_CHARS = 24_000
#: Expected answer per pair (one sentence and statement numbers) and the bound of one batch answer.
ANSWER_CHARS_PER_PAIR = 400
MAX_BATCH_ANSWER_CHARS = 6_000
#: Bumped when checking a pair changes in a way the prompt and schema don't show.
RULES_VERSION = 1
#: Answers not in the expected format for one input of a pair before it is skipped (until it changes).
MAX_ATTEMPTS = 3
#: Block ids of the connections SKAZ writes (``Connections._block``).
LINK_PREFIX = "c-link-"
QUESTION = (
    "Are these two concepts meaningfully connected, so that a reader of one page clearly benefits from "
    "the other?"
)

Log = Callable[[str], Awaitable[None]]
Count = Callable[[dict[str, int]], Awaitable[None]]
PairIds = tuple[str, str]


def unordered(a: str, b: str) -> PairIds:
    return (a, b) if a < b else (b, a)


class Check(NamedTuple):
    key: str
    outcome: str
    attempts: int


def linked_pages(db: KnowledgeDatabase, page_id: str) -> set[PairIds]:
    """The pairs of this page's connections written by SKAZ (``c-link-*`` blocks) with the concept
    pages they link to, as the index has them now."""
    with db.read() as connection:
        concepts = {row[0].removesuffix(".md"): row[1] for row in connection.execute(
            "SELECT rel_path, id FROM pages WHERE kind = 'concept'")}
        rows = connection.execute(
            "SELECT text FROM blocks WHERE page_id = ? AND kind = 'connection' AND block_id LIKE ?",
            (page_id, f"{LINK_PREFIX}%")).fetchall()
    return {unordered(page_id, concepts[target]) for row in rows for target in link_targets(row[0])
            if concepts.get(target, page_id) != page_id}


def remember_removed(db: KnowledgeDatabase, pairs: Iterable[PairIds]) -> None:
    """The user deleted these pairs' connections: never suggested again (cleared only with a page)."""
    now = utc_now()
    with db.write() as connection:
        connection.executemany(
            "INSERT INTO wiki_connection_checks(page_a, page_b, input_key, outcome, attempts, checked_at) "
            "VALUES (?, ?, '', 'removed', 0, ?) ON CONFLICT(page_a, page_b) DO UPDATE SET "
            "input_key = '', outcome = 'removed', attempts = 0, checked_at = excluded.checked_at",
            [(a, b, now) for a, b in pairs],
        )


def mark_pending(db: KnowledgeDatabase, page_ids: Iterable[str]) -> None:
    """Concept pages among ``page_ids`` wait for the next connection run (other pages have none)."""
    now = utc_now()
    with db.write() as connection:
        connection.executemany(
            "INSERT OR IGNORE INTO wiki_connection_pending(page_id, added_at) "
            "SELECT id, ? FROM pages WHERE id = ? AND kind = 'concept'",
            [(now, page_id) for page_id in page_ids],
        )


def after_user_edit(db: KnowledgeDatabase, page_id: str, before: set[PairIds]) -> None:
    """A manual edit of a page landed (``before``: its ``linked_pages`` until then): the connections
    it took away are remembered as the user's removal, and the page waits for a connection run."""
    removed = before - linked_pages(db, page_id)
    if removed:
        remember_removed(db, removed)
    mark_pending(db, [page_id])


@dataclass(frozen=True)
class Side:
    page: PageRecord
    statements: tuple[Statement, ...]


@dataclass(frozen=True)
class Pair:
    """A candidate pair to check: written on ``first`` (the page that asked)."""

    first: Side
    second: Side
    language: str
    key: str
    #: Answers for this exact input already not in the expected format (``unanswered``).
    attempts: int = 0

    @property
    def ids(self) -> tuple[str, str]:
        a, b = sorted((self.first.page.id, self.second.page.id))
        return a, b


@dataclass(frozen=True)
class Plan:
    pages: tuple[str, ...]
    todo: tuple[Pair, ...]
    #: Pairs decided before, not asked: a remembered "no" for the same input …
    reused: int = 0
    #: … given up after ``MAX_ATTEMPTS`` answers not in the expected format for the same input …
    skipped: int = 0
    #: … or whose connection the user deleted.
    removed: int = 0

    @property
    def total(self) -> int:
        return len(self.todo) + self.reused + self.skipped + self.removed


@dataclass
class Outcome:
    """What one run did, for the job's counters and journal."""

    pages: int = 0
    pairs: int = 0
    reused: int = 0
    declined: int = 0
    checked: int = 0
    unchecked: int = 0
    skipped: int = 0
    removed: int = 0
    batches: int = 0
    written: int = 0

    @property
    def settled(self) -> int:
        return self.reused + self.declined + self.checked + self.skipped + self.removed

    def counters(self) -> dict[str, int]:
        return {
            "connection_pairs": self.pairs, "connection_pairs_reused": self.reused,
            "connection_pairs_declined": self.declined, "connection_pairs_checked": self.checked,
            "connection_pairs_unchecked": self.unchecked, "connection_pairs_skipped": self.skipped,
            "connection_pairs_removed": self.removed, "connection_batches": self.batches,
        }


Found = tuple[PageRecord, str, Sequence[Statement], Sequence[Statement]]


def _side_print(side: Side) -> dict[str, Any]:
    return {
        "page": side.page.id,
        "title": side.page.title,
        "statements": [
            [item.text, [[cite.material_id, cite.seg, cite.quote] for cite in item.cites]]
            for item in side.statements
        ],
    }


def pair_key(a: Side, b: Side, *, language: str, profile: object, decider: str | None) -> str:
    """The fingerprint of exactly what a check of this pair reads and who answers it."""
    rules = {"version": RULES_VERSION, "instructions": instructions_for(CONNECTIONS_INSTRUCTIONS, language),
             "schema": CONNECTIONS_SCHEMA, "question": QUESTION, "side": MAX_SIDE}
    sides = sorted((_side_print(a), _side_print(b)), key=lambda item: str(item["page"]))
    return fingerprint({"rules": rules, "profile": profile, "decider": decider, "sides": sides})


def _page_chars(side: Side) -> int:
    """An upper bound of the characters a page adds to a batch prompt (numbers counted wide)."""
    rows = "\n".join(item.line(9999) for item in side.statements)
    return len(f"Page 9999: {side.page.title[:200]}") + len(untrusted_block("page 9999", rows)) + 4


_FRAME_CHARS = len("Concept pages (statements are numbered across all pages):") + len(
    "Pairs to check (first page — second page):") + 8
_PAIR_CHARS = len("Pair 9999: page 9999 — page 9999") + 1


def _batch_pairs(attempts: int) -> int:
    """How many pairs share a batch: a batch whose answer was not in the expected format is split
    (halved) the next time, and a pair's last try is alone, so its failure is its own."""
    if attempts >= MAX_ATTEMPTS - 1:
        return 1
    return max(1, (MAX_BATCH_ANSWER_CHARS // ANSWER_CHARS_PER_PAIR) >> attempts)


def batches(pairs: Sequence[Pair]) -> list[list[Pair]]:
    """Pairs in batches bounded by the prompt and answer size (one language and one number of
    failed attempts per batch), in order.

    A pair that alone exceeds the bound is a batch of its own: never dropped.
    """
    groups: dict[tuple[str, int], list[Pair]] = {}
    for item in pairs:
        groups.setdefault((item.language, min(item.attempts, MAX_ATTEMPTS - 1)), []).append(item)
    result: list[list[Pair]] = []
    for (_language, attempts), group in groups.items():
        max_pairs = _batch_pairs(attempts)
        current: list[Pair] = []
        pages: set[str] = set()
        size = _FRAME_CHARS

        def extra(item: Pair, pages: set[str]) -> int:
            sides = {item.first.page.id: item.first, item.second.page.id: item.second}
            new = [side for page_id, side in sides.items() if page_id not in pages]
            return _PAIR_CHARS + sum(_page_chars(side) for side in new)

        for item in group:
            cost = extra(item, pages)
            if current and (size + cost > MAX_BATCH_CHARS or len(current) >= max_pairs):
                result.append(current)
                current, pages, size = [], set(), _FRAME_CHARS
                cost = extra(item, pages)
            current.append(item)
            pages |= {item.first.page.id, item.second.page.id}
            size += cost
        if current:
            result.append(current)
    return result


class Connections:
    def __init__(self, ctx: WikiContext) -> None:
        self.ctx = ctx

    def candidates(self, page: PageRecord) -> list[PageRecord]:
        """The first ``MAX_CANDIDATES`` of ``ranked`` (what a page with nothing decided yet checks)."""
        return self.ranked(page)[:MAX_CANDIDATES]

    def ranked(self, page: PageRecord) -> list[PageRecord]:
        """Every candidate of ``page``, best first: mentions it or shares a source, other folders
        first, never one already connected."""
        kb = self.ctx.kb
        concepts = {record.id: record for record in kb.pages(kind="concept")}
        connected = {
            edge.target if edge.source == page.id else edge.source
            for edge in self.ctx.graph.edges()
            if edge.kind == "connection" and page.id in (edge.source, edge.target)
        }
        scored: dict[str, int] = {}
        for name in dict.fromkeys((page.title, page.original or "", *page.aliases)):
            if not name.strip():
                continue
            for hit in kb.search(name, limit=20).blocks:
                if hit.page_id in concepts:
                    scored[hit.page_id] = scored.get(hit.page_id, 0) + 2
        for record in concepts.values():
            if set(record.sources) & set(page.sources):
                scored[record.id] = scored.get(record.id, 0) + 1
        result = []
        for page_id, _score in sorted(scored.items(), key=lambda item: -item[1]):
            candidate = concepts.get(page_id)
            if candidate is None or page_id == page.id or page_id in connected:
                continue
            result.append(candidate)
        result.sort(key=lambda record: bool(set(record.folders) & set(page.folders)))  # other folders first
        return result

    # -- bookkeeping (worker threads) ---------------------------------------------------------

    def _concept_ids(self) -> set[str]:
        return {record.id for record in self.ctx.kb.pages(kind="concept")}

    def _pending(self) -> list[str]:
        with self.ctx.kb.db.read() as connection:
            return [row[0] for row in connection.execute(
                "SELECT page_id FROM wiki_connection_pending ORDER BY added_at, page_id")]

    def _add_pending(self, page_ids: Iterable[str]) -> None:
        mark_pending(self.ctx.kb.db, page_ids)

    def _settle_pending(self, page_ids: Iterable[str]) -> None:
        with self.ctx.kb.db.write() as connection:
            connection.executemany("DELETE FROM wiki_connection_pending WHERE page_id = ?",
                                   [(page_id,) for page_id in page_ids])

    def _prune(self) -> None:
        """Checks and pending marks of pages that are no longer in the index are never reused."""
        with self.ctx.kb.db.write() as connection:
            connection.execute(
                "DELETE FROM wiki_connection_checks WHERE page_a NOT IN (SELECT id FROM pages) "
                "OR page_b NOT IN (SELECT id FROM pages)")
            connection.execute(
                "DELETE FROM wiki_connection_pending WHERE page_id NOT IN (SELECT id FROM pages)")

    def _checks(self) -> dict[PairIds, Check]:
        with self.ctx.kb.db.read() as connection:
            rows = connection.execute(
                "SELECT page_a, page_b, input_key, outcome, attempts FROM wiki_connection_checks").fetchall()
        return {(row[0], row[1]): Check(row[2], row[3], int(row[4])) for row in rows}

    def _removed_with(self, page_id: str) -> set[str]:
        """Pages whose connection with ``page_id`` the user deleted."""
        with self.ctx.kb.db.read() as connection:
            rows = connection.execute(
                "SELECT page_a, page_b FROM wiki_connection_checks WHERE outcome = 'removed' "
                "AND (page_a = ? OR page_b = ?)", (page_id, page_id)).fetchall()
        return {row[1] if row[0] == page_id else row[0] for row in rows}

    def _remember(self, pairs: Sequence[Pair], outcome: str) -> None:
        """Checked without a connection; never over a connection the user deleted."""
        now = utc_now()
        with self.ctx.kb.db.write() as connection:
            connection.executemany(
                "INSERT INTO wiki_connection_checks(page_a, page_b, input_key, outcome, attempts, "
                "checked_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(page_a, page_b) DO UPDATE SET "
                "input_key = excluded.input_key, outcome = excluded.outcome, attempts = 0, "
                "checked_at = excluded.checked_at WHERE wiki_connection_checks.outcome != 'removed'",
                [(*item.ids, item.key, outcome, now) for item in pairs],
            )

    def _unanswered(self, pairs: Sequence[Pair]) -> set[PairIds]:
        """One more answer not in the expected format for each pair's input; the pairs given up now."""
        now = utc_now()
        given_up: set[PairIds] = set()
        with self.ctx.kb.db.write() as connection:
            for item in pairs:
                row = connection.execute(
                    "SELECT input_key, outcome, attempts FROM wiki_connection_checks "
                    "WHERE page_a = ? AND page_b = ?", item.ids).fetchone()
                if row is not None and row[1] == "removed":
                    continue
                same = row is not None and row[1] == "unanswered" and row[0] == item.key
                attempts = int(row[2]) + 1 if same and row is not None else 1
                connection.execute(
                    "INSERT INTO wiki_connection_checks(page_a, page_b, input_key, outcome, attempts, "
                    "checked_at) VALUES (?, ?, ?, 'unanswered', ?, ?) ON CONFLICT(page_a, page_b) DO UPDATE "
                    "SET input_key = excluded.input_key, outcome = excluded.outcome, "
                    "attempts = excluded.attempts, checked_at = excluded.checked_at",
                    (*item.ids, item.key, attempts, now),
                )
                if attempts >= MAX_ATTEMPTS:
                    given_up.add(item.ids)
        return given_up

    # -- planning (code, no model) --------------------------------------------------------------

    def plan(self, page_ids: Sequence[str] | None, *, profile: object, decider: str | None) -> Plan:
        """The run's pages (asked ∪ still pending) and the pairs whose exact input wasn't checked yet.

        ``page_ids=None``: every concept page. Each page gets up to ``MAX_CANDIDATES`` pairs to
        check (a pair another page of the run checks counts too); a decided pair takes no slot.
        """
        kb = self.ctx.kb
        self._prune()
        concepts = self._concept_ids()
        asked = sorted(concepts) if page_ids is None else list(page_ids)
        scope = tuple(page_id for page_id in dict.fromkeys([*asked, *self._pending()]) if page_id in concepts)
        sides: dict[str, Side] = {}

        def side(record: PageRecord) -> Side:
            if record.id not in sides:
                sides[record.id] = Side(record, tuple(page_statements(kb, record.id, limit=MAX_SIDE)))
            return sides[record.id]

        checks = self._checks()
        seen: set[PairIds] = set()
        decided: dict[PairIds, str] = {}
        todo: list[Pair] = []
        default_language = self.ctx.settings().language
        for page_id in scope:
            page = kb.page_repo.get(page_id)
            if page is None or page.kind != "concept":
                continue
            own = side(page)
            if not own.statements:
                continue
            language = page.language or default_language
            slots = 0
            for record in self.ranked(page):
                if slots >= MAX_CANDIDATES:
                    break
                ids = unordered(page.id, record.id)
                if ids in decided:
                    continue
                if ids in seen:
                    slots += 1  # checked once in this run, from the page that asked first
                    continue
                check = checks.get(ids)
                if check is not None and check.outcome == "removed":
                    decided[ids] = "removed"
                    continue
                other = side(record)
                if not other.statements:
                    continue
                key = pair_key(own, other, language=language, profile=profile, decider=decider)
                attempts = 0
                if check is not None and check.key == key:
                    if check.outcome in ("none", "declined"):
                        decided[ids] = "reused"
                        continue
                    if check.outcome == "unanswered" and check.attempts >= MAX_ATTEMPTS:
                        decided[ids] = "skipped"
                        continue
                    if check.outcome == "unanswered":
                        attempts = check.attempts
                seen.add(ids)
                todo.append(Pair(own, other, language, key, attempts))
                slots += 1
        kinds = list(decided.values())
        return Plan(scope, tuple(todo), reused=kinds.count("reused"), skipped=kinds.count("skipped"),
                    removed=kinds.count("removed"))

    # -- the run ------------------------------------------------------------------------------------

    async def find(
        self, page_ids: Sequence[str] | None, caller: AgentCaller, log: Log, count: Count, *,
        profile: object,
    ) -> Outcome:
        """Find connections around ``page_ids`` (``None``: the whole wiki) plus any pages left pending."""
        layer = self.ctx.decisions()
        decider = str(layer.id) if layer is not None else None
        plan = await disk_call(self.plan, page_ids, profile=profile, decider=decider)
        await disk_call(self._add_pending, plan.pages)
        outcome = Outcome(pages=len(plan.pages), pairs=plan.total, reused=plan.reused,
                          skipped=plan.skipped, removed=plan.removed)
        await count(outcome.counters())
        if plan.skipped:
            await log(f"{plan.skipped} connection pair(s) skipped: no answer in the expected format "
                      f"{MAX_ATTEMPTS} times; they are checked again when a page's statements change.")
        try:
            unfinished = await self._run(plan, caller, log, count, outcome)
        except Exception:
            await log(f"Checked {outcome.settled} of {outcome.pairs} candidate pair(s) before the agent "
                      "stopped; the rest will be checked on the next run.")
            await count(outcome.counters())
            raise
        await disk_call(self._settle_pending, [page for page in plan.pages if page not in unfinished])
        return outcome

    async def _run(self, plan: Plan, caller: AgentCaller, log: Log, count: Count,
                   outcome: Outcome) -> set[str]:
        """Screen, then check the batches one by one; returns the pages with pairs left unchecked."""
        to_ask: list[Pair] = []
        for item in plan.todo:
            first, second = item.first, item.second
            verdict = await self.ctx.confirm(
                "\n".join([
                    untrusted_block("concept A", f"{first.page.title}: {first.statements[0].text[:300]}"),
                    untrusted_block("concept B", f"{second.page.title}: {second.statements[0].text[:300]}"),
                ]),
                QUESTION,
            )
            if verdict.answer is False:
                await disk_call(self._remember, [item], "declined")
                outcome.declined += 1
                continue
            to_ask.append(item)
        await count(outcome.counters())
        unfinished: set[str] = set()
        for batch in batches(to_ask):
            outcome.batches += 1
            answered = await self._ask(batch, caller)
            if answered is None:
                unfinished |= await self._not_answered(batch, log, outcome)
                await count(outcome.counters())
                continue
            found, invalid = answered
            if invalid:  # malformed entries count against their own pairs only
                unfinished |= await self._not_answered(invalid, log, outcome)
            connected: set[tuple[str, str]] = set()
            by_page: dict[str, list[Found]] = {}
            for item, text, mine, theirs in found:
                by_page.setdefault(item.first.page.id, []).append((item.second.page, text, mine, theirs))
            for page_id, items in by_page.items():
                targets = await disk_call(self._write, page_id, items)
                connected |= {(min(page_id, target), max(page_id, target)) for target in targets}
                outcome.written += len(targets)
                if targets:
                    record = next(item.first.page for item in batch if item.first.page.id == page_id)
                    await log(f"“{record.title}”: {len(targets)} connection(s) written.")
            settled = [item for item in batch if item not in invalid]
            await disk_call(self._remember, [item for item in settled if item.ids not in connected], "none")
            outcome.checked += len(settled)
            await count(outcome.counters())
        return unfinished

    async def _not_answered(self, pairs: Sequence[Pair], log: Log, outcome: Outcome) -> set[str]:
        """Pairs whose answer was not in the expected format: one more attempt each, given up at
        ``MAX_ATTEMPTS``; returns the pages left with pairs to check again."""
        given_up = await disk_call(self._unanswered, pairs)
        again = [item for item in pairs if item.ids not in given_up]
        outcome.unchecked += len(again)
        outcome.skipped += len(given_up)
        if again:
            await log(f"{len(again)} connection pair(s) got no answer in the expected format; "
                      f"they will be checked again on the next run (up to {MAX_ATTEMPTS} times).")
        if given_up:
            await log(f"{len(given_up)} connection pair(s) got no answer in the expected format "
                      f"{MAX_ATTEMPTS} times; they are skipped until a page's statements change.")
        return {item.first.page.id for item in again}

    async def _ask(self, batch: Sequence[Pair], caller: AgentCaller) -> tuple[
            list[tuple[Pair, str, list[Statement], list[Statement]]], list[Pair]] | None:
        """One batch to the writing agent: its valid connections and the pairs whose entry was not
        in the expected format (statements of the wrong page, no text); ``None`` when the whole
        answer was not."""
        pages: dict[str, Side] = {}
        for item in batch:
            pages.setdefault(item.first.page.id, item.first)
            pages.setdefault(item.second.page.id, item.second)
        number = {page_id: index for index, page_id in enumerate(pages, start=1)}
        pairs = [(number[item.first.page.id], number[item.second.page.id]) for item in batch]
        listed = [(side.page.title, side.statements) for side in pages.values()]
        prompt, owner = connections_prompt(listed, pairs)
        flat = [statement for side in pages.values() for statement in side.statements]
        answer = await caller.ask_json(
            instructions_for(CONNECTIONS_INSTRUCTIONS, batch[0].language),
            prompt, CONNECTIONS_SCHEMA, ConnectionsOut,
        )
        if answer is None:
            return None
        result: list[tuple[Pair, str, list[Statement], list[Statement]]] = []
        taken: set[int] = set()
        malformed: set[int] = set()
        for found in answer.connections:
            if not 1 <= found.pair <= len(batch) or found.pair in taken:
                continue  # an unknown pair, or a second connection for one pair
            first, second = pairs[found.pair - 1]
            mine = [flat[n - 1] for n in dict.fromkeys(found.first_side) if owner.get(n) == first]
            theirs = [flat[n - 1] for n in dict.fromkeys(found.second_side) if owner.get(n) == second]
            text = clean_text(found.text)
            if not mine or not theirs or not text:
                malformed.add(found.pair)
                continue
            if self.ctx.flagged(text):
                continue  # read as instructions: never written, the pair counts as checked
            taken.add(found.pair)
            result.append((batch[found.pair - 1], text, mine, theirs))
        return result, [batch[number - 1] for number in sorted(malformed - taken)]

    # -- writing ----------------------------------------------------------------------------------

    def _block(self, target: PageRecord, text: str, mine: Sequence[Statement],
               theirs: Sequence[Statement]) -> Block | None:
        citations = self.ctx.citations()
        cites_mine = citations.verified(cite for item in mine for cite in item.cites)
        cites_theirs = citations.verified(cite for item in theirs for cite in item.cites)
        if not cites_mine or not cites_theirs:
            return None  # one side's quote no longer holds: no connection without both sides
        cites: tuple[Cite, ...] = (*cites_mine, *cites_theirs)
        link = f"[[{target.rel_path.removesuffix('.md')}|{target.title}]]"
        body = " ".join([text, *citations.links(cites), link])
        return Block.create(f"{LINK_PREFIX}{uuid4().hex[:12]}", "connection", body, cites=cites)

    def _write(self, page_id: str, found: Sequence[Found]) -> list[str]:
        """All connections of one answer for one page in one rewrite; the ids of the pages connected."""
        with self.ctx.write_lock:
            library, path = page_path(self.ctx.kb, page_id)
            blocks: list[Block] = []
            targets: list[str] = []
            removed = self._removed_with(page_id)  # deleted by the user while this run was asking
            for target, text, mine, theirs in found:
                if target.id in targets or target.id in removed or self.ctx.graph.connected(
                        page_id, target.id):
                    continue  # one connection per pair, never a second one, never a deleted one
                block = self._block(target, text, mine, theirs)
                if block is not None:
                    blocks.append(block)
                    targets.append(target.id)
            if not blocks:
                return []

            def build(document: PageDocument) -> PageDocument:
                parts = list(document.parts)
                insert_into_section(parts, "connection", document.meta.language or "en", blocks)
                return replace(document, parts=spaced(parts))

            changed = rewrite(library, path, build)
            reindex(self.ctx.kb, library, path)
            self.ctx.graph.refresh()
            return targets if changed else []
