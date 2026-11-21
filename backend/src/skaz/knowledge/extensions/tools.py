"""Agent-facing tools. A run's trusted chat identity comes from SKAZ, never from tool arguments."""

from __future__ import annotations

import json
from typing import Any

from pydantic import Field

from ...native_io import disk_call
from ..agents.tools import (
    DEFAULT_MAX_OUTPUT_BYTES,
    SkazTool,
    ToolContext,
    ToolInputError,
    _Args,
    _fit,
    render,
    size,
)
from ..chats.service import ChatService
from ..errors import KnowledgeError
from ..permissions.broker import PermissionBroker
from ..permissions.store import RunRef
from ..sources.service import SourceService
from .chat_install import ChatInstall
from .service import Extensions, result_file


class Discover(_Args):
    connection_id: str | None = Field(default=None, max_length=120)
    tool: str | None = Field(default=None, max_length=256)
    offset: int = Field(default=0, ge=0)


class Proposal(_Args):
    url: str = Field(min_length=1, max_length=4096)


class SkillSource(_Args):
    url: str | None = Field(default=None, min_length=1, max_length=4096)
    attachment_id: str | None = Field(default=None, min_length=1, max_length=120)


class Call(_Args):
    connection_id: str = Field(min_length=1, max_length=120)
    tool: str = Field(min_length=1, max_length=256)
    arguments: dict[str, Any]


