"""Build a portable, script-free material from a PDF. Coordinates use the top-left origin."""

from __future__ import annotations

import base64
import hashlib
import io
import math
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from html import escape
from pathlib import Path
from typing import cast

import pypdfium2 as pdfium  # type: ignore[import-untyped]
import pypdfium2.raw as raw  # type: ignore[import-untyped]
from lxml import etree  # type: ignore[import-untyped]
from PIL import Image, ImageDraw, ImageFont

from .fragments import Paragraph
from .guard import clean_invisible
from .pdf import PdfExtraction, PdfRejected, extract_pdf, open_pdf, pdf_raster_inputs

CARD_NAME = "material.html"
MAX_CARD_BYTES = 64 * 1024 * 1024
_PDFIUM_LOCK = threading.Lock()  # PDFium is not reentrant even across documents.
Box = tuple[float, float, float, float]
_CAPTION = re.compile(r"^(?:fig(?:ure)?\.?|рис(?:унок)?\.?|table|таблица)\s*[\dIVX]", re.I)


@dataclass
class VisualPage:
    width: float
    height: float
    lines: list[tuple[Box, str]] = field(default_factory=list)
    figures: list[tuple[Box, bytes]] = field(default_factory=list)
    chart_boxes: list[Box] = field(default_factory=list)
    scan: bool = False
    whole: bool = False
    blocked: bool = False


def _union(boxes: Sequence[Box]) -> Box:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def _near(a: Box, b: Box, gap: float) -> bool:
    return a[0] <= b[2] + gap and b[0] <= a[2] + gap and a[1] <= b[3] + gap and b[1] <= a[3] + gap


def _inside(point_box: Box, box: Box) -> bool:
    x, y = (point_box[0] + point_box[2]) / 2, (point_box[1] + point_box[3]) / 2
    return box[0] <= x <= box[2] and box[1] <= y <= box[3]


def _webp(image: Image.Image, *, photo: bool) -> bytes:
    out = io.BytesIO()
    image.save(out, "WEBP", quality=87, lossless=not photo, method=4)
    return out.getvalue()


def _bitmap(page: pdfium.PdfPage) -> Image.Image:
    width, height = page.get_size()
    scale = min(2.5, 2400 / max(width, height))
    bitmap = page.render(scale=scale)
    try:
        return cast(Image.Image, bitmap.to_pil()).convert("RGB")
    finally:
        bitmap.close()


def _visual_page(display: bytes, comparisons: Sequence[bytes]) -> VisualPage:
    with _PDFIUM_LOCK, pdfium.PdfDocument(display) as doc:
        page = doc[0]
        width, height = page.get_size()
        if not all(math.isfinite(x) and 0 < x <= 20000 for x in (width, height)):
            raise PdfRejected("This PDF contains an unsupported page size.")
        result = VisualPage(width, height)
        full: Box = (0, 0, width, height)
        textpage = page.get_textpage()
        images: list[Box] = []
        paths: list[Box] = []
        rotated = page.get_rotation() != 0
        complex_page = rotated or tuple(page.get_bbox()) != (0, 0, width, height)
        for obj in page.get_objects(max_depth=1, textpage=textpage):
            x0, y0, x1, y1 = obj.get_bounds()
            box = (x0, height - y1, x1, height - y0)
            if not all(math.isfinite(v) for v in box):
                complex_page = True
                continue
            if obj.type == raw.FPDF_PAGEOBJ_TEXT:
                text = obj.extract().strip()
                if text:
                    result.lines.append((box, text))
            elif obj.type == raw.FPDF_PAGEOBJ_IMAGE:
                images.append(box)
            elif obj.type == raw.FPDF_PAGEOBJ_PATH:
                paths.append(box)
            else:
                complex_page = True
        result.scan = (
            len(images) == 1
            and (images[0][2] - images[0][0]) * (images[0][3] - images[0][1]) > 0.70 * width * height
        )
        # A chart is often drawn from individual axes, bars and strokes. Keep touching marks
        # together, including nearby labels but excluding the author's figure caption.
        clusters: list[Box] = []
        if len(paths) > 600:
            complex_page = True
        else:
            for path in paths:
                touching = [b for b in clusters if _near(path, b, 15)]
                clusters = [b for b in clusters if b not in touching]
                clusters.append(_union([path, *touching]))
        regions = [(box, True) for box in images]
        for core in clusters:
            if core[2] - core[0] < 8 or core[3] - core[1] < 8:
                complex_page = True
                break
            near = [box for box, text in result.lines if not _CAPTION.match(text) and _near(box, core, 24)]
            region = _union([core, *near])
            result.chart_boxes.append(region)
            regions.append((region, False))
        if len(regions) > 32 or any(
            _near(a, b, 0) for i, (a, _) in enumerate(regions) for b, _ in regions[:i]
        ):
            complex_page = True
        result.whole = complex_page or result.scan
        if result.whole:
            regions = [(full, result.scan)]
        if not regions and not comparisons:
            return result
        rendered = _bitmap(page)
        for comparison in comparisons:
            with pdfium.PdfDocument(comparison) as filtered:
                if _bitmap(filtered[0]).tobytes() != rendered.tobytes():
                    result.blocked = True
                    return result
        sx, sy = rendered.width / width, rendered.height / height
        for box, photo in regions:
            crop = (
                max(0, math.floor(box[0] * sx)),
                max(0, math.floor(box[1] * sy)),
                min(rendered.width, math.ceil(box[2] * sx)),
                min(rendered.height, math.ceil(box[3] * sy)),
            )
            if crop[2] > crop[0] and crop[3] > crop[1]:
                result.figures.append((box, _webp(rendered.crop(crop), photo=photo)))
        return result


