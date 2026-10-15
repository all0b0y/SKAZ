"""PDF text with the invisible layer removed (poisoning layer 2), split into paragraphs per page.

Every text-showing operator is classified by the graphics state it runs in.
Text is *hidden* when it is drawn with render mode 3 or 7 (``Tr 3``: neither
filled nor stroked), fully transparent, in a colour close to what is painted
beneath it, placed outside the page's crop box, drawn at zero/tiny size or zero
horizontal scale, or inside an optional-content layer that is off by default.
Hidden operators are taken out of a private copy of the page before pypdf
extracts the text, so the visible text keeps its layout; a second copy with
only the hidden operators gives the removed text for the finding. Form XObjects
are followed (three levels).

"Beneath it" (user bug 1016-7: white titles on dark slides were dropped): the
page starts white; every filled path drawn earlier in the content stream paints
its bounding box (cut to the clipping path's box) in its fill colour, blended by
its fill alpha; an image or a shading paints an unknown colour. The colour under
the point where the text starts (a third of an em above its baseline) is the
background; over an unknown colour the text counts as visible.

Not detected (no renderer here): text covered by an image or a filled shape
drawn after it, text clipped away by a clipping path, colours from
patterns/separations, glyphs that a font draws empty; a filled non-rectangular
path counts as its bounding box. A page whose only text is invisible and which
draws a page-sized image is treated as a scanned page with an OCR layer: that
text is what a reader sees in the image, so it is kept (and still goes
through the instruction detector).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from io import BytesIO
from typing import Any

from pypdf import PdfReader, PdfWriter
from pypdf.errors import PdfReadError, PyPdfError
from pypdf.generic import (
    ContentStream,
    DictionaryObject,
    FloatObject,
    IndirectObject,
    NameObject,
    StreamObject,
)

from ..errors import KnowledgeError
from .fragments import Paragraph, sanitize_title
from .guard import Finding, clean_invisible, strip_invisible
from .guard.findings import visible_repr
from .pdf_layout import PageText, Shape, body_size, largest_text, page_text, paragraph_role

NO_TEXT_LAYER = "This PDF has no text layer (scanned pages). OCR isn't supported yet."
ONLY_HIDDEN_TEXT = "This PDF has no visible text: all of its text is hidden, and hidden text isn't added."
#: Text whose colour differs from the colour beneath it by at most this much in every RGB channel is hidden.
SAME_COLOUR = 0.1
#: Text drawn with a fill (or stroke) alpha at most this is transparent.
TRANSPARENT = 0.05
#: A light background: text in its colour is named "white text" in the finding.
LIGHT = 0.9
#: Where the text's background is sampled: this much of an em above the start of its baseline.
SAMPLE_EM = 0.33
#: Painted regions kept per page before only large ones (``LARGE_PAINT`` of the page) are recorded.
MAX_PAINTS = 2000
LARGE_PAINT = 0.01
TINY_TEXT_PT = 1.0
PAGE_MARGIN_PT = 2.0
OCR_IMAGE_COVERAGE = 0.5
MAX_FORM_DEPTH = 3
_SHOW = frozenset({b"Tj", b"TJ", b"'", b'"'})
_UNTITLED = re.compile(
    r"^(?:untitled|unknown|microsoft word\b.*|document\d*|\S+\.(?:docx?|pdf|tex|indd|pptx?))$", re.IGNORECASE
)

Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
Box = tuple[float, float, float, float]
Rgb = tuple[float, float, float]
WHITE_RGB: Rgb = (1.0, 1.0, 1.0)
#: The clip of a clipping path that cuts everything away.
NOWHERE: Box = (math.inf, math.inf, -math.inf, -math.inf)
_FILL = frozenset({b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*"})
_STROKE = frozenset({b"S", b"s"})


class PdfRejected(KnowledgeError):
    status_code = 422


def _mul(m: Matrix, n: Matrix) -> Matrix:
    """``m × n`` in PDF row-vector convention (apply ``m`` first, then ``n``)."""
    a, b, c, d, e, f = m
    a2, b2, c2, d2, e2, f2 = n
    return (
        a * a2 + b * c2,
        a * b2 + b * d2,
        c * a2 + d * c2,
        c * b2 + d * d2,
        e * a2 + f * c2 + e2,
        e * b2 + f * d2 + f2,
    )


def _num(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def _matrix(operands: list[Any]) -> Matrix | None:
    if len(operands) < 6:
        return None
    values = [_num(item) for item in operands[:6]]
    return (values[0], values[1], values[2], values[3], values[4], values[5])


def _apply(m: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def _bounds(points: list[tuple[float, float]]) -> Box | None:
    if not points:
        return None
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return (min(xs), min(ys), max(xs), max(ys))


def _intersect(box: Box | None, clip: Box | None) -> Box | None:
    if box is None or clip is None:
        return box
    left, bottom = max(box[0], clip[0]), max(box[1], clip[1])
    right, top = min(box[2], clip[2]), min(box[3], clip[3])
    return (left, bottom, right, top) if left <= right and bottom <= top else None


@dataclass
class _GState:
    ctm: Matrix = IDENTITY
    fill: tuple[str, tuple[float, ...]] = ("gray", (0.0,))
    stroke: tuple[str, tuple[float, ...]] = ("gray", (0.0,))
    fill_space: str = "gray"
    stroke_space: str = "gray"
    render: int = 0
    font_size: float = 12.0
    hscale: float = 100.0
    leading: float = 0.0
    fill_alpha: float = 1.0
    stroke_alpha: float = 1.0
    #: The clipping path's bounding box on the page; ``None``: not clipped.
    clip: Box | None = None

    def copy(self) -> _GState:
        return _GState(
            self.ctm,
            self.fill,
            self.stroke,
            self.fill_space,
            self.stroke_space,
            self.render,
            self.font_size,
            self.hscale,
            self.leading,
            self.fill_alpha,
            self.stroke_alpha,
            self.clip,
        )


def _clamp(value: float) -> float:
    return min(1.0, max(0.0, value))


def _rgb(color: tuple[str, tuple[float, ...]]) -> Rgb | None:
    """The colour in RGB, or ``None`` when it can't be known (patterns, separations, odd spaces)."""
    space, values = color
    if not values:
        return None
    if space == "gray":
        gray = _clamp(values[0])
        return (gray, gray, gray)
    if space == "rgb" and len(values) >= 3:
        return (_clamp(values[0]), _clamp(values[1]), _clamp(values[2]))
    if space == "cmyk" and len(values) >= 4:
        c, m, y, k = (_clamp(value) for value in values[:4])
        return ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
    return None


