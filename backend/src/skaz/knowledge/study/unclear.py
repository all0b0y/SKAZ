"""P3-b: the user's «Unclear» marks as the agent reads them (``skaz_study_unclear``) and the UI lists them.

Decisions 8–10 of ``P3-OPEN-ANSWER-FEEDBACK.md``: a mark lives on the card or test question (not the
attempt), survives retakes, is never cleared by a right answer and never touches FSRS; only the user
clears it. The agent only reads them — every item with its text, type, options, right answer, the
user's last answer, its source with the quote and where it is — in the scope of the chat: its folders,
or the whole library when the chat has none («All»).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from ..errors import KnowledgeError
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


def _last_answer(study: StudyService, row: ItemRow, question: Question) -> str | None:
    """What the user answered last time, in any attempt of a block showing this question."""
    blocks = list(dict.fromkeys([*([row.block_id] if row.block_id else []),
                                 *(study.store.block_ids_of_page(row.page_id) if row.page_id else [])]))
    newest: tuple[str, dict[str, Any]] | None = None
    for block_id in blocks:
        for attempt in study.store.attempts(block_id):
            entry = (attempt.answers.get("items") or {}).get(question.id)
            if entry and (newest is None or attempt.started_at >= newest[0]):
                newest = (attempt.started_at, dict(entry))
    if newest is None:
        return None
    entry = newest[1]
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
    out: list[dict[str, Any]] = []
    wanted = set(folders or ())
    for row in study.items.unclear():
        if page_id is not None and row.page_id != page_id:
            continue
        resolved = _resolve(study, row)
        if resolved is None:
            continue
        item, title, item_folders, where = resolved
        if wanted and not wanted & set(item_folders):
            continue
        entry: dict[str, Any] = {"item_id": row.item_id, "in": title, "where": where, "page_id": row.page_id}
        if isinstance(item, Question):
            entry.update({"kind": "test question", "type": item.type, "question": item.question})
            if item.type in ("choice", "multi"):
                entry["options"] = [{"text": text, "right": True} for text in item.answers] + [
                    {"text": text, "right": False, "made_up_by_agent": True} for text in item.wrong]
            entry["right_answer"] = list(item.answers)
            entry["last_answer"] = _last_answer(study, row, item)
        else:
            entry.update({"kind": "flashcard", "question": item.question, "right_answer": [item.answer]})
            rating = study.store.last_rating(item.id)
            entry["last_answer"] = f"graded {_GRADE.get(rating, '?')}" if rating else None
        entry["source"] = _cites(item)
        if item.explanation:
            entry["agent_explanation"] = item.explanation
        out.append(entry)
        if len(out) >= MAX_ITEMS:
            break
    return out