def _visual_pages(data: bytes) -> list[VisualPage]:
    reader = open_pdf(data)
    pages: list[VisualPage] = []
    encoded_bytes = 0
    for number in range(1, len(reader.pages) + 1):
        display, *checks = pdf_raster_inputs(reader, number)
        try:
            page = _visual_page(display, checks)
        except (pdfium.PdfiumError, ValueError, RuntimeError) as exc:
            raise PdfRejected(f"Could not read the layout of page {number}.") from exc
        encoded_bytes += sum(len(content) for _, content in page.figures)
        if encoded_bytes * 4 // 3 >= MAX_CARD_BYTES:
            raise PdfRejected("The illustrated material exceeds the local import size limit.")
        pages.append(page)
    return pages


_VISION = """
ObjC.import('Vision'); ObjC.import('Foundation');
function run(argv) {
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 0;
  req.automaticallyDetectsLanguage = true;
  const url = $.NSURL.fileURLWithPath($(argv[0]));
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
  const err = Ref();
  if (!handler.performRequestsError($([req]), err)) throw Error('Recognition failed');
  const found = req.results;
  const out = [];
  for (let i=0; i<found.count; i++) {
    const candidates = found.objectAtIndex(i).topCandidates(1);
    if (candidates.count) out.push(ObjC.unwrap(candidates.firstObject.string));
  }
  return out.join('\\n');
}
"""


def _ocr(webp: bytes) -> str | None:
    with tempfile.TemporaryDirectory(prefix="skaz-ocr-") as tmp:
        path = Path(tmp) / "scan.png"
        with Image.open(io.BytesIO(webp)) as scan:
            scan.save(path, "PNG")
        commands: list[list[str]] = []
        if sys.platform == "darwin":
            commands.append(["/usr/bin/osascript", "-l", "JavaScript", "-e", _VISION, str(path)])
        binary = shutil.which("tesseract")
        if binary:
            commands.append([binary, str(path), "stdout", "--psm", "3"])
        for command in commands:
            try:
                job = subprocess.run(command, capture_output=True, timeout=30, check=True)
                return clean_invisible(job.stdout.decode("utf-8", "replace")).text.strip()
            except (OSError, subprocess.SubprocessError):
                continue
        return None


def _key(text: str) -> str:
    return "".join(text.casefold().split())


