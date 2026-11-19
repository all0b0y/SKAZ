"""Bounded, layer-2-guarded DOCX text and metadata extraction."""

from __future__ import annotations

import io
import re
import zipfile
import zlib
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO

from lxml import etree  # type: ignore[import-untyped]

from ...markdown.source import FragmentRole
from ..fragments import Paragraph, sanitize_title
from ..guard import Finding, clean_invisible
from ..intake import SourceRejected

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
DC_NS = "http://purl.org/dc/elements/1.1/"

MAX_DOCX_ENTRIES = 2048
MAX_DOCX_PART_BYTES = 16 * 1024 * 1024
MAX_DOCX_TOTAL_XML_BYTES = 48 * 1024 * 1024
_READ_CHUNK = 64 * 1024

_UNTITLED_DOCX = re.compile(
    r"^(?:untitled|unknown|microsoft word\b.*|document\d*|\S+\.(?:docx?|pdf|tex|pptx?))$",
    re.IGNORECASE,
)
_HEADING_STYLE = re.compile(r"^(?:heading|заголовок)[ _-]*([1-6])$", re.IGNORECASE)

_XML_PARSER = etree.XMLParser(
    resolve_entities=False,
    no_network=True,
    dtd_validation=False,
    load_dtd=False,
    huge_tree=False,
)


def _w(tag: str) -> str:
    return f"{{{W_NS}}}{tag}"


def _dc(tag: str) -> str:
    return f"{{{DC_NS}}}{tag}"


@dataclass(frozen=True)
class DocxExtraction:
    """Extracted text paragraphs, document title, and layer-2 findings from a DOCX package."""

    title: str | None
    paragraphs: list[Paragraph]
    findings: list[Finding]
    hidden_runs_removed: int
    table_count: int
    failure: str | None = None


