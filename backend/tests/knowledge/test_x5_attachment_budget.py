"""Attachments of the current chat message are read in full up to their own budget (X5, task 6).

A pasted text, file or link sent with the question used to enter the prompt only up to
``ITEM_CHARS`` (8 000) like any mention; the rest depended on the agent calling
``skaz_read_material``. Now the current message's attachments share ``ATTACHMENT_CHARS``
(60 000) of their own; past that the context says exactly where to continue reading.
Mentions, the open page/material and earlier turns keep their old limits.
"""
from __future__ import annotations

from skaz.knowledge.chats.context import (
    ATTACHMENT_CHARS,
    CONTEXT_CHARS,
    ITEM_CHARS,
    ContextBuilder,
    history,
)
from skaz.knowledge.chats.model import Chat, Message, MessageInput, Ref
from skaz.knowledge.chats.resolve import MaterialReader
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService

from .ingest_support import add_material

FRAGMENT = 1_000


def paragraphs(tag: str, count: int) -> list[FragmentInput]:
    """``count`` fragments of about ``FRAGMENT`` chars, each with a findable marker."""
    filler = "энтропия " * ((FRAGMENT - 12) // 9)
    return [FragmentInput(text=f"[{tag}-{n}] {filler}") for n in range(1, count + 1)]


def chat() -> Chat:
    return Chat(id="chat-1", title="Chat", title_auto=True, pinned=False, engine="codex", model=None,
                effort=None, recording_material_id=None, folder_ids=(), unread=False, last_preview="",
                created_at="", updated_at="")


def request(kb: KnowledgeService, given: MessageInput) -> str:
    return ContextBuilder(kb, MaterialReader(kb)).request(chat(), given, lambda _id: None)


def test_attachments_of_the_question_are_read_in_full_within_their_budget(ready: KnowledgeService) -> None:
    first = add_material(ready, "Тексты", "Первый", paragraphs("a", 25), kind="text")
    second = add_material(ready, "Тексты", "Второй", paragraphs("b", 25), kind="text")
    assert 25 * FRAGMENT > ITEM_CHARS and 50 * FRAGMENT < ATTACHMENT_CHARS
    text = request(ready, MessageInput("Сравни", attachments=(first, second)))
    for tag in ("a", "b"):
        assert all(f"[{tag}-{n}]" in text for n in range(1, 26)), tag  # every fragment, past ITEM_CHARS
    assert "skaz_read_material" not in text
    assert text.endswith("The user's message:\nСравни")


def test_past_the_budget_the_context_says_where_to_continue(ready: KnowledgeService) -> None:
    big = add_material(ready, "Тексты", "Большой", paragraphs("a", 45), kind="text")
    more = add_material(ready, "Тексты", "Ещё", paragraphs("b", 40), kind="text")
    last = add_material(ready, "Тексты", "Последний", paragraphs("c", 5), kind="text")
    text = request(ready, MessageInput("Что там?", attachments=(big, more, last)))

    assert all(f"[a-{n}]" in text for n in range(1, 46))  # the first fits whole
    shown = [n for n in range(1, 41) if f"[b-{n}]" in text]
    assert shown and shown == list(range(1, len(shown) + 1)) and len(shown) < 40
    next_seg = len(shown) + 1
    assert (f"…[continue reading: call skaz_read_material with material_id {more} and from_seg {next_seg}]"
            in text)
    # Nothing of the third fits any more; it is named with where to start.
    assert "[c-1]" not in text
    assert f"material_id {last} and from_seg 1]" in text
    attached = sum(len(line) for line in text.splitlines() if line.startswith(f"[{big}:")
                   or line.startswith(f"[{more}:"))
    assert attached <= ATTACHMENT_CHARS


def test_the_attachment_budget_is_its_own(ready: KnowledgeService) -> None:
    """A full general context (mentions, open material) doesn't eat the attachments' budget."""
    mentioned = [add_material(ready, "Тексты", f"Упомянутый {n}", paragraphs(f"m{n}", 12), kind="text")
                 for n in range(8)]
    attached = add_material(ready, "Тексты", "Вложение", paragraphs("x", 30), kind="text")
    assert 8 * ITEM_CHARS >= CONTEXT_CHARS  # the mentions alone fill the general budget
    given = MessageInput("Вопрос", mentions=tuple(Ref("material", item, "") for item in mentioned),
                         attachments=(attached,))
    text = request(ready, given)
    assert all(f"[x-{n}]" in text for n in range(1, 31))


def test_mentions_and_earlier_turns_keep_their_limits(ready: KnowledgeService) -> None:
    long = add_material(ready, "Тексты", "Длинный", paragraphs("m", 20), kind="text")
    text = request(ready, MessageInput("О чём?", mentions=(Ref("material", long, "Длинный"),)))
    assert "[m-1]" in text and "[m-20]" not in text  # a mention is still clipped at ITEM_CHARS
    assert "read them with skaz_read_material" in text

    # An earlier question's attachments are not re-sent with later turns: only its text is history.
    past = Message(id="msg-1", chat_id="chat-1", seq=1, role="user", state="done", created_at="",
                   input=MessageInput("Прочти", attachments=(long,)))
    (turn,) = history([past])
    assert turn.content == "Прочти" and "[m-1]" not in turn.content