def _same_colour(first: Rgb | None, second: Rgb | None) -> bool:
    if first is None or second is None:
        return False
    return max(abs(a - b) for a, b in zip(first, second, strict=True)) <= SAME_COLOUR + 1e-9


@dataclass(frozen=True)
class _Paint:
    """A region painted on the page, in drawing order; ``colour`` ``None``: an image or shading."""

    box: Box
    colour: Rgb | None
    alpha: float = 1.0


@dataclass
class _StreamReport:
    hidden: set[int] = field(default_factory=set)
    shows: int = 0
    reasons: dict[str, int] = field(default_factory=dict)


@dataclass
class _PageAnalysis:
    #: Key: () for the page content, (name, …) for a form XObject reached by those names.
    streams: dict[tuple[str, ...], _StreamReport] = field(default_factory=dict)
    image_coverage: float = 0.0

    @property
    def hidden_count(self) -> int:
        return sum(len(report.hidden) for report in self.streams.values())

    @property
    def show_count(self) -> int:
        return sum(report.shows for report in self.streams.values())

    def reasons(self) -> list[str]:
        merged: dict[str, int] = {}
        for report in self.streams.values():
            for reason, count in report.reasons.items():
                merged[reason] = merged.get(reason, 0) + count
        return sorted(merged, key=lambda reason: -merged[reason])


