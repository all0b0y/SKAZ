"""Check sources, bind installation to the checked bytes/recipient, and retain profile-local settings."""

from __future__ import annotations

import base64
import json
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

from ...native_io import disk_call
from ..chats.model import FilePart
from ..errors import NameRejected, NameTaken, NotFound
from ..ids import new_id
from ..service import KnowledgeService
from ..skills import SkazSkill, skill
from ..skills.settings import is_enabled, set_enabled
from .skill_source import MAX_SKILL, assess, download_url
from .transport import Transport, address, local

# Trust roots ship with SKAZ. No unapproved URL becomes an endorsed publisher automatically.
SKILL_SOURCES: dict[str, dict[str, str]] = {}
MCP_SOURCES: frozenset[str] = frozenset()
MAX_FILE = 8 * 1024 * 1024


@dataclass
class Check:
    url: str
    details: dict[str, Any]
    instructions: str
    expires: float


class Extensions:
    def __init__(self, kb: KnowledgeService) -> None:
        self.kb = kb
        self.transport = Transport()
        self.skill_sources = SKILL_SOURCES
        self.mcp_sources = MCP_SOURCES
        self._checks: dict[str, Check] = {}

    async def check(self, kind: str, url: str) -> dict[str, Any]:
        address(url)
        instructions = ""
        if kind == "mcp":
            async with self.transport.session(url, discover=True) as remote:
                tools = await remote.tools()
                trust = (
                    "local"
                    if local(remote.url)
                    else "verified"
                    if remote.url in self.mcp_sources
                    else "unverified"
                )
                details: dict[str, Any] = {
                    "kind": kind,
                    "name": remote.name[:200],
                    "recipient": remote.url,
                    "trust": trust,
                    "tools": tools,
                    "warning": "Unverified MCP publisher." if trust == "unverified" else None,
                }
        elif kind == "skill":
            packet = await self.transport.request(download_url(url), limit=MAX_SKILL)
            details, instructions = await disk_call(
                assess, packet.content, packet.url, self.skill_sources.get(url)
            )
        else:
            raise NameRejected("Unknown source type.")
        return self._ticket(url, details, instructions)

    def _ticket(self, url: str, details: dict[str, Any], instructions: str) -> dict[str, Any]:
        now = time.monotonic()
        self._checks = {k: v for k, v in self._checks.items() if v.expires > now}
        if len(self._checks) >= 128:
            self._checks.pop(next(iter(self._checks)))
        token = secrets.token_urlsafe(24)
        self._checks[token] = Check(url, details, instructions, now + 300)
        return {**details, "check_id": token}

    async def add(self, url: str, check_id: str, acknowledge: bool) -> dict[str, Any]:
        checked = self._checks.get(check_id)
        if not checked or checked.expires < time.monotonic() or checked.url != url:
            raise NameTaken("The address changed or the check expired. Check the source again.")
        if checked.details["kind"] == "mcp" and checked.details["trust"] == "unverified" and not acknowledge:
            raise NameRejected("Confirm the unverified MCP publisher before connecting.")
        self._checks.pop(check_id)
        return await disk_call(self._insert, checked)

    def install_attachment(self, ident: str, raw: bytes) -> dict[str, Any]:
        source = f"attachment:{ident}"
        details, instructions = assess(raw, source, None)
        details["recipient"] = "SKILL.md"
        return self._insert(Check(source, details, instructions, 0))

    def _insert(self, checked: Check) -> dict[str, Any]:
        ident = new_id("ext")
        details = checked.details
        try:
            with self.kb.db.write() as db:
                db.execute(
                    "INSERT INTO external_tools(id,kind,url,details,instructions) VALUES(?,?,?,?,?)",
                    (ident, details["kind"], checked.url, json.dumps(details), checked.instructions),
                )
        except sqlite3.IntegrityError as error:
            raise NameTaken("This source has already been added.") from error
        return {**details, "id": ident, "url": checked.url, "active": True}

    def settings_view(self) -> dict[str, list[dict[str, Any]]]:
        human = skill("humanizer")
        groups: dict[str, list[dict[str, Any]]] = {
            "mcp": [],
            "skills": [
                {
                    "kind": "skill",
                    "id": human.id,
                    "name": human.name,
                    "built_in": True,
                    "active": is_enabled(self.kb.settings, human.id),
                    "version": human.version,
                }
            ],
        }
        with self.kb.db.read() as db:
            rows = db.execute(
                "SELECT id,kind,url,details,active FROM external_tools ORDER BY rowid"
            ).fetchall()
        for row in rows:
            groups["mcp" if row["kind"] == "mcp" else "skills"].append(self._item(row))
        return groups

    @staticmethod
    def _item(row: sqlite3.Row) -> dict[str, Any]:
        return {
            **json.loads(row["details"]),
            "id": row["id"],
            "url": row["url"],
            "active": bool(row["active"]),
        }

    def get(self, ident: str) -> dict[str, Any]:
        with self.kb.db.read() as db:
            row = db.execute("SELECT * FROM external_tools WHERE id=?", (ident,)).fetchone()
        if row is None:
            raise NotFound("This connection or skill is unavailable.")
        return self._item(row)

    def toggle(self, ident: str, active: bool) -> dict[str, Any]:
        if ident == "humanizer":
            set_enabled(self.kb.settings, ident, active)
            return self.settings_view()["skills"][0]
        with self.kb.db.write() as db:
            if not db.execute("UPDATE external_tools SET active=? WHERE id=?", (active, ident)).rowcount:
                raise NotFound("This connection or skill is unavailable.")
        return self.get(ident)

    def remove(self, ident: str) -> None:
        with self.kb.db.write() as db:
            if not db.execute("DELETE FROM external_tools WHERE id=?", (ident,)).rowcount:
                raise NotFound("This connection or skill is unavailable.")

    def skills(self) -> tuple[SkazSkill, ...]:
        with self.kb.db.read() as db:
            rows = db.execute(
                "SELECT * FROM external_tools WHERE active=1 AND kind='skill' ORDER BY id"
            ).fetchall()
        found = []
        for row in rows:
            item = self._item(row)
            found.append(
                SkazSkill(
                    item["id"],
                    item["name"],
                    item["version"],
                    "",
                    item["url"],
                    item["sha256"],
                    Path("SKILL.md"),
                    row["instructions"],
                )
            )
        return tuple(found)

    def discover(self) -> list[dict[str, Any]]:
        return [
            {
                "id": item["id"],
                "name": item["name"],
                "recipient": item["recipient"],
                "tool_count": len(item["tools"]),
            }
            for item in self.settings_view()["mcp"]
            if item["active"]
        ]

    def save_file(self, message_id: str, name: str, mime: str, content: bytes) -> FilePart:
        ident = new_id("file")
        with self.kb.db.write() as db:
            db.execute(
                "INSERT INTO chat_result_files(id,message_id,name,mime_type,content) VALUES(?,?,?,?,?)",
                (ident, message_id, name, mime, content),
            )
        return FilePart(ident, name, mime, len(content))

    def file(self, chat_id: str, message_id: str, file_id: str) -> dict[str, Any]:
        with self.kb.db.read() as db:
            row = db.execute(
                "SELECT f.* FROM chat_result_files f JOIN chat_messages m ON m.id=f.message_id "
                "WHERE f.id=? AND m.id=? AND m.chat_id=? AND m.role='assistant'",
                (file_id, message_id, chat_id),
            ).fetchone()
        if row is None:
            raise NotFound("This file is unavailable in this chat.")
        return {
            "id": file_id,
            "name": row["name"],
            "mime_type": row["mime_type"],
            "size": len(row["content"]),
            "data": base64.b64encode(row["content"]).decode("ascii"),
        }


