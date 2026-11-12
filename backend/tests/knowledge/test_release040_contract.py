"""C0 wire/storage contracts: fakes only, no provider calls and no live app."""

from __future__ import annotations

import importlib
import json
import re
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any, cast, get_args

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel, ValidationError

from skaz.knowledge.api import ROUTERS
from skaz.knowledge.store.schema import MODULES, applied_versions, apply_schemas

REPO = Path(__file__).resolve().parents[3]
CASES = json.loads((Path(__file__).parent / "fixtures/release040_routes.json").read_text())
AREAS = ("science", "explore", "areas", "research", "freshness", "maintenance", "repeats")


def app_for_contracts() -> FastAPI:
    app = FastAPI()
    for router in ROUTERS:
        app.include_router(router)
    return app


def fixture_data() -> dict[str, Any]:
    text = (REPO / "frontend/src/kb/api/fake/fixtures.ts").read_text()
    return cast(
        dict[str, Any],
        json.loads(
            text.split("export const contractFixtures = ", 1)[1].split(" satisfies ContractFixtures;")[0]
        ),
    )


def model(area: str, name: str) -> type[BaseModel]:
    module = importlib.import_module(f"skaz.knowledge.api.schemas_{area}")
    return getattr(module, name)  # type: ignore[no-any-return]


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["method"] + " " + c["path"])
def test_every_route_declares_shapes_and_fails_closed(case: dict[str, Any]) -> None:
    app = app_for_contracts()
    operation = app.openapi()["paths"][case["path"]][case["method"].lower()]
    success = operation["responses"]["200"]["content"]["application/json"]["schema"]
    assert success == {"$ref": "#/components/schemas/" + case["response"]}
    assert operation["responses"]["503"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/KbContractError"
    }
    if case["body"]:
        assert operation["requestBody"]["content"]["application/json"]["schema"] == {
            "$ref": "#/components/schemas/" + case["body"]
        }
    url = re.sub(r"\{[^}]+\}", "fixture-1", case["path"])
    with TestClient(app) as client:
        response = client.request(case["method"], url, json=case["example"])
    assert response.status_code == 503
    assert response.json() == {"code": "not_ready"}


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["area"] + "." + c["name"])
def test_route_delegates_to_own_service_and_fixture_is_valid(case: dict[str, Any]) -> None:
    app = app_for_contracts()
    payload = model(case["area"], case["response"]).model_validate(fixture_data()[case["response"]])
    calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    async def handler(*args: Any, **kwargs: Any) -> BaseModel:
        calls.append((args, kwargs))
        return payload

    service = type("FixtureService", (), {})()
    setattr(service, case["name"], handler)
    setattr(app.state, "kb_" + case["area"], service)
    url = re.sub(r"\{[^}]+\}", "fixture-1", case["path"])
    with TestClient(app) as client:
        response = client.request(case["method"], url, json=case["example"])
    assert response.status_code == 200, response.text
    assert response.json() == payload.model_dump(mode="json")
    assert len(calls) == 1
    args, _ = calls[0]
    if "{" in case["path"]:
        assert args[0] == "fixture-1"
    if case["body"]:
        assert isinstance(args[-1], BaseModel)
        assert args[-1].model_dump(mode="json", exclude_unset=True) == (
            {"key": "**********"} if case["body"] == "KbOpenAlexKeyUpdate" else case["example"]
        )


def test_route_manifest_covers_all_seven_routers() -> None:
    expected = {(row["method"], row["path"]) for row in CASES}
    actual: set[tuple[str, str]] = set()
    for area in AREAS:
        router = importlib.import_module(f"skaz.knowledge.api.{area}").router
        for route in router.routes:
            actual.update((method, route.path) for method in route.methods)
    assert actual == expected


@pytest.mark.parametrize("existing", [False, True])
def test_schema_append_is_idempotent_and_preserves_existing_database(existing: bool) -> None:
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys=ON")
    old_modules = tuple(module for module in MODULES if module.NAME not in AREAS)
    if existing:
        apply_schemas(connection, old_modules)
        connection.execute("INSERT INTO settings(key,value) VALUES ('c0_sentinel','\"keep me\"')")
    apply_schemas(connection)
    apply_schemas(connection)
    versions = applied_versions(connection)
    # EX2 step 0: areas is at v2 (own topics); the other 0.4.0 modules are at v1.
    assert all(versions[area] == (2 if area == "areas" else 1) for area in AREAS)
    if existing:
        assert connection.execute("SELECT value FROM settings WHERE key='c0_sentinel'").fetchone() == (
            '"keep me"',
        )
    assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    for table in (
        "science_egress",
        "explore_completed_work",
        "research_tasks",
        "explore_signals",
        "material_publications",
        "freshness_marks",
        "material_repeat_checks",
    ):
        assert connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
    connection.close()


