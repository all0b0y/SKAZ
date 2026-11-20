"""Translate accepted SKAZ actions to local Me observations."""
from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import datetime
from hashlib import sha256
from typing import TYPE_CHECKING

from ...native_io import disk_call
from ..study.activity import CaptureStudyActivity, StudyActivity, StudyObserver
from . import MeError
from .graph import MeGraphStore
from .observations import Action, Offer, TrustedEvent

if TYPE_CHECKING:
    from ..chats.model import Message

_RETURN = re.compile(
    r"(?:let['’]s (?:go|get) back to the original (?:question|goal)"
    r"|return to the original (?:question|goal)|верн[её]мся к исходно(?:му вопросу|й цели))[.!?]?",
    re.IGNORECASE,
)
_CONTINUE = re.compile(
    r"(?:let['’]s continue (?:this branch|on this point)|continue this branch|продолжим эту ветку)[.!?]?",
    re.IGNORECASE,
)


def _label(text: str) -> Action | None:
    clean = text.strip()
    if _RETURN.fullmatch(clean):
        return "return_to_goal"
    return "continue_branch" if _CONTINUE.fullmatch(clean) else None


def _anchor(question: Message, prior: Sequence[Message]) -> str | None:
    picked = question.input.selection if question.input is not None else None
    if picked is None:
        return None
    answers = [item.id for item in prior if item.role == "assistant" and item.state == "done"]
    return picked.message_id if picked.message_id in answers[:-1] else None


def is_branching(question: Message, prior: Sequence[Message]) -> bool:
    """Current turn context only. This does not need, or create, learning evidence."""
    anchor = _anchor(question, prior)
    if anchor is None:
        return False
    last_answer = None
    earlier: set[str] = set()
    for item in prior:
        if item.role == "assistant" and item.state == "done":
            if last_answer is not None:
                earlier.add(last_answer)
            last_answer = item.id
        if item.role == "user" and item.input is not None and item.input.selection is not None:
            other = item.input.selection.message_id
            if other in earlier and other != anchor:
                return True
    return False


def accept_chat(graph: MeGraphStore, question: Message, prior: Sequence[Message], epoch: str) -> None:
    """Only two distinct explicit jumps in accepted turns establish a branching context.

    An intervening visible answer can contain a recap without a typed marker. It is therefore
    insufficient for an independent target label. Old or unobserved turns establish no pivots.
    """
    given = question.input
    if given is None:
        return
    scope = question.chat_id
    stamp = datetime.fromisoformat(question.created_at)
    state = graph.open()
    if state.controls.learning_epoch("chat") != epoch:
        return
    previous = next((item for item in reversed(prior) if item.role == "user"), None)
    episode = state.ledger.episodes.get(previous.id) if previous is not None else None
    if previous is not None and episode is not None and episode.eligible and episode.kind == "opportunity":
        visible_answer = any(
            item.role == "assistant" and item.seq > previous.seq and item.parts for item in prior
        )
        text = given.text if not (given.attachments or given.mentions or given.quotes) else ""
        label = None if visible_answer else _label(text)
        graph.observe(TrustedEvent(
            producer="chat", family="chat_return", event_id=f"{question.id}:outcome",
            source_ref=question.id, episode_id=episode.id, session_id=episode.session_id,
            scope=scope, context_key=episode.context_key, epoch=epoch, sequence=episode.sequence + 1,
            occurred_at=stamp, actor="user", kind="choice" if label else "close", selected=label,
            uncued=label is not None,
        ))
    anchor = _anchor(question, prior)
    if anchor is None:
        return
    visible_ids = {message.id for message in prior}
    has_other_pivot = any(
        item.kind == "branch" and item.epoch == epoch and item.scope == scope
        and item.context_key != anchor and item.id in visible_ids
        for item in state.ledger.episodes.values()
    )
    offers = (Offer(action="return_to_goal"), Offer(action="continue_branch"))
    graph.observe(TrustedEvent(
        producer="chat", family="chat_return", event_id=f"{question.id}:context",
        source_ref=question.id, episode_id=question.id, session_id=scope, scope=scope, epoch=epoch,
        context_key="branching" if has_other_pivot else anchor, sequence=0, occurred_at=stamp,
        kind="opportunity" if has_other_pivot else "branch", actor="system" if has_other_pivot else "user",
        offered_set=offers if has_other_pivot else (),
    ))


def _study_signal(graph: MeGraphStore, epoch: str, event: StudyActivity) -> None:
    # The current UI confirms these actions without confirming that both a voluntary attempt
    # and a walkthrough were available. Record an ineligible episode in the isolated profile.
    identity = sha256(
        f"{event.block_id}\0{event.session_id}\0{event.item_id}\0{event.kind}".encode()
    ).hexdigest()[:32]
    graph.observe(TrustedEvent(
        producer="study", family="study_revision", event_id=identity, episode_id=identity,
        source_ref=event.source_ref, scope=event.block_id, session_id=event.session_id,
        context_key="revision",
        epoch=epoch, sequence=0, occurred_at=datetime.fromisoformat(event.occurred_at),
        kind=event.kind, actor="user",
    ))


def study_observer(graph: MeGraphStore) -> CaptureStudyActivity:
    async def capture() -> StudyObserver | None:
        try:
            epoch = await disk_call(graph.source_epoch, "study")
        except MeError:
            return None
        if epoch is None:
            return None

        async def observe(event: StudyActivity) -> None:
            try:
                await disk_call(_study_signal, graph, epoch, event)
            except MeError:
                # The accepted Study command stays successful when its separate Me write fails.
                return

        return observe

    return capture
