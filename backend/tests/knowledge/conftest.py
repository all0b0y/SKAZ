"""Shared fixtures for the knowledge wiki: a temporary library, never the real ~/Documents."""
from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.knowledge.markdown.source import Origin
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources.fragments import to_fragments
from skaz.knowledge.sources.intake import BOOK_PAGES, Original, Prepared, flag_instructions
from skaz.knowledge.sources.pdf import extract_pdf
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN


@pytest.fixture
def documents(tmp_path: Path) -> Path:
    path = tmp_path / "Documents"
    path.mkdir()
    return path


@pytest.fixture
def legacy_pdf_intake(monkeypatch: pytest.MonkeyPatch) -> None:
    """Persist a pre-card PDF using the usual service and library transaction."""
    def prepare(data: bytes, *, origin: Origin, fallback: str, original: Original) -> Prepared:
        extracted = extract_pdf(data)
        return Prepared(
            kind="book" if extracted.page_count >= BOOK_PAGES else "pdf",
            title=extracted.title,
            fallback_title=fallback,
            fragments=to_fragments(extracted.paragraphs),
            findings=flag_instructions(extracted.findings),
            origin=origin,
            extractor="pdf",
            original=original,
            failure=extracted.failure,
            extra={"pages": extracted.page_count},
        )

    monkeypatch.setattr("skaz.knowledge.sources.service.prepare_pdf", prepare)


@pytest.fixture
def kb_config(tmp_path: Path, documents: Path, request: pytest.FixtureRequest) -> AppConfig:
    return AppConfig(token=TOKEN, data_dir=tmp_path / "data", request_timeout_s=5.0,
                     documents_dir=documents, documents_sandbox=documents,
                     use_legacy_me=getattr(request, "param", None) == "legacy_me")


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