def test_checkpoint_work_is_unique_and_read_marks_are_one_per_target() -> None:
    with sqlite3.connect(":memory:") as db:
        apply_schemas(db)
        db.execute(
            "INSERT INTO explore_jobs(id, owner, state, stage, budget_json, counters_json, created_at,"
            " updated_at) VALUES ('job','explore','running','novelty','{}','{}','now','now')"
        )
        db.execute("INSERT INTO explore_completed_work VALUES ('job','work','novelty','{}','now')")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO explore_completed_work VALUES ('job','work','novelty','{}','now')")
        db.execute("INSERT INTO explore_read_marks VALUES ('material','mat','useful_method','now')")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO explore_read_marks VALUES ('material','mat','not_for_me','now')")


def test_secret_and_unknown_request_fields_never_echo() -> None:
    app = app_for_contracts()
    app.state.kb_science = object()  # validation must run; no service method should be called
    with TestClient(app) as client:
        response = client.put("/kb/settings/science/openalex-key", json={"key": "SENSITIVE" * 1000})
        assert response.status_code == 422
        assert response.json() == {"code": "invalid_request"}
        response = client.post("/kb/science/search", json={"payload": {"chat_text": "SENSITIVE"}})
        assert response.status_code == 422
        assert "SENSITIVE" not in response.text
        response = client.get("/kb/science/journal?limit=10000")
        assert response.status_code == 422


def test_no_secret_in_settings_response_or_repr() -> None:
    from skaz.knowledge.api.schemas_science import KbOpenAlexKeyUpdate, KbScienceSettings

    key = KbOpenAlexKeyUpdate.model_validate({"key": "fixture-private-key"})
    assert "fixture-private-key" not in repr(key)
    assert "fixture-private-key" not in key.model_dump_json()
    assert "key" not in KbScienceSettings.model_fields


def test_egress_payload_has_no_freeform_text_or_secrets() -> None:
    from skaz.knowledge.api.schemas_science import KbSciencePayload

    assert set(KbSciencePayload.model_fields) == {"topics", "dois", "ids"}
    for key in ("chat", "material_text", "api_key", "prompt"):
        with pytest.raises(ValidationError):
            KbSciencePayload.model_validate({key: "private"})


def test_boundary_rejects_ambiguous_dates_and_missing_consent() -> None:
    from skaz.knowledge.api.schemas_explore_common import KbDateWindow, KbPublicationDate
    from skaz.knowledge.api.schemas_freshness import KbLinkCheckStart
    from skaz.knowledge.api.schemas_science import KbScienceSettingsUpdate

    with pytest.raises(ValidationError):
        KbScienceSettingsUpdate(enabled=True)
    with pytest.raises(ValidationError):
        KbDateWindow(from_date="2026-12-31", to_date="2024-01-01")  # type: ignore[arg-type]
    with pytest.raises(ValidationError):
        KbLinkCheckStart()
    with pytest.raises(ValidationError):
        KbLinkCheckStart(material_ids=["m"], folder_id="f")
    with pytest.raises(ValidationError):
        KbPublicationDate(year=2026, date=None, precision="month", origin="crossref", evidence_url=None)


@pytest.mark.parametrize(
    "module",
    [f"skaz.knowledge.{area}.protocols" for area in AREAS] + ["skaz.knowledge.research.tool_contracts"],
)
def test_owner_can_import_its_protocol_first(module: str) -> None:
    """Each owning slice imports its own protocols before anything else has loaded the API package."""
    done = subprocess.run([sys.executable, "-c", f"import {module}"], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["method"] + " " + c["path"])
async def test_real_app_answers_not_ready_and_no_existing_route_shadows(
    case: dict[str, Any], kb_client: httpx.AsyncClient
) -> None:
    url = re.sub(r"\{[^}]+\}", "fixture-1", case["path"])
    response = await kb_client.request(case["method"], url, json=case["example"])
    assert response.status_code == 503, response.text
    assert response.json() == {"code": "not_ready"}


