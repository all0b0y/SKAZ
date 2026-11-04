"""Answer blocks in a chat answer: checking their sources against the library and this chat.

The rules are the chat's own (``chats.resolve``): a fragment must exist and not be excluded, a
page must exist (a missing block falls back to the page), and a web result must be a link a
web search *of this chat* returned. Runs in a worker thread, like the resolver.
"""
from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from typing import Any

from ..answer_blocks.part import (
    MAX_RAW_CHARS,
    TOO_LONG,
    UNFINISHED,
    BlockPart,
    BlockSource,
    MaterialSource,
    PageSource,
    WebSource,
    unfinished,
)
from ..answer_blocks.registry import Broken, build_block
from ..service import KnowledgeService
from .model import Part
from .parsing import CiteToken, PageToken, parse_token
from .resolve import Resolver

_WEB_PREFIX = "w:"
#: A block whose data made the check itself fail (FIX-1 F2.2): broken, never a failed answer.
UNEXPECTED = "SKAZ couldn't check this block's data."
log = logging.getLogger(__name__)


def _url_key(url: str) -> str:
    return url.strip().rstrip("/")


class ChatWebResults:
    """The result links of this chat's web searches, read once per answer."""

    def __init__(self, kb: KnowledgeService, chat_id: str) -> None:
        self.kb = kb
        self.chat_id = chat_id
        self._links: dict[str, WebSource] | None = None

    def get(self, url: str) -> WebSource | None:
        if self._links is None:
            self._links = self._load()
        return self._links.get(_url_key(url))

    def _load(self) -> dict[str, WebSource]:
        # The links column of ``web_search_requests`` (permissions.web_search.WebSearchStore).
        with self.kb.db.read() as connection:
            rows = connection.execute("SELECT links FROM web_search_requests WHERE chat_id = ?",
                                      (self.chat_id,)).fetchall()
        links: dict[str, WebSource] = {}
        for row in rows:
            try:
                items = json.loads(row["links"] or "[]")
            except ValueError:
                continue
            for item in items if isinstance(items, list) else []:
                if isinstance(item, dict) and isinstance(item.get("url"), str):
                    url = item["url"]
                    links.setdefault(_url_key(url), WebSource(url, str(item.get("title") or "")))
        return links


class BlockChecker:
    """The sources of one block, each added once; ``source`` answers ``None`` for a made-up id."""

    def __init__(self, resolver: Resolver, web: ChatWebResults) -> None:
        self.resolver = resolver
        self.web = web
        self.sources: list[BlockSource] = []
        self._timed: list[bool] = []

    def source(self, ref: str) -> int | None:
        found = self._resolve(ref.strip().removeprefix("⟦").removesuffix("⟧").strip())
        if found is None:
            return None
        source, timed = found
        if source in self.sources:
            return self.sources.index(source)
        self.sources.append(source)
        self._timed.append(timed)
        return len(self.sources) - 1

    def timed(self, index: int) -> bool:
        return 0 <= index < len(self._timed) and self._timed[index]

    def _resolve(self, ref: str) -> tuple[BlockSource, bool] | None:
        bare = ref.removeprefix(_WEB_PREFIX)
        if bare.startswith(("http://", "https://")):
            link = self.web.get(bare)
            return (link, False) if link is not None else None
        if ref.startswith("mat-"):
            ref = "m:" + ref
        elif ref.startswith("pg-"):
            ref = "p:" + ref
        token = parse_token(ref)
        if isinstance(token, CiteToken):
            cite = self.resolver.cite(token)
            if cite is None:
                return None
            fragment = self.resolver.reader.fragment(cite.material_id, cite.seg)
            timed = fragment is not None and fragment.start_ms is not None
            return MaterialSource(cite.material_id, cite.seg, cite.quote), timed
        if isinstance(token, PageToken):
            page = self.resolver.page(token)
            return (PageSource(page.page_id, page.block_id, page.title, page.kind), False) if page else None
        return None


class AnswerBlocks:
    """Turns the fenced blocks of one answer into checked parts."""

    def __init__(self, kb: KnowledgeService, resolver: Resolver, chat_id: str) -> None:
        self.resolver = resolver
        self.web = ChatWebResults(kb, chat_id)

    def resolve(self, payload: str, block_id: str, cut: str = "") -> BlockPart:
        """``cut``: the fence never closed (``unfinished``) or ran too long (``too_long``)."""
        if cut:
            return BlockPart(block_id, "broken", error=TOO_LONG if cut == "too_long" else UNFINISHED,
                             raw=payload[:MAX_RAW_CHARS])
        checker = BlockChecker(self.resolver, self.web)
        try:
            built = build_block(payload, checker)
            data, sources = _used_only(json.loads(built.data), checker.sources)
        except Broken as error:
            return BlockPart(block_id, "broken", kind=error.kind, error=str(error),
                             raw=payload[:MAX_RAW_CHARS])
        except Exception as error:  # one odd block never fails the whole answer
            log.warning("Answer block %s couldn't be built: %s", block_id, type(error).__name__)
            return BlockPart(block_id, "broken", error=UNEXPECTED, raw=payload[:MAX_RAW_CHARS])
        return BlockPart(block_id, "ready", kind=built.kind,
                         data=json.dumps(data, ensure_ascii=False, sort_keys=True),
                         sources=tuple(sources), hidden=built.hidden, beside=built.beside, link=built.link)


def _used_only(data: Any, sources: Sequence[BlockSource]) -> tuple[Any, list[BlockSource]]:
    """Only the sources a drawn item rests on (a hidden item's source gets no chip), renumbered."""
    order: dict[int, int] = {}

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(item) for item in node]
        if not isinstance(node, dict):
            return node
        out = {key: walk(value) for key, value in node.items() if key != "src"}
        if isinstance(node.get("src"), list):
            out["src"] = [order.setdefault(index, len(order)) for index in node["src"]]
        return out

    pruned = walk(data)
    return pruned, [sources[old] for old, _new in sorted(order.items(), key=lambda pair: pair[1])]


def finish_drawing(parts: Sequence[Part]) -> list[Part]:
    """The answer ended: a block still drawing (its fence never closed) is shown as broken."""
    return [unfinished(part) if isinstance(part, BlockPart) and part.state == "drawing" else part
            for part in parts]
