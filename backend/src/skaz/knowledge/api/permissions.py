"""``/kb/permissions`` and ``/kb/questions``: the user's answers to agents (0.3.1 phase P).

* ``POST /kb/permissions/{id}/decide`` — Allow / Allow in this chat / Deny (+ reason); 409 when
  already decided (``ALREADY_DECIDED``) or nobody waits any more (``NOT_WAITING``), 422 for
  "Allow in this chat" on a deletion (deleting always asks).
* ``POST /kb/permissions/{id}/undo`` — puts the files back as they were before the change;
  409 ``CHANGED`` once a file changed since (the reason in words), ``NOT_APPLIED`` otherwise.
* ``POST /kb/questions/{id}/answer`` — an option or the user's own answer; after the agent
  stopped waiting it goes to the chat as a new message "Answer to the question: …".

Each returns the part as the chat shows it; the chat also gets a ``part_update`` event.
"""
from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, Request

from ..permissions.broker import PermissionBroker
from ..permissions.questions import QuestionBroker
from ..permissions.wiki_tools import WikiEditor
from .chats import ChatRoute, permission_part, question_part
from .deps import kb_call
from .schemas_chats import KbPermissionDecide, KbPermissionPart, KbQuestionAnswer, KbQuestionPart

router = APIRouter(prefix="/kb", tags=["kb"], route_class=ChatRoute)


def get_permissions(request: Request) -> PermissionBroker:
    return cast(PermissionBroker, request.app.state.runtime.kb_permissions)


def get_questions(request: Request) -> QuestionBroker:
    return cast(QuestionBroker, request.app.state.runtime.kb_questions)


def get_editor(request: Request) -> WikiEditor:
    return cast(WikiEditor, request.app.state.runtime.kb_wiki_edits)


PermissionsDep = Annotated[PermissionBroker, Depends(get_permissions)]
QuestionsDep = Annotated[QuestionBroker, Depends(get_questions)]
EditorDep = Annotated[WikiEditor, Depends(get_editor)]


@router.post("/permissions/{permission_id}/decide")
async def decide_permission(permission_id: str, body: KbPermissionDecide,
                            permissions: PermissionsDep) -> KbPermissionPart:
    """The agent waits for this; it gets the decision (and a Deny's reason) right away."""
    record = await permissions.decide(permission_id, body.decision, body.reason)
    return await kb_call(permission_part, record)


@router.post("/permissions/{permission_id}/undo")
async def undo_permission(permission_id: str, editor: EditorDep) -> KbPermissionPart:
    """Undo an applied change (e.g. one allowed by "Allow in this chat")."""
    record = await editor.undo(permission_id)
    return await kb_call(permission_part, record)


@router.post("/questions/{question_id}/answer")
async def answer_question(question_id: str, body: KbQuestionAnswer,
                          questions: QuestionsDep) -> KbQuestionPart:
    record = await questions.answer(question_id, option_index=body.option_index, text=body.text)
    return await kb_call(question_part, record)
