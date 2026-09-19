"""The database file is user-visible inside the SKAZ data folder.

It is named after the product, not the internal Python package. A data folder
written by an earlier build still holds ``audiohelper.sqlite3``; adopting that
file by renaming it (rather than starting a second, empty database beside it)
is what keeps a dev install's sessions intact.
"""

from __future__ import annotations

from pathlib import Path

from audiohelper.config import AppConfig, adopt_legacy_database


def _config(data_dir: Path) -> AppConfig:
    return AppConfig(token="t", data_dir=data_dir)


def test_database_is_named_after_the_product(tmp_path: Path) -> None:
    assert _config(tmp_path).db_path.name == "skaz.sqlite3"


def test_a_legacy_database_is_adopted_under_the_new_name(tmp_path: Path) -> None:
    legacy = tmp_path / "audiohelper.sqlite3"
    legacy.write_bytes(b"sqlite-payload")

    adopt_legacy_database(_config(tmp_path))

    assert (tmp_path / "skaz.sqlite3").read_bytes() == b"sqlite-payload"
    assert not legacy.exists()


def test_sqlite_sidecar_files_move_with_the_database(tmp_path: Path) -> None:
    """A -wal left behind would be silently discarded: it holds committed data."""
    (tmp_path / "audiohelper.sqlite3").write_bytes(b"main")
    (tmp_path / "audiohelper.sqlite3-wal").write_bytes(b"wal")
    (tmp_path / "audiohelper.sqlite3-shm").write_bytes(b"shm")

    adopt_legacy_database(_config(tmp_path))

    assert (tmp_path / "skaz.sqlite3-wal").read_bytes() == b"wal"
    assert (tmp_path / "skaz.sqlite3-shm").read_bytes() == b"shm"
    assert not (tmp_path / "audiohelper.sqlite3-wal").exists()


def test_an_existing_database_is_never_overwritten(tmp_path: Path) -> None:
    (tmp_path / "audiohelper.sqlite3").write_bytes(b"legacy")
    (tmp_path / "skaz.sqlite3").write_bytes(b"current")

    adopt_legacy_database(_config(tmp_path))

    assert (tmp_path / "skaz.sqlite3").read_bytes() == b"current"


def test_a_clean_installation_is_a_no_op(tmp_path: Path) -> None:
    adopt_legacy_database(_config(tmp_path))

    assert not (tmp_path / "skaz.sqlite3").exists()
