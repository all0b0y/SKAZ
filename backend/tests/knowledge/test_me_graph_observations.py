from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from skaz.knowledge.chats.model import Message, MessageInput, Selection, TextPart
from skaz.knowledge.me import MeConflict
from skaz.knowledge.me.adapters import accept_chat
from skaz.knowledge.me.graph import MeGraphStore
from skaz.knowledge.me.observations import Offer, TrustedEvent, pattern_id
from skaz.knowledge.me.policy import TurnContext, resolve

NOW = datetime(2026, 1, 1, 10, tzinfo=UTC)


def observation(number: int, epoch: str, *, kind: str = "opportunity",
                choice: str | None = None, both: bool = True) -> TrustedEvent:
    offers = [Offer(action="allow_attempt", position=0)]
    if both:
        offers.append(Offer(action="show_walkthrough", position=1))
    return TrustedEvent.model_validate({
        "schema_version": 1, "producer": "study", "family": "study_revision",
        "scope": "deck_1", "session_id": f"session_{number}", "context_key": "revision",
        "episode_id": f"episode_{number}", "source_ref": f"source_{number}", "epoch": epoch,
        "event_id": f"event_{number}_{kind}", "kind": kind, "selected": choice,
        "sequence": int(kind != "opportunity"), "actor": "system" if kind == "opportunity" else "user",
        "occurred_at": NOW + timedelta(minutes=number),
        "offered_set": offers if kind == "opportunity" else [],
    })


def test_shadow_replay_dedup_and_counterexample(tmp_path: Path) -> None:
    graph = MeGraphStore(tmp_path, clock=NOW.isoformat)
    assert graph.observe(observation(0, graph.open().controls.epoch)) == "ignored"
    state = graph.set_controls(graph.open().revision, study=True)
    epoch = state.controls.study_epoch
    for number in range(6):
        opening = observation(number, epoch)
        assert graph.observe(opening) == "accepted"
        assert graph.observe(opening) == "duplicate"
        decision = observation(number, epoch, kind="choice", choice="allow_attempt")
        assert graph.observe(decision) == "accepted"
    done = observation(6, epoch, kind="choice", choice="show_walkthrough")
    assert graph.observe(observation(6, epoch)) == "accepted"
    before = graph.open().ledger.episodes[done.episode_id].forecast
    assert before is not None and before.graph > 0.7
    assert graph.observe(done) == "accepted"
    with pytest.raises(MeConflict):
        graph.observe(done.model_copy(update={"selected": "allow_attempt"}))
    later = graph.open().ledger
    assert later.episodes[done.episode_id].forecast == before
    [pattern] = later.patterns.values()
    assert (pattern.positive, pattern.negative, pattern.unknown, pattern.sessions) == (6, 1, 0, 7)
    revision = TurnContext("chat_one", "Help me revise.", "revision", True, practice_scope="deck_1")
    assert not resolve(graph.open(), revision).block
    study_block = resolve(graph.open(), revision, frozenset({"study_revision"})).block
    assert "allow_attempt" in study_block and "let the user try" not in study_block
    other = TurnContext("chat_one", "Help me revise.", "revision", True, practice_scope="deck_2")
    assert not resolve(graph.open(), other, frozenset({"study_revision"})).block
    override = TurnContext("chat_one", "Show me the walkthrough.", "revision", True, practice_scope="deck_1")
    assert not resolve(graph.open(), override, frozenset({"study_revision"})).block
    assert graph.observe(observation(7, epoch, both=False)) == "accepted"
    assert graph.observe(observation(7, epoch, kind="choice", choice="show_walkthrough")) == "ignored"
    assert graph.open().ledger.patterns[pattern.id].negative == 1

    assert graph.revoke_sources({"source_6"})
    after = MeGraphStore(tmp_path).open()
    assert after.ledger.patterns[pattern.id].negative == 0
    assert graph.observe(done) == "ignored"
    graph.revoke_sources({"source_0"})
    after_withdrawal = graph.open()
    assert after_withdrawal.ledger.episodes["episode_1"].forecast is None
    assert after_withdrawal.ledger.patterns[pattern.id].positive == 5


