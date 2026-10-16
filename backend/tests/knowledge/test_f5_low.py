"""Cheap Low rows of QA area E: E5 (library in the data folder), E6 (file without an extension),
E7 (newest first within one second), E19 (a PDF page of same-size text is not a title)."""
from __future__ import annotations

from pathlib import PurePath
from typing import Any

import httpx
import pytest

from skaz.knowledge.errors import LibraryConflict
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import DATA_DIR_REASON, KnowledgeService
from skaz.knowledge.sources.pdf import extract_pdf
from skaz.knowledge.speech.media import UnsupportedMedia, file_kind
from tests.knowledge.pdf_fixtures import line, make_pdf


def test_e5_library_inside_or_around_the_data_folder_is_refused(service: KnowledgeService,
                                                                 kb_config: Any) -> None:
    data = kb_config.data_dir
    service.documents_sandbox = None  # the packaged app: no dev sandbox, the chooser can go anywhere
    for place in (data, data / "Sub"):
        with pytest.raises(LibraryConflict) as error:
            service.connect(str(place))
        assert error.value.message == DATA_DIR_REASON
    assert not (data / "SKAZ").exists() and service.view().state == "not_configured"


async def test_e5_api_answers_409(kb_client: httpx.AsyncClient, kb_app: Any) -> None:
    kb_app.state.runtime.kb.documents_sandbox = None
    response = await kb_client.post("/kb/library", json={"path": str(kb_app.state.runtime.kb.data_dir)})
    assert response.status_code == 409 and response.json()["detail"] == DATA_DIR_REASON


def test_e6_file_without_extension_says_so() -> None:
    with pytest.raises(UnsupportedMedia) as error:
        file_kind(PurePath("/etc/passwd"))
    assert str(error.value).startswith("SKAZ can't import files without an extension. Supported: ")
    with pytest.raises(UnsupportedMedia, match=r"can't import \.xyz files"):
        file_kind(PurePath("/a/b.xyz"))


def test_e7_materials_created_within_one_second_are_newest_first(ready: KnowledgeService) -> None:
    titles = [f"Scale item {number}" for number in range(12)]
    for title in titles:
        ready.create_material(INBOX_ID, title, "text", [FragmentInput(text=title)])
    assert [record.title for record in ready.materials()] == titles[::-1]
    ready.rescan()  # the order comes from the files, not from insertion order
    assert [record.title for record in ready.materials()] == titles[::-1]


def test_e19_page_of_same_size_text_is_not_the_title() -> None:
    body = [line(f"Page 1 of the QA document. Lorem ipsum dolor sit amet {n}.", 720 - 14 * n)
            for n in range(12)]
    assert extract_pdf(make_pdf([b"".join(body)])).title is None  # the caller uses the file name
    titled = make_pdf([line("Real Title", 740, size=24) + b"".join(body)])
    assert extract_pdf(titled).title == "Real Title"
