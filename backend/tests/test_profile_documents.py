"""Development/test libraries cannot connect the installed profile's documents.

The root-selection route is gone (the knowledge library chooses its own place); the
start-up refusal of an outside override stays.
"""
from pathlib import Path

import pytest

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.secrets import MemorySecretStore


def test_external_root_override_is_rejected_before_writing(tmp_path: Path) -> None:
    config = AppConfig(token="test", data_dir=tmp_path / "data",
                       documents_sandbox=tmp_path / "test-documents",
                       session_files_root=tmp_path / "production-documents")
    with pytest.raises(ValueError, match="Development libraries"):
        create_app(config, secret_store=MemorySecretStore())
    assert not (tmp_path / "production-documents").exists()