def _read_text(data: bytes) -> tuple[PdfExtraction, dict[int, str | None]]:
    extraction = extract_pdf(data)
    recognized: dict[int, str | None] = {}
    if extraction.scan_pages:
        reader = open_pdf(data)
        for number in extraction.scan_pages:
            display, *comparisons = pdf_raster_inputs(reader, number)
            with _PDFIUM_LOCK, pdfium.PdfDocument(display) as doc:
                image = _bitmap(doc[0])
                for comparison in comparisons:
                    with pdfium.PdfDocument(comparison) as filtered:
                        if _bitmap(filtered[0]).tobytes() != image.tobytes():
                            raise PdfRejected(f"SKAZ can't faithfully read the scan on page {number}.")
            recognized[number] = _ocr(_webp(image, photo=False))
    return extraction, recognized


def _box(box: Box) -> str:
    return ",".join(f"{v:.2f}" for v in box)


@dataclass
class CardBlock:
    box: Box
    markup: str
    paragraph: Paragraph | None = None


def _in_reading_order(blocks: list[CardBlock], width: float) -> list[CardBlock]:
    ordered = sorted(blocks, key=lambda v: (v.box[1], v.box[0]))
    # A spanning heading, figure or footer breaks the two-column reading band.
    middle = width / 2
    result: list[CardBlock] = []
    band: list[CardBlock] = []

    def flush() -> None:
        left = [item for item in band if item.box[2] <= middle]
        right = [item for item in band if item.box[0] >= middle]
        overlap = (
            left
            and right
            and max(item.box[3] for item in left) > right[0].box[1]
            and max(item.box[3] for item in right) > left[0].box[1]
        )
        result.extend([*left, *right] if overlap else band)
        band.clear()

    for block in ordered:
        if block.box[0] < middle < block.box[2]:
            flush()
            result.append(block)
        else:
            band.append(block)
    flush()
    return result


def build_card(data: bytes, fallback: str) -> tuple[PdfExtraction, bytes]:
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="skaz-pdf-visual") as work:
        visuals = work.submit(_visual_pages, data)
        extraction, recognized = _read_text(data)
        pages = visuals.result()
    title = escape(extraction.title or fallback)
    output = [
        f'<!doctype html><html><head><meta charset="utf-8"><title>{title}</title>'
        '<meta name="viewport" content="width=device-width, initial-scale=1"><style>'
        "body{font:1rem/1.55 system-ui;max-width:58rem;margin:auto;padding:1rem;color-scheme:light dark}"
        "section{border-block-start:1px solid #8886;margin-block:1rem}figure{margin:1rem 0}svg{max-width:100%;height:auto}"
        "summary{cursor:pointer}p{white-space:pre-wrap}</style></head><body>"
    ]
    assets: dict[str, bytes] = {}
    paragraphs: list[Paragraph] = []
    for number, page in enumerate(pages, 1):
        source = [p for p in extraction.paragraphs if p.page == number]
        output.append(
            f'<section data-page="{number}" data-width="{page.width}" data-height="{page.height}"'
            f' data-blocked="{int(page.blocked)}"><h2>Page {number}</h2>'
        )
        blocks: list[CardBlock] = []
        line_index = 0
        for index, p in enumerate(source):
            key = _key(p.text)
            # Match guarded paragraphs to drawing positions. Geometry never introduces new text.
            matched: list[Box] = []
            for j in range(line_index, len(page.lines)):
                pos, line = page.lines[j]
                if _key(line) and _key(line) in key:
                    matched.append(pos)
                    line_index = j + 1
                    if _key(line) == key:
                        break
                elif matched:
                    break
            if matched and all(any(_inside(b, c) for c in page.chart_boxes) for b in matched):
                continue
            pos = _union(matched) if matched else (20, 20 + index * 14, page.width - 20, 33 + index * 14)
            tag = "h3" if p.role == "heading" else "p"
            markup = f'<{tag} data-text="1" data-box="{_box(pos)}">{escape(p.text)}</{tag}>'
            blocks.append(CardBlock(pos, markup, p))
        for pos, image in page.figures:
            asset = hashlib.sha256(image).hexdigest()
            assets.setdefault(asset, image)
            with Image.open(io.BytesIO(image)) as decoded:
                w, h = decoded.size
            blocks.append(
                CardBlock(
                    pos,
                    f'<figure data-asset="{asset}" data-box="{_box(pos)}">'
                    f'<svg role="img" aria-label="Page {number} illustration" width="{w}" height="{h}" '
                    f'viewBox="0 0 {w} {h}"><use href="#asset-{asset}"/></svg></figure>',
                    None,
                )
            )
        if page.whole and page.figures:
            for block in blocks:
                if block.paragraph is None:
                    output.append(block.markup)
            transcript = [b.paragraph for b in blocks if b.paragraph is not None]
            if page.scan and not transcript:
                ocr = recognized.get(number)
                if ocr is None:
                    output.append("<p>Text recognition is unavailable on this computer.</p>")
                elif ocr:
                    transcript = [Paragraph(line, page=number) for line in ocr.splitlines() if line.strip()]
            if transcript:
                output.append("<details><summary>Recognized text</summary>")
                output.extend(f'<p data-text="1">{escape(p.text)}</p>' for p in transcript)
                output.append("</details>")
                paragraphs.extend(transcript)
        else:
            for block in _in_reading_order(blocks, page.width):
                output.append(block.markup)
                if block.paragraph is not None:
                    paragraphs.append(block.paragraph)
        output.append("</section>")
    output.append('<svg width="0" height="0" aria-hidden="true"><defs>')
    for asset, image in assets.items():
        with Image.open(io.BytesIO(image)) as decoded:
            w, h = decoded.size
        output.append(
            f'<image id="asset-{asset}" width="{w}" height="{h}" href="data:image/webp;base64,'
            f'{base64.b64encode(image).decode("ascii")}"/>'
        )
    output.append("</defs></svg></body></html>")
    card = "".join(output).encode()
    if len(card) > MAX_CARD_BYTES:
        raise PdfRejected("The illustrated material exceeds the local import size limit.")
    return replace(
        extraction, paragraphs=paragraphs, failure=None if paragraphs else extraction.failure
    ), card


