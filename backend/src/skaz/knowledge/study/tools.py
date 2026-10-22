"""The agents' study tools (0.3.1 S3, S5, S12): make a deck or a test, read a deck, show saved ones.

Only in a chat answer (the tool needs the answer's chat). Making a deck or a test shows the block in
the chat at once and returns — the agent never waits for the user's grades or answers, and the user
may go on asking about anything (S5). Saving to the wiki is the user's decision in the block (S6).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import Field

from ...native_io import disk_call
from ..agents.tools import SkazTool, ToolContext, ToolInputError, _Args
from ..errors import KnowledgeError
from ..permissions.store import RunRef
from .checks import CardIn, QuestionIn
from .scheduling import Mode
from .service import StudyService

NOT_IN_CHAT = "Flashcards and tests are only possible in a chat with the user."
STUDY_TOOL_NAMES = ("skaz_study_make_deck", "skaz_study_make_test", "skaz_study_read", "skaz_study_show")
MAX_CARDS = 60
MAX_QUESTIONS = 40


class MakeDeckArgs(_Args):
    title: str = Field(min_length=1, max_length=120, description="Deck title (also its wiki file name).")
    cards: list[CardIn] = Field(min_length=1, max_length=MAX_CARDS)


class MakeTestArgs(_Args):
    title: str = Field(min_length=1, max_length=120, description="Test title (also its wiki file name).")
    questions: list[QuestionIn] = Field(min_length=1, max_length=MAX_QUESTIONS)


class ShowArgs(_Args):
    page_ids: list[str] = Field(
        min_length=1, max_length=10, description="Saved decks (or one test) to show, by page id."
    )
    mode: Mode = Field(
        default="due",
        description="due: what is due today plus new cards within today's "
        "limit; new: only new cards; hard: often forgotten or marked hard; quick10: the 10 "
        "closest to being forgotten; all: every card. hard/quick10/all are practice: they don't "
        "change the schedule, except Again.",
    )
    card_ids: list[str] | None = Field(
        default=None, max_length=500, description="Optional: only these cards (block ids c-…)."
    )


class ReadArgs(_Args):
    page_id: str = Field(min_length=1, max_length=120, description="A deck or test page id.")


class StudyTools:
    def __init__(self, study: StudyService, runs: Callable[[str], RunRef | None]) -> None:
        self.study = study
        self.runs = runs

    def _ref(self, context: ToolContext | None) -> RunRef:
        ref = self.runs(context.run_id) if context is not None else None
        if ref is None:
            raise ToolInputError(NOT_IN_CHAT)
        return ref

    def tools(self) -> tuple[SkazTool, ...]:
        shown = (
            " The block appears in the chat at once and you don't wait: the user flips, grades or answers "
            "on their own and may ask you anything meanwhile. Saving it to the wiki is the user's choice "
            "in the block. The result lists items that were dropped and why."
        )
        return (
            SkazTool(
                "skaz_study_make_deck",
                "Make flashcards from the user's materials or wiki pages and show them in the chat. Each "
                "answer needs a citation whose quote is copied verbatim from the fragment; a card without "
                "one is dropped. Your own example or mnemonic goes in explanation, never in the answer."
                + shown,
                MakeDeckArgs,
                run=self._run(self._make_deck),
                timeout_s=60.0,
            ),
            SkazTool(
                "skaz_study_make_test",
                "Make a test (choice, multi, short or open questions, as the user asked) and show it in the "
                "chat. Every right answer needs a citation with a verbatim quote; wrong options are yours "
                "and are shown as made up by you. Choice and short answers are checked by SKAZ; open "
                "answers are checked by you later." + shown,
                MakeTestArgs,
                run=self._run(self._make_test),
                timeout_s=60.0,
            ),
            SkazTool(
                "skaz_study_read",
                "Read a saved deck (each card with its review state: new, learning, known or hard, and "
                "when it is due) or a test.",
                ReadArgs,
                run=self._run(self._read),
                timeout_s=30.0,
            ),
            SkazTool(
                "skaz_study_show",
                "Show saved decks in the chat in a review mode (the same card block), or one saved test "
                "to take again." + shown,
                ShowArgs,
                run=self._run(self._show),
                timeout_s=60.0,
            ),
        )

    def _run(
        self,
        work: Callable[[RunRef | None, Any], Awaitable[dict[str, Any]]],
    ) -> Callable[[ToolContext | None, Any], Awaitable[dict[str, Any]]]:
        async def run(context: ToolContext | None, args: Any) -> dict[str, Any]:
            self.study.remember_loop()
            try:
                return await work(self._ref(context) if not isinstance(args, ReadArgs) else None, args)
            except KnowledgeError as error:
                raise ToolInputError(error.message) from error

        return run

    async def _make_deck(self, ref: RunRef | None, args: MakeDeckArgs) -> dict[str, Any]:
        assert ref is not None
        made = await disk_call(self.study.make_deck, ref, args.title, args.cards)
        return {
            "status": "shown",
            "study_id": made.block.id,
            "cards": len(made.block.payload.get("cards", [])),
            "dropped": [{"card": d.index, "reason": d.reason} for d in made.dropped],
            "save": "the user decides in the block",
        }

    async def _make_test(self, ref: RunRef | None, args: MakeTestArgs) -> dict[str, Any]:
        assert ref is not None
        made = await disk_call(self.study.make_test, ref, args.title, args.questions)
        return {
            "status": "shown",
            "study_id": made.block.id,
            "questions": len(made.block.payload.get("questions", [])),
            "dropped": [{"question": d.index, "reason": d.reason} for d in made.dropped],
            "save": "the user decides in the block",
        }

    async def _read(self, _ref: RunRef | None, args: ReadArgs) -> dict[str, Any]:
        return {"status": "ok", "text": await disk_call(self.study.agent_summary, args.page_id)}

    async def _show(self, ref: RunRef | None, args: ShowArgs) -> dict[str, Any]:
        assert ref is not None
        block = await disk_call(self.study.show_saved, ref, args.page_ids, args.mode, args.card_ids)
        order = block.payload.get("order") or []
        held = int(block.payload.get("held_back") or 0)
        result: dict[str, Any] = {"status": "shown", "study_id": block.id, "items": len(order)}
        if held:
            result["held_back"] = f"{held} new cards wait for another day (today's limit for their folder)"
        if not order:
            result["note"] = "Nothing to show in this mode now; say so, or offer another mode."
        return result
