"""The small YAML subset used in SKAZ frontmatter, without a YAML dependency.

SKAZ writes every value as JSON (valid YAML flow style). The reader also
accepts what Obsidian's property editor writes back: plain scalars and
block-style lists (``key:`` followed by ``  - item`` lines).
"""
from __future__ import annotations

import json
import re
from typing import Any

_KEY = re.compile(r"^([A-Za-z_][\w-]*):(?:[ \t]+(.*?))?[ \t]*$")
_ITEM = re.compile(r"^[ \t]+-[ \t]*(.*?)[ \t]*$")


class FrontmatterError(ValueError):
    pass


def split_frontmatter(text: str) -> tuple[str, dict[str, Any], str]:
    """Return ``(raw_frontmatter_with_fences, fields, body)``; raises when absent."""
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip("\r\n") != "---":
        raise FrontmatterError("Missing frontmatter.")
    for index in range(1, len(lines)):
        if lines[index].rstrip("\r\n") == "---":
            raw = "".join(lines[: index + 1])
            body = "".join(lines[index + 1:])
            return raw, _parse_fields(lines[1:index]), body
    raise FrontmatterError("Unterminated frontmatter.")


def _parse_fields(lines: list[str]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    current: str | None = None
    for line in (item.rstrip("\r\n") for item in lines):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        item = _ITEM.match(line)
        if item is not None and current is not None:
            key = current
            value = fields.get(key)
            if not isinstance(value, list):
                value = []
                fields[key] = value
            value.append(_scalar(item.group(1)))
            continue
        match = _KEY.match(line)
        if match is None:
            raise FrontmatterError(f"Unreadable frontmatter line: {line!r}")
        current = match.group(1)
        raw_value = match.group(2)
        fields[current] = None if raw_value is None or raw_value == "" else _value(raw_value)
    return fields


def _value(raw: str) -> Any:
    if raw.startswith("[") and raw.endswith("]"):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            inner = raw[1:-1].strip()
            return [_scalar(part.strip()) for part in inner.split(",")] if inner else []
    return _scalar(raw)


def _scalar(raw: str) -> Any:
    if raw in ("~", "null", "Null", "NULL"):
        return None
    if raw.startswith('"'):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw
    if len(raw) >= 2 and raw.startswith("'") and raw.endswith("'"):
        return raw[1:-1].replace("''", "'")
    if raw in ("true", "false"):
        return raw == "true"
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    return raw


def render_frontmatter(fields: dict[str, Any]) -> str:
    lines = ["---"]
    for key, value in fields.items():
        lines.append(f"{key}: {json.dumps(value, ensure_ascii=False)}")
    lines.append("---")
    return "\n".join(lines) + "\n"