class _Analyzer:
    def __init__(self, reader: PdfReader, page_box: tuple[float, float, float, float]) -> None:
        self.reader = reader
        self.box = page_box
        self.page_area = max(1.0, (page_box[2] - page_box[0]) * (page_box[3] - page_box[1]))
        self.off_groups = self._off_groups()
        self.result = _PageAnalysis()
        self.paints: list[_Paint] = []

    def _paint(self, box: Box | None, colour: Rgb | None, alpha: float, clip: Box | None) -> None:
        box = _intersect(box, clip)
        if box is None or alpha <= TRANSPARENT:
            return
        area = (box[2] - box[0]) * (box[3] - box[1])
        if len(self.paints) >= MAX_PAINTS and area < LARGE_PAINT * self.page_area:
            return
        self.paints.append(_Paint(box, colour, alpha))

    def _background(self, x: float, y: float) -> Rgb | None:
        """The colour painted at a point so far (the page is white), ``None`` when unknown."""
        colour: Rgb | None = WHITE_RGB
        for paint in self.paints:
            left, bottom, right, top = paint.box
            if not (left <= x <= right and bottom <= y <= top):
                continue
            if paint.colour is None:
                colour = None
            elif paint.alpha >= 1 - TRANSPARENT:
                colour = paint.colour
            elif colour is not None:
                alpha = paint.alpha
                mixed = [
                    alpha * new + (1 - alpha) * old for new, old in zip(paint.colour, colour, strict=True)
                ]
                colour = (mixed[0], mixed[1], mixed[2])
        return colour

    def _alphas(self, resources: DictionaryObject | None, name: Any, state: _GState) -> None:
        try:
            if resources is None or "/ExtGState" not in resources:
                return
            states: Any = resources["/ExtGState"].get_object()
            params: Any = states.get(name)
            if params is None:
                return
            params = params.get_object()
            if "/ca" in params:
                state.fill_alpha = _clamp(_num(params["/ca"], 1.0))
            if "/CA" in params:
                state.stroke_alpha = _clamp(_num(params["/CA"], 1.0))
        except (KeyError, AttributeError, TypeError, ValueError, PyPdfError):
            return

    def _off_groups(self) -> set[int]:
        try:
            root: Any = self.reader.trailer["/Root"]
            properties = root.get("/OCProperties")
            if properties is None:
                return set()
            default = properties.get_object().get("/D")
            off = default.get_object().get("/OFF", []) if default is not None else []
            return {item.idnum for item in off if isinstance(item, IndirectObject)}
        except (KeyError, AttributeError, TypeError, PyPdfError):
            return set()

    def _oc_hidden(self, resources: Any, operands: list[Any]) -> bool:
        if len(operands) < 2 or operands[0] != "/OC" or not self.off_groups:
            return False
        target = operands[1]
        try:
            if isinstance(target, NameObject) and resources is not None:
                target = resources.get("/Properties", {}).get_object().raw_get(target)
            if not isinstance(target, IndirectObject):
                return False
            group: Any = target.get_object()
            if group.get("/Type") == "/OCMD":
                members = group.get("/OCGs")
                members = members if isinstance(members, list) else [members]
                ids = [item.idnum for item in members if isinstance(item, IndirectObject)]
                return bool(ids) and all(idnum in self.off_groups for idnum in ids)
            return target.idnum in self.off_groups
        except (KeyError, AttributeError, TypeError, PyPdfError):
            return False

    def _space(self, resources: DictionaryObject | None, name: Any) -> str:
        names = {
            "/DeviceGray": "gray",
            "/G": "gray",
            "/DeviceRGB": "rgb",
            "/RGB": "rgb",
            "/DeviceCMYK": "cmyk",
            "/CMYK": "cmyk",
            "/CalGray": "gray",
            "/CalRGB": "rgb",
        }
        if name in names:
            return names[name]
        try:
            if resources is not None and "/ColorSpace" in resources:
                spaces: Any = resources["/ColorSpace"].get_object()
                entry = spaces.get(name)
                if entry is not None:
                    entry = entry.get_object()
                    if isinstance(entry, list) and entry and entry[0] == "/ICCBased":
                        count = int(entry[1].get_object().get("/N", 0))
                        return {1: "gray", 3: "rgb", 4: "cmyk"}.get(count, "other")
                    if isinstance(entry, list) and entry and entry[0] in names:
                        return names[entry[0]]
        except (KeyError, AttributeError, TypeError, ValueError, PyPdfError):
            pass
        return "other"

    def _hidden_reason(self, state: _GState, tm: Matrix, oc_hidden: bool) -> str | None:
        if oc_hidden:
            return "a hidden layer"
        if state.render in (3, 7):
            return "invisible render mode (Tr 3)"
        fills, strokes = state.render in (0, 2, 4, 6), state.render in (1, 2, 5, 6)
        if (not fills or state.fill_alpha <= TRANSPARENT) and (
            not strokes or state.stroke_alpha <= TRANSPARENT
        ):
            return "transparent text"
        full = _mul(tm, state.ctm)
        background = self._background(*_apply(full, 0.0, SAMPLE_EM * state.font_size))
        if (not fills or _same_colour(_rgb(state.fill), background)) and (
            not strokes or _same_colour(_rgb(state.stroke), background)
        ):
            light = background is not None and min(background) >= LIGHT
            return "white text" if light else "text the colour of its background"
        scale = math.sqrt(abs(full[0] * full[3] - full[1] * full[2]))
        if state.font_size == 0 or state.hscale == 0 or abs(state.font_size) * scale < TINY_TEXT_PT:
            return "zero-size text"
        x, y = full[4], full[5]
        left, bottom, right, top = self.box
        if (
            x < left - PAGE_MARGIN_PT
            or x > right + PAGE_MARGIN_PT
            or y < bottom - PAGE_MARGIN_PT
            or y > top + PAGE_MARGIN_PT
        ):
            return "text outside the page"
        return None

    def run(
        self,
        contents: Any,
        resources: DictionaryObject | None,
        state: _GState,
        key: tuple[str, ...] = (),
        depth: int = 0,
    ) -> None:
        report = self.result.streams.setdefault(key, _StreamReport())
        operations = ContentStream(contents, self.reader, "bytes").operations
        stack: list[_GState] = []
        marked: list[bool] = []
        tm: Matrix = IDENTITY
        tlm: Matrix = IDENTITY
        path: list[tuple[float, float]] = []
        clipping = False
        for position, (operands, operator) in enumerate(operations):
            if operator in (b"m", b"l", b"c", b"v", b"y"):
                values = [_num(item) for item in operands]
                path.extend(
                    _apply(state.ctm, values[index], values[index + 1])
                    for index in range(0, len(values) - 1, 2)
                )
            elif operator == b"re" and len(operands) >= 4:
                x, y, width, height = (_num(item) for item in operands[:4])
                path.extend(
                    _apply(state.ctm, px, py)
                    for px, py in ((x, y), (x + width, y), (x, y + height), (x + width, y + height))
                )
            elif operator in (b"W", b"W*"):
                clipping = True
            elif operator in _FILL or operator in _STROKE or operator == b"n":
                box = _bounds(path)
                if operator in _FILL:
                    self._paint(box, _rgb(state.fill), state.fill_alpha, state.clip)
                if clipping:
                    clipped = _intersect(box, state.clip) if box is not None else state.clip
                    state.clip = clipped if clipped is not None else NOWHERE
                path, clipping = [], False
            elif operator == b"sh":
                self._paint(state.clip or self.box, None, state.fill_alpha, None)
            elif operator == b"INLINE IMAGE":
                self._image(state)
            elif operator == b"gs" and operands:
                self._alphas(resources, operands[0], state)
            elif operator == b"q":
                stack.append(state.copy())
            elif operator == b"Q":
                if stack:
                    state = stack.pop()
            elif operator == b"cm":
                matrix = _matrix(operands)
                if matrix is not None:
                    state.ctm = _mul(matrix, state.ctm)
            elif operator == b"BT":
                tm = tlm = IDENTITY
            elif operator in (b"Td", b"TD") and len(operands) >= 2:
                tx, ty = _num(operands[0]), _num(operands[1])
                if operator == b"TD":
                    state.leading = -ty
                tlm = _mul((1, 0, 0, 1, tx, ty), tlm)
                tm = tlm
            elif operator == b"Tm":
                matrix = _matrix(operands)
                if matrix is not None:
                    tm = tlm = matrix
            elif operator == b"T*":
                tlm = _mul((1, 0, 0, 1, 0, -state.leading), tlm)
                tm = tlm
            elif operator == b"TL" and operands:
                state.leading = _num(operands[0])
            elif operator == b"Tf" and len(operands) >= 2:
                state.font_size = _num(operands[1], 12.0)
            elif operator == b"Tr" and operands:
                state.render = int(_num(operands[0]))
            elif operator == b"Tz" and operands:
                state.hscale = _num(operands[0], 100.0)
            elif operator == b"g" and operands:
                state.fill, state.fill_space = ("gray", (_num(operands[0]),)), "gray"
            elif operator == b"G" and operands:
                state.stroke, state.stroke_space = ("gray", (_num(operands[0]),)), "gray"
            elif operator == b"rg" and len(operands) >= 3:
                state.fill, state.fill_space = ("rgb", tuple(_num(item) for item in operands[:3])), "rgb"
            elif operator == b"RG" and len(operands) >= 3:
                state.stroke, state.stroke_space = ("rgb", tuple(_num(item) for item in operands[:3])), "rgb"
            elif operator == b"k" and len(operands) >= 4:
                state.fill, state.fill_space = ("cmyk", tuple(_num(item) for item in operands[:4])), "cmyk"
            elif operator == b"K" and len(operands) >= 4:
                state.stroke, state.stroke_space = (
                    ("cmyk", tuple(_num(item) for item in operands[:4])),
                    "cmyk",
                )
            elif operator == b"cs" and operands:
                state.fill_space = self._space(resources, operands[0])
                state.fill = (
                    state.fill_space,
                    (0.0,) if state.fill_space != "cmyk" else (0.0, 0.0, 0.0, 1.0),
                )
            elif operator == b"CS" and operands:
                state.stroke_space = self._space(resources, operands[0])
                state.stroke = (state.stroke_space, (0.0,))
            elif operator in (b"sc", b"scn") and operands:
                numbers = tuple(_num(item) for item in operands if isinstance(item, (int, float)))
                state.fill = (state.fill_space if numbers else "other", numbers)
            elif operator in (b"SC", b"SCN") and operands:
                numbers = tuple(_num(item) for item in operands if isinstance(item, (int, float)))
                state.stroke = (state.stroke_space if numbers else "other", numbers)
            elif operator in (b"BDC", b"BMC"):
                marked.append(operator == b"BDC" and self._oc_hidden(resources, operands))
            elif operator == b"EMC":
                if marked:
                    marked.pop()
            elif operator in _SHOW:
                if operator in (b"'", b'"'):
                    tlm = _mul((1, 0, 0, 1, 0, -state.leading), tlm)
                    tm = tlm
                report.shows += 1
                reason = self._hidden_reason(state, tm, any(marked))
                if reason is not None:
                    report.hidden.add(position)
                    report.reasons[reason] = report.reasons.get(reason, 0) + 1
            elif operator == b"Do" and operands:
                self._do(resources, operands[0], state, key, depth, any(marked))

    def _image(self, state: _GState) -> None:
        area = abs(state.ctm[0] * state.ctm[3] - state.ctm[1] * state.ctm[2])
        self.result.image_coverage = max(self.result.image_coverage, area / self.page_area)
        corners = [_apply(state.ctm, x, y) for x, y in ((0, 0), (1, 0), (0, 1), (1, 1))]
        self._paint(_bounds(corners), None, state.fill_alpha, state.clip)

    def _do(
        self,
        resources: DictionaryObject | None,
        name: Any,
        state: _GState,
        key: tuple[str, ...],
        depth: int,
        oc_hidden: bool,
    ) -> None:
        try:
            if resources is None or "/XObject" not in resources:
                return
            xobjects: Any = resources["/XObject"].get_object()
            xobject = xobjects.get(name)
            if xobject is None:
                return
            xobject = xobject.get_object()
            subtype = xobject.get("/Subtype")
            if subtype == "/Image":
                self._image(state)
            elif subtype == "/Form" and depth < MAX_FORM_DEPTH and not oc_hidden:
                inner = state.copy()
                matrix = _matrix(list(xobject.get("/Matrix", []))) or IDENTITY
                inner.ctm = _mul(matrix, inner.ctm)
                form_resources = xobject.get("/Resources")
                form_resources = form_resources.get_object() if form_resources is not None else resources
                self.run(xobject, form_resources, inner, (*key, str(name)), depth + 1)
        except (KeyError, AttributeError, TypeError, ValueError, PyPdfError):
            return


