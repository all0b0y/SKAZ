from pathlib import Path

import pytest

from skaz.import_temp import ImportTemp


def test_cleanup_only_removes_job_owned_audio(tmp_path: Path) -> None:
    original = tmp_path / "original.mp4"
    original.write_bytes(b"user owned")
    temp = ImportTemp(tmp_path / "work")
    directory = temp.directory("a" * 32)
    (directory / "audio.m4a").write_bytes(b"temporary")
    temp.remove("a" * 32)
    assert original.read_bytes() == b"user owned"
    assert not directory.exists()


def test_symlink_cannot_turn_cleanup_into_original_deletion(tmp_path: Path) -> None:
    original = tmp_path / "original"
    original.mkdir()
    (original / "media").write_bytes(b"keep")
    temp = ImportTemp(tmp_path / "work")
    directory = temp.directory("b" * 32)
    directory.rmdir()
    directory.symlink_to(original, target_is_directory=True)
    with pytest.raises(ValueError):
        temp.remove("b" * 32)
    assert (original / "media").read_bytes() == b"keep"


def test_source_path_is_not_a_job_identifier(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        ImportTemp(tmp_path).directory("../original")
