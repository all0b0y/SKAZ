"""N7-4: a chat's library sources, kept by SKAZ's library tools (not by the model).

* «Use only these sources» — the tools give the agent only the chosen materials and wiki pages: a
  read of anything else is refused with the reason; search hits, lists and the wiki index outside the
  set are dropped before the agent gets them.
* «Exclude from this chat» — the same for one material or page the other way round: it is never
  given to the agent in this chat; a wiki page's citations of it lose their quote.

The agent's own knowledge can't be switched off this way; answers mark it (P1 «agent's knowledge»).
Applied in :meth:`ToolRegistry.call` for every chat turn (Codex dynamic tools and MCP alike); runs
that are no chat answer (wiki jobs) get no scope.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import partial
from typing import Any

from ...native_io import disk_call
from ..agents.tools import ResultNarrowing, ToolContext
from .search_rules import ChatRules, SearchRulesStore
from .store import RunRef

#: Read tools whose ``material_id`` names one material.
MATERIAL_TOOLS = frozenset({"skaz_read_material", "skaz_recent_speech", "skaz_get_fragment"})
NOT_IN_SOURCES = ("This material is not among the sources the user chose for this chat. Answer from "
                  "the chosen sources and say what they don't cover.")
EXCLUDED = "The user excluded this material from this chat. Don't use it; say what is missing instead."
PAGE_NOT_IN_SOURCES = ("This wiki page is not among the sources the user chose for this chat. Answer from "
                       "the chosen sources and say what they don't cover.")
PAGE_EXCLUDED = "The user excluded this wiki page from this chat. Don't use it."
#: Added to a filtered result so the agent knows the list is not the whole library.
SCOPED_NOTE = "Only the sources the user allows in this chat are listed."


@dataclass(frozen=True)
class SourceScope:
    #: ``None``: all sources; else only these material / page ids.
    only: frozenset[str] | None
    excluded: frozenset[str]

    def allows(self, item_id: str) -> bool:
        if item_id in self.excluded:
            return False
        return self.only is None or item_id in self.only

    def refusal(self, item_id: str, *, page: bool = False) -> str | None:
        if self.allows(item_id):
            return None
        if item_id in self.excluded:
            return PAGE_EXCLUDED if page else EXCLUDED
        return PAGE_NOT_IN_SOURCES if page else NOT_IN_SOURCES


def scope_of(rules: ChatRules) -> SourceScope | None:
    if not rules.sources_only and not rules.excluded:
        return None
    return SourceScope(frozenset(rules.sources) if rules.sources_only else None, frozenset(rules.excluded))


def refuse_args(tool: str, args: Any, scope: SourceScope | None) -> str | None:
    """Why this read can't run in this chat (``None``: it may), before anything is read."""
    if scope is None:
        return None
    if tool in MATERIAL_TOOLS:
        material_id = getattr(args, "material_id", None)
        if isinstance(material_id, str):
            return scope.refusal(material_id)
    if tool == "skaz_read_page":
        page_id = getattr(args, "page_id", None)
        if isinstance(page_id, str):
            return scope.refusal(page_id, page=True)
    return None


def _keep(items: object, key: str, scope: SourceScope) -> tuple[list[Any], int]:
    if not isinstance(items, list):
        return [], 0
    kept = [item for item in items if not isinstance(item, Mapping) or scope.allows(str(item.get(key, "")))]
    return kept, len(items) - len(kept)


def scope_payload(tool: str, payload: dict[str, Any], scope: SourceScope | None) -> dict[str, Any] | str:
    """The tool's result with what the chat's sources don't allow taken out; a string: refuse with it."""
    if scope is None:
        return payload
    dropped = 0
    if tool == "skaz_read_page":
        page = payload.get("page")
        page_id = page.get("id") if isinstance(page, Mapping) else None
        if isinstance(page_id, str):
            reason = scope.refusal(page_id, page=True)
            if reason is not None:
                return reason  # found by title: the id is known only now
        for entry in payload.get("entries") or []:
            for cite in entry.get("cites") or [] if isinstance(entry, Mapping) else []:
                material_id = str(cite.get("ref", "")).split(":", 1)[0]
                if isinstance(cite, dict) and not scope.allows(material_id):
                    cite.pop("quote", None)
                    cite["excluded"] = True
        return payload
    if tool == "skaz_search":
        payload["fragments"], a = _keep(payload.get("fragments"), "material_id", scope)
        payload["blocks"], b = _keep(payload.get("blocks"), "page_id", scope)
        payload["pages"], c = _keep(payload.get("pages"), "id", scope)
        dropped = a + b + c
    elif tool == "skaz_list_materials":
        payload["materials"], dropped = _keep(payload.get("materials"), "id", scope)
    elif tool == "skaz_wiki_index":
        payload["pages"], dropped = _keep(payload.get("pages"), "id", scope)
    else:
        return payload
    if dropped or scope.only is not None:
        payload["scope_note"] = SCOPED_NOTE
    return payload


def sources_note(rules: ChatRules, title: Callable[[str], str | None]) -> str:
    """SKAZ's note before the user's question when the chat's sources are narrowed (strict mode)."""
    def named(ids: tuple[str, ...]) -> str:
        return "; ".join(f"«{title(item) or 'no longer in the library'}» ({item})" for item in ids)

    lines: list[str] = []
    if rules.sources_only:
        lines.append("[SKAZ — sources of this chat, set by the user] Use only these sources: "
                     + (named(rules.sources) or "none chosen yet")
                     + ". SKAZ's library tools give you nothing else. Answer only from them; when they don't "
                       "cover something, say so plainly. Anything from your own knowledge must be marked as "
                       "such, never cited.")
    if rules.excluded:
        lines.append("[SKAZ — excluded from this chat by the user] Don't use: " + named(rules.excluded)
                     + ". The library tools won't give them to you.")
    return "\n".join(lines)


class ChatSourceScopes:
    """The registry's ``scope`` hook: the chat of a run, its rules, the refusal / narrowing of one call."""

    def __init__(self, runs: Callable[[str], RunRef | None], store: SearchRulesStore) -> None:
        self.runs = runs
        self.store = store

    async def __call__(self, tool: str, args: Any,
                       context: ToolContext | None) -> tuple[str | None, ResultNarrowing | None]:
        ref = self.runs(context.run_id) if context is not None else None
        if ref is None:
            return None, None
        scope = scope_of(await disk_call(self.store.chat, ref.chat_id))
        if scope is None:
            return None, None
        refusal = refuse_args(tool, args, scope)
        if refusal is not None:
            return refusal, None
        return None, partial(scope_payload, tool, scope=scope)
