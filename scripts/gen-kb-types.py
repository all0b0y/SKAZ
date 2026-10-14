#!/usr/bin/env python3
"""Generate ``frontend/src/api/kb/types.gen.ts`` from the backend OpenAPI schema (``/kb/*`` only).

The schema comes from ``create_app`` with a throw-away test configuration; no
server is started, nothing outside a temporary directory is touched.
openapi-typescript is not used on purpose: it needs TypeScript 5 and the
project is on TypeScript 7, and new npm dependencies are not allowed.

Usage (from the repository root)::

    backend/.venv/bin/python scripts/gen-kb-types.py          # write the file
    backend/.venv/bin/python scripts/gen-kb-types.py --check  # exit 1 if stale
"""
from __future__ import annotations

import json
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
OUTPUT = REPO / "frontend" / "src" / "api" / "kb" / "types.gen.ts"
COMMAND = "backend/.venv/bin/python scripts/gen-kb-types.py"
PREFIX = "/kb"
_IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")
_METHODS = ("get", "post", "put", "patch", "delete")


def load_openapi() -> dict[str, Any]:
    try:
        import skaz  # noqa: F401
    except ImportError:
        sys.path.insert(0, str(REPO / "backend" / "src"))
    from skaz.app import create_app
    from skaz.config import AppConfig
    from skaz.secrets import MemorySecretStore

    with tempfile.TemporaryDirectory(prefix="skaz-gen-kb-") as scratch:
        base = Path(scratch)
        documents = base / "Documents"
        documents.mkdir()
        config = AppConfig(token="gen-kb-types", data_dir=base / "data", documents_dir=documents,
                           documents_sandbox=documents)
        app = create_app(config, secret_store=MemorySecretStore())
        try:
            return app.openapi()
        finally:
            app.state.runtime.close()


def _ref_name(ref: str) -> str:
    return _type_name(ref.rsplit("/", 1)[-1])


def _type_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", name)


def _wrap(expression: str) -> str:
    return f"({expression})" if " | " in expression else expression


def _property(name: str) -> str:
    return name if _IDENTIFIER.match(name) else json.dumps(name)


def ts_type(schema: dict[str, Any], indent: str = "") -> str:
    if "$ref" in schema:
        return _ref_name(schema["$ref"])
    for key in ("anyOf", "oneOf"):
        if key in schema:
            members: list[str] = []
            for option in schema[key]:
                rendered = ts_type(option, indent)
                if rendered not in members:
                    members.append(rendered)
            return " | ".join(members)
    if "const" in schema:
        return json.dumps(schema["const"], ensure_ascii=False)
    if "enum" in schema:
        return " | ".join(json.dumps(value, ensure_ascii=False) for value in schema["enum"])
    kind = schema.get("type")
    if isinstance(kind, list):
        return " | ".join(ts_type({**schema, "type": item}, indent) for item in kind)
    if kind == "string":
        return "string"
    if kind in ("integer", "number"):
        return "number"
    if kind == "boolean":
        return "boolean"
    if kind == "null":
        return "null"
    if kind == "array":
        return f"{_wrap(ts_type(schema.get('items', {}), indent))}[]"
    if kind == "object" or "properties" in schema:
        if schema.get("properties"):
            return _object_literal(schema, indent)
        extra = schema.get("additionalProperties")
        if isinstance(extra, dict) and extra:
            return f"Record<string, {ts_type(extra, indent)}>"
        return "Record<string, unknown>"
    return "unknown"


def _object_literal(schema: dict[str, Any], indent: str) -> str:
    required = set(schema.get("required", []))
    inner = indent + "  "
    lines = ["{"]
    for name, child in schema.get("properties", {}).items():
        optional = "" if name in required else "?"
        lines.append(f"{inner}{_property(name)}{optional}: {ts_type(child, inner)};")
    lines.append(f"{indent}}}")
    return "\n".join(lines)


