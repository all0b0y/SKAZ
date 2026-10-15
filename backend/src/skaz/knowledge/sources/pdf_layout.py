"""Lines and paragraph breaks of a PDF page rebuilt from where the glyphs are.

``PageObject.extract_text()`` starts a new line for every text object (``BT … ET``). Producers
such as Google Docs and Chrome (Skia) put every word — and every space — in its own text object,
so a page came out one word per line (user bug 1016-3). Here pypdf still decodes the text (its
visitor reports each run with its matrices, font and size), and the lines are rebuilt from the
positions, in content-stream order (so the columns of a two-column page stay apart):

* a run continues the current line when its baseline is the same (within 0.45 em) and it does
  not jump back to the left;
* a space is put between two runs when neither brings one and the gap between the end of the
  first (its width from the font's metrics) and the start of the next is wider than 0.2 em;
* a new paragraph starts when the vertical step is clearly larger than the page's usual line
  step, the font size changes, or the line starts with a bullet glyph.
"""

from __future__ import annotations

import itertools
import math
import statistics
from dataclasses import dataclass, field
from typing import Any

from pypdf import PageObject
from pypdf.errors import PyPdfError

from .pdf_glyphs import judge, shift_text

SAME_LINE_EM = 0.45
SPACE_GAP_EM = 0.2
NEW_LINE_BACK_EM = 1.0
PARAGRAPH_STEP = 1.3
PARAGRAPH_EXTRA_EM = 0.3
SIZE_CHANGE = 0.2
#: A line that starts with one of these is a list item: it starts a paragraph of its own.
BULLETS = frozenset("•●▪◦‣■□►➢✓✔○◆◇")
#: Glyph width (thousandths of an em) when the font gives none.
DEFAULT_WIDTH = 500.0


@dataclass
class Run:
    """One piece of text as pypdf decoded it, placed on the page (PDF user space, y up)."""

    text: str
    x: float
    y: float
    #: Font size on the page (the matrices applied), in points.
    size: float
    end: float
    font: Any = None


@dataclass
class Line:
    runs: list[Run] = field(default_factory=list)
    text: str = ""

    @property
    def y(self) -> float:
        return self.runs[0].y

    @property
    def x(self) -> float:
        return self.runs[0].x

    @property
    def size(self) -> float:
        """The size most of the line's letters have."""
        weight: dict[float, int] = {}
        for run in self.runs:
            key = round(run.size, 1)
            weight[key] = weight.get(key, 0) + len(run.text.strip())
        return max(weight, key=lambda key: weight[key]) if weight else 0.0

    @property
    def end(self) -> float:
        return self.runs[-1].end


def _mul(m: list[float], n: list[float]) -> tuple[float, ...]:
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


