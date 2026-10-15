"""Every name SKAZ derives itself is cleaned (forbidden characters replaced), never refused.

The user's report: a YouTube video «Почему фондовый рынок США стал ПОМОЙКОЙ?» could
not be added ("A name can't contain ?"). Only names the user typed are refused.
"""

from __future__ import annotations

from datetime import datetime

from skaz.knowledge.library.names import validate_name
from skaz.knowledge.markdown.source import Origin
from skaz.knowledge.sources.fragments import first_words_title
from skaz.knowledge.sources.intake import Original, prepare_html, prepare_pdf, prepare_text, prepare_text_file
from skaz.knowledge.sources.links import interpret_video_info
from skaz.knowledge.speech.media import default_recording_titles
from tests.knowledge.pdf_fixtures import line, make_pdf
from tests.knowledge.source_corpus import CLEAN_EN

REPORTED = "Почему фондовый рынок США стал ПОМОЙКОЙ?"
CLEANED = "Почему фондовый рынок США стал ПОМОЙКОЙ"


def usable(name: str | None) -> str:
    assert name is not None
    assert validate_name(name) == name
    return name


def test_video_metadata_title() -> None:
    title, _duration = interpret_video_info({"title": REPORTED, "duration": 802})
    assert usable(title) == CLEANED


def test_web_page_title() -> None:
    html = f"<html><head><title>{REPORTED}</title></head><body><article><p>{CLEAN_EN[0]}</p>" \
        f"<p>{CLEAN_EN[1]}</p></article></body></html>"
    prepared = prepare_html(html, origin=Origin(type="url", url="https://e.example/a"), fallback="e.example",
                            original=Original("original.html", data=html.encode()))
    assert usable(prepared.title) == CLEANED


def test_pdf_metadata_title() -> None:
    data = make_pdf([line(CLEAN_EN[0], 700)], title=REPORTED)
    original = Original("original.pdf", data=data)
    prepared = prepare_pdf(data, origin=Origin(type="file"), fallback="x", original=original)
    assert usable(prepared.title) == CLEANED


def test_text_and_markdown_files() -> None:
    plain = prepare_text_file(CLEAN_EN[0].encode(), f"{REPORTED}.txt", origin=Origin(type="file"))
    assert usable(plain.title) == CLEANED
    markdown = f"# {REPORTED}\n\n{CLEAN_EN[0]}".encode()
    heading = prepare_text_file(markdown, "notes.md", origin=Origin(type="file"))
    assert usable(heading.title) == CLEANED
    no_heading = prepare_text_file(CLEAN_EN[0].encode(), f"{REPORTED}.md", origin=Origin(type="file"))
    assert usable(no_heading.title or no_heading.fallback_title) == CLEANED


def test_pasted_text_first_words() -> None:
    assert usable(first_words_title(f"{REPORTED}\n\n{CLEAN_EN[0]}")) == CLEANED
    prepared = prepare_text(f"Q3: plan / budget?\n\n{CLEAN_EN[0]}", origin=Origin(type="paste"))
    assert usable(prepared.title) == "Q3 - plan - budget"


def test_recording_default_names_are_valid_names() -> None:
    for name in default_recording_titles(datetime(2026, 10, 16, 9, 5, 7)):
        usable(name)
