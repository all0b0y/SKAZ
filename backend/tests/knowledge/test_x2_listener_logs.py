"""Review Low: listener failures of the legacy live store and import service log ids and types only.

``logger.exception`` wrote the exception message and traceback lines — which can quote a title or
recognised text — into the app log the renderer reads. Now: ``error_note`` (types and code places).
"""
from __future__ import annotations

import logging
from typing import Any

import pytest

from skaz.import_service import ImportService
from skaz.live_store import LiveStore

SECRET = "Diagnosis of Anna Petrova"


def failing(_session_id: str) -> None:
    raise RuntimeError(f"could not show “{SECRET}”")


def assert_ids_only(caplog: pytest.LogCaptureFixture, session_id: str) -> None:
    text = caplog.text + "".join(str(record.exc_info) for record in caplog.records)
    assert SECRET not in text
    assert all(record.exc_info is None for record in caplog.records)
    assert session_id in caplog.text and "RuntimeError" in caplog.text


def test_a_failing_live_listener_logs_the_session_id_and_the_type(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    store: Any = LiveStore.__new__(LiveStore)
    store._listeners = [failing]
    store._notify("ses-live-1")
    assert_ids_only(caplog, "ses-live-1")


def test_a_failing_import_listener_logs_the_session_id_and_the_type(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    service: Any = ImportService.__new__(ImportService)
    service._listeners = [failing]
    service._notify("ses-import-1")
    assert_ids_only(caplog, "ses-import-1")