def _floats(values: Any) -> list[float]:
    try:
        result = [float(item) for item in list(values)[:6]]
    except (TypeError, ValueError):
        return [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    if len(result) < 6 or not all(math.isfinite(item) for item in result):
        return [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    return result


class _Widths:
    """Glyph widths per decoded character for one font (pypdf's font model, read once)."""

    def __init__(self, font: Any) -> None:
        self.widths: dict[str, float] = {}
        self.default = DEFAULT_WIDTH
        try:
            from pypdf.generic._font import Font  # pypdf's own model of a font resource

            model = Font.from_font_resource(font)
        except Exception:  # any odd font: fall back to an average width
            return
        raw = dict(model.character_widths)
        self.default = float(raw.get("default", DEFAULT_WIDTH)) or DEFAULT_WIDTH
        codes: dict[str, str] = {}
        if isinstance(model.encoding, dict):
            for number, glyph in model.encoding.items():
                if isinstance(glyph, str) and isinstance(number, int):
                    codes.setdefault(glyph, chr(number))
        for key, glyph in model.character_map.items():
            if isinstance(glyph, str) and isinstance(key, str):
                codes.setdefault(glyph, key)
        for char, code in codes.items():
            width = raw.get(code)
            if isinstance(width, (int, float)) and width > 0:
                self.widths[char] = float(width)
        for key, width in raw.items():
            if isinstance(key, str) and len(key) == 1 and isinstance(width, (int, float)) and width > 0:
                self.widths.setdefault(key, float(width))

    def of(self, text: str) -> float:
        return sum(self.widths.get(char, self.default) for char in text)


class _Collector:
    def __init__(self) -> None:
        self.runs: list[Run] = []
        self.widths: dict[int, _Widths] = {}

    def width(self, font: Any, text: str) -> float:
        if font is None:
            return DEFAULT_WIDTH * len(text)
        key = id(font)
        if key not in self.widths:
            self.widths[key] = _Widths(font)
        return self.widths[key].of(text)

    def visit(self, text: str, cm: Any, tm: Any, font: Any, size: Any) -> None:
        if not text or not text.strip("\n"):
            return
        full = _mul(_floats(tm), _floats(cm))
        try:
            points = abs(float(size))
        except (TypeError, ValueError):
            points = 12.0
        scale_x = math.hypot(full[0], full[1])
        scale_y = math.hypot(full[2], full[3])
        x, y = full[4], full[5]
        pieces = text.split("\n")
        for index, piece in enumerate(pieces):
            if index and not piece:
                continue
            # A run pypdf broke itself carries its later lines without a position: put them under it.
            line_y = y - index * points * scale_y * 1.2
            end = x + self.width(font, piece) * points / 1000 * scale_x
            self.runs.append(Run(piece, x, line_y, points * scale_y, end, font))


@dataclass
class PageRuns:
    runs: list[Run]
    #: Text of fonts that couldn't be read (one entry per font), left out of ``runs``.
    unreadable: list[str] = field(default_factory=list)
    #: Runs decoded by a constant glyph shift (``pdf_glyphs``).
    decoded: int = 0


def page_runs(page: PageObject) -> PageRuns:
    collector = _Collector()
    page.extract_text(visitor_text=collector.visit)
    return repair(collector.runs)


def repair(runs: list[Run]) -> PageRuns:
    """Judge each font's text on the page as a whole: keep it, decode it, or leave it out."""
    by_font: dict[int, list[Run]] = {}
    for run in runs:
        by_font.setdefault(id(run.font), []).append(run)
    dropped: set[int] = set()
    unreadable: list[str] = []
    decoded = 0
    for font_runs in by_font.values():
        joined = " ".join(run.text for run in font_runs)
        verdict = judge(joined, font_runs[0].font)
        if verdict.action == "decoded":
            for run in font_runs:
                run.text = shift_text(run.text, verdict.shift)
            decoded += len(font_runs)
        elif verdict.action == "unreadable":
            dropped.update(id(run) for run in font_runs)
            unreadable.append(" ".join(joined.split()))
    return PageRuns([run for run in runs if id(run) not in dropped], unreadable, decoded)


def build_lines(runs: list[Run]) -> list[Line]:
    lines: list[Line] = []
    current: Line | None = None
    for run in runs:
        if current is not None and current.runs:
            last = current.runs[-1]
            em = max(last.size, run.size, 1.0)
            same = abs(run.y - last.y) <= SAME_LINE_EM * em and run.x >= last.end - NEW_LINE_BACK_EM * em
            if same:
                text = current.text
                apart = run.x - last.end > SPACE_GAP_EM * em
                if apart and text and not text[-1].isspace() and not run.text[:1].isspace():
                    text += " "
                current.text = text + run.text
                current.runs.append(run)
                continue
        current = Line([run], run.text)
        lines.append(current)
    for line in lines:
        line.text = " ".join(line.text.split())
    return [line for line in lines if line.text]


def _typical_step(lines: list[Line]) -> float | None:
    steps = []
    for above, below in itertools.pairwise(lines):
        size = below.size
        step = above.y - below.y
        if size > 0 and abs(above.size - size) <= SIZE_CHANGE * size and 0.9 * size < step < 3 * size:
            steps.append(step / size)
    return statistics.median(steps) if steps else None


def paragraph_breaks(lines: list[Line]) -> list[bool]:
    """``breaks[i]``: a new paragraph starts at ``lines[i]`` (the first line never counts)."""
    typical = _typical_step(lines)
    breaks = [False] * len(lines)
    for index in range(1, len(lines)):
        above, below = lines[index - 1], lines[index]
        size = max(above.size, below.size, 1.0)
        if below.text[:1] in BULLETS:
            breaks[index] = True
            continue
        if abs(above.size - below.size) > SIZE_CHANGE * min(above.size, below.size):
            breaks[index] = True
            continue
        step = (above.y - below.y) / size
        if step <= 0:
            continue  # the next column or a jump up: the text rules decide
        if typical is None:
            breaks[index] = step > 1.8
        else:
            breaks[index] = step > typical * PARAGRAPH_STEP and step > typical + PARAGRAPH_EXTRA_EM
    return breaks


@dataclass(frozen=True)
class PageText:
    #: One line per rebuilt line, a blank line between paragraphs.
    text: str
    unreadable: list[str] = field(default_factory=list)
    decoded: int = 0


def page_text(page: PageObject) -> PageText:
    """The page's text in reading lines, with unreadable fonts left out (reported separately)."""
    try:
        found = page_runs(page)
        lines = build_lines(found.runs)
    except (PyPdfError, KeyError, ValueError, TypeError, AttributeError, ZeroDivisionError):
        return PageText(page.extract_text())
    breaks = paragraph_breaks(lines)
    out: list[str] = []
    for line, new_paragraph in zip(lines, breaks, strict=True):
        if new_paragraph:
            out.append("")
        out.append(line.text)
    return PageText("\n".join(out), found.unreadable, found.decoded)


def largest_text(page: PageObject) -> str | None:
    """The page's biggest text (a title candidate): lines within 5 % of the largest size."""
    try:
        lines = build_lines(page_runs(page).runs)
    except (PyPdfError, KeyError, ValueError, TypeError, AttributeError, ZeroDivisionError):
        return None
    if not lines:
        return None
    biggest = max(line.size for line in lines)
    if biggest <= 0:
        return None
    return " ".join(line.text for line in lines if line.size >= biggest * 0.95)