def card_pages(data: bytes) -> list[etree._Element]:
    if len(data) > MAX_CARD_BYTES:
        raise PdfRejected("The stored material exceeds the local import size limit.")
    tree = etree.HTML(data, parser=etree.HTMLParser(no_network=True, encoding="utf-8", huge_tree=True))
    if tree is None or not (pages := list(tree.iter("section"))):
        raise PdfRejected("The stored document could not be read.")
    return pages


def card_page_png(pages: list[etree._Element], number: int) -> bytes:
    page = pages[number - 1]
    if page.get("data-blocked") == "1":
        raise PdfRejected(f"SKAZ can't faithfully render page {number} with its hidden text.")
    width, height = float(page.attrib["data-width"]), float(page.attrib["data-height"])
    scale = min(2.0, 2400 / max(width, height))
    canvas = Image.new("RGB", (max(1, round(width * scale)), max(1, round(height * scale))), "white")
    brush = ImageDraw.Draw(canvas)
    assets = {el.get("id"): el for el in page.getroottree().getroot().iter("image")}
    for el in page:
        if not el.get("data-box"):
            continue
        x, y, r, b = (round(float(n) * scale) for n in el.attrib["data-box"].split(","))
        if el.tag == "figure":
            href = assets[f"asset-{el.attrib['data-asset']}"].attrib["href"]
            with Image.open(io.BytesIO(base64.b64decode(href.split(",", 1)[1], validate=True))) as image:
                canvas.paste(image.resize((max(1, r - x), max(1, b - y)), Image.Resampling.LANCZOS), (x, y))
        elif el.get("data-text") and el.text:
            size = max(9, min(80, b - y))
            font: ImageFont.FreeTypeFont | ImageFont.ImageFont
            try:
                font = ImageFont.truetype("Arial.ttf", size)
            except OSError:
                font = ImageFont.load_default(size=size)
            brush.text((x, y), el.text, font=font, fill="black")
    out = io.BytesIO()
    canvas.save(out, "PNG")
    return out.getvalue()
