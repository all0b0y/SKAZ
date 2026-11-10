"""Full text as plain text (decision 3c′): TEI XML, an arXiv HTML page or an open article page.

Never a PDF: no PDF is downloaded or parsed here. The text is external data, never instructions —
callers hand it to agents through ``untrusted_block``.
"""

from __future__ import annotations

from lxml import etree  # type: ignore[import-untyped]

from ..sources.fetch import Fetched
from ..sources.html import ArticleRejected, decode_html, extract_article
from ..sources.web_page import HTML_TYPES

_TEI = "{http://www.tei-c.org/ns/1.0}"
#: Less than this is a stub (a landing page, a "no HTML version" note), not the article.
MIN_TEXT_LETTERS = 1500
MIN_TEI_LETTERS = 500
MAX_TEXT_CHARS = 400_000


def _letters(text: str) -> int:
    return sum(char.isalpha() for char in text)


def _clip(text: str) -> str:
    return text[:MAX_TEXT_CHARS]


def tei_text(body: bytes) -> str | None:
    """The body of a GROBID TEI document: section heads and paragraphs; ``None`` when there is none."""
    parser = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False, load_dtd=False)
    try:
        root = etree.fromstring(body, parser=parser)
    except etree.XMLSyntaxError:
        return None
    text_body = root.find(f"{_TEI}text/{_TEI}body")
    if text_body is None:
        return None
    blocks: list[str] = []
    for node in text_body.iter(f"{_TEI}head", f"{_TEI}p"):
        line = " ".join("".join(node.itertext()).split())
        if line:
            blocks.append(line)
    text = "\n\n".join(blocks)
    return _clip(text) if _letters(text) >= MIN_TEI_LETTERS else None


def page_text(fetched: Fetched) -> str | None:
    """The article text of an HTML page; ``None`` when it is not HTML or holds too little text."""
    if fetched.content_type not in HTML_TYPES:
        return None
    try:
        extraction = extract_article(decode_html(fetched.body, fetched.charset))
    except ArticleRejected:
        return None
    text = "\n\n".join(paragraph.text for paragraph in extraction.paragraphs if paragraph.text.strip())
    if extraction.password_fields and _letters(text) < 3 * MIN_TEXT_LETTERS:
        return None
    return _clip(text) if _letters(text) >= MIN_TEXT_LETTERS else None
