"""Extract → clean (layer 2) → fragments: the part of adding a material that touches no library.

Each ``prepare_*`` returns a ``Prepared`` the service publishes. Nothing here
writes files or calls the network.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from ..errors import KnowledgeError
from ..markdown.source import FragmentInput, MaterialKind, Origin
from .fragments import (
    first_words_title,
    paragraph_of_offset,
    sanitize_title,
    text_paragraphs,
    to_fragments,
)
from .guard import Finding, clean_invisible, detect_instruction
from .html import extract_article
from .markdown_blocks import block_of_offset, markdown_blocks
from .pdf import extract_pdf

TEXT_EXTENSIONS = frozenset({".txt", ".md", ".markdown"})
PDF_EXTENSIONS = frozenset({".pdf"})
#: A PDF with at least this many pages is filed as a book.
BOOK_PAGES = 100
_TEXT_FINDING_KINDS = frozenset({"unicode_tags", "hidden_html", "html_comment", "hidden_pdf_text"})


class SourceRejected(KnowledgeError):
    status_code = 422


@dataclass(frozen=True)
class Original:
    """The untouched input, kept in the material's ``.skaz/`` as evidence (decision 41)."""

    name: str
    data: bytes | None = None
    path: Path | None = None


@dataclass(frozen=True)
class Prepared:
    kind: MaterialKind
    #: The document's own title (already made a valid name), if it has one.
    title: str | None
    #: Used when there is no title: file name, domain, "Pasted text".
    fallback_title: str
    fragments: list[FragmentInput]
    findings: list[Finding]
    origin: Origin
    extractor: str
    original: Original | None = None
    #: Set when no text could be extracted; the material is created as ``failed`` with this reason.
    failure: str | None = None
    extra: dict[str, object] = field(default_factory=dict)


def flag_instructions(findings: Sequence[Finding]) -> list[Finding]:
    """Layer 3 over removed hidden text too: hidden instructions are marked (strong signal of an attack)."""
    flagged = []
    for finding in findings:
        if finding.kind in _TEXT_FINDING_KINDS and detect_instruction(finding.original) is not None:
            finding = finding.model_copy(update={"instruction": True})
        flagged.append(finding)
    return flagged


def prepare_text(
    text: str,
    *,
    origin: Origin,
    original_name: str = "original.txt",
    title: str | None = None,
    fallback: str = "Pasted text",
    markdown: bool = False,
) -> Prepared:
    cleaned = clean_invisible(text)
    if markdown:  # headings, lists, quotes, code and tables keep their roles (QA B3)
        blocks = markdown_blocks(cleaned.text)
        paragraphs = [block.paragraph for block in blocks]
        findings = [item.at(index=block_of_offset(blocks, item.offset or 0)) for item in cleaned.findings]
    else:
        paragraphs = text_paragraphs(cleaned.text)
        findings = [
            item.at(index=paragraph_of_offset(cleaned.text, item.offset or 0)) for item in cleaned.findings
        ]
    derived = title
    if derived is None and markdown:
        heading = next((line for line in cleaned.text.splitlines() if line.startswith("# ")), None)
        derived = sanitize_title(heading[2:]) if heading else None
    if derived is None and not markdown and origin.type == "paste":
        derived = first_words_title(cleaned.text)
    return Prepared(
        kind="text",
        title=derived,
        fallback_title=fallback,
        fragments=to_fragments(paragraphs),
        findings=flag_instructions(findings),
        origin=origin,
        extractor="markdown" if markdown else "text",
        original=Original(original_name, data=text.encode("utf-8")),
        failure=None if paragraphs else "This text is empty after removing invisible characters.",
    )


def decode_text_file(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    for encoding in ("utf-8-sig", "cp1251"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def prepare_text_file(data: bytes, file_name: str, *, origin: Origin) -> Prepared:
    stem = Path(file_name).stem
    markdown = Path(file_name).suffix.lower() in (".md", ".markdown")
    prepared = prepare_text(
        decode_text_file(data),
        origin=origin,
        original_name=f"original{Path(file_name).suffix}",
        fallback=sanitize_title(stem) or "Text",
        markdown=markdown,
    )
    title = prepared.title if markdown else sanitize_title(stem)
    return Prepared(
        prepared.kind,
        title,
        prepared.fallback_title,
        prepared.fragments,
        prepared.findings,
        origin,
        prepared.extractor,
        Original(f"original{Path(file_name).suffix.lower()}", data=data),
        prepared.failure,
    )


def prepare_pdf(data: bytes, *, origin: Origin, fallback: str, original: Original) -> Prepared:
    extraction = extract_pdf(data)
    kind: MaterialKind = "book" if extraction.page_count >= BOOK_PAGES else "pdf"
    return Prepared(
        kind=kind,
        title=extraction.title,
        fallback_title=fallback,
        fragments=to_fragments(extraction.paragraphs),
        findings=flag_instructions(extraction.findings),
        origin=origin,
        extractor="pdf",
        original=original,
        failure=extraction.failure,
        extra={"pages": extraction.page_count},
    )


def prepare_html(html: str, *, origin: Origin, fallback: str, original: Original) -> Prepared:
    extraction = extract_article(html)
    failure = None if extraction.paragraphs else "SKAZ couldn't find any article text on this page."
    return Prepared(
        kind="web",
        title=extraction.title,
        fallback_title=fallback,
        fragments=to_fragments(extraction.paragraphs),
        findings=flag_instructions(extraction.findings),
        origin=origin,
        extractor="html",
        original=original,
        failure=failure,
        extra={"site_name": extraction.site_name} if extraction.site_name else {},
    )
