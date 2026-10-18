"""M1: Obsidian notes imported as ``.md`` show their text, not Obsidian's syntax."""
from __future__ import annotations

from skaz.knowledge.sources.markdown_blocks import markdown_blocks

NOTE = """---
tags: [ai, llm, памятка]
updated: 2026-10-16
---
# Трейсинг — путь запроса через систему

> [!abstract] Коротко
> Tracing — запись связанного пути выполнения операции.[32]

Связь с [[Evals — оценка|оценкой]], [[Метрики#TTFT]] и [[Note#^abc]]. ![[diagram.png]] #ai #llm/tracing
задача #1 ==важно== %%скрыто%% `#include <x>` и https://example.com/page#part конец ^blk-1
"""


def texts() -> list[tuple[str, str]]:
    return [(block.paragraph.role or "", block.paragraph.text) for block in markdown_blocks(NOTE)]


def test_front_matter_is_metadata_not_text() -> None:
    assert texts()[0] == ("heading", "Трейсинг — путь запроса через систему")
    assert not any("tags:" in text or "updated:" in text for _role, text in texts())


def test_a_callout_is_a_quote_that_starts_with_its_title() -> None:
    assert texts()[1] == ("quote", "Коротко: Tracing — запись связанного пути выполнения операции.[32]")


def test_untitled_callout_uses_its_type() -> None:
    blocks = markdown_blocks("> [!warning]\n> Не трогать прод.\n")
    assert blocks[0].paragraph.text == "Warning: Не трогать прод."


def test_links_keep_their_words_and_obsidian_marks_go() -> None:
    role, text = texts()[2]
    assert role == "paragraph"
    assert text == ("Связь с оценкой, Метрики › TTFT и Note. задача #1 важно #include <x> и "
                    "https://example.com/page#part конец")
