"""Units of the chat area: the streaming link parser, the change feeds, titles, storage recovery."""
from __future__ import annotations

import pytest

from skaz.knowledge.agents.engine import TextDelta
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.registry import EngineRegistry
from skaz.knowledge.agents.tools import ToolRegistry
from skaz.knowledge.chats.analysis import Chunk, page_title, paragraphs
from skaz.knowledge.chats.events import ChatFeed, ListFeed
from skaz.knowledge.chats.model import (
    Chat,
    CitePart,
    ConnectionPart,
    Message,
    MessageInput,
    PagePart,
    Part,
    Quote,
    Ref,
    TextPart,
    part_from_json,
    part_to_json,
)
from skaz.knowledge.chats.parsing import (
    CiteToken,
    ConnectionOut,
    Output,
    PageToken,
    StreamParser,
    TextOut,
    parse_token,
)
from skaz.knowledge.chats.service import ChatService
from skaz.knowledge.chats.store import RESTART_REASON, ChatRepository
from skaz.knowledge.chats.text import agent_text, auto_title
from skaz.knowledge.ingest.checks import check_statement
from skaz.knowledge.ingest.model import BlockOut, CiteOut
from skaz.knowledge.markdown.source import Fragment
from skaz.knowledge.service import KnowledgeService

STREAM = (
    "Энтропия растёт ⟦m:mat-a1:seg-12|точные слова⟧, см. ⟦p:pg-x#c-1⟧ и ⟦p:pg-y⟧.\n"
    "```skaz-connection\n{\"folders\": [], \"inference\": \"x\"}\n```\n"
    "Сломано ⟦m:mat-a1:3 и ⟦m:mat-b2:4⟧ потом ⟦ без конца\n"
    "Код:\n```python\nprint('⟦не токен')\n```\n"
    "Текст ```skaz-connection в середине строки.\n"
    "⟦q:нечто⟧ конец"
)


def _merged(outputs: list[Output]) -> list[Output]:
    merged: list[Output] = []
    for item in outputs:
        if isinstance(item, TextOut) and merged and isinstance(merged[-1], TextOut):
            merged[-1] = TextOut(merged[-1].text + item.text)
        else:
            merged.append(item)
    return merged


def _parse(text: str, step: int) -> list[Output]:
    parser = StreamParser()
    out: list[Output] = []
    for start in range(0, len(text), step):
        out += parser.feed(text[start:start + step])
    return _merged(out + parser.finish())


def test_parser_output_does_not_depend_on_how_the_text_was_split() -> None:
    expected = _parse(STREAM, len(STREAM))
    for step in (1, 2, 3, 5, 8, 13, 40):
        assert _parse(STREAM, step) == expected
    assert expected == [
        TextOut("Энтропия растёт "), CiteToken("mat-a1", 12, "точные слова"), TextOut(", см. "),
        PageToken("pg-x", "c-1"), TextOut(" и "), PageToken("pg-y", None), TextOut(".\n"),
        ConnectionOut('{"folders": [], "inference": "x"}\n'),
        TextOut("Сломано "), CiteToken("mat-b2", 4, None),
        TextOut(" потом  без конца\nКод:\n```python\nprint('не токен')\n```\n"
                "Текст ```skaz-connection в середине строки.\n конец"),
    ]


def test_parse_token_forms() -> None:
    assert parse_token("m:mat-x1:7") == CiteToken("mat-x1", 7, None)
    assert parse_token("m:mat-x1:seg-7| «цитата» ") == CiteToken("mat-x1", 7, "цитата")
    assert parse_token("p:pg-1#c-ab-2") == PageToken("pg-1", "c-ab-2")
    for bad in ("m:pg-1:3", "m:mat-x:0", "m:mat-x", "p:mat-x", "x:pg-1", "m", "p:pg-1#seg-2"):
        assert parse_token(bad) is None


