"""Check sources, bind installation to the checked bytes/recipient, and retain profile-local settings."""

from __future__ import annotations

import asyncio
import base64
import json
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

from ...native_io import disk_call
from ..chats.model import FilePart
from ..errors import NameRejected, NameTaken, NotFound
from ..ids import new_id
from ..keyed_locks import KeyedLocks
from ..service import KnowledgeService
from ..skills import skill
from ..skills.settings import is_enabled, set_enabled
from .skill_source import MAX_SKILL, assess, download_url
from .transport import BeforeSend, Transport, address, local

# Trust roots ship with SKAZ. No unapproved URL becomes an endorsed publisher automatically.
SKILL_SOURCES: dict[str, dict[str, str]] = {}
MCP_SOURCES: frozenset[str] = frozenset()
MAX_FILE = 8 * 1024 * 1024
CATALOG_TIMEOUT_S = 35
LEGACY_SKILL_HISTORY = "external_skills.legacy_inline"


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
        self._catalogs = KeyedLocks()

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

    def active_mcp(self, ident: str) -> dict[str, Any]:
        item = self.get(ident)
        if not item["active"] or item["kind"] != "mcp":
            raise NameRejected("This MCP is inactive.")
        return item

    async def refresh_mcp(self, ident: str, *, before_send: BeforeSend | None = None) -> dict[str, Any]:
        try:
            async with asyncio.timeout(CATALOG_TIMEOUT_S), self._catalogs.hold(ident):
                item = await disk_call(self.active_mcp, ident)
                recipient = item["recipient"]
                async with self.transport.session(recipient, before_send=before_send) as remote:
                    tools = await remote.tools()
                return await disk_call(self._save_catalog, ident, recipient, tools)
        except TimeoutError as error:
            raise NameRejected("Refreshing the MCP tools timed out. Try again.") from error

    def _save_catalog(self, ident: str, recipient: str, tools: list[dict[str, Any]]) -> dict[str, Any]:
        with self.kb.db.write() as db:
            row = db.execute(
                "SELECT * FROM external_tools WHERE id=? AND kind='mcp' AND active=1", (ident,)
            ).fetchone()
            if row is None:
                raise NameRejected("The connection was disabled or removed during the refresh.")
            details = json.loads(row["details"])
            if details["recipient"] != recipient:
                raise NameRejected("The connection address changed during the refresh.")
            details["tools"] = tools
            db.execute("UPDATE external_tools SET details=? WHERE id=?", (json.dumps(details), ident))
        return {**details, "id": ident, "url": row["url"], "active": True}

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
            removed = db.execute(
                "DELETE FROM external_tools WHERE id=? RETURNING kind,details", (ident,)
            ).fetchone()
            if removed is None:
                raise NotFound("This connection or skill is unavailable.")
            if removed["kind"] == "skill" and "description" not in json.loads(removed["details"]):
                db.execute(
                    "INSERT OR IGNORE INTO settings(key,value) VALUES(?, 'true')", (LEGACY_SKILL_HISTORY,)
                )

    def skill_session_state(self) -> tuple[frozenset[str], bool]:
        """Availability and evidence of installs made when all active skills went into the prompt."""
        with self.kb.db.read() as db:
            rows = db.execute(
                "SELECT id,active,details FROM external_tools WHERE kind='skill'"
            ).fetchall()
            had_legacy = db.execute("SELECT 1 FROM settings WHERE key=?", (LEGACY_SKILL_HISTORY,)).fetchone()
        enabled = frozenset(row["id"] for row in rows if row["active"])
        # Catalog rows installed by the inline-prompt implementation have no description field.
        legacy = had_legacy is not None or any(
            "description" not in json.loads(row["details"]) for row in rows
        )
        return enabled, legacy

    def skill_catalog(self) -> list[dict[str, Any]]:
        with self.kb.db.read() as db:
            rows = db.execute(
                "SELECT id,details FROM external_tools WHERE kind='skill' AND active=1 ORDER BY id"
            ).fetchall()
        catalog = []
        for row in rows:
            item = json.loads(row["details"])
            catalog.append({
                "id": row["id"], "name": item["name"], "description": item.get("description", ""),
            })
        return catalog

    def skill_instructions(self, ident: str) -> tuple[str, str]:
        with self.kb.db.read() as db:
            row = db.execute(
                "SELECT details,instructions FROM external_tools WHERE id=? AND kind='skill' AND active=1",
                (ident,),
            ).fetchone()
        if row is None:
            raise NotFound("This skill is disabled or unavailable.")
        return str(json.loads(row["details"])["name"]), str(row["instructions"])

    def skill_is_enabled(self, ident: str) -> bool:
        with self.kb.db.read() as db:
            return db.execute(
                "SELECT 1 FROM external_tools WHERE id=? AND kind='skill' AND active=1", (ident,)
            ).fetchone() is not None

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