def test_pending_observation_cannot_commit_after_revocation(tmp_path: Path) -> None:
    graph = MeGraphStore(tmp_path)
    state = graph.set_controls(graph.open().revision, study=True)
    opening = observation(0, state.controls.study_epoch)
    graph.observe(opening)
    disabled = graph.set_controls(graph.open().revision, study=False)
    restored = graph.set_controls(disabled.revision, study=True)
    assert restored.controls.study_epoch != state.controls.study_epoch
    assert MeGraphStore(tmp_path).observe(observation(
        0, state.controls.study_epoch, kind="choice", choice="allow_attempt",
    )) == "ignored"
    [pattern] = graph.open().ledger.patterns.values()
    assert (pattern.unknown, pattern.negative) == (1, 0)
    graph.forget_pattern(pattern.id, pattern.revision)
    assert graph.observe(opening.model_copy(update={"epoch": restored.controls.study_epoch})) == "ignored"
    assert not graph.open().ledger.patterns


def test_source_switches_have_independent_pending_epochs(tmp_path: Path) -> None:
    graph = MeGraphStore(tmp_path)
    state = graph.set_controls(graph.open().revision, study=True, chat=True)
    opening = observation(0, state.controls.study_epoch)
    assert graph.observe(opening) == "accepted"
    changed = graph.set_controls(graph.open().revision, chat=False)
    assert changed.controls.study_epoch == state.controls.study_epoch
    assert graph.observe(observation(
        0, state.controls.study_epoch, kind="choice", choice="allow_attempt",
    )) == "accepted"


@pytest.mark.parametrize("with_answer", [False, True])
def test_chat_outcome_is_unknown_if_an_answer_may_have_intervened(
    tmp_path: Path, with_answer: bool,
) -> None:
    graph = MeGraphStore(tmp_path, clock=NOW.isoformat)
    state = graph.set_controls(graph.open().revision, chat=True)
    epoch = state.controls.chat_epoch
    chat = "synthetic_chat"

    def answer(name: str, number: int) -> Message:
        return Message(
            name, chat, number, "assistant", "done", NOW.isoformat(), parts=(TextPart("A detail."),),
        )

    def question(name: str, number: int, text: str, anchor: str | None = None) -> Message:
        picked = Selection(anchor, "block_one", "block", None, ()) if anchor is not None else None
        return Message(
            name, chat, number, "user", "done", NOW.isoformat(),
            parts=(), input=MessageInput(text, selection=picked),
        )

    prior = [answer("answer_one", 1), answer("answer_two", 2)]
    pivot = question("pivot_one", 3, "Explore this point.", "answer_one")
    accept_chat(graph, pivot, prior, epoch)
    prior += [pivot, answer("answer_three", 4)]
    step = question("pivot_two", 5, "Explore another point.", "answer_two")
    accept_chat(graph, step, prior, epoch)
    [pending] = graph.open().ledger.patterns.values()
    assert pending.unknown == 1 and not pending.positive
    prior.append(step)
    if with_answer:
        prior.append(answer("answer_four", 6))
    label = "Let's go back to the original question."
    accept_chat(graph, question("return", 7, label), prior, epoch)
    ledger = graph.open().ledger
    [after] = ledger.patterns.values()
    assert (after.positive, after.unknown) == ((0, 1) if with_answer else (1, 0))
    assert not after.negative and label not in ledger.model_dump_json()


