"""P3-c: «Ask the agent» on a test question — the question goes with the chat message as a chip.

Decisions 11–12 of ``P3-OPEN-ANSWER-FEEDBACK.md``. The P2 selection carries the test block and the
question by id (``kind="study"``); nothing but the ids is trusted from the client. What the agent gets
depends on the user's answer, enforced here and not by a prompt:

* not checked yet — the question, its type and the options as the user sees them, and that the user
  has not answered: never the right answer(s), which option comes from the source, the accepted
  spellings, the agent's explanation or the source quotes (they hold the answer);
* checked — the full context: the options with where each comes from, the user's answer and how it
  went (an open answer: its status and key ideas), the right answer, the source with quotes.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from ..chats.model import SelectedItem, Selection
from ..chats.selection import SelectionInvalid
from .format import Question
from .review import STATUSES

if TYPE_CHECKING:  # the service imports this module
    from .service import StudyService

GONE = "This test is no longer here."
_STATUS_WORDS = {"got": "got it", "almost": "almost there", "not_yet": "not yet"}


def _place(study: StudyService, block_id: str, item_id: str) -> tuple[Any, Question, int, int]:
    block = study.store.block(block_id)
    if block is None or block.kind != "test":
        raise SelectionInvalid(GONE)
    questions = {q.id: q for q in study.questions(block)}
    order = [i for i in study._test_order(block) if i in questions]
    if item_id not in questions:
        raise SelectionInvalid("This question is no longer in the test.")
    number = order.index(item_id) + 1 if item_id in order else 1
    return block, questions[item_id], number, len(order) or len(questions)


def check_study_selection(study: StudyService, selection: Selection) -> Selection:
    """The «📍 question N» chip as stored: one question of an existing test block, its number, the title."""
    ids = list(dict.fromkeys(item.id for item in selection.items))
    if len(ids) != 1:
        raise SelectionInvalid("Ask about one question at a time.")
    block, _question, number, _total = _place(study, selection.block_id, ids[0])
    return Selection(block.message_id, block.id, "study", block.title,
                     (SelectedItem(ids[0], f"question {number}"),), "ask")


def study_folders(study: StudyService, block_id: str) -> list[str]:
    """The folders a chat asking about this test belongs to (a new chat from a wiki test is in its folder)."""
    block = study.store.block(block_id)
    if block is None:
        return []
    if block.page_id:
        record = study.kb.page_repo.get(block.page_id)
        if record is not None:
            return list(record.folders)
    return [block.folder_id] if block.folder_id else []


def _entry(study: StudyService, block: Any, item_id: str) -> dict[str, Any] | None:
    attempt = study.attempt(block)
    entry = (attempt.answers.get("items") or {}).get(item_id) if attempt is not None else None
    return dict(entry) if entry else None


NOT_ANSWERED = (
    "The user asks about this question of their test (pressed «Ask the agent»). They have NOT answered "
    "it yet: explain only what the question asks and the ideas or terms it needs. Never give the answer "
    "away and never say or hint which option is right; if they ask for the answer, suggest they answer "
    "first. Answer in the language of the question unless the user wrote their own words in another "
    "language. The question:"
)
ANSWERED = (
    "The user asks about this question of their test (pressed «Ask the agent») after answering it. "
    "Explain the question and the right answer from the source — read and cite the fragments "
    "(⟦m:<material_id>:<seg>|<exact words>⟧); what the user got right first, then what to add, kindly. "
    "Answer in the language of the question unless the user wrote their own words in another language. "
    "The question:"
)


def question_context(study: StudyService, block_id: str, item_id: str) -> tuple[str, str, str] | None:
    """(note, label, body) for the chat question's context; ``None`` when the test is gone since."""
    try:
        block, question, number, total = _place(study, block_id, item_id)
    except SelectionInvalid:
        return None
    entry = _entry(study, block, item_id)
    checked = bool(entry and entry.get("checked"))
    options = study.options(block, question)
    shown: dict[str, Any] = {"test": block.title, "question_number": f"{number} of {total}",
                             "type": question.type, "question": question.question}
    if not checked:
        # Only what the user sees before answering: the options' words, never their origin.
        if options:
            shown["options"] = [f"{chr(65 + n)}. {option['text']}" for n, option in enumerate(options)]
        shown["answered"] = False
        return NOT_ANSWERED, "test question", json.dumps(shown, ensure_ascii=False, indent=1)
    assert entry is not None
    if options:
        shown["options"] = [
            {"key": chr(65 + n), "text": option["text"],
             "from": "the source (right)" if option["origin"] == "source" else "made up by the agent (wrong)",
             "picked_by_user": option["id"] in (entry.get("choices") or [])}
            for n, option in enumerate(options)
        ]
    else:
        shown["user_answer"] = entry.get("text")
    if entry.get("status") in _STATUS_WORDS:
        shown["result"] = _STATUS_WORDS[entry["status"]] + " (the agent's review, counted by SKAZ)"
        ideas = (entry.get("review") or {}).get("ideas") or []
        shown["key_ideas"] = [{"idea": idea.get("text"),
                               "status": "covered (counted by the user)" if idea.get("by_user")
                               else idea.get("status") if idea.get("status") in STATUSES else "missing"}
                              for idea in ideas]
    else:
        shown["result"] = "right" if float(entry.get("score") or 0.0) >= 1.0 else "not yet right"
    shown["right_answer"] = list(question.answers)
    if question.accept:
        shown["also_accepted"] = list(question.accept)
    shown["source"] = [{"cite": f"m:{c.material_id}:{c.seg}", "quote": c.quote} for c in question.cites]
    if question.explanation:
        shown["agent_explanation"] = question.explanation
    shown["answered"] = True
    return ANSWERED, "test question", json.dumps(shown, ensure_ascii=False, indent=1)