def _filtered(
    operations: list[tuple[list[Any], bytes]],
    hidden: set[int],
    keep_hidden: bool,
) -> list[tuple[list[Any], bytes]]:
    """Drop the text-showing operators of one kind; keep positioning so words stay apart."""
    result: list[tuple[list[Any], bytes]] = []
    for position, (operands, operator) in enumerate(operations):
        if operator in _SHOW and (position in hidden) != keep_hidden:
            if operator in (b"'", b'"'):
                result.append(([], b"T*"))
            result.append(([FloatObject(12), FloatObject(0)], b"Td"))
        else:
            result.append((operands, operator))
    return result


def _variant_text(
    reader: PdfReader, page_number: int, analysis: _PageAnalysis, keep_hidden: bool
) -> PageText:
    writer = PdfWriter()
    page = writer.add_page(reader.pages[page_number])
    for key, report in analysis.streams.items():
        if not report.hidden and not keep_hidden:
            continue
        if key == ():
            stream = ContentStream(page.get_contents(), writer, "bytes")
            stream.operations = _filtered(stream.operations, report.hidden, keep_hidden)
            page.replace_contents(stream)
            continue
        resources: Any = page.get("/Resources")
        target: Any = None
        for name in key:
            resources = resources.get_object() if resources is not None else None
            if resources is None or "/XObject" not in resources:
                target = None
                break
            target = resources["/XObject"].get_object().get(name)
            target = target.get_object() if target is not None else None
            resources = target.get("/Resources", resources) if target is not None else None
        if isinstance(target, StreamObject):
            stream = ContentStream(target, writer, "bytes")
            stream.operations = _filtered(stream.operations, report.hidden, keep_hidden)
            target.set_data(stream.get_data())
    return page_text(page)


