"""P3-b: the user's «Unclear» marks as the agent reads them (``skaz_study_unclear``) and the UI lists them.

Decisions 8–10 of ``P3-OPEN-ANSWER-FEEDBACK.md``: a mark lives on the card or test question (not the
attempt), survives retakes, is never cleared by a right answer and never touches FSRS; only the user
clears it. The agent only reads them — every item with its text, type, options, right answer, the
user's last answer, its source with the quote and where it is — in the scope of the chat: its folders,
or the whole library when the chat has none («All»). A test question the user has not answered yet
(decision 12, Q1 p3 H2) goes without its right answer, which option is right, the explanation and the
source quotes — only what the user sees before answering, and ``answered: false``.

In a chat whose sources are narrowed (N7-4, ``scope``) an item resting on sources outside them is left
out and counted, judged by its real citations *before* an unanswered question's are stripped (so such
a question can't slip through for lack of a source); the quotes of outside sources on a kept item are
withheld (Q1 n78 H-1 × p3 H2).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from ..errors import KnowledgeError
from ..permissions.source_scope import SourceScope, unclear_item_allowed, withhold_quotes
from .format import Card, Question, read_cards, read_questions
from .items import ItemRow
from .scheduling import RATING

if TYPE_CHECKING:  # the service imports this module
    from .service import StudyService

MAX_ITEMS = 40
_GRADE = {int(value): name for name, value in RATING.items()}


def _cites(item: Card | Question) -> list[dict[str, Any]]:
    return [{"cite": f"m:{c.material_id}:{c.seg}", "quote": c.quote} for c in item.cites]


def _resolve(study: StudyService, row: ItemRow) -> tuple[Card | Question, str, tuple[str, ...], str] | None:
    """The item as it is now: (item, title of its deck/test, its folders, where it is); ``None`` if gone."""
    if row.page_id:
        record = study.kb.page_repo.get(row.page_id)
        if record is not None:
            try:
                document = study._document(row.page_id)
            except (KnowledgeError, OSError, ValueError, UnicodeDecodeError):
                return None
            found: Card | Question | None = (
                next((c for c in read_cards(document) if c.id == row.item_id), None)
                if row.kind == "card"
                else next((q for q in read_questions(document) if q.id == row.item_id), None)
            )
            if found is None:
                return None
            return found, record.title, tuple(record.folders), f"p:{row.page_id}#{row.item_id}"
    block = study.store.block(row.block_id) if row.block_id else None
    if block is None:
        return None
    if row.kind == "card":
        card = next((c for c, _page in study.cards(block) if c.id == row.item_id), None)
        item: Card | Question | None = card
    else:
        item = next((q for q in study.questions(block) if q.id == row.item_id), None)
    if item is None:
        return None
    kind = "deck" if block.kind == "deck" else "test"
    where = f"{kind} block {block.id} in chat {block.chat_id} (not saved)"
    return item, block.title, (block.folder_id,) if block.folder_id else (), where


def _orphaned(study: StudyService, row: ItemRow) -> bool:
    """Neither the block it was marked in nor its saved page exists any more."""
    block_gone = row.block_id is None or study.store.block(row.block_id) is None
    return block_gone and (row.page_id is None or study.kb.page_repo.get(row.page_id) is None)


def _newest_entry(study: StudyService, row: ItemRow, question: Question) -> dict[str, Any] | None:
    """The user's answer in the newest attempt that asks this question; ``None``: not answered there.

    Any block showing the question counts (the chat block, or a block of its saved page); in a block,
    its current attempt wins (a retake asks the question again, so until it is answered there the
    question is unanswered — decision 12), unless that attempt leaves the question out («tricky ones»).
    """
    blocks = list(dict.fromkeys([*([row.block_id] if row.block_id else []),
                                 *(study.store.block_ids_of_page(row.page_id) if row.page_id else [])]))
    newest: tuple[str, dict[str, Any] | None] | None = None
    for block_id in blocks:
        block = study.store.block(block_id)
        if block is None:
            continue
        asking = []
        for attempt in study.store.attempts(block_id):
            order = attempt.answers.get("order") or []
            entry = (attempt.answers.get("items") or {}).get(question.id)
            if entry or not order or question.id in order:
                asking.append((attempt, entry))
        if not asking:
            continue
        current = block.state.get("attempt")
        attempt, entry = next((pair for pair in asking if pair[0].id == current), asking[-1])
        if newest is None or attempt.started_at >= newest[0]:
            newest = (attempt.started_at, dict(entry) if entry else None)
    return newest[1] if newest is not None else None


def _last_answer(entry: dict[str, Any], question: Question) -> str | None:
    """What the user answered, and how it went."""
    if entry.get("choices"):
        texts = {f"r{n}": text for n, text in enumerate(question.answers)}
        texts.update({f"w{n}": text for n, text in enumerate(question.wrong)})
        given = "; ".join(str(texts.get(choice) or choice) for choice in entry["choices"])
    else:
        given = str(entry.get("text") or "")
    if not given:
        return None
    if entry.get("status"):
        state = {"got": "got it", "almost": "almost there", "not_yet": "not yet"}.get(entry["status"], "")
    elif entry.get("checked"):
        state = "right" if float(entry.get("score") or 0.0) >= 1.0 else "not right"
    else:
        state = "not checked"
    return f"{given} ({state})"


def unclear_items(study: StudyService, folders: Sequence[str] | None, page_id: str | None = None
                  ) -> list[dict[str, Any]]:
    """Items marked «Unclear» in ``folders`` (``None`` or empty = the whole library), oldest mark first."""
    return scoped_unclear_items(study, folders, page_id, None)[0]


def scoped_unclear_items(study: StudyService, folders: Sequence[str] | None, page_id: str | None,
                         scope: SourceScope | None) -> tuple[list[dict[str, Any]], int]:
    """:func:`unclear_items` as a chat with these sources may read them: (items, how many left out)."""
    out: list[dict[str, Any]] = []
    left_out = 0
    wanted = set(folders or ())
    orphans: list[str] = []
    for row in study.items.unclear():
        if page_id is not None and row.page_id != page_id:
            continue
        resolved = _resolve(study, row)
        if resolved is None:
            if _orphaned(study, row):
                orphans.append(row.item_id)  # its chat and page are deleted: forget it (Q1 p3 L3)
            continue
        item, title, item_folders, where = resolved
        if wanted and not wanted & set(item_folders):
            continue
        entry: dict[str, Any] = {"item_id": row.item_id, "in": title, "where": where, "page_id": row.page_id}
        if scope is not None and not unclear_item_allowed({**entry, "source": _cites(item)}, scope):
            left_out += 1
            continue
        if isinstance(item, Question):
            entry.update({"kind": "test question", "type": item.type, "question": item.question})
            given = _newest_entry(study, row, item)
            if not (given and given.get("checked")):
                # Not answered (or not checked) yet: only what the user sees before answering — the
                # options' words in a neutral order, never which is right, the answer or its source
                # (decision 12, in code, the same as «Ask the agent» in ``ask.py``).
                if item.type in ("choice", "multi"):
                    entry["options"] = [{"text": text} for text in sorted([*item.answers, *item.wrong])]
                entry.update({"answered": False, "last_answer": None})
                out.append(entry)
                if len(out) >= MAX_ITEMS:
                    break
                continue
            if item.type in ("choice", "multi"):
                entry["options"] = [{"text": text, "right": True} for text in item.answers] + [
                    {"text": text, "right": False, "made_up_by_agent": True} for text in item.wrong]
            entry["right_answer"] = list(item.answers)
            entry["last_answer"] = _last_answer(given, item)
            entry["answered"] = True
        else:
            entry.update({"kind": "flashcard", "question": item.question, "right_answer": [item.answer]})
            rating = study.store.last_rating(item.id)
            entry["last_answer"] = f"graded {_GRADE.get(rating, '?')}" if rating else None
        entry["source"] = _cites(item)
        if scope is not None:
            withhold_quotes(entry["source"], scope)
        if item.explanation:
            entry["agent_explanation"] = item.explanation
        out.append(entry)
        if len(out) >= MAX_ITEMS:
            break
    study.items.forget(orphans)
    return out, left_out
