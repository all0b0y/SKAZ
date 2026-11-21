"""The source and consent for profile changes come from the live user turn."""

from __future__ import annotations

import re
from typing import Any

from ...native_io import disk_call
from ..chats.model import MessageInput
from ..chats.service import ChatService
from ..errors import KnowledgeError, NameRejected
from ..permissions.broker import PermissionBroker
from ..permissions.store import RunRef
from ..sources.service import SourceService
from .service import Extensions
from .skill_source import MAX_SKILL
from .transport import address, local

# Full commands only. Quoted, negated, or unrelated requests never count as consent.
_SKILL = r"(?:install(?: this| the)?(?: skill)?|установи(?:ть)?(?: этот)?(?: скилл?)?)"
_MCP = r"(?:connect(?: this| the)?(?: mcp)?(?: server)?|подключи(?:ть)?(?: этот)?(?: mcp)?(?: сервер)?)"


def requested(text: str, source: str, *, mcp: bool = False) -> bool:
    command = re.compile(_MCP if mcp else _SKILL, re.IGNORECASE)
    if not source:
        return command.fullmatch(text.strip()) is not None
    match = re.fullmatch(r"(.+?)(?:\s*:\s*|\s+)" + re.escape(source), text.strip())
    return match is not None and command.fullmatch(match[1]) is not None


def supplied_url(text: str, url: str) -> bool:
    links = re.findall(r'https?://[^\s<>"\x27]+', text)
    return any(candidate == url or candidate.rstrip(").,;!?]") == url for candidate in links)


class ChatInstall:
    def __init__(
        self,
        extensions: Extensions,
        chats: ChatService,
        permissions: PermissionBroker,
        sources: SourceService,
    ) -> None:
        self.extensions = extensions
        self.chats = chats
        self.permissions = permissions
        self.sources = sources

    def input(self, ref: RunRef) -> MessageInput:
        given = self.chats.run_input(ref)
        if given is None:
            raise NameRejected("This chat turn has ended.")
        return given

    async def connect(self, ref: RunRef, source: str) -> dict[str, Any]:
        url = address(source)
        trust = "local" if local(url) else "verified" if url in self.extensions.mcp_sources else "unverified"
        explicit = requested(self.input(ref).text, url, mcp=True)
        warn_first = trust == "unverified" or self.input(ref).text.strip() == url
        if warn_first:
            decision = await self.permissions.request(
                ref,
                "mcp_connect",
                page_id=None,
                title=url,
                preview={"recipient": url, "arguments": {"source": url, "trust": trust}},
            )
            if decision.status != "allowed":
                return {"status": decision.status, "reason": decision.reason}
        self.input(ref)
        info = await self.extensions.check("mcp", url)
        if (not explicit and not warn_first) or (info["recipient"] != url and info["trust"] == "unverified"):
            decision = await self.permissions.request(
                ref,
                "mcp_connect",
                page_id=None,
                title=info["name"],
                preview={
                    "recipient": info["recipient"],
                    "arguments": {"source": url, "trust": info["trust"]},
                },
            )
            if decision.status != "allowed":
                return {"status": decision.status, "reason": decision.reason}
        self.input(ref)
        item = await self.extensions.add(url, info["check_id"], True)
        return {"status": "ok", "id": item["id"]}

    async def install(
        self, ref: RunRef, url: str | None, attachment: str | None, *, raw: bytes | None = None
    ) -> dict[str, Any]:
        given = self.input(ref)
        if not url and not attachment and len(given.attachments) == 1:
            attachment = given.attachments[0]
        if bool(url) == bool(attachment):
            raise NameRejected("Choose one skill URL or one attached SKILL.md.")
        if url:
            if not supplied_url(given.text, url):
                raise NameRejected("Use the skill URL in the current user message.")
            consent = requested(given.text, url)
        else:
            if not attachment or attachment not in given.attachments:
                raise NameRejected("Choose SKILL.md from this user message.")
            if raw is None:
                raw = await disk_call(self.sources.skill_attachment, attachment, max_bytes=MAX_SKILL)
            if raw is None:
                raise NameRejected("The selected attachment is not SKILL.md.")
            consent = len(given.attachments) == 1 and (
                requested(given.text, "") or requested(given.text, "SKILL.md")
            )
        if not consent:
            decision = await self.permissions.request(
                ref,
                "skill_install",
                page_id=None,
                title="this skill",
                preview={"recipient": url or "SKILL.md", "arguments": {"source": url or attachment}},
            )
            if decision.status != "allowed":
                return {"status": decision.status, "reason": decision.reason}
        self.input(ref)
        if url:
            ticket = await self.extensions.check("skill", url)
            self.input(ref)
            item = await self.extensions.add(url, ticket["check_id"], False)
        else:
            assert attachment and raw is not None
            item = await disk_call(self.extensions.install_attachment, attachment, raw)
        return {"status": "ok", "id": item["id"], "name": item["name"]}

    async def shared(self, ref: RunRef, given: MessageInput) -> tuple[str, tuple[str, ...]] | None:
        """Handle shared setup sources while preserving other attachments for the agent."""
        if given.mentions or given.quotes or given.selection:
            return None
        text = given.text.strip()
        replies: list[str] = []
        remaining: list[str] = []
        if given.attachments and text.casefold().rstrip(".!") in {
            "",
            "вот",
            "вот скилл",
            "держи",
            "skill.md",
            "here",
            "here is the skill",
        }:
            for attachment in given.attachments:
                try:
                    raw = await disk_call(self.sources.skill_attachment, attachment, max_bytes=MAX_SKILL)
                    if raw is None:
                        remaining.append(attachment)
                        continue
                    result = await self.install(ref, None, attachment, raw=raw)
                    replies.append(self._skill_reply(result))
                except KnowledgeError as error:
                    replies.append(error.message)
        elif not given.attachments:
            try:
                if re.fullmatch(r"https://[^\s]+/SKILL\.md(?:\?[^\s]*)?", text, re.I):
                    replies.append(self._skill_reply(await self.install(ref, text, None)))
                elif re.fullmatch(r"https?://[^\s]+/mcp/?(?:\?[^\s]*)?", text, re.I):
                    result = await self.connect(ref, text)
                    replies.append("MCP connected." if result["status"] == "ok" else "Connection skipped.")
            except KnowledgeError as error:
                replies.append(error.message)
        return ("\n".join(replies), tuple(remaining)) if replies else None

    @staticmethod
    def _skill_reply(result: dict[str, Any]) -> str:
        return f"Installed {result['name']}." if result["status"] == "ok" else "Skill installation skipped."
