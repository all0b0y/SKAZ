"""Discrepancies between sources (decision 4, API-B2 §2.2).

Who decides: the writing agent compares new statements of a concept page with
the statements other sources made there (structured answer); the decision
layer confirms each pair (yes/no, threshold B9: a confident "no" drops it,
undecided leaves the agent's word, logged). A confirmed pair is written as an
agent explanation "Sources disagree …" — both statements stay, on equal
terms — and raises a ``discrepancy`` notification with four actions.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict, dataclass, replace
from uuid import uuid4

from ...native_io import disk_call
from ..agents.prompting import untrusted_block
from ..errors import KnowledgeError
from ..ids import new_id
from ..ingest.checks import clean_text
from ..ingest.pages import insert_into_section, spaced
from ..ingest.prompts import instructions_for
from ..markdown.page import Block, PageDocument
from ..notifications.actions import ActionSpec
from ..service import KnowledgeService
from ..store.records import NotificationRecord
from .agent import AgentCaller
from .context import WikiContext
from .edit import add_note
from .pages_io import page_path, reindex, rewrite
from .prompts import (
    DISCREPANCY_INSTRUCTIONS,
    DISCREPANCY_SCHEMA,
    DiscrepanciesOut,
    discrepancy_prompt,
)
from .statements import Statement, page_statements

KIND = "discrepancy"
QUESTION = (
    "Do these two statements contradict each other — they cannot both be true — rather than differ in "
    "detail, in the viewpoint of a discipline, in terms, or in the conditions they describe?"
)
LABELS = {
    "en": {"disagree": "Sources disagree", "superseded": "— superseded by “{winner}” (your choice)."},
    "ru": {"disagree": "Источники расходятся", "superseded": "— заменено версией из «{winner}» (ваш выбор)."},
}
#: A citation wikilink in a block body (``[[Materials/…#^seg-N|…]]``).
_CITATION_LINK = re.compile(r"\s*\[\[[^\]|\n]*#\^seg-\d+(?:\|[^\]\n]*)?\]\]")
MAX_NEW = 12
MAX_EXISTING = 24
#: Pages asked together in one call: at most this many, and about this much statement text.
MAX_BATCH_PAGES = 8
MAX_BATCH_CHARS = 16_000

Log = Callable[[str], Awaitable[None]]


class SideGone(KnowledgeError):
    status_code = 409


@dataclass(frozen=True)
class _Check:
    """One page's part of a disagreement check: what is new and what other sources said before."""

    page_id: str
    title: str
    language: str
    new: list[Statement]
    existing: list[Statement]

    def size(self) -> int:
        return 200 + sum(len(item.line(0)) for item in (*self.new, *self.existing))


def _batches(checks: Sequence[_Check]) -> list[list[_Check]]:
    """Pages of one language together (the instructions name it), in order, within the batch limits."""
    batches: list[list[_Check]] = []
    open_batch: dict[str, tuple[list[_Check], int]] = {}
    for check in checks:
        current = open_batch.get(check.language)
        fits = current is not None and len(current[0]) < MAX_BATCH_PAGES and (
            current[1] + check.size() <= MAX_BATCH_CHARS)
        if current is not None and fits:
            current[0].append(check)
            open_batch[check.language] = (current[0], current[1] + check.size())
            continue
        batch = [check]
        batches.append(batch)
        open_batch[check.language] = (batch, check.size())
    return batches


def _labels(language: str) -> dict[str, str]:
    return LABELS.get(language, LABELS["en"])


