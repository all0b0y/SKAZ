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