def test_deleting_a_chat_is_not_blocked_by_research_or_readings() -> None:
    with sqlite3.connect(":memory:") as db:
        db.execute("PRAGMA foreign_keys=ON")
        apply_schemas(db)
        now = "2026-11-09T10:00:00Z"
        for chat in ("chat-task", "chat-origin", "chat-read"):
            db.execute(
                "INSERT INTO chat_threads(id, title, engine, created_at, updated_at) VALUES (?,?,?,?,?)",
                (chat, chat, "claude", now, now),
            )
        db.execute(
            "INSERT INTO explore_jobs(id, owner, state, stage, budget_json, counters_json, created_at,"
            " updated_at) VALUES ('job','research','running','collect','{}','{}',?,?)",
            (now, now),
        )
        db.execute("INSERT INTO explore_runs(id, request_json) VALUES ('job','{}')")
        db.execute(
            "INSERT INTO science_works(id, provider, provider_id, metadata_json, updated_at)"
            " VALUES ('work','openalex','W1','{}',?)",
            (now,),
        )
        db.execute(
            "INSERT INTO explore_findings(id, run_id, work_id, channel, label, reason, theses_json,"
            " details_json, created_at) VALUES ('f','job','work','search','new','r','[]','{}',?)",
            (now,),
        )
        db.execute(
            "INSERT INTO explore_readings(id, finding_id, chat_id, mode, text_kind, started_at)"
            " VALUES ('r','f','chat-read','notes','abstract_only',?)",
            (now,),
        )
        db.execute(
            "INSERT INTO research_tasks(id, title, description, chat_id, origin_chat_id, job_id,"
            " request_json, created_at, updated_at)"
            " VALUES ('t','t','d','chat-task','chat-origin','job','{}',?,?)",
            (now, now),
        )
        db.execute(
            "INSERT INTO research_permissions(id, chat_id, message_id, run_id, engine, arguments_json,"
            " status, task_id, created_at) VALUES ('p','chat-origin','m','r','claude','{}','allowed','t',?)",
            (now,),
        )
        db.execute("DELETE FROM chat_threads WHERE id='chat-read'")
        db.execute("DELETE FROM chat_threads WHERE id='chat-task'")
        assert db.execute("SELECT count(*) FROM research_tasks").fetchone() == (0,)
        assert db.execute("SELECT task_id FROM research_permissions").fetchone() == (None,)
        db.execute("DELETE FROM chat_threads WHERE id='chat-origin'")
        assert db.execute("SELECT count(*) FROM explore_findings").fetchone() == (1,)


def test_area_material_kinds_are_the_real_material_kinds() -> None:
    from skaz.knowledge.api.schemas_areas import KbAreaMaterial
    from skaz.knowledge.markdown.source import MATERIAL_KINDS

    schema = KbAreaMaterial.model_json_schema()["properties"]["kind"]
    assert set(schema["enum"]) == set(MATERIAL_KINDS)


def test_budget_rules() -> None:
    from skaz.knowledge.api.schemas_explore_common import KbRunBudget

    ok = {"unit": "candidate", "limit": 30, "used": 18, "remaining": 12, "total_used": 48,
          "batch": 2, "free_only": False}
    assert KbRunBudget.model_validate(ok).remaining == 12
    for bad in ({"limit": 31, "remaining": 13}, {"remaining": 11}, {"total_used": 17}):
        with pytest.raises(ValidationError):
            KbRunBudget.model_validate({**ok, **bad})
    assert KbRunBudget.model_validate(
        {**ok, "unit": "link", "limit": 100, "used": 18, "remaining": 82, "total_used": 18, "batch": 1}
    ).limit == 100


def test_map_can_carry_every_v3_level_and_deep_gaps() -> None:
    from skaz.knowledge.api.schemas_areas import KbArea, KbAreaMap

    assert {"domain", "field", "subfield", "topic", "custom"} == set(
        KbArea.model_json_schema()["properties"]["level"]["enum"]
    )
    assert KbAreaMap.model_fields["worth_closing"].annotation == list[KbArea]


def test_research_card_can_join_the_chat_part_union() -> None:
    from skaz.knowledge.api.schemas_research import KbResearchPermission

    field = KbResearchPermission.model_fields["type"]
    assert field.is_required() and get_args(field.annotation) == ("research",)


def test_retraction_is_per_statement_and_tray_text_is_exact() -> None:
    from skaz.knowledge.api.schemas_maintenance import KbFreshnessMark, KbMarkedStatement
    from skaz.knowledge.maintenance.protocols import WEEKLY_CHECK_STARTED_BODY

    assert "sole_source" in KbMarkedStatement.model_fields
    assert "sole_source" not in KbFreshnessMark.model_fields
    assert WEEKLY_CHECK_STARTED_BODY == (
        "SKAZ works in the tray; Quit pauses the check, it resumes next launch"
    )


def test_domain_errors_become_codes_without_their_message() -> None:
    from skaz.knowledge.errors import NotFound

    app = app_for_contracts()

    async def missing(_work_id: str) -> None:
        raise NotFound("private title of a material")

    service = type("FixtureService", (), {})()
    service.work = missing
    app.state.kb_science = service
    with TestClient(app) as client:
        response = client.get("/kb/science/works/work-1")
    assert response.status_code == 404
    assert response.json() == {"code": "not_found"}
