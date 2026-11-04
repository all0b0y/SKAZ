"""N6 «Я» store: encryption at rest, limits, versions / restore, agents' edits and Undo (decisions 3–8)."""
from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from skaz.knowledge.me import (
    HOW_TO_WORK,
    HOW_TO_WORK_LIMIT,
    MAX_VERSIONS,
    PROFILE,
    PROFILE_LIMIT,
    SEARCH,
    MeConflict,
    MeError,
    MeLimitExceeded,
    MeNotFound,
)
from skaz.knowledge.me.store import MeStore
from skaz.knowledge.me.vault import KEY_NAME, UNREADABLE_SUFFIX, VAULT_NAME, MeVault

SECRET = "Меня зовут Аглая Секретова, учусь в МГУ"


@pytest.fixture
def folder(tmp_path: Path) -> Path:
    return tmp_path / "secrets"


def store_at(folder: Path) -> MeStore:
    return MeStore(MeVault(folder))


def test_builtins_come_first_empty_and_on(folder: Path) -> None:
    store = store_at(folder)
    store.create("Zeta habits", "Last by title", "z")
    store.create("Alpha habits", "First by title", "a")
    skills = store.skills()
    assert [skill.id for skill in skills] == [PROFILE, HOW_TO_WORK, SEARCH, "alpha-habits", "zeta-habits"]
    profile, how, search = skills[:3]
    assert (profile.title, profile.kind, profile.limit, profile.always_on) == (
        "Profile", "profile", PROFILE_LIMIT, True)
    assert (how.title, how.kind, how.limit, how.always_on) == ("How to work with me", "how_to_work",
                                                               HOW_TO_WORK_LIMIT, True)
    assert (search.title, search.kind, search.limit, search.always_on) == ("Search", "search", None, False)
    assert all(skill.enabled and skill.builtin for skill in skills[:3])
    assert (profile.version, profile.chars, profile.updated_at) == (0, 0, None)
    assert store.enabled() is True


def test_saved_profile_is_encrypted_at_rest_with_private_permissions(folder: Path) -> None:
    store = store_at(folder)
    store.update(PROFILE, text=SECRET)
    store.create("Ответы", "Как отвечать на вопросы", "Сначала пример, потом теория")
    vault = folder / VAULT_NAME
    blob = vault.read_bytes()
    for plain in (SECRET, "Аглая", "Секретова", "Сначала пример", "Ответы"):
        assert plain.encode() not in blob
    assert stat.S_IMODE(os.stat(vault).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(folder / KEY_NAME).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(folder).st_mode) == 0o700
    # A fresh process reads it back.
    again = store_at(folder)
    assert again.skill(PROFILE).text == SECRET
    assert again.skill(_id_of(again, "Ответы")).text == "Сначала пример, потом теория"


def _id_of(store: MeStore, title: str) -> str:
    return next(skill.id for skill in store.skills() if skill.title == title)


def test_limits_refuse_and_tell_the_agent_to_consolidate(folder: Path) -> None:
    store = store_at(folder)
    store.update(PROFILE, text="x" * PROFILE_LIMIT)
    with pytest.raises(MeLimitExceeded):
        store.update(PROFILE, text="x" * (PROFILE_LIMIT + 1))
    with pytest.raises(MeLimitExceeded) as refused:
        store.agent_edit("append", chat_id="chat-1", message_id="msg-1", skill_id=PROFILE, text="Имя: Аглая")
    assert "Consolidate first" in refused.value.message and "replace" in refused.value.message
    assert store.skill(PROFILE).text == "x" * PROFILE_LIMIT  # nothing written
    # Consolidating is allowed: a shorter rewrite, then the append fits.
    store.agent_edit("replace", chat_id="chat-1", message_id="msg-1", skill_id=PROFILE, text="short")
    store.agent_edit("append", chat_id="chat-1", message_id="msg-1", skill_id=PROFILE, text="Имя: Аглая")
    assert store.skill(PROFILE).text == "short\nИмя: Аглая"
    with pytest.raises(MeLimitExceeded):
        store.update(HOW_TO_WORK, text="y" * (HOW_TO_WORK_LIMIT + 1))


def test_every_text_change_is_a_version_and_restore_makes_a_new_one(folder: Path) -> None:
    store = store_at(folder)
    store.update(HOW_TO_WORK, text="first")
    store.update(HOW_TO_WORK, text="second")
    store.update(HOW_TO_WORK, text="second")  # unchanged: no version
    store.update(HOW_TO_WORK, enabled=False)  # a switch is not a version
    assert store.skill(HOW_TO_WORK).version == 2
    restored = store.restore(HOW_TO_WORK, 1)
    assert (restored.text, restored.version) == ("first", 3)
    versions = store.versions(HOW_TO_WORK)
    assert [(item.version, item.source) for item in versions] == [(3, "restore"), (2, "user"), (1, "user")]
    assert versions[0].summary == "Restored version 1" and versions[0].chars == len("first")
    with pytest.raises(MeNotFound):
        store.restore(HOW_TO_WORK, 99)
    for index in range(MAX_VERSIONS + 5):
        store.update(HOW_TO_WORK, text=f"v{index}")
    assert len(store.versions(HOW_TO_WORK)) == MAX_VERSIONS