def test_separate_chats_support_one_action_only_in_branching_discussions(tmp_path: Path) -> None:
    graph = MeGraphStore(tmp_path, admitted=frozenset({"chat_return"}))
    epoch = graph.set_controls(graph.open().revision, chat=True).controls.chat_epoch

    def discussion(chat: str) -> None:
        prior: list[Message] = []

        def answer() -> None:
            sequence = len(prior)
            prior.append(Message(f"{chat}_a{sequence}", chat, sequence, "assistant", "done", NOW.isoformat(),
                                 parts=(TextPart("A separate detail."),)))

        def user(text: str, anchor: int | None = None) -> None:
            sequence = len(prior)
            picked = (Selection(prior[anchor].id, "block", "block", None, ())
                      if anchor is not None else None)
            question = Message(f"{chat}_q{sequence}", chat, sequence, "user", "done", NOW.isoformat(),
                               parts=(), input=MessageInput(text, selection=picked))
            accept_chat(graph, question, prior, epoch)
            prior.append(question)

        answer()
        answer()
        user("Explore this", 0)
        answer()
        for _ in range(2):
            user("Explore that", 1)
            user("Let's go back to the original question.")
            answer()

    for chat in ("one", "two", "three"):
        discussion(chat)
    state = graph.open()
    [pattern] = state.ledger.patterns.values()
    assert (pattern.positive, pattern.sessions) == (6, 3)
    next_chat = TurnContext("four", "More", "branching", False)
    branch_block = resolve(state, next_chat, graph.admitted).block
    assert "return_to_goal" in branch_block and "Offer a short recap" not in branch_block
    local_opt_out = pattern_id("chat_return", "four", "branching")
    opted_out = state.model_copy(update={"ledger": state.ledger.model_copy(update={
        "suppressed": frozenset({local_opt_out}),
    })})
    assert not resolve(opted_out, next_chat, graph.admitted).block
    other_chat = TurnContext("five", "More", "branching", False)
    assert "return_to_goal" in resolve(opted_out, other_chat, graph.admitted).block
    assert not resolve(state, TurnContext("four", "More", "unknown", False), graph.admitted).block
    graph.revoke_sources(set(), scope="one", keep_experience=True)
    preserved = MeGraphStore(tmp_path).open()
    [same] = preserved.ledger.patterns.values()
    assert (same.positive, same.sessions, same.forecast) == (6, 3, pattern.forecast)
    assert not any(e.session_id == "one" for e in preserved.ledger.episodes.values())
    graph.revoke_sources(set(), scope="two")
    [less] = graph.open().ledger.patterns.values()
    assert (less.positive, less.sessions) == (4, 2)
    assert not resolve(graph.open(), next_chat, graph.admitted).block
    graph.forget_pattern(less.id, less.revision)
    assert not MeGraphStore(tmp_path).open().ledger.patterns


@pytest.mark.parametrize("disabled", [False, True])
def test_retention_choice_for_pre_upgrade_chat_pattern(tmp_path: Path, disabled: bool) -> None:
    from skaz.knowledge.me.observations import SHARED_CHAT

    graph = MeGraphStore(tmp_path, new_profile=True)
    epoch = graph.open().controls.chat_epoch
    event = TrustedEvent(
        producer="chat", family="chat_return", session_id="old", scope="old", epoch=epoch,
        episode_id="pivot", source_ref="question", event_id="open", context_key="branching",
        occurred_at=NOW, sequence=0, kind="opportunity", actor="system",
        offered_set=(Offer(action="return_to_goal"), Offer(action="continue_branch")),
    )
    graph.observe(event)
    graph.observe(event.model_copy(update={
        "event_id": "picked", "sequence": 1, "kind": "choice", "actor": "user",
        "selected": "return_to_goal", "uncued": True,
    }))
    [local] = graph.open().ledger.patterns.values()
    if disabled:
        graph.set_pattern_enabled(local.id, local.revision, False)
    graph.revoke_sources({"question"}, scope="old", keep_experience=True)
    after = MeGraphStore(tmp_path).open().ledger
    assert not after.episodes
    if disabled:
        assert not after.patterns
    else:
        [shared] = after.patterns.values()
        assert (shared.scope, shared.positive, shared.sessions) == (SHARED_CHAT, 1, 1)
