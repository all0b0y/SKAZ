"""One-off migration: move per-profile "api_key" in test payloads to "provider_keys".

Scans ``json={...}`` blocks, finds nested profile dicts ("asr"/"agent"/"notes"),
removes their ``"api_key": <expr>`` entry and emits a single ``"provider_keys"``
mapping keyed by that profile's provider literal. Blocks whose provider is not a
plain string literal are reported and left untouched for manual review.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

PROFILE_KEYS = ("asr", "agent", "notes")


def find_blocks(text: str, opener: str) -> list[tuple[int, int]]:
    """Spans of balanced ``{...}`` that follow each ``opener`` occurrence."""
    spans = []
    for match in re.finditer(re.escape(opener), text):
        brace = text.find("{", match.end() - 1)
        # Only a payload that literally starts with a dict is a candidate; a
        # variable (json=payload) or a later unrelated brace must not be grabbed.
        if brace == -1 or text[match.end() : brace].strip() != "":
            continue
        start = brace
        depth, i, in_str, quote = 0, start, False, ""
        while i < len(text):
            ch = text[i]
            if in_str:
                if ch == "\\":
                    i += 2
                    continue
                if ch == quote:
                    in_str = False
            elif ch in "\"'":
                in_str, quote = True, ch
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    spans.append((start, i + 1))
                    break
            i += 1
    return spans


def inner_dict(block: str, key: str) -> tuple[int, int] | None:
    match = re.search(rf'"{key}"\s*:\s*\{{', block)
    if match is None:
        return None
    start = block.index("{", match.end() - 1)
    depth, i, in_str, quote = 0, start, False, ""
    while i < len(block):
        ch = block[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                in_str = False
        elif ch in "\"'":
            in_str, quote = True, ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return start, i + 1
        i += 1
    return None


KEY_RE = re.compile(r'\s*"api_key"\s*:\s*([^,}\n]+?)\s*(,)?(?=\s*[}\n])')


def migrate_block(block: str, report: list[str], where: str) -> str:
    keys: dict[str, str] = {}
    for profile_key in PROFILE_KEYS:
        span = inner_dict(block, profile_key)
        if span is None:
            continue
        start, end = span
        profile = block[start:end]
        key_match = KEY_RE.search(profile)
        if key_match is None:
            continue
        provider_match = re.search(r'"provider"\s*:\s*"([a-z0-9-]+)"', profile)
        if provider_match is None:
            report.append(f"{where}: {profile_key} has api_key but no literal provider")
            continue
        keys[provider_match.group(1)] = key_match.group(1).strip()
        cleaned = profile[: key_match.start()] + profile[key_match.end() :]
        cleaned = re.sub(r",(\s*)}", r"\1}", cleaned)
        cleaned = re.sub(r"{\s*,", "{", cleaned)
        block = block[:start] + cleaned + block[end:]
    if not keys:
        return block
    rendered = ", ".join(f'"{provider}": {value}' for provider, value in keys.items())
    return block[:1] + f'"provider_keys": {{{rendered}}}, ' + block[1:].lstrip()


def migrate(path: Path, report: list[str]) -> bool:
    text = original = path.read_text()
    for opener in ("json=", "json = "):
        while True:
            spans = find_blocks(text, opener)
            changed = False
            for start, end in spans:
                block = text[start:end]
                new_block = migrate_block(block, report, f"{path.name}:{text[:start].count(chr(10)) + 1}")
                if new_block != block:
                    text = text[:start] + new_block + text[end:]
                    changed = True
                    break
            if not changed:
                break
    if text != original:
        path.write_text(text)
        return True
    return False


def main() -> None:
    root = Path(sys.argv[1])
    report: list[str] = []
    touched = [p.name for p in sorted(root.glob("test_*.py")) if migrate(p, report)]
    print("migrated:", ", ".join(touched) or "none")
    for line in report:
        print("MANUAL:", line)


if __name__ == "__main__":
    main()