@dataclass(frozen=True)
class PdfExtraction:
    title: str | None
    paragraphs: list[Paragraph]
    findings: list[Finding]
    page_count: int
    #: Set when the PDF can't give any text; the material is created as ``failed`` with this reason.
    failure: str | None = None


_HYPHENATED = re.compile(r"(\w)-$")


def _paragraphs(text: str) -> list[tuple[int, str]]:
    """Rebuild paragraphs from extracted lines: blank lines and short sentence-final lines end them.

    Each comes with the number of the blank-line-separated block of ``text`` it was in.
    """
    lines = [line.strip() for line in text.split("\n")]
    lengths = sorted(len(line) for line in lines if line)
    if not lengths:
        return []
    typical = lengths[min(len(lengths) - 1, int(len(lengths) * 0.9))]
    paragraphs: list[tuple[int, str]] = []
    current = ""
    block, in_block = 0, False
    for line in lines:
        if not line:
            if current:
                paragraphs.append((block, current))
            current = ""
            if in_block:
                block, in_block = block + 1, False
            continue
        in_block = True
        if current:
            hyphen = _HYPHENATED.search(current)
            if hyphen is not None and line[:1].islower():
                current = current[:-1] + line
            else:
                current = f"{current} {line}"
        else:
            current = line
        if line[-1:] in '.!?…:»"”)' and len(line) < 0.8 * typical:
            paragraphs.append((block, current))
            current = ""
    if current:
        paragraphs.append((block, current))
    return paragraphs


