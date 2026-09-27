"""Development/test libraries cannot connect the installed profile's documents."""
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.secrets import MemorySecretStore


def test_profile_documents_are_scoped_and_persist_between_launches(tmp_path: Path) -> None:
    documents = tmp_path / "Documents" / "SKAZ-test"
    documents.mkdir(parents=True)
    config = AppConfig(token="test", data_dir=tmp_path / "data",
                       documents_dir=documents, documents_sandbox=documents)
    root = documents / "SKAZ"
    for launch in range(2):
        with TestClient(create_app(config, secret_store=MemorySecretStore()),
                        base_url="http://127.0.0.1", headers={"Authorization": "Bearer test"}) as client:
            view = client.get("/storage/root").json()
            assert view["suggested_root"] == str(root)
            if launch == 0:
                assert client.put("/storage/root", json={
                    "root": str(tmp_path / "Documents" / "SKAZ"), "expected_root": None,
                }).status_code == 422
                assert client.put("/storage/root", json={
                    "root": str(root), "expected_root": None,
                }).status_code == 200
            else:
                assert view["root"] == str(root)
    assert not (tmp_path / "Documents" / "SKAZ").exists()


def test_external_root_override_is_rejected_before_writing(tmp_path: Path) -> None:
    config = AppConfig(token="test", data_dir=tmp_path / "data",
                       documents_sandbox=tmp_path / "test-documents",
                       session_files_root=tmp_path / "production-documents")
    with pytest.raises(ValueError, match="Development libraries"):
        create_app(config, secret_store=MemorySecretStore())
    assert not (tmp_path / "production-documents").exists()