def _validate_zip_entries(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    entries = archive.infolist()
    if len(entries) > MAX_DOCX_ENTRIES:
        raise SourceRejected("This DOCX archive has too many entries to read safely.")
    by_name: dict[str, zipfile.ZipInfo] = {}
    for info in entries:
        if info.flag_bits & 0x1:
            raise SourceRejected("Encrypted DOCX files can't be read.")
        name = info.filename
        if name.startswith(("/", "\\")) or "\\" in name:
            raise SourceRejected("This DOCX archive has an invalid entry path.")
        parts = PurePosixPath(name).parts
        if ".." in parts:
            raise SourceRejected("This DOCX archive has an invalid entry path.")
        by_name[name] = info
    if "[Content_Types].xml" not in by_name or "word/document.xml" not in by_name:
        raise SourceRejected("This file isn't a valid DOCX document.")
    return by_name


def _read_zip_xml(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    *,
    budget_remaining: int,
) -> tuple[etree._Element, int]:
    if info.file_size > MAX_DOCX_PART_BYTES or info.file_size > budget_remaining:
        raise SourceRejected("This DOCX document expands beyond SKAZ's safety limit.")
    limit = min(MAX_DOCX_PART_BYTES, budget_remaining)
    chunks: list[bytes] = []
    total = 0
    try:
        with archive.open(info, "r") as handle:
            while True:
                chunk = handle.read(min(_READ_CHUNK, limit - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    raise SourceRejected("This DOCX document expands beyond SKAZ's safety limit.")
                chunks.append(chunk)
    except (zipfile.BadZipFile, zlib.error, RuntimeError, EOFError, OSError) as error:
        raise SourceRejected("This DOCX file is damaged and can't be read.") from error
    raw = b"".join(chunks)
    try:
        root = etree.fromstring(raw, parser=_XML_PARSER)
    except etree.XMLSyntaxError as error:
        raise SourceRejected("This DOCX file has malformed XML and can't be read.") from error
    return root, budget_remaining - total


def _flag_enabled(el: etree._Element | None) -> bool:
    if el is None:
        return False
    val = el.get(_w("val"))
    if val is None:
        return True
    return val.strip().lower() not in ("0", "false", "off")


def _run_is_hidden(run: etree._Element) -> bool:
    rpr = run.find(_w("rPr"))
    if rpr is None:
        return False
    if _flag_enabled(rpr.find(_w("vanish"))) or _flag_enabled(rpr.find(_w("webHidden"))):
        return True
    sz = rpr.find(_w("sz"))
    if sz is not None:
        raw_sz = sz.get(_w("val"))
        if raw_sz is not None:
            try:
                if int(raw_sz) <= 2:  # <= 1 pt (w:sz is measured in half-points)
                    return True
            except ValueError:
                pass
    color = rpr.find(_w("color"))
    if color is not None:
        val = (color.get(_w("val")) or "").strip().lower()
        if val == "ffffff" and rpr.find(_w("shd")) is None:
            return True
    return False


def _run_text(run: etree._Element) -> tuple[str, bool]:
    """Return ``(visible_text, was_hidden)`` for a ``w:r`` element."""
    if _run_is_hidden(run):
        hidden_parts = [t.text for t in run.findall(_w("t")) if t.text]
        return "", bool("".join(hidden_parts).strip())
    parts: list[str] = []
    for child in run:
        tag = child.tag
        if tag == _w("t"):
            if child.text:
                parts.append(child.text)
        elif tag == _w("tab"):
            parts.append("\t")
        elif tag in (_w("br"), _w("cr")):
            parts.append("\n")
        elif tag == _w("noBreakHyphen"):
            parts.append("-")
        elif tag == _w("softHyphen"):
            continue
    return "".join(parts), False


def _iter_runs(container: etree._Element) -> Iterable[etree._Element]:
    """Yield ``w:r`` elements in document order, skipping tracked deletions and field instructions."""
    for child in container:
        tag = child.tag
        if tag == _w("r"):
            yield child
        elif tag in (_w("del"), _w("moveFrom")):
            continue
        elif tag in (
            _w("hyperlink"),
            _w("ins"),
            _w("sdt"),
            _w("sdtContent"),
            _w("fldSimple"),
            _w("smartTag"),
        ):
            yield from _iter_runs(child)


def _paragraph_text(p_el: etree._Element) -> tuple[str, int]:
    parts: list[str] = []
    hidden_count = 0
    for run in _iter_runs(p_el):
        txt, was_hidden = _run_text(run)
        if was_hidden:
            hidden_count += 1
        elif txt:
            parts.append(txt)
    joined = "".join(parts)
    # Collapse single internal line breaks inside a paragraph without introducing double blank lines.
    normalized = re.sub(r"[ \t]+", " ", re.sub(r"\n+", " ", joined)).strip()
    return normalized, hidden_count


def _paragraph_role(p_el: etree._Element) -> tuple[FragmentRole, int | None]:
    ppr = p_el.find(_w("pPr"))
    if ppr is None:
        return "paragraph", None
    pstyle = ppr.find(_w("pStyle"))
    style_val = (pstyle.get(_w("val")) or "").strip() if pstyle is not None else ""
    lower = style_val.lower()
    if lower == "title":
        return "heading", 1
    if lower == "subtitle":
        return "heading", 2
    match = _HEADING_STYLE.match(style_val)
    if match:
        return "heading", int(match.group(1))
    outline = ppr.find(_w("outlineLvl"))
    if outline is not None:
        raw_lvl = outline.get(_w("val"))
        if raw_lvl is not None:
            try:
                lvl = int(raw_lvl) + 1
                if 1 <= lvl <= 6:
                    return "heading", lvl
            except ValueError:
                pass
    if ppr.find(_w("numPr")) is not None or "list" in lower:
        return "list_item", None
    if "quote" in lower or lower == "blocktext":
        return "quote", None
    if "code" in lower or "macro" in lower:
        return "code", None
    return "paragraph", None


def _table_text(tbl_el: etree._Element) -> tuple[str, int]:
    rows: list[list[str]] = []
    hidden_count = 0
    for tr in tbl_el.findall(_w("tr")):
        cells: list[str] = []
        for tc in tr.findall(_w("tc")):
            cell_parts: list[str] = []
            for p_el in tc.findall(_w("p")):
                txt, hidden = _paragraph_text(p_el)
                hidden_count += hidden
                if txt:
                    cell_parts.append(txt)
            cell_text = " ".join(cell_parts).replace("|", "\\|").strip()
            cells.append(cell_text)
        if any(cells):
            rows.append(cells)
    if not rows:
        return "", hidden_count
    width = max(len(r) for r in rows)
    padded = [r + [""] * (width - len(r)) for r in rows]
    header = "| " + " | ".join(padded[0]) + " |"
    separator = "| " + " | ".join("---" for _ in range(width)) + " |"
    body = ["| " + " | ".join(r) + " |" for r in padded[1:]]
    return "\n".join([header, separator, *body]), hidden_count


def _extract_title(
    archive: zipfile.ZipFile,
    entries: dict[str, zipfile.ZipInfo],
    *,
    budget: int,
) -> tuple[str | None, int]:
    core_info = entries.get("docProps/core.xml")
    if core_info is None:
        return None, budget
    try:
        core_root, budget = _read_zip_xml(archive, core_info, budget_remaining=budget)
    except SourceRejected:
        return None, budget
    title_el = core_root.find(_dc("title"))
    if title_el is None or not title_el.text:
        return None, budget
    raw_title = title_el.text.strip()
    if _UNTITLED_DOCX.match(raw_title):
        return None, budget
    return sanitize_title(raw_title), budget


def extract_docx(source: Path | bytes | BinaryIO) -> DocxExtraction:
    """Extract clean paragraphs, title, and findings from a disk-backed, open-handle, or bytes DOCX."""
    zip_target: Path | io.BytesIO | BinaryIO = (
        io.BytesIO(source) if isinstance(source, (bytes, bytearray)) else source
    )
    try:
        with zipfile.ZipFile(zip_target, "r") as archive:
            entries = _validate_zip_entries(archive)
            budget = MAX_DOCX_TOTAL_XML_BYTES
            _ct_root, budget = _read_zip_xml(
                archive, entries["[Content_Types].xml"], budget_remaining=budget
            )
            title, budget = _extract_title(archive, entries, budget=budget)
            doc_root, budget = _read_zip_xml(
                archive, entries["word/document.xml"], budget_remaining=budget
            )
    except (zipfile.BadZipFile, OSError, ValueError) as error:
        if isinstance(error, SourceRejected):
            raise
        raise SourceRejected("This file isn't a valid DOCX document.") from error

    body = doc_root.find(_w("body"))
    if body is None:
        raise SourceRejected("This DOCX file has no document body.")

    paragraphs: list[Paragraph] = []
    findings: list[Finding] = []
    hidden_runs_removed = 0
    table_count = 0

    for child in body:
        if child.tag == _w("p"):
            raw_text, hidden = _paragraph_text(child)
            hidden_runs_removed += hidden
            if not raw_text:
                continue
            cleaned = clean_invisible(raw_text)
            text = cleaned.text.strip()
            idx = len(paragraphs)
            for finding in cleaned.findings:
                findings.append(finding.at(index=idx))
            if not text:
                continue
            role, level = _paragraph_role(child)
            paragraphs.append(Paragraph(text=text, index=idx, role=role, level=level))
        elif child.tag == _w("tbl"):
            raw_table, hidden = _table_text(child)
            hidden_runs_removed += hidden
            if not raw_table:
                continue
            cleaned = clean_invisible(raw_table)
            text = cleaned.text.strip()
            idx = len(paragraphs)
            for finding in cleaned.findings:
                findings.append(finding.at(index=idx))
            if not text:
                continue
            table_count += 1
            paragraphs.append(Paragraph(text=text, index=idx, role="table"))

    failure = None if paragraphs else "This DOCX file has no readable text."
    return DocxExtraction(
        title=title,
        paragraphs=paragraphs,
        findings=findings,
        hidden_runs_removed=hidden_runs_removed,
        table_count=table_count,
        failure=failure,
    )
