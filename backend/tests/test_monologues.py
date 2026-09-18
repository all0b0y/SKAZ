"""Monologues as the citation unit: grouping rules and anchor survival.

Boundaries are asserted against the rules a listener can check on the recording —
who is speaking, where the silences are — never against a guess about meaning.
"""

from __future__ import annotations

from audiohelper import monologues as mono


def token(
    identifier: str, text: str, start_ms: int, end_ms: int, speaker: int | None = 1
) -> mono.Token:
    return mono.Token(id=identifier, text=text, start_ms=start_ms, end_ms=end_ms, speaker=speaker)


def test_speaker_change_starts_a_new_monologue() -> None:
    built = mono.build([
        token("t1", "Привет. ", 0, 500, speaker=1),
        token("t2", "Здравствуйте. ", 600, 1200, speaker=2),
    ])
    assert [m.speaker for m in built] == [1, 2]
    assert [m.text for m in built] == ["Привет.", "Здравствуйте."]


def test_long_pause_splits_one_speaker() -> None:
    built = mono.build([
        token("t1", "Первая мысль. ", 0, 1_000),
        token("t2", "Вторая мысль. ", 1_000 + mono.MONOLOGUE_GAP_MS + 1, 5_000),
    ])
    assert len(built) == 2


def test_short_pause_keeps_one_monologue() -> None:
    built = mono.build([
        token("t1", "Первая часть ", 0, 1_000),
        token("t2", "и её продолжение. ", 1_500, 2_500),
    ])
    assert len(built) == 1
    assert built[0].text == "Первая часть и её продолжение."


def test_uninterrupted_speech_is_cut_by_the_duration_ceiling() -> None:
    # A lecture with no pauses must still break into citable blocks, or an anchor
    # would name "monologue 1" for forty minutes and tell the listener nothing.
    tokens = [
        token(f"t{index}", "слово ", index * 5_000, index * 5_000 + 4_000)
        for index in range(60)
    ]
    built = mono.build(tokens)
    assert len(built) > 1
    assert all(m.end_ms - m.start_ms <= mono.MAX_MONOLOGUE_MS + 5_000 for m in built)


def test_undiarised_speech_is_never_given_a_speaker() -> None:
    built = mono.build([
        token("t1", "Текст без диаризации. ", 0, 1_000, speaker=None),
        token("t2", "Продолжение. ", 1_200, 2_000, speaker=None),
    ])
    assert len(built) == 1
    assert built[0].speaker is None
    assert mono.speaker_label(built[0]) == "Спикер не определён"


def test_numbering_is_display_only_and_recomputed() -> None:
    first = token("t1", "Раз. ", 0, 500, speaker=1)
    second = token("t2", "Два. ", 10_000, 10_500, speaker=2)
    built = mono.build([first, second])
    cited = mono.anchor(built[1], built[1].tokens)
    resolved = mono.resolve(cited, built)
    assert resolved is not None and resolved.number == 2
    # The same anchor, after an earlier monologue was deleted, is monologue 1 now —
    # the stored form did not change, only what the reader is shown.
    rebuilt = mono.resolve(cited, mono.build([second]))
    assert rebuilt is not None and rebuilt.number == 1


def test_anchor_survives_a_wording_edit_inside_the_range() -> None:
    original = [
        token("t1", "Мы используем алгоритм Дейкстры. ", 0, 2_000),
        token("t2", "Он даёт кратчайший путь. ", 2_200, 4_000),
    ]
    built = mono.build(original)
    cited = mono.anchor(built[0], built[0].tokens[:1])
    corrected = mono.build([
        token("t1", "Мы используем алгоритм Дейкстры (исправлено). ", 0, 2_000),
        original[1],
    ])
    resolved = mono.resolve(cited, corrected)
    assert resolved is not None
    assert "исправлено" in resolved.tokens[0].text


def test_anchor_is_lost_rather_than_moved_when_its_tokens_are_gone() -> None:
    built = mono.build([token("t1", "Удалённая фраза. ", 0, 1_000)])
    cited = mono.anchor(built[0], built[0].tokens)
    survivor = mono.build([token("t9", "Совсем другая фраза. ", 0, 1_000)])
    assert mono.resolve(cited, survivor) is None


def test_sentences_split_by_punctuation_and_keep_an_unterminated_tail() -> None:
    built = mono.build([
        token("t1", "Первое предложение. ", 0, 1_000),
        token("t2", "Второе предложение! ", 1_100, 2_000),
        token("t3", "Хвост без точки", 2_100, 3_000),
    ])
    split = mono.sentences(built[0])
    assert [len(part) for part in split] == [1, 1, 1]
    assert "".join(t.text for t in split[-1]).strip() == "Хвост без точки"


def test_a_split_sentence_still_resolves_to_the_same_speech() -> None:
    built = mono.build([token("t1", "Одна длинная фраза без точки ", 0, 2_000)])
    cited = mono.anchor(built[0], built[0].tokens)
    # The user split the phrase in two; both halves keep their token identity.
    edited = mono.build([
        token("t1", "Одна длинная фраза. ", 0, 1_000),
        token("t1b", "Без точки. ", 1_100, 2_000),
    ])
    assert mono.resolve(cited, edited) is not None
