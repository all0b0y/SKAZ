"""A library scan must not undo a write that lands while it runs (status, appended speech)."""
from __future__ import annotations

import threading
from typing import Any

import pytest

from skaz.knowledge import service as service_module
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService


def test_a_status_written_during_a_rescan_survives_the_index_replace(
    ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch,
) -> None:
    files = ready.create_material(INBOX_ID, "Talk", "audio", [FragmentInput(text="Hello there.")],
                                  status="processing")
    material_id = files.manifest.id
    real_scan = service_module.scan_library  # type: ignore[attr-defined]
    writer: list[threading.Thread] = []

    def scan_then_write_meanwhile(*args: Any, **kwargs: Any) -> Any:
        result = real_scan(*args, **kwargs)  # the files are read: "processing"
        thread = threading.Thread(target=ready.set_material_status, args=(material_id, "failed"))
        thread.start()
        writer.append(thread)
        thread.join(timeout=0.3)  # without the shared lock the write lands here, before the replace
        return result

    monkeypatch.setattr(service_module, "scan_library", scan_then_write_meanwhile)
    ready.rescan()
    writer[0].join(timeout=5)
    assert not writer[0].is_alive()
    record = ready.material_repo.get(material_id)
    assert record is not None and record.status == "failed"