def test_builtins_keep_their_names_and_cannot_be_deleted(folder: Path) -> None:
    store = store_at(folder)
    with pytest.raises(MeConflict):
        store.update(PROFILE, title="Me myself")
    assert store.update(PROFILE, title="Profile").title == "Profile"  # unchanged title is fine
    with pytest.raises(MeConflict):
        store.delete(SEARCH)
    with pytest.raises(MeNotFound):
        store.skill("nope")


def test_agent_edits_are_recorded_and_undo_restores_the_version_before(folder: Path) -> None:
    store = store_at(folder)
    store.update(HOW_TO_WORK, text="Explain with formulas")
    edit = store.agent_edit("append", chat_id="chat-1", message_id="msg-1", skill_id=HOW_TO_WORK,
                            text="Prefers an example first")
    assert (edit.action, edit.skill_title, edit.summary) == ("append", "How to work with me",
                                                             "+ Prefers an example first")
    store.agent_edit("append", chat_id="chat-1", message_id="msg-2", skill_id=HOW_TO_WORK,
                     text="Short answers")
    skill, undone = store.undo(edit.id)
    assert skill.text == "Explain with formulas" and undone.undone
    assert store.versions(HOW_TO_WORK)[0].source == "restore"
    with pytest.raises(MeConflict) as again:
        store.undo(edit.id)
    assert again.value.code == "already_undone"
    with pytest.raises(MeNotFound):
        store.undo("me-unknown")


def test_profile_edit_summaries_carry_no_profile_content(folder: Path) -> None:
    store = store_at(folder)
    edit = store.agent_edit("append", chat_id="chat-1", message_id="msg-1", skill_id=PROFILE, text=SECRET)
    assert "Аглая" not in edit.summary and edit.summary


def test_agent_create_and_delete_are_undoable(folder: Path) -> None:
    store = store_at(folder)
    made = store.agent_edit("create", chat_id="c", message_id="m", title="Exam prep",
                            description="How the user drills before exams", text="Ten questions, then review")
    assert made.skill_id == "exam-prep" and made.summary == "New skill “Exam prep”"
    gone = store.agent_edit("delete", chat_id="c", message_id="m2", skill_id="exam-prep")
    assert "exam-prep" not in [skill.id for skill in store.skills()]
    store.undo(gone.id)
    assert store.skill("exam-prep").text == "Ten questions, then review"
    store.undo(made.id)
    assert "exam-prep" not in [skill.id for skill in store.skills()]
    # A built-in "delete" only clears its text, and Undo brings the text back.
    store.update(SEARCH, text="Google Scholar first")
    cleared = store.agent_edit("delete", chat_id="c", message_id="m3", skill_id=SEARCH)
    assert store.skill(SEARCH).text == ""
    assert store.undo(cleared.id)[0].text == "Google Scholar first"


def test_agent_writes_are_refused_when_me_or_the_skill_is_off_or_cite_materials(folder: Path) -> None:
    store = store_at(folder)
    store.update(HOW_TO_WORK, enabled=False)
    with pytest.raises(MeError):
        store.agent_edit("append", chat_id="c", message_id="m", skill_id=HOW_TO_WORK, text="x")
    with pytest.raises(MeError):
        store.agent_edit("append", chat_id="c", message_id="m", skill_id=SEARCH,
                         text="Napoleon started the war in 1812 ⟦m:mat-1:2⟧")
    store.set_enabled(False)
    with pytest.raises(MeError):
        store.agent_edit("append", chat_id="c", message_id="m", skill_id=SEARCH, text="arXiv")
    assert store.skill(SEARCH).text == ""


def test_user_delete_removes_the_skill_with_its_versions_and_edits(folder: Path) -> None:
    store = store_at(folder)
    edit = store.agent_edit("create", chat_id="c", message_id="m", title="Секретный навык", description="d",
                            text="тайный текст")
    assert edit.skill_id == "sekretnyy-navyk"
    store.delete(edit.skill_id)
    with pytest.raises(MeNotFound):
        store.undo(edit.id)
    with pytest.raises(MeNotFound):
        store.versions(edit.skill_id)


def test_an_unreadable_vault_is_kept_aside_never_overwritten(folder: Path) -> None:
    store = store_at(folder)
    store.update(PROFILE, text=SECRET)
    (folder / KEY_NAME).unlink()  # the key is lost
    fresh = store_at(folder)
    assert fresh.skill(PROFILE).text == ""
    fresh.update(SEARCH, text="arXiv")
    assert (folder / (VAULT_NAME + UNREADABLE_SUFFIX)).exists()
    fresh.erase()
    assert not any(folder.iterdir())
