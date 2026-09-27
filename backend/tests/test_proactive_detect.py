"""Trigger detection for the proactive assistant, on fixed transcripts (issue #10).

These are deterministic text fixtures: they pin the trigger rules, they are not
evidence of recognition or answer quality on real speech.
"""

from __future__ import annotations

import pytest

from skaz.proactive_detect import (
    detect,
    is_question_or_request,
    mentions_alias,
    normalise_aliases,
    public_query,
    split_sentences,
)

ALIASES = ["Alex", "Саша", "Алекс", "project falcon"]


def kinds(text: str, *, final: bool = True) -> list[tuple[str, bool, str]]:
    return [(item.addressed, item.finished, item.text) for item in detect(text, ALIASES, final=final)]


@pytest.mark.parametrize("text", [
    "Alex, what do you think about the budget?",
    "What do you think, Alex?",
    "Hey Alex, could you share the slides?",
    "So, Alex, what is the status of the migration?",
    "Alex, quick question. When is the release?",
    "Alex, please send the report to everyone.",
    "Alex — can you take the next item?",
    "Саша, как думаешь, успеем к пятнице?",
    "А ты что думаешь, Саша?",
    "Алекс, расскажи, пожалуйста, про тесты.",
    "Слушай, Саша, можешь напомнить, какой был дедлайн?",
    "Саша, есть ли у нас оценка по срокам?",
])
def test_direct_address_with_question_or_request_fires(text: str) -> None:
    [(addressed, finished, heard)] = kinds(text)
    assert addressed == "direct"
    assert finished is True
    assert heard == text


@pytest.mark.parametrize("text", [
    # Third-person mentions.
    "As Alex said, we need to ship by Friday.",
    "Alex said we should ship. What do you think?",
    "Did Alex finish the report?",
    "Have you met Alex?",
    "Can you ask Alex about it?",
    "Alex's point was good. Any questions?",
    "Как сказал Саша, дедлайн в пятницу.",
    "Надо спросить у Саши.",
    "Саша сказал, что всё готово. Вопросы есть?",
    "Спросим Сашу потом.",
    # Plain statements addressed to the user ask nothing.
    "Alex, thanks.",
    "Alex, the deadline is Friday.",
    "Саша, спасибо, это было полезно.",
    # A question without the user's name is not addressed to the user.
    "What do you all think about the budget?",
    "Какие есть вопросы?",
    # A name alone is not yet a question.
    "Alex?",
])
def test_mentions_statements_and_general_questions_do_not_fire(text: str) -> None:
    assert kinds(text) == []


@pytest.mark.parametrize("text", [
    "Alex what do you think",
    "Alex can you send it?",
    "What do you think Alex?",
])
def test_address_without_punctuation_is_only_possible(text: str) -> None:
    assert [addressed for addressed, _finished, _heard in kinds(text)] == ["possible"]


def test_unpunctuated_name_next_to_impersonal_question_does_not_fire() -> None:
    assert kinds("Alex will present, right?") == []


def test_question_still_being_spoken_is_shown_but_not_finished() -> None:
    assert kinds("Hey Alex, could you share the slides", final=False) == [
        ("direct", False, "Hey Alex, could you share the slides"),
    ]
    # The same text is finished once no more speech can follow.
    assert kinds("Hey Alex, could you share the slides", final=True)[0][1] is True


def test_preface_waits_for_the_question_that_follows() -> None:
    assert kinds("Alex, quick question.", final=False) == []
    assert kinds("Alex, quick question. When do we", final=False) == [
        ("direct", False, "Alex, quick question. When do we"),
    ]


def test_only_the_addressed_question_is_the_heard_text() -> None:
    text = "We covered the roadmap. Alex, when does the beta start? Then we move on."
    assert kinds(text) == [("direct", True, "Alex, when does the beta start?")]


def test_multiword_code_phrase_and_case_insensitive_alias() -> None:
    assert kinds("project falcon, do you copy?") == [("direct", True, "project falcon, do you copy?")]
    assert kinds("ALEX, what's next?")[0][0] == "direct"


def test_aliases_do_not_match_inside_words() -> None:
    assert detect("Alexander, what do you think?", ["Alex"], final=True) == []


def test_normalise_aliases_trims_and_deduplicates() -> None:
    assert normalise_aliases([" Alex ", "alex", "", "Project   Falcon"]) == ["Project Falcon", "Alex"]


def test_public_query_drops_names_and_code_phrases() -> None:
    assert public_query("Alex, how does OAuth token refresh work?", ALIASES) == \
        "how does OAuth token refresh work?"
    assert "falcon" not in public_query("Hey Alex, what is the status of project falcon?", ALIASES)
    assert not mentions_alias(public_query("Саша, что такое CRDT?", ALIASES), ALIASES)


def test_sentence_split_keeps_decimal_numbers_together() -> None:
    assert [item.text for item in split_sentences("The budget is 3.5 million. Why?")] == [
        "The budget is 3.5 million.", "Why?",
    ]


@pytest.mark.parametrize(("text", "expected"), [
    ("When is the release?", True),
    ("when is the release", True),
    ("Please send it", True),
    ("Расскажи про тесты", True),
    ("Есть ли у нас оценка", True),
    ("The release is on Friday.", False),
    ("Спасибо.", False),
    ("?", False),
])
def test_question_or_request(text: str, expected: bool) -> None:
    assert is_question_or_request(text) is expected