class Discrepancies:
    def __init__(self, ctx: WikiContext) -> None:
        self.ctx = ctx

    # -- bookkeeping ----------------------------------------------------------

    def _checked(self, page_id: str) -> set[str]:
        with self.ctx.kb.db.read() as connection:
            return {
                row[0]
                for row in connection.execute(
                    "SELECT block_id FROM wiki_checked WHERE page_id = ?", (page_id,)
                )
            }

    def _mark_checked(self, page_id: str, block_ids: Sequence[str]) -> None:
        with self.ctx.kb.db.write() as connection:
            connection.executemany(
                "INSERT OR IGNORE INTO wiki_checked(page_id, block_id) VALUES (?, ?)",
                [(page_id, block_id) for block_id in block_ids],
            )

    def _known(self, page_id: str, a: str, b: str) -> bool:
        with self.ctx.kb.db.read() as connection:
            return (
                connection.execute(
                    "SELECT 1 FROM wiki_discrepancies WHERE page_id = ? AND "
                    "((block_a = ? AND block_b = ?) OR (block_a = ? AND block_b = ?))",
                    (page_id, a, b, b, a),
                ).fetchone()
                is not None
            )

    # -- the check --------------------------------------------------------------

    async def check_page(
        self, page_id: str, new_block_ids: Sequence[str] | None, caller: AgentCaller, log: Log
    ) -> int:
        """One page: see ``check_pages``."""
        return await self.check_pages([(page_id, new_block_ids)], caller, log)

    async def check_pages(
        self, requests: Sequence[tuple[str, Sequence[str] | None]], caller: AgentCaller, log: Log,
        done: Callable[[], Awaitable[None]] | None = None,
    ) -> int:
        """Compare new statements with those of other sources, page by page; returns how many were reported.

        ``new_block_ids=None``: every statement not compared before ("Find connections"). Pages are
        asked together in batches (one agent call each); when a batch answer is not usable, each of its
        pages is asked on its own, so no page is skipped because another one was in its batch.
        ``done`` is awaited once per requested page when it is finished.
        """
        checks: list[_Check] = []
        for page_id, new_block_ids in requests:
            check = await self._prepare(page_id, new_block_ids)
            if check is not None:
                checks.append(check)
            elif done is not None:
                await done()
        found = 0
        for batch in _batches(checks):
            answer = await self._ask(batch, caller)
            if answer is None and len(batch) > 1:
                for check in batch:
                    found += await self._apply(check, await self._ask([check], caller), 1, log)
                    if done is not None:
                        await done()
                continue
            for number, check in enumerate(batch, start=1):
                found += await self._apply(check, answer, number, log)
                if done is not None:
                    await done()
        return found

    async def _prepare(self, page_id: str, new_block_ids: Sequence[str] | None) -> _Check | None:
        """What one page compares; ``None`` (its new statements marked checked) when there is nothing."""
        record = await disk_call(self.ctx.kb.page_repo.get, page_id)
        if record is None or record.kind != "concept":
            return None
        statements = await disk_call(page_statements, self.ctx.kb, page_id)
        checked = await disk_call(self._checked, page_id)
        wanted = set(new_block_ids) if new_block_ids is not None else None
        new = [
            item
            for item in statements
            if (item.block_id in wanted if wanted is not None else item.block_id not in checked)
        ][:MAX_NEW]
        new_materials = {item.material_id for item in new}
        existing = [item for item in statements if item not in new and item.material_id not in new_materials][
            :MAX_EXISTING
        ]
        if not new or not existing:
            await disk_call(self._mark_checked, page_id, [item.block_id for item in new])
            return None
        return _Check(page_id, record.title, record.language or self.ctx.settings().language, new, existing)

    async def _ask(self, batch: Sequence[_Check], caller: AgentCaller) -> DiscrepanciesOut | None:
        return await caller.ask_json(
            instructions_for(DISCREPANCY_INSTRUCTIONS, batch[0].language),
            discrepancy_prompt([(check.title, check.new, check.existing) for check in batch]),
            DISCREPANCY_SCHEMA,
            DiscrepanciesOut,
        )

    async def _apply(self, check: _Check, answer: DiscrepanciesOut | None, number: int, log: Log) -> int:
        """The conflicts of page ``number`` of the answer; an unusable answer leaves the page unchecked."""
        page_id, new, existing = check.page_id, check.new, check.existing
        if answer is None:
            await log(f"The disagreement check of “{check.title}” was not in the expected format; skipped.")
            return 0
        found = 0
        for conflict in answer.conflicts:
            if conflict.page != number:
                continue
            if not 1 <= conflict.new <= len(new) or not len(new) < conflict.existing <= len(new) + len(
                existing
            ):
                continue
            side_new, side_old = new[conflict.new - 1], existing[conflict.existing - len(new) - 1]
            if side_new.material_id == side_old.material_id:
                continue
            if await disk_call(self._known, page_id, side_new.block_id, side_old.block_id):
                continue
            verdict = await self.ctx.confirm(
                "\n".join(
                    [
                        untrusted_block("statement A", side_old.line("A")),
                        untrusted_block("statement B", side_new.line("B")),
                    ]
                ),
                QUESTION,
            )
            if verdict.answer is False:
                await log(f"“{check.title}”: the decision layer found no real disagreement in one pair.")
                continue
            if verdict.answer is None:
                await log(
                    f"“{check.title}”: {verdict.reason}; the writing agent's finding of a disagreement "
                    "was kept."
                )
            explanation = clean_text(conflict.explanation)
            if explanation and self.ctx.flagged(explanation):
                explanation = ""
            await disk_call(self._report, page_id, side_old, side_new, explanation, check.language)
            found += 1
        await disk_call(self._mark_checked, page_id, [item.block_id for item in new])
        if found:
            await log(f"“{check.title}”: {found} disagreement(s) between sources were marked.")
        return found

    def _report(self, page_id: str, old: Statement, new: Statement, explanation: str, language: str) -> None:
        explanation_id = f"c-disc-{uuid4().hex[:12]}"
        labels = _labels(language)
        body = (
            f"{labels['disagree']}: [[#^{old.block_id}|{old.material_title}]] — "
            f"[[#^{new.block_id}|{new.material_title}]]."
        )
        if explanation:
            body += f" {explanation}"
        block = Block.create(explanation_id, "explanation", body)
        with self.ctx.write_lock:
            library, path = page_path(self.ctx.kb, page_id)

            def build(document: PageDocument) -> PageDocument | None:
                ids = {part.id for part in document.blocks()}
                if old.block_id not in ids or new.block_id not in ids:
                    return None
                parts = list(document.parts)
                insert_into_section(parts, "explanation", document.meta.language or language, [block])
                return replace(document, parts=spaced(parts))

            if not rewrite(library, path, build):
                return
            reindex(self.ctx.kb, library, path)
        page = self.ctx.kb.page(page_id)
        entries = {entry.id: entry for entry in page.entries}

        def side(statement: Statement) -> dict[str, object]:
            entry = entries.get(statement.block_id)
            citation = asdict(entry.citations[0]) if entry and entry.citations else None
            return {
                "block_id": statement.block_id,
                "text": statement.text,
                "citation": citation,
                "material_title": statement.material_title,
                "folder_name": statement.folder_name,
            }

        notification = self.ctx.kb.notify(
            KIND,
            f"Sources disagree on “{page.title}”",
            body=f"“{old.material_title}” and “{new.material_title}” say different things.",
            payload={
                "page_id": page_id,
                "page_title": page.title,
                "sides": [side(old), side(new)],
                "explanation_block_id": explanation_id,
            },
            requires_action=True,
            subject={"type": "page", "id": page_id, "block_id": explanation_id, "seg": None},
        )
        with self.ctx.kb.db.write() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO wiki_discrepancies(id, page_id, block_a, block_b, explanation_id, "
                "notification_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    new_id("dis"),
                    page_id,
                    old.block_id,
                    new.block_id,
                    explanation_id,
                    notification.id,
                    notification.created_at,
                ),
            )

    # -- the notification -------------------------------------------------------

    @staticmethod
    def actions(record: NotificationRecord) -> Sequence[ActionSpec]:
        sides = record.payload.get("sides") or [{}, {}]
        titles = [str(side.get("material_title") or "source") for side in sides[:2]]
        if len(titles) == 2 and titles[0] == titles[1]:
            titles = [
                f"{title} ({side.get('folder_name') or index + 1})"
                for index, (title, side) in enumerate(zip(titles, sides, strict=False))
            ]
        return (
            ActionSpec("keep_both", "Keep both", primary=True),
            # "<X> is right" — the user picks the source that is right, not one to fix (QA C16).
            *(ActionSpec(f"prefer_{index}", f"“{title}” is right") for index, title in enumerate(titles)),
            ActionSpec("own_note", "Write my own note", needs_text=True),
        )

    async def resolve(
        self, kb: KnowledgeService, record: NotificationRecord, action: str, text: str | None
    ) -> None:
        page_id = str(record.payload.get("page_id", ""))
        explanation_id = record.payload.get("explanation_block_id")
        if action == "keep_both":
            return
        if action == "own_note":
            assert text is not None
            exists = isinstance(explanation_id, str) and await disk_call(
                self._has_block, page_id, explanation_id
            )
            await disk_call(
                self._locked, add_note, kb, page_id, text, after_block_id=explanation_id if exists else None
            )
            return
        index = int(action.removeprefix("prefer_"))
        sides = record.payload.get("sides") or []
        winner, loser = sides[index], sides[1 - index]
        await disk_call(
            self._supersede,
            page_id,
            str(loser.get("block_id")),
            str(winner.get("material_title") or "the other source"),
        )

    def _locked(self, function: Callable[..., object], *args: object, **kwargs: object) -> object:
        with self.ctx.write_lock:
            return function(*args, **kwargs)

    def _has_block(self, page_id: str, block_id: str) -> bool:
        return any(block.block_id == block_id for block in self.ctx.kb.page_repo.blocks(page_id))

    def _supersede(self, page_id: str, loser_id: str, winner_title: str) -> None:
        """The losing statement is retired visibly, as the user's decision (QA C16).

        It stays where it was, with its source (the source did say it), but struck through and
        followed by "superseded by <winner> (your choice)"; the block becomes the user's
        (``user_edited``), so ingest never brings it back as a plain statement.
        """
        with self.ctx.write_lock:
            library, path = page_path(self.ctx.kb, page_id)

            def build(document: PageDocument) -> PageDocument:
                index = next(
                    (
                        i
                        for i, part in enumerate(document.parts)
                        if isinstance(part, Block) and part.id == loser_id
                    ),
                    None,
                )
                if index is None:
                    raise SideGone("That statement is no longer on the page.")
                loser = document.parts[index]
                assert isinstance(loser, Block)
                language = document.meta.language or "en"
                links = "".join(match.group(0) for match in _CITATION_LINK.finditer(loser.body))
                text = _CITATION_LINK.sub("", loser.body).strip()
                if text.startswith("~~"):
                    return document  # already retired
                note = _labels(language)["superseded"].format(winner=winner_title)
                body = f"~~{text}~~ {note}{links}"
                retired = replace(loser, body=body, raw=None).remarked(owner="user_edited")
                parts = list(document.parts)
                parts[index] = retired
                return replace(document, parts=spaced(parts))

            rewrite(library, path, build)
            reindex(self.ctx.kb, library, path)


async def no_log(_message: str) -> None:
    await asyncio.sleep(0)