def result_file(content: dict[str, Any]) -> tuple[str, str, bytes] | None:
    kind = content.get("type")
    if kind in ("image", "audio"):
        res = content
        raw = res.get("data")
    elif kind == "resource" and isinstance(content.get("resource"), dict):
        res = content["resource"]
        raw = res.get("blob")
    else:
        return None
    mime = res.get("mimeType") or "application/octet-stream"
    if not isinstance(mime, str) or len(mime) > 120:
        raise NameRejected("Invalid file format in the MCP response.")
    uri = str(res.get("uri") or "")
    name = res.get("name") or PurePosixPath(unquote(urlsplit(uri).path)).name
    name = name or {
        "image/png": "result.png",
        "image/jpeg": "result.jpg",
        "application/pdf": "result.pdf",
    }.get(mime, "result.bin")
    if (
        not isinstance(name, str)
        or name in (".", "..")
        or len(name) > 255
        or any(c in "/\\" or ord(c) < 32 for c in name)
    ):
        raise NameRejected("Invalid file name in the MCP response.")
    if isinstance(raw, str):
        try:
            data = base64.b64decode(raw, validate=True)
        except ValueError as error:
            raise NameRejected("The MCP returned invalid file bytes.") from error
    elif isinstance(res.get("text"), str):
        data = res["text"].encode()
    else:
        raise NameRejected("The MCP did not return the original file.")
    if len(data) > MAX_FILE:
        raise NameRejected("The result file exceeds 8 MB.")
    return name, mime, data
