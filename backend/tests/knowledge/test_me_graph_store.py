from __future__ import annotations

from pathlib import Path

import pytest

from skaz.knowledge.me import MeConflict, MeNotFound
from skaz.knowledge.me.graph import GraphUnavailable, MeGraphStore
from skaz.knowledge.me.policy import ProjectionReader, TurnContext
from skaz.knowledge.me.store import MeStore
from skaz.knowledge.me.vault import MeVault


def test_import_preserves_disabled_profile_versions_and_undo(tmp_path: Path) -> None:
    legacy = MeStore(MeVault(tmp_path))
    legacy.update("profile", text="I study applied physics.", enabled=False)
    legacy.update("how-to-work", text="When introducing a term, give one example.")
    edit = legacy.agent_edit("append", skill_id="how-to-work", text="Always use short answers.",
                             chat_id="chat_one", message_id="msg_one")
    legacy.set_enabled(False)
    old_bytes = (tmp_path / "me.json.enc").read_bytes()

    graph = MeGraphStore(tmp_path)
    state = graph.open()
    assert not state.controls.enabled and not state.controls.personal
    assert not state.controls.study and not state.controls.chat
    assert state.entries["how-to-work"][-1].kind == "legacy_import"
    assert state.entries["how-to-work"][-1].origin == "agent"
    assert len(state.entries["how-to-work"]) == 2
    assert (tmp_path / "me.json.enc").read_bytes() == old_bytes

    restored = graph.undo(edit.id)
    assert restored.text == "When introducing a term, give one example."
    reopened = MeGraphStore(tmp_path).open()
    assert reopened.entries["how-to-work"][-1] == restored
    assert reopened.edits[edit.id].undone
    graph.erase(graph.open().revision)
    with pytest.raises(MeNotFound):
        graph.undo(edit.id)


@pytest.mark.parametrize("interrupted_phase", ["preparing", "verified", "graph"])
def test_migration_resumes_exact_candidate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                          interrupted_phase: str) -> None:
    legacy = MeStore(MeVault(tmp_path))
    legacy.create("Work routine", "After a review", "1. Read\n2. Verify")
    graph = MeGraphStore(tmp_path)
    save = graph.vault.write

    def interrupted(data: dict[str, object]) -> None:
        save(data)
        if data["phase"] == interrupted_phase:
            raise OSError("simulated process interruption")

    monkeypatch.setattr(graph.vault, "write", interrupted)
    with pytest.raises(GraphUnavailable):
        graph.open()
    current = MeGraphStore(tmp_path).open()
    assert current.phase == "graph"
    assert current.entries["work-routine"][-1].text == "1. Read\n2. Verify"


def test_corrupt_legacy_is_distinct_from_an_empty_profile(tmp_path: Path) -> None:
    original = tmp_path / "me.json.enc"
    original.write_bytes(b"not an encrypted profile")
    graph = MeGraphStore(tmp_path)
    with pytest.raises(GraphUnavailable):
        graph.open()
    assert original.read_bytes() == b"not an encrypted profile"
    assert not graph.vault.path.exists()


def test_revisions_and_erase_survive_restart(tmp_path: Path) -> None:
    legacy = MeStore(MeVault(tmp_path))
    legacy.update("profile", text="I study a private subject.")
    graph = MeGraphStore(tmp_path)
    original = graph.create(text="Always use short answers.", area="chat")
    first_key = graph.vault.key_path.read_bytes()
    unused_by_me = tmp_path / "provider-fixture.key"
    unused_by_me.write_bytes(b"synthetic fixture")
    changed = graph.update(original.id, original.revision, enabled=False)
    with pytest.raises(MeConflict):
        MeGraphStore(tmp_path).update(original.id, original.revision, enabled=True)
    changed = graph.restore(changed.id, changed.revision, original.revision)
    assert not changed.enabled
    assert b"short answers" not in graph.vault.path.read_bytes()
    graph.forget(changed.id, changed.revision)
    with pytest.raises(MeNotFound):
        graph.restore(changed.id, changed.revision, original.revision)
    before = graph.open().controls.epoch
    state = graph.erase(graph.open().revision)
    assert state.controls.epoch != before
    assert not state.controls.study and not state.controls.chat
    assert graph.vault.key_path.read_bytes() != first_key
    assert not (tmp_path / "me.json.enc").exists()
    assert not (tmp_path / "me.key").exists()
    assert unused_by_me.read_bytes() == b"synthetic fixture"
    assert MeGraphStore(tmp_path).open().entries == {}


def test_cold_rule_applies_after_unrelated_turns_and_checks_the_local_exception(tmp_path: Path) -> None:
    graph = MeGraphStore(tmp_path / "one")
    reader = ProjectionReader(capacity=1)
    rule = "When introducing a term, give one example."
    graph.create(text=rule, area="chat")
    context = TurnContext("chat_one", "Define momentum.", "introduce_term", False)
    warm = reader.read(graph.open(), context, frozenset(), opportunity=True)
    assert rule in warm.block
    reader.materialized(warm)
    unrelated = TurnContext("chat_one", "Continue the list.", "unknown", False)
    for _ in range(100):
        assert not reader.read(graph.open(), unrelated, frozenset(), opportunity=True).block
    reopened = MeGraphStore(tmp_path / "one")
    cold = ProjectionReader()
    assert cold.read(reopened.open(), context, frozenset()).block == warm.block
    assert not cold.read(MeGraphStore(tmp_path / "two").open(), context, frozenset()).block
    exception = "When introducing a term, don't give examples."
    reopened.remember(text=exception, area="chat", chat_id="chat_one", source_id="source_one",
                      answer_id="answer_one", epoch=reopened.current_epoch())
    narrowed = cold.read(reopened.open(), context, frozenset())
    assert exception in narrowed.block and rule not in narrowed.block
    elsewhere = TurnContext("chat_two", "Define momentum.", "introduce_term", False)
    assert rule in cold.read(reopened.open(), elsewhere, frozenset()).block