def test_unterminated_connection_is_reported_for_text_fallback() -> None:
    parser = StreamParser()
    out = parser.feed("Начало\n```skaz-connection\n{\"folders\"")
    assert _merged(out) == [TextOut("Начало\n")]
    assert parser.finish() == [ConnectionOut('{"folders"')]


async def test_chat_feed_serves_cursors_it_keeps_and_asks_for_a_snapshot_otherwise() -> None:
    feed = ChatFeed(start=100, capacity=3)
    assert feed.after(100) == [] and feed.after(99) is None and feed.after(101) is None
    first = feed.emit("delta", "msg-1", text="a")
    feed.emit("delta", "msg-1", text="b")
    assert [event.text for event in feed.after(100) or []] == ["a", "b"]
    assert [event.seq for event in feed.after(first.seq) or []] == [102]
    feed.emit("delta", "msg-1", text="c")
    feed.emit("delta", "msg-1", text="d")
    assert feed.after(100) is None  # dropped from the window
    assert [event.text for event in feed.after(101) or []] == ["b", "c", "d"]
    await feed.wait(feed.cursor, 0.01)  # nothing new: returns after the timeout
    listing = ListFeed(start=5)
    listing.touch("chat-a")
    listing.touch("chat-b")
    listing.touch("chat-a")
    assert listing.after(5) == ["chat-a", "chat-b"] and listing.after(listing.cursor) == []
    assert listing.after(listing.cursor + 1) is None


def test_auto_title_and_page_title() -> None:
    assert auto_title("\n  **Что такое** энтропия?\nВторая строка") == "Что такое энтропия?"
    long = "Почему " + "очень " * 20 + "длинный вопрос"
    title = auto_title(long)
    assert title.endswith("…") and len(title) <= 61 and " " in title
    assert auto_title("   ") == "New chat"
    assert page_title("Что такое [[энтропия]]: кратко/подробно?") == "Что такое энтропия кратко подробно"
    assert page_title("...") == "Analysis"


def test_parts_round_trip_and_agent_text_keeps_only_checked_tokens() -> None:
    parts: list[Part] = [TextPart("A "), CitePart("mat-1", 2, "q"), PagePart("pg-1", "c-1", "T", "concept"),
                         ConnectionPart((), "inf", None)]
    assert [part_from_json(part_to_json(part)) for part in parts] == parts
    assert agent_text(parts[:3]) == "A ⟦m:mat-1:2⟧⟦p:pg-1#c-1⟧"
    given = MessageInput("t", (Ref("page", "pg-1", "T"),), (Quote("chat", "chat-1", "x", message_id="m"),),
                         ("mat-1",))
    assert MessageInput.from_json(given.to_json()) == given


def test_paragraphs_attach_chips_to_their_text() -> None:
    items = paragraphs([TextPart("Первый абзац"), CitePart("mat-1", 1), TextPart(".\n\n"),
                        CitePart("mat-1", 2),
                        TextPart("Второй\n- пункт один\n- пункт два\n## Заголовок\nконец")])
    def segs(item: Chunk) -> list[int]:
        return [chip.seg for chip in (item.chips[n] for n in item.slots()) if isinstance(chip, CitePart)]

    texts = [(item.kind, item.bare().strip(), segs(item))
             for item in items if not isinstance(item, ConnectionPart)]
    # A chip right after a break belongs to the paragraph before; a list is one block (QA D1).
    assert texts == [("paragraph", "Первый абзац.", [1, 2]), ("paragraph", "Второй", []),
                     ("list", "- пункт один\n- пункт два", []), ("heading", "Заголовок", []),
                     ("paragraph", "конец", [])]


