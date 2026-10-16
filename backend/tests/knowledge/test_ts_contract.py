"""The committed TypeScript contract must equal what the generator produces from the live schema."""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "scripts" / "gen-kb-types.py"


def generator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("gen_kb_types", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_types_gen_ts_is_fresh() -> None:
    module = generator()
    expected = module.render()
    current = module.OUTPUT.read_text(encoding="utf-8") if module.OUTPUT.exists() else ""
    assert current == expected, f"frontend/src/api/kb/types.gen.ts is stale. Run: {module.COMMAND}"


def test_generator_covers_only_kb_routes_and_their_schemas() -> None:
    text = generator().render()
    assert '"GET /kb/wiki/pages/{page_id}"' in text
    assert "export interface KbPage {" in text
    assert "/sessions" not in text and "HTTPValidationError" not in text
    assert "section: string | null;" in text
    assert 'owner: "agent" | "user" | "user_edited";' in text


def test_ts_rendering_of_schema_shapes() -> None:
    module = generator()
    spec = {
        "paths": {"/kb/x": {"post": {
            "requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/In"}}}},
            "responses": {"200": {"content": {"application/json": {"schema": {
                "type": "array", "items": {"$ref": "#/components/schemas/Out"}}}}}},
        }}, "/other": {"get": {"responses": {}}}},
        "components": {"schemas": {
            "In": {"type": "object", "properties": {"tags": {"type": "array", "items": {
                "anyOf": [{"type": "string"}, {"type": "null"}]}}}, "required": []},
            "Out": {"type": "object", "properties": {
                "mode": {"const": "a"},
                "map": {"type": "object", "additionalProperties": {"type": "integer"}},
                "nested": {"type": "object", "properties": {"x-y": {"type": "boolean"}}, "required": ["x-y"]},
            }, "required": ["mode", "map", "nested"]},
            "Unused": {"type": "object", "properties": {"a": {"type": "string"}}},
        }},
    }
    text = module.render(spec)
    assert "tags?: (string | null)[];" in text
    assert 'mode: "a";' in text and "map: Record<string, number>;" in text
    assert '"x-y": boolean;' in text
    assert "Unused" not in text and "/other" not in text
    assert "response: Out[];" in text
