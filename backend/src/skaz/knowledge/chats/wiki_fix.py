"""P2 decision 4: «That’s wrong» → the agent rechecks → «Fix in wiki», changed only on the user's click.

The agent proposes with ``skaz_wiki_propose_fix`` — a structured proposal SKAZ checks against the real
page before the user sees anything:

* only in an answer to a question whose selection the user marked «That’s wrong»;
* only a block of a wiki page that the marked items cite (a page source of theirs);
* never the user's own note;
* ``wrong`` must be words of that block, copied exactly (the agent read the page);
* the corrected paragraph must be a valid user paragraph and actually differ.

The answer then shows a card: the block before → after and «Fix in wiki». Nothing is written until
the user clicks; the click writes only if the block is still exactly what the card shows — checked in
the same library write (``WikiService.update_block(expected=…)`` → ``wiki/edit.py``: the block
becomes ``user_edited``, its links and citations kept). A block that changed since is marked
``stale`` and left alone. Nothing else remembers that an item was wrong: no hidden signals.
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import replace
from typing import Any, Protocol

from pydantic import Field

from ...native_io import disk_call
from ..agents.tools import SkazTool, ToolContext, ToolInputError, _Args
from ..answer_blocks.part import PageSource
from ..errors import KnowledgeError, NotFound
from ..ids import new_id
from ..markdown.page import parse_page
from ..permissions.store import RunRef
from ..service import KnowledgeService
from ..wiki.edit import BlockChanged, clean_user_text, readable_text
from ..wiki.pages_io import page_path
from .fix_part import WikiFixPart
from .selection import selected_sources
from .service import ChatConflict, ChatService

FIX_TOOL = "skaz_wiki_propose_fix"
NOT_IN_CHAT = "A wiki fix can only be proposed in a chat answer."
NOT_MARKED = ("A wiki fix can only be proposed in an answer to items the user marked as wrong "
              "(That’s wrong). Suggest the change in words instead.")
NOT_CITED = ("This page is not a source of the items the user marked as wrong. Propose fixes only to the "
             "wiki blocks those items cite.")


class FixArgs(_Args):
    page_id: str = Field(min_length=1, max_length=120,
                         description="The wiki page (an id from the items' sources).")
    block_id: str = Field(min_length=1, max_length=120,
                          description="The block to correct (from skaz_read_page).")
    wrong: str = Field(min_length=3, max_length=500,
                       description="The wrong words, copied exactly from the block's text as "
                                   "skaz_read_page shows it.")
    text: str = Field(min_length=1, max_length=4_000,
                      description="The whole corrected paragraph, in the page's language, plain text "
                                  "(the block's citations are kept by SKAZ).")
    reason: str = Field(min_length=1, max_length=300,
                        description="One sentence for the user: what is wrong and which source says so.")


class WikiEdits(Protocol):
    def update_block(self, page_id: str, block_id: str, text: str, *,
                     expected: str | None = None) -> object: ...


def _same(a: str, b: str) -> bool:
    return " ".join(a.split()) == " ".join(b.split())


class WikiFixes:
    """The proposal tool and the user's «Fix in wiki»."""

    def __init__(self, kb: KnowledgeService, chats: ChatService, wiki: Callable[[], WikiEdits]) -> None:
        self.kb = kb
        self.chats = chats
        self.wiki = wiki
        self._proposed: set[tuple[str, str, str]] = set()
        self._lock = asyncio.Lock()

    # -- the agent's proposal -----------------------------------------------------------

    def tools(self) -> tuple[SkazTool, ...]:
        return (SkazTool(
            FIX_TOOL,
            "Only after the user marked items of your earlier answer as wrong (That’s wrong) and the "
            "sources show that a wiki page those items cite is itself wrong: propose the corrected "
            "paragraph of that page block. Read the page first (skaz_read_page) and copy the wrong words "
            "exactly. SKAZ shows the user the block before → after with a «Fix in wiki» button; nothing "
            "changes unless the user clicks it. Never for the user's own notes. Then say in a sentence "
            "what you proposed.",
            FixArgs, run=self._run, timeout_s=30.0,
        ),)

    async def _run(self, context: ToolContext | None, args: Any) -> dict[str, Any]:
        ref = self.chats.run_ref(context.run_id) if context is not None else None
        if ref is None:
            raise ToolInputError(NOT_IN_CHAT)
        try:
            part = await disk_call(self._propose, ref, args)
        except KnowledgeError as error:
            raise ToolInputError(error.message) from error
        await self.chats.add_part(ref.chat_id, ref.message_id, part)
        return {"status": "shown", "fix_id": part.fix_id,
                "next": "The user sees the block before → after and decides; nothing changed yet."}

    def _propose(self, ref: RunRef, args: FixArgs) -> WikiFixPart:
        repo = self.chats.repo
        answer = repo.message(ref.chat_id, ref.message_id)
        question = repo.message(ref.chat_id, answer.reply_to or "") if answer is not None else None
        selection = question.input.selection if question is not None and question.input is not None else None
        if selection is None or selection.intent != "wrong":
            raise ToolInputError(NOT_MARKED)
        cited = [source for source in selected_sources(repo.messages(ref.chat_id), selection)
                 if isinstance(source, PageSource) and source.page_id == args.page_id]
        if not cited or not any(source.block_id in (None, args.block_id) for source in cited):
            raise ToolInputError(NOT_CITED)
        record = self.kb.page_repo.get(args.page_id)
        _library, path = page_path(self.kb, args.page_id)
        block = parse_page(path.read_text(encoding="utf-8")).block(args.block_id)
        if record is None or block is None:
            raise ToolInputError("Block not found: read the page with skaz_read_page for its block ids.")
        if block.owner == "user":
            raise ToolInputError("That is the user's own note: suggest the change in words instead.")
        before = readable_text(block.body)
        if " ".join(args.wrong.split()) not in " ".join(before.split()):
            raise ToolInputError("The words in “wrong” are not in that block: read the page with "
                                 "skaz_read_page and copy them exactly.")
        after = clean_user_text(args.text)
        if _same(after, before):
            raise ToolInputError("The corrected text is the same as the block's text.")
        key = (ref.message_id, args.page_id, args.block_id)
        if key in self._proposed:
            raise ToolInputError("You already proposed a fix for this block in this answer.")
        self._proposed.add(key)
        return WikiFixPart(new_id("fix"), args.page_id, args.block_id, record.title, before, after,
                           " ".join(args.reason.split()))

    # -- the user's click -----------------------------------------------------------------

    async def apply(self, chat_id: str, message_id: str, fix_id: str) -> WikiFixPart:
        """Write the fix as the user's edit if the block is still as proposed; else mark it stale."""
        async with self._lock:
            message = await disk_call(self.chats.repo.message, chat_id, message_id)
            if message is None or message.role != "assistant":
                raise NotFound("This answer is no longer in the chat.")
            if message.state == "streaming":
                raise ChatConflict("Wait until the answer is finished.", "ANSWERING")
            part = next((p for p in message.parts if isinstance(p, WikiFixPart) and p.fix_id == fix_id), None)
            if part is None:
                raise NotFound("This fix is no longer in the answer.")
            if part.status != "proposed":
                return part
            done = await disk_call(self._write, part)
            updated = replace(part, status="applied" if done else "stale")
            # Under the answer's own lock, like an Undo of a «Я» edit in the same answer (N6): neither
            # save overwrites the other.
            await self.chats.update_part(chat_id, message_id, updated)
            return updated

    def _write(self, part: WikiFixPart) -> bool:
        """The check and the write are one library write (``update_block(expected=…)`` compares the
        block in the file being rewritten): an edit that lands in between is never overwritten."""
        try:
            self.wiki().update_block(part.page_id, part.block_id, part.after, expected=part.before)
        except (NotFound, BlockChanged):
            return False
        return True