def test_paragraphs_keep_code_fences_tables_and_setext_headings_whole() -> None:
    items = paragraphs([TextPart("Title\n===\n\n~~~\na\n\n# not a heading\n~~~\n\n"
                                 "| a | b |\n| - | - |\n| 1 | 2 |\ntext after\n\n```\nunclosed")])
    shapes = [(item.kind, item.lines) for item in items if not isinstance(item, ConnectionPart)]
    assert shapes == [("heading", ["Title"]), ("code", ["~~~", "a", "", "# not a heading", "~~~"]),
                      ("table", ["| a | b |", "| - | - |", "| 1 | 2 |"]), ("paragraph", ["text after"]),
                      ("code", ["```", "unclosed", "```"])]


def test_a_quote_only_in_an_analysis_page_cannot_back_a_source_claim() -> None:
    """Ingest layer 4 checks quotes against this material's fragments only — never wiki pages."""
    fragments = {1: Fragment(seg=1, text="Энтропия — мера беспорядка системы.")}
    analysis_text = "энтропия — это хаос во Вселенной"
    block = BlockOut(kind="from_source", text="Энтропия — хаос.", cites=[CiteOut(seg=1, quote=analysis_text)])
    assert check_statement(block, fragments, frozenset()) == "quote_not_in_source"


def test_streaming_answers_become_interrupted_after_a_restart(ready: KnowledgeService) -> None:
    repo = ChatRepository(ready.db)
    repo.create(Chat(id="chat-1", title="T", title_auto=False, pinned=False, engine="codex", model=None,
                     effort=None, recording_material_id=None, folder_ids=(), unread=False, last_preview="",
                     created_at="2026-10-15T10:00:00.000Z", updated_at="2026-10-15T10:00:00.000Z"))
    question, answer = repo.add_messages([
        Message(id="msg-q", chat_id="chat-1", seq=0, role="user", state="done", created_at="x",
                parts=(TextPart("Q"),), input=MessageInput("Q")),
        Message(id="msg-a", chat_id="chat-1", seq=0, role="assistant", state="streaming", created_at="x",
                parts=(TextPart("partial"),), engine="codex", reply_to="msg-q"),
    ], {})
    assert (question.seq, answer.seq) == (1, 2)
    engines = {engine: FakeEngine(engine, script=[TextDelta("", "x")]) for engine in ("codex", "claude_code",
                                                                                         "hermes")}
    service = ChatService(ready, agents=lambda: EngineRegistry(engines, ready.settings),  # type: ignore[arg-type]
                          tools=ToolRegistry(ready))
    assert service.recovered == 1
    stored = repo.message("chat-1", "msg-a")
    assert stored is not None and stored.state == "interrupted"
    assert stored.failure is not None and stored.failure.message == RESTART_REASON
    assert stored.parts == (TextPart("partial"),)


def test_repository_refuses_unknown_columns(ready: KnowledgeService) -> None:
    with pytest.raises(ValueError, match="Unknown chat columns"):
        ChatRepository(ready.db).update("chat-1", engine_secret="x")


def test_instructions_require_exact_words_for_every_fragment_citation() -> None:
    # Live B5 (Codex): 5/5 answers cited fragments without words, so the source popup had no quote.
    from skaz.knowledge.chats.context import instructions
    from skaz.knowledge.ingest.checks import MIN_QUOTE_CHARS

    text = instructions(None)
    assert "Always add the exact words you relied on, copied verbatim" in text
    assert f"at least {MIN_QUOTE_CHARS} characters" in text
    assert "⟦m:mat-1a2b3c:12|" in text
    # The old optional wording is gone; a token without words is no longer the shown form.
    assert "When you rely on exact words" not in text
    assert "for example ⟦m:mat-1a2b3c:12⟧" not in text


def test_a_citation_without_or_with_a_short_quote_still_parses_with_quote_dropped() -> None:
    # Required in the prompt, tolerated in parsing: a missing quote stays None, never an error.
    assert parse_token("m:mat-x1:7") == CiteToken("mat-x1", 7, None)
    assert parse_token("m:mat-x1:7|") == CiteToken("mat-x1", 7, None)