def _metadata_title(reader: PdfReader) -> str | None:
    try:
        raw = reader.metadata.title if reader.metadata is not None else None
    except (PyPdfError, AttributeError, TypeError, ValueError):
        return None
    title = sanitize_title(str(raw)) if raw else None
    if title is None or _UNTITLED.match(title) or len(title) < 3:
        return None
    return title


def _largest_line(reader: PdfReader, analysis: _PageAnalysis) -> str | None:
    """The first page's biggest visible text, as a title (hidden text never becomes the title)."""
    writer = PdfWriter()
    page = writer.add_page(reader.pages[0])
    if analysis.hidden_count:
        report = analysis.streams.get(())
        if report is not None:
            stream = ContentStream(page.get_contents(), writer, "bytes")
            stream.operations = _filtered(stream.operations, report.hidden, keep_hidden=False)
            page.replace_contents(stream)
    text = largest_text(page)
    return sanitize_title(text) if text else None


def _hidden_finding(text: str, page: int, reasons: list[str]) -> Finding | None:
    removed = strip_invisible(text).strip()
    if not removed:
        return None
    return Finding(
        kind="hidden_pdf_text",
        page=page,
        original=visible_repr(" ".join(removed.split())),
        detail="Removed hidden PDF text (" + ", ".join(reasons) + ").",
    )


