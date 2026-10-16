"""Shared fixtures for the knowledge wiki: a temporary library, never the real ~/Documents."""
from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.knowledge.service import KnowledgeService
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN


@pytest.fixture
def documents(tmp_path: Path) -> Path:
    path = tmp_path / "Documents"
    path.mkdir()
    return path


@pytest.fixture
def kb_config(tmp_path: Path, documents: Path) -> AppConfig:
    return AppConfig(token=TOKEN, data_dir=tmp_path / "data", request_timeout_s=5.0,
                     documents_dir=documents, documents_sandbox=documents)


@pytest.fixture
def service(kb_config: AppConfig) -> Iterator[KnowledgeService]:
    kb = KnowledgeService(kb_config.data_dir, documents_dir=kb_config.documents_dir,
                          documents_sandbox=kb_config.documents_sandbox)
    yield kb
    kb.close()


@pytest.fixture
def ready(service: KnowledgeService) -> KnowledgeService:
    """A service connected to a fresh library at ``<tmp>/Documents/SKAZ``."""
    view = service.connect(None)
    assert view.state == "ready"
    return service


@pytest.fixture
def kb_app(kb_config: AppConfig) -> Iterator[Any]:
    application = create_app(kb_config, secret_store=MemorySecretStore(),
                             http_client=httpx.AsyncClient(transport=httpx.MockTransport(
                                 lambda request: httpx.Response(599))))
    yield application
    application.state.runtime.close()


@pytest.fixture
async def kb_client(kb_app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=kb_app),
        base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        yield client