def _collect_refs(schema: Any, found: set[str]) -> None:
    if isinstance(schema, dict):
        ref = schema.get("$ref")
        if isinstance(ref, str):
            found.add(ref.rsplit("/", 1)[-1])
        for value in schema.values():
            _collect_refs(value, found)
    elif isinstance(schema, list):
        for value in schema:
            _collect_refs(value, found)


def _json_schema(container: dict[str, Any] | None) -> dict[str, Any] | None:
    if not container:
        return None
    content = container.get("content", {}).get("application/json")
    return content.get("schema") if content else None


def _success(operation: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    for status in sorted(operation.get("responses", {})):
        if status.startswith("2"):
            return status, _json_schema(operation["responses"][status])
    return "200", None


def _kb_operations(spec: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    operations = []
    for path in sorted(spec.get("paths", {})):
        if path != PREFIX and not path.startswith(PREFIX + "/"):
            continue
        for method in _METHODS:
            operation = spec["paths"][path].get(method)
            if operation is not None:
                operations.append((path, method, operation))
    return operations


def _reachable(spec: dict[str, Any], operations: list[tuple[str, str, dict[str, Any]]]) -> list[str]:
    schemas = spec.get("components", {}).get("schemas", {})
    pending: set[str] = set()
    for _path, _method, operation in operations:
        _collect_refs(_json_schema(operation.get("requestBody")), pending)
        _collect_refs(_success(operation)[1], pending)
        _collect_refs(operation.get("parameters", []), pending)
    seen: set[str] = set()
    while pending:
        name = pending.pop()
        if name in seen or name not in schemas:
            continue
        seen.add(name)
        _collect_refs(schemas[name], pending)
    return sorted(seen)


def _parameters(operation: dict[str, Any], where: str) -> str:
    params = [param for param in operation.get("parameters", []) if param.get("in") == where]
    if not params:
        return "Record<string, never>"
    fields = []
    for param in params:
        optional = "" if param.get("required") else "?"
        fields.append(f"{_property(param['name'])}{optional}: {ts_type(param.get('schema', {}), '      ')}")
    return "{ " + "; ".join(fields) + " }"


def render(spec: dict[str, Any] | None = None) -> str:
    spec = spec if spec is not None else load_openapi()
    operations = _kb_operations(spec)
    schemas = spec.get("components", {}).get("schemas", {})
    out = [
        "// Generated by scripts/gen-kb-types.py from the backend OpenAPI schema. Do not edit by hand.",
        f"// Regenerate: {COMMAND}",
        "",
    ]
    for name in _reachable(spec, operations):
        schema = schemas[name]
        description = schema.get("description")
        if description:
            out.append("/** " + " ".join(description.split()).replace("*/", "* /") + " */")
        if schema.get("type") == "object" and schema.get("properties"):
            out.append(f"export interface {_type_name(name)} {_object_literal(schema, '')}")
        else:
            out.append(f"export type {_type_name(name)} = {ts_type(schema)};")
        out.append("")
    out.append("/** Every /kb route: path and query parameters, JSON body and JSON response. */")
    out.append("export interface KbEndpoints {")
    for path, method, operation in operations:
        status, response = _success(operation)
        body = _json_schema(operation.get("requestBody"))
        out.append(f"  {json.dumps(method.upper() + ' ' + path)}: {{")
        out.append(f"    path: {_parameters(operation, 'path')};")
        out.append(f"    query: {_parameters(operation, 'query')};")
        out.append(f"    body: {ts_type(body, '    ') if body is not None else 'never'};")
        out.append(f"    response: {ts_type(response, '    ') if response is not None else 'void'};")
        out.append(f"    status: {status};")
        out.append("  };")
    out.append("}")
    out.append("")
    out.append("export type KbRoute = keyof KbEndpoints;")
    return "\n".join(out) + "\n"


def main(argv: list[str]) -> int:
    text = render()
    if "--check" in argv:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != text:
            print(f"{OUTPUT.relative_to(REPO)} is stale. Run: {COMMAND}", file=sys.stderr)
            return 1
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(text, encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