def attach(
    extensions: Extensions, chats: ChatService, permissions: PermissionBroker, sources: SourceService
) -> list[SkazTool]:
    installer = ChatInstall(extensions, chats, permissions, sources)
    chats.review_shared_tools = installer.shared

    def owner(ctx: ToolContext | None) -> RunRef:
        ref = chats.run_ref(ctx.run_id) if ctx else None
        if ref is None:
            raise ToolInputError("An active chat is required.")
        return ref

    async def discover(ctx: ToolContext | None, args: Discover) -> dict[str, Any]:
        owner(ctx)
        try:
            if args.connection_id:
                item = await disk_call(extensions.get, args.connection_id)
                if not item["active"] or item["kind"] != "mcp":
                    raise ToolInputError("This MCP is inactive.")
                if args.tool:
                    selected = next((t for t in item["tools"] if t["name"] == args.tool), None)
                    if selected is None:
                        raise ToolInputError("The selected tool is unavailable.")
                    schema = json.dumps(selected["inputSchema"], ensure_ascii=False, separators=(",", ":"))
                    part = schema[args.offset : args.offset + 3500]
                    return {
                        "status": "ok",
                        "schema_json": part,
                        "next_offset": args.offset + len(part)
                        if args.offset + len(part) < len(schema)
                        else None,
                    }
                rows = [{"name": t["name"], "description": t["description"]} for t in item["tools"]]
                field = "tools"
            else:
                rows = await disk_call(extensions.discover)
                field = "connections"
            page, more = _fit(
                "skaz_mcp_list", {"status": "ok"}, field, rows[args.offset :], DEFAULT_MAX_OUTPUT_BYTES - 1024
            )
            return {"status": "ok", field: page, "next_offset": args.offset + len(page) if more else None}
        except KnowledgeError as error:
            raise ToolInputError(error.message) from error

    async def propose(ctx: ToolContext | None, args: Proposal) -> dict[str, Any]:
        ref = owner(ctx)
        try:
            return await installer.connect(ref, args.url)
        except KnowledgeError as error:
            raise ToolInputError(error.message) from error

    async def install(ctx: ToolContext | None, args: SkillSource) -> dict[str, Any]:
        try:
            return await installer.install(owner(ctx), args.url, args.attachment_id)
        except KnowledgeError as error:
            raise ToolInputError(error.message) from error

    async def invoke(ctx: ToolContext | None, args: Call) -> dict[str, Any]:
        ref = owner(ctx)
        try:
            item = await disk_call(extensions.get, args.connection_id)
            if not item["active"] or item["kind"] != "mcp":
                raise ToolInputError("This MCP is inactive.")
            tool = next((t for t in item["tools"] if t["name"] == args.tool), None)
            if tool is None:
                raise ToolInputError("The selected tool is unavailable.")
            schema = tool["inputSchema"]
            if len(json.dumps(args.arguments).encode()) > 65536:
                raise ToolInputError("The arguments are too large.")
            if set(schema.get("required", [])) - args.arguments.keys() or (
                schema.get("additionalProperties") is False
                and args.arguments.keys() - schema.get("properties", {}).keys()
            ):
                raise ToolInputError("The arguments do not match this MCP tool.")
            verdict = await permissions.request(
                ref,
                "mcp_call",
                page_id=None,
                title=args.tool,
                preview={"recipient": item["recipient"], "arguments": args.arguments},
            )
            if verdict.status != "allowed":
                return {"status": verdict.status, "reason": verdict.reason}
            owner(ctx)
            if not (await disk_call(extensions.get, args.connection_id))["active"]:
                raise ToolInputError("This MCP was disabled before the call.")
            async with extensions.transport.session(item["recipient"]) as remote:
                owner(ctx)
                current = await disk_call(extensions.get, args.connection_id)
                if not current["active"] or current["recipient"] != remote.url:
                    raise ToolInputError("The connection changed before the call.")
                reply = await remote.rpc("tools/call", {"name": args.tool, "arguments": args.arguments})
            if reply.get("isError"):
                raise ToolInputError("The external MCP reported an error.")
            owner(ctx)
            content = reply.get("content", [])
            if not isinstance(content, list) or not all(isinstance(c, dict) for c in content):
                raise ToolInputError("The MCP returned an invalid result.")
            # Validate every attachment before saving any. Text links never become local files.
            decoded = [result_file(c) for c in content]
            results = []
            for entry, file in zip(content, decoded, strict=True):
                if file is None:
                    results.append(entry)
                else:
                    part = await disk_call(extensions.save_file, ref.message_id, *file)
                    await chats.add_part(ref.chat_id, ref.message_id, part)
                    results.append({"file": part.name, "size": part.size})
            payload = {
                "status": "ok",
                "content": results,
                **({"structuredContent": reply["structuredContent"]} if "structuredContent" in reply else {}),
            }
            if size(render("skaz_mcp_call", payload, web=True)) > DEFAULT_MAX_OUTPUT_BYTES:
                # The action completed. A failure here could cause a duplicate external write.
                return {
                    "status": "ok",
                    "truncated": True,
                    "completed": True,
                    "result_excerpt": json.dumps(payload, ensure_ascii=False)[:3500],
                }
            return payload
        except KnowledgeError as error:
            raise ToolInputError(error.message) from error

    return [
        SkazTool(
            "skaz_skill_install",
            "Install a SKILL.md from the current user's URL or attachment_id. For a single attached "
            "SKILL.md omit arguments. SKAZ checks the instructions and asks before installation "
            "unless the user explicitly requested it. Never run bundled scripts.",
            SkillSource,
            run=install,
            timeout_s=None,
            untrusted_result=True,
        ),
        SkazTool(
            "skaz_mcp_list",
            "List active external MCP recipients. Pass connection_id to list its tools, then tool to read "
            "its argument schema. Continue a listing or schema with next_offset as offset.",
            Discover,
            run=discover,
            untrusted_result=True,
        ),
        SkazTool(
            "skaz_mcp_propose",
            "Check an MCP URL and ask the user before adding the connection.",
            Proposal,
            run=propose,
            timeout_s=None,
        ),
        SkazTool(
            "skaz_mcp_call",
            "Call one tool from skaz_mcp_list. Send only data authorized for this task. "
            "SKAZ shows the recipient and exact arguments to the user and applies this chat's decision.",
            Call,
            run=invoke,
            timeout_s=None,
            untrusted_result=True,
        ),
    ]
