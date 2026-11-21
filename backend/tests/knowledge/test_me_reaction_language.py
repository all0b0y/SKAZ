"""Additional counterexamples to interpreting a bare word match as feedback."""
from __future__ import annotations

import pytest

from skaz.knowledge.chats.model import MessageInput, Selection
from skaz.knowledge.me.experience import Attempt, Situation, feedback


@pytest.fixture
def attempt() -> Attempt:
    return Attempt(question="q", answer="a", chat="c", epoch="e", shapes=("table",),
                   situation=Situation(words=frozenset()))


@pytest.mark.parametrize("text", [
    "Помоги настроить микрофон.",
    "Таблица помогла бы, но её здесь нет.",
    "В статье написано «таблица помогла», что это означает?",
    "Почему таблица помогла другому человеку?",
    "А если заменить аккумулятор телефона?",
])
def test_no_positive_for_new_task_quotation_or_hypothesis(attempt: Attempt, text: str) -> None:
    assert "confirmed" not in feedback(attempt, MessageInput(text)).values()
    assert "continued" not in feedback(attempt, MessageInput(text)).values()


def test_wrong_selection_is_explicit_negative(attempt: Attempt) -> None:
    selection = Selection("a", "b", "block", None, (), intent="wrong")
    assert feedback(attempt, MessageInput("Вот здесь", selection=selection)) == {"table": "corrected"}


def test_normal_continuation_does_not_require_a_question_mark(attempt: Attempt) -> None:
    assert feedback(attempt, MessageInput("Понял, продолжим этот расчёт дальше.")) == {"table": "continued"}



def test_late_clarification_identifies_the_original_values_not_last_answer() -> None:
    from skaz.knowledge.chats.model import Message, TextPart
    from skaz.knowledge.me.experience import ReplyExperience, delivered, target

    chat = "chat"
    def user(i: int, text: str) -> Message:
        return Message(f"u{i}", chat, i, "user", "done", "", input=MessageInput(text))

    def answer(i: int, parent: Message, text: str) -> Message:
        return Message(f"a{i}", chat, i, "assistant", "done", "", reply_to=parent.id,
                       parts=(TextPart(text),))

    first = user(1, "На сколько процентов изменилась цена с 80 до 100?")
    a = answer(2, first, "Изменение цены: (100 − 80) / 80 = 25%.")
    second = user(3, "А если теперь взять 120?")
    b = answer(4, second, "Получится другое значение, рассмотрим его подробнее.")
    m1, m2 = delivered(first, a, "e"), delivered(second, b, "e")
    assert m1 and m2
    memory = ReplyExperience(attempts={a.id: m1, b.id: m2})
    later = user(5, "Я спрашивал, почему в исходной задаче с 80 и 100 делим на старую цену.")
    assert target(memory, later, [first, a, second, b], "e") == m1


def test_missing_named_original_never_returns_a_similar_calculation() -> None:
    from skaz.knowledge.chats.model import Message, TextPart
    from skaz.knowledge.me.experience import ReplyExperience, delivered, original

    first = Message("q", "c", 1, "user", "done", "", input=MessageInput(
        "Посчитай изменение тарифа Кедр с 80 до 100."))
    answer = Message("a", "c", 2, "assistant", "done", "", reply_to=first.id,
                     parts=(TextPart("Тариф Кедр: (100 − 80) / 80 = 25%."),))
    record = delivered(first, answer, "e")
    assert record is not None
    request = Message("new", "c", 3, "user", "done", "", input=MessageInput(
        "Верни тот сохранённый расчёт тарифа Сосна с 80 до 100."))
    assert original(ReplyExperience(attempts={"a": record}), request, [first, answer]) == ""
