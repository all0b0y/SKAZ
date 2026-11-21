"""Assess the exact instruction file using the pinned Hermes policy."""

from __future__ import annotations

import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from urllib.parse import urlsplit

import yaml  # type: ignore[import-untyped]
from yaml.nodes import MappingNode, ScalarNode  # type: ignore[import-untyped]

from ..errors import NameRejected
from .hermes_guard.skills_guard import TRUSTED_REPOS, scan_skill, should_allow_install
from .transport import address, local

MAX_SKILL = 128 * 1024


def download_url(url: str) -> str:
    parsed = urlsplit(address(url))
    if parsed.scheme != "https" or local(url):
        raise NameRejected("Use an HTTPS skill source or attach SKILL.md in this chat.")
    parts = parsed.path.strip("/").split("/")
    if parsed.netloc == "github.com" and len(parts) >= 2:
        repo = "/".join(parts[:2])
        if len(parts) == 2:
            return f"https://raw.githubusercontent.com/{repo}/HEAD/SKILL.md"
        if len(parts) >= 4 and parts[2] in {"blob", "tree"}:
            path = "/".join(parts[3:])
            if parts[2] == "tree":
                path += "/SKILL.md"
            return f"https://raw.githubusercontent.com/{repo}/{path}"
    return url


def trusted_repo(url: str) -> bool:
    parsed = urlsplit(url)
    parts = parsed.path.strip("/").split("/")
    return (
        parsed.netloc == "raw.githubusercontent.com"
        and len(parts) >= 4
        and parts[2] in {"main", "master", "HEAD"}
        and "/".join(parts[:2]) in TRUSTED_REPOS
        and all(part not in {"", ".", ".."} and "%" not in part for part in parts)
    )


def assess(raw: bytes, source: str, pin: dict[str, str] | None) -> tuple[dict[str, Any], str]:
    digest = hashlib.sha256(raw).hexdigest()
    if pin and digest != pin["sha256"]:
        raise NameRejected("The downloaded skill does not match the approved version.")
    if not raw or len(raw) > MAX_SKILL or b"\0" in raw:
        raise NameRejected("Provide a UTF-8 SKILL.md of at most 128 KiB.")
    try:
        instructions = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise NameRejected("A skill must contain UTF-8 instructions.") from error
    lines = instructions.splitlines()
    if not lines or lines[0] != "---" or "---" not in lines[1:]:
        raise NameRejected("SKILL.md needs name and description in its frontmatter.")
    end = lines.index("---", 1)
    if not any(line.strip() for line in lines[end + 1 :]):
        raise NameRejected("SKILL.md has no instructions.")
    try:
        front = yaml.compose("\n".join(lines[1:end]), Loader=yaml.BaseLoader)
    except (yaml.YAMLError, RecursionError) as error:
        raise NameRejected("Unreadable SKILL.md frontmatter.") from error
    fields = (
        {k.value: v.value for k, v in front.value if isinstance(k, ScalarNode) and isinstance(v, ScalarNode)}
        if isinstance(front, MappingNode)
        else {}
    )
    if not all(fields.get(key, "").strip() for key in ("name", "description")):
        raise NameRejected("SKILL.md needs a name and a description.")
    trusted = bool(pin) or trusted_repo(source)
    with TemporaryDirectory(prefix="skaz-skill-") as directory:
        path = Path(directory, "SKILL.md")
        path.write_bytes(raw)
        result = scan_skill(path, trust_level="trusted" if trusted else "community")
    allowed, _ = should_allow_install(result)
    if not allowed:
        severity = "critical" if result.verdict == "dangerous" else "high"
        finding = next((f for f in result.findings if f.severity == severity), None)
        reason = f" Line {finding.line}: {finding.description}." if finding else ""
        raise NameRejected(f"Hermes Skills Guard blocked this skill ({result.verdict})." + reason)
    return {
        "kind": "skill",
        "name": pin["name"] if pin else fields["name"][:200],
        "recipient": source,
        "trust": "verified" if trusted else "unverified",
        "publisher": pin["publisher"] if pin else urlsplit(source).hostname or "Chat attachment",
        "version": pin["version"] if pin else fields.get("version", digest[:12])[:80],
        "sha256": digest,
        "tools": [],
    }, instructions
