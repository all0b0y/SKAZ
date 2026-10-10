"""Persistent chat/access contracts over real temporary SQLite, without models."""
from __future__ import annotations

from pathlib import Path

import pytest

from skaz import repository as repo
from skaz.agent.codex_chats import ChatAccessRevoked, ChatStore
from skaz.db import Database


def test_legacy_migration_is_idempotent_and_chat_history_isolated(tmp_path: Path) -> None:
    db = Database(tmp_path / "db.sqlite")
    try:
        sid = repo.create_session(db, "Authored session").id
        old = repo.add_message(db, sid, "user", "Old question", [])
        store = ChatStore(db)
        legacy = store.list(sid)[0]
        assert legacy["title"] == "Previous conversation"
        assert store.messages(legacy["id"])[0]["id"] == old.id
        fresh = store.create(sid, "session")
        assert store.messages(fresh["id"]) == []
        assert store.selected(sid) == fresh["id"]
        store.append(fresh["id"], "user", "Fresh question", [])
        assert store.get(fresh["id"])["title"] == "Fresh question"
        assert store.messages(legacy["id"])[0]["content"] == "Old question"
        assert len(ChatStore(db).list(sid)) == 2
        store.rename(fresh["id"], "Manual")
        store.append(fresh["id"], "user", "Another", [])
        assert store.get(fresh["id"])["title"] == "Manual"
        store.select(legacy["id"])
        assert store.selected(sid) == legacy["id"]
    finally:
        db.close()


def test_group_additions_next_request_removal_permanently_revokes(tmp_path: Path) -> None:
    import json

    db = Database(tmp_path / "db.sqlite")
    try:
        a, b, c = [repo.create_session(db, name).id for name in ("a", "b", "c")]
        def layout(members: list[str]) -> None:
            doc = json.dumps({"groups": [{"id": "g", "name": "Group"}],
                              "membership": dict.fromkeys(members, "g")})
            with db.write() as conn:
                conn.execute("INSERT OR REPLACE INTO physical_storage VALUES (1,0,?)", (doc,))
        layout([a, b])
        store = ChatStore(db)
        chat = store.create(a, "group")
        assert set(store.authorize(chat["id"])) == {a, b}
        layout([a, b, c])
        assert set(store.authorize(chat["id"])) == {a, b, c}
        layout([a, c])
        with pytest.raises(ChatAccessRevoked):
            store.authorize(chat["id"])
        layout([a, b, c])
        with pytest.raises(ChatAccessRevoked):
            store.authorize(chat["id"])
        assert store.get(chat["id"])["revoked"] is True
        assert store.messages(chat["id"]) == []  # Still readable.
    finally:
        db.close()


def test_deleted_source_revokes_all_scope_and_history_is_not_resubmitted(tmp_path: Path) -> None:
    db = Database(tmp_path / "db.sqlite")
    try:
        a, b = [repo.create_session(db, name).id for name in ("a", "b")]
        store = ChatStore(db)
        chat = store.create(a, "all")
        store.append(chat["id"], "user", "Question", [])
        store.authorize(chat["id"])
        with db.write() as conn:
            conn.execute("DELETE FROM sessions WHERE id=?", (b,))
        with pytest.raises(ChatAccessRevoked):
            store.context(chat["id"])
        assert store.messages(chat["id"])[0]["content"] == "Question"
        fresh = store.create(a, "all")
        assert store.context(fresh["id"]) == []
    finally:
        db.close()


def test_validation_selection_ownership_and_explicit_delete(tmp_path: Path) -> None:
    db = Database(tmp_path / "db.sqlite")
    try:
        sid = repo.create_session(db, "session").id
        store = ChatStore(db)
        with pytest.raises(ValueError):
            store.create(sid, "group")
        with pytest.raises(ValueError):
            store.create(sid, "anything")
        chat = store.create(sid, "session")
        with pytest.raises(ValueError):
            store.rename(chat["id"], " ")
        with pytest.raises(ValueError):
            store.delete(chat["id"], confirmed=False)
        store.delete(chat["id"], confirmed=True)
        assert store.list(sid) == []
        assert store.selected(sid) is None
    finally:
        db.close()



def test_sidebar_groups_give_group_chats_their_sources_without_file_mode(tmp_path: Path) -> None:
    db = Database(tmp_path / "db.sqlite")
    try:
        a, b, c = [repo.create_session(db, name).id for name in ("a", "b", "c")]
        store = ChatStore(db)
        assert store.group_scope(a) == "not_in_group"
        with pytest.raises(ValueError, match="isn’t in a group"):
            store.create(a, "group")

        store.mirror_sidebar_groups({a: "g", b: "g", c: None})
        assert store.group_scope(a) == "available"
        assert store.group_scope(c) == "not_in_group"
        chat = store.create(a, "group")
        assert set(store.authorize(chat["id"])) == {a, b}

        # Removing a session the chat has seen revokes it for good, as in file mode.
        store.mirror_sidebar_groups({a: "g", b: None, c: None})
        with pytest.raises(ChatAccessRevoked):
            store.authorize(chat["id"])
        assert store.get(chat["id"])["revoked"] is True
    finally:
        db.close()


def test_file_mode_groups_win_over_the_sidebar_copy(tmp_path: Path) -> None:
    import json

    db = Database(tmp_path / "db.sqlite")
    try:
        a = repo.create_session(db, "a").id
        store = ChatStore(db)
        store.mirror_sidebar_groups({a: "g"})
        with db.write() as conn:
            conn.execute("INSERT INTO physical_storage VALUES (1,0,?)",
                         (json.dumps({"groups": [], "membership": {}}),))
        assert store.group_scope(a) == "not_in_group"
        with pytest.raises(ValueError, match="File mode"):
            store.mirror_sidebar_groups({a: "g"})
    finally:
        db.close()


def test_an_empty_chat_changes_scope_but_history_keeps_it(tmp_path: Path) -> None:
    db = Database(tmp_path / "db.sqlite")
    try:
        a, b = [repo.create_session(db, name).id for name in ("a", "b")]
        store = ChatStore(db)
        chat = store.create(a, "session")
        store.rescope(chat["id"], "all")
        assert store.get(chat["id"])["scope"] == "all"
        assert set(store.authorize(chat["id"])) == {a, b}
        with pytest.raises(ValueError, match="isn’t in a group"):
            store.rescope(chat["id"], "group")

        store.append(chat["id"], "user", "What was decided?", [])
        with pytest.raises(ValueError, match="keeps its scope"):
            store.rescope(chat["id"], "session")
        assert store.get(chat["id"])["scope"] == "all"
    finally:
        db.close()