def _unreadable_finding(text: str, page: int) -> Finding:
    return Finding(
        kind="unreadable_pdf_text",
        page=page,
        original=visible_repr(text),
        detail=f"Unreadable text in the PDF (page {page}): its font has no usable character map.",
    )


def open_pdf(data: bytes) -> PdfReader:
    try:
        reader = PdfReader(BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise PdfRejected("This PDF is password-protected. Remove the password and add it again.")
        _ = len(reader.pages)
    except PdfRejected:
        raise
    except (PdfReadError, PyPdfError, ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        raise PdfRejected("SKAZ can't read this PDF: the file looks damaged.") from error
    return reader


def extract_pdf(data: bytes) -> PdfExtraction:
    reader = open_pdf(data)
    #: (page, text, shape of its paragraph block) — roles need the whole document's body size.
    pieces: list[tuple[int, str, Shape | None]] = []
    shaped: list[Shape] = []
    findings: list[Finding] = []
    any_visible = any_hidden = False
    title: str | None = None
    for number, page in enumerate(reader.pages):
        try:
            box = page.cropbox
            analyzer = _Analyzer(
                reader, (float(box.left), float(box.bottom), float(box.right), float(box.top))
            )
            contents = page.get_contents()
            resources = page.get("/Resources")
            resources = resources.get_object() if resources is not None else None
            if contents is not None:
                analyzer.run(contents, resources, _GState())
            analysis = analyzer.result
            ocr_layer = (
                analysis.show_count > 0
                and analysis.hidden_count == analysis.show_count
                and analysis.image_coverage >= OCR_IMAGE_COVERAGE
                and set(analysis.reasons()) == {"invisible render mode (Tr 3)"}
            )
            if analysis.hidden_count and not ocr_layer:
                visible = _variant_text(reader, number, analysis, keep_hidden=False)
                hidden = _variant_text(reader, number, analysis, keep_hidden=True)
                finding = _hidden_finding(hidden.text, number + 1, analysis.reasons())
                if finding is not None:
                    findings.append(finding)
                    any_hidden = True
            else:
                visible = page_text(page)
            if number == 0:
                title = _metadata_title(reader) or (
                    _largest_line(reader, analysis) if not ocr_layer else None
                )
        except (PyPdfError, KeyError, ValueError, TypeError, AttributeError, RecursionError) as error:
            raise PdfRejected(f"SKAZ can't read page {number + 1} of this PDF.") from error
        findings.extend(_unreadable_finding(text, number + 1) for text in visible.unreadable)
        cleaned = clean_invisible(visible.text, page=number + 1)
        findings.extend(cleaned.findings)
        blocks = [part for part in re.split(r"\n\s*\n", cleaned.text) if part.strip()]
        # Cleaning removes characters, not lines; should a block go anyway, the roles are not guessed.
        shapes = visible.shapes if len(visible.shapes) == len(blocks) else []
        shaped.extend(shapes)
        for block, text in _paragraphs(cleaned.text):
            pieces.append((number + 1, text, shapes[block] if block < len(shapes) else None))
            any_visible = True
    body = body_size(shaped)
    paragraphs: list[Paragraph] = []
    for page_number, text, shape in pieces:
        role, level = paragraph_role(shape, body) if shape is not None else ("paragraph", None)
        paragraphs.append(Paragraph(text, page=page_number, role=role, level=level))
    failure = None
    if not any_visible:
        failure = ONLY_HIDDEN_TEXT if any_hidden else NO_TEXT_LAYER
    return PdfExtraction(title, paragraphs, findings, len(reader.pages), failure)
