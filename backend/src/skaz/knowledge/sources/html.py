"""Web article: hidden content removed before readability, then the main text as paragraphs.

Removed before readability (each element with readable text gives a finding):
``display:none``, ``visibility:hidden|collapse``, the ``hidden`` attribute,
``aria-hidden="true"``, ``opacity:0``, ``font-size:0``, zero width/height
(with hidden overflow) or ``max-height:0``, ``clip: rect(0…)``/``clip-path``
that cuts everything, ``transform: scale(0)``, far off-screen positioning or
``text-indent``, text coloured transparent or like its background (white on
the default white page included), common screen-reader-only classes
(``sr-only``, ``visually-hidden``…), HTML comments, and ``script``/``style``/
``noscript``/``template``/``iframe``/``object``/``svg`` etc. Attributes
(``alt``, ``title``, ``aria-label``) never become text: only text nodes are read.

Styles come from inline ``style`` attributes and from ``<style>`` elements
in the page (simple cascade: rules in document order, then inline; no
specificity, ``!important`` or inheritance quirks beyond the basics). Not
caught without a browser: external stylesheets, rules inside ``@media``,
pseudo-classes, styles set by JavaScript, text hidden behind other elements,
``::before``/``::after`` content, and colours compared with a background
image or a gradient.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import lxml.html  # type: ignore[import-untyped]
from lxml import etree
from lxml.cssselect import CSSSelector  # type: ignore[import-untyped]
from readability import Document  # type: ignore[import-untyped]

from ..errors import KnowledgeError
from ..markdown.source import FragmentRole
from .fragments import Paragraph, sanitize_title
from .guard import Finding, clean_invisible
from .guard.findings import visible_repr

REMOVED_TAGS = frozenset(
    {
        "script",
        "style",
        "noscript",
        "template",
        "iframe",
        "object",
        "embed",
        "svg",
        "canvas",
        "button",
        "select",
        "option",
        "textarea",
        "input",
        "head",
        "link",
        "meta",
        "audio",
        "video",
        "source",
        "track",
        "map",
    }
)
BLOCK_TAGS = frozenset(
    {
        "p",
        "div",
        "section",
        "article",
        "header",
        "footer",
        "main",
        "aside",
        "nav",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "ul",
        "ol",
        "dl",
        "dt",
        "dd",
        "blockquote",
        "pre",
        "table",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "td",
        "th",
        "figure",
        "figcaption",
        "hr",
        "address",
        "details",
        "summary",
        "caption",
        "body",
        "html",
    }
)
SR_ONLY_CLASSES = frozenset(
    {
        "sr-only",
        "visually-hidden",
        "visuallyhidden",
        "screen-reader-text",
        "screen-reader-only",
        "a11y-hidden",
        "element-invisible",
        "hidden",
        "hide",
        "is-hidden",
        "u-hidden",
        "d-none",
        "invisible",
    }
)
#: Hidden on every screen size; the generic utility classes above may be undone by a responsive variant.
_ALWAYS_SR_ONLY = frozenset(
    {
        "sr-only",
        "visually-hidden",
        "visuallyhidden",
        "screen-reader-text",
        "screen-reader-only",
        "a11y-hidden",
        "element-invisible",
    }
)
#: ``md:block`` (Tailwind) or ``d-md-block`` (Bootstrap): shown from some width on.
_RESPONSIVE_CLASS = re.compile(r"^(?:[\w-]+:|d-(?:sm|md|lg|xl|xxl)-)")
MIN_COMMENT_LETTERS = 20
_COLOR_DISTANCE = 24.0
_OFFSCREEN_PX = 1000.0


class ArticleRejected(KnowledgeError):
    status_code = 422


@dataclass(frozen=True)
class ArticleExtraction:
    title: str | None
    paragraphs: list[Paragraph]
    findings: list[Finding]
    site_name: str | None
    #: ``<script>`` elements in the raw page (a page whose text needs JavaScript has some, little text).
    scripts: int = 0
    #: Password fields in the raw page (a sign-in form instead of the page).
    password_fields: int = 0


# -- CSS -------------------------------------------------------------------

_DECLARATION = re.compile(r"([\w-]+)\s*:\s*([^;]+)")
_CSS_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_NAMED_COLORS = {
    "white": (255, 255, 255),
    "black": (0, 0, 0),
    "red": (255, 0, 0),
    "green": (0, 128, 0),
    "blue": (0, 0, 255),
    "gray": (128, 128, 128),
    "grey": (128, 128, 128),
    "silver": (192, 192, 192),
    "whitesmoke": (245, 245, 245),
    "snow": (255, 250, 250),
    "ivory": (255, 255, 240),
    "ghostwhite": (248, 248, 255),
    "floralwhite": (255, 250, 240),
    "seashell": (255, 245, 238),
    "mintcream": (245, 255, 250),
    "azure": (240, 255, 255),
    "aliceblue": (240, 248, 255),
    "linen": (250, 240, 230),
    "honeydew": (240, 255, 240),
    "lavenderblush": (255, 240, 245),
    "yellow": (255, 255, 0),
    "navy": (0, 0, 128),
    "maroon": (128, 0, 0),
    "purple": (128, 0, 128),
    "orange": (255, 165, 0),
    "lightgray": (211, 211, 211),
    "lightgrey": (211, 211, 211),
    "darkgray": (169, 169, 169),
    "darkgrey": (169, 169, 169),
    "beige": (245, 245, 220),
}
Color = tuple[float, float, float, float]
WHITE: Color = (255.0, 255.0, 255.0, 1.0)
BLACK: Color = (0.0, 0.0, 0.0, 1.0)


def parse_declarations(text: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for name, value in _DECLARATION.findall(_CSS_COMMENT.sub("", text or "")):
        found[name.strip().lower()] = value.replace("!important", "").strip().lower()
    return found


def parse_color(value: str | None) -> Color | None:
    if not value:
        return None
    value = value.strip().lower()
    if value == "transparent":
        return (0.0, 0.0, 0.0, 0.0)
    if value in _NAMED_COLORS:
        r, g, b = _NAMED_COLORS[value]
        return (float(r), float(g), float(b), 1.0)
    hex_match = re.fullmatch(r"#([0-9a-f]{3,8})", value)
    if hex_match:
        digits = hex_match.group(1)
        if len(digits) in (3, 4):
            digits = "".join(char * 2 for char in digits)
        if len(digits) in (6, 8):
            alpha = int(digits[6:8], 16) / 255 if len(digits) == 8 else 1.0
            return (
                float(int(digits[0:2], 16)),
                float(int(digits[2:4], 16)),
                float(int(digits[4:6], 16)),
                alpha,
            )
        return None
    func = re.fullmatch(
        r"rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)", value
    )
    if func:

        def channel(raw: str) -> float:
            return float(raw[:-1]) * 2.55 if raw.endswith("%") else float(raw)

        alpha_raw = func.group(4)
        alpha = 1.0
        if alpha_raw:
            alpha = float(alpha_raw[:-1]) / 100 if alpha_raw.endswith("%") else float(alpha_raw)
        return (channel(func.group(1)), channel(func.group(2)), channel(func.group(3)), alpha)
    return None


def _length(value: str | None) -> float | None:
    """A CSS length in px (``em``/``rem`` as 16px, ``%`` as itself); ``None`` when not a plain length."""
    if value is None:
        return None
    match = re.fullmatch(
        r"(-?[\d.]+)(px|pt|em|rem|%|vw|vh|cm|mm|in)?", value.strip().split()[0] if value.strip() else ""
    )
    if not match:
        return None
    number = float(match.group(1))
    unit = match.group(2) or "px"
    return (
        number
        * {
            "px": 1,
            "pt": 1.33,
            "em": 16,
            "rem": 16,
            "%": 1,
            "vw": 10,
            "vh": 10,
            "cm": 38,
            "mm": 3.8,
            "in": 96,
        }[unit]
    )


def _top_level_rules(css: str) -> Iterator[tuple[str, str]]:
    """``(selectors, declarations)`` outside ``@media``/``@keyframes``…; ``@supports``/``@layer`` are entered.

    Rules inside ``@media`` are skipped on purpose: a rule that hides something
    on phones only must not remove text a desktop reader sees.
    """
    css = _CSS_COMMENT.sub("", css)
    stack: list[tuple[str, str, int]] = []  # (role, prelude, body start); role: skip | enter | rule
    boundary = 0
    for position, char in enumerate(css):
        if char == "{":
            prelude = css[boundary:position].strip()
            if stack and stack[-1][0] in ("skip", "rule"):
                role = "skip"
            elif prelude.startswith("@"):
                role = "enter" if prelude.startswith(("@supports", "@layer")) else "skip"
            else:
                role = "rule"
            stack.append((role, prelude, position + 1))
            boundary = position + 1
        elif char == "}":
            if stack:
                role, prelude, body_start = stack.pop()
                if role == "rule":
                    yield prelude, css[body_start:position]
            boundary = position + 1
        elif char == ";" and (not stack or stack[-1][0] == "enter"):
            boundary = position + 1


_HIDING_PROPERTIES = frozenset(
    {
        "display",
        "visibility",
        "opacity",
        "font-size",
        "color",
        "background",
        "background-color",
        "width",
        "height",
        "max-height",
        "max-width",
        "overflow",
        "clip",
        "clip-path",
        "transform",
        "position",
        "left",
        "top",
        "text-indent",
        "line-height",
    }
)


def _stylesheet(document: Any) -> list[tuple[Any, dict[str, str], str]]:
    """``(selector, declarations, source)`` for rules that set a property layer 2 looks at."""
    rules: list[tuple[Any, dict[str, str], str]] = []
    for style in document.iter("style"):
        for selectors, body in _top_level_rules(style.text or ""):
            declarations = {
                key: value for key, value in parse_declarations(body).items() if key in _HIDING_PROPERTIES
            }
            if not declarations:
                continue
            for selector in selectors.split(","):
                selector = selector.strip()
                if not selector or ":" in selector:
                    continue
                try:
                    rules.append((CSSSelector(selector), declarations, selector))
                except Exception:
                    continue
    return rules


# -- hidden-element detection -------------------------------------------------


@dataclass(frozen=True)
class _Context:
    color: Color = BLACK
    background: Color = WHITE
    visible: bool = True
    font_zero: bool = False
    #: The page set a background colour on this element or an ancestor (not an image/gradient).
    background_known: bool = False
    #: The text colour came from an inline ``style`` attribute.
    color_inline: bool = False


def _element_label(element: Any) -> str:
    label = element.tag if isinstance(element.tag, str) else "node"
    if element.get("id"):
        label += "#" + element.get("id")[:40]
    classes = (element.get("class") or "").split()
    if classes:
        label += "." + ".".join(item[:30] for item in classes[:3])
    return label


def _blend(color: Color, background: Color) -> Color:
    alpha = color[3]
    return (
        color[0] * alpha + background[0] * (1 - alpha),
        color[1] * alpha + background[1] * (1 - alpha),
        color[2] * alpha + background[2] * (1 - alpha),
        1.0,
    )


def _distance(left: Color, right: Color) -> float:
    return float(sum((left[i] - right[i]) ** 2 for i in range(3)) ** 0.5)


def _subtree_hidden(element: Any, style: dict[str, str]) -> str | None:
    """Why the whole element (and everything inside) is not shown, or ``None``."""
    if element.get("hidden") is not None:
        return "hidden attribute"
    if element.tag == "dialog" and element.get("open") is None:
        return "closed dialog"
    if (element.get("aria-hidden") or "").strip().lower() == "true":
        return 'aria-hidden="true"'
    classes = {item.lower() for item in (element.get("class") or "").split()}
    responsive = any(_RESPONSIVE_CLASS.match(item) for item in classes)
    if classes & SR_ONLY_CLASSES and not (responsive and not classes & _ALWAYS_SR_ONLY):
        return "screen-reader-only class"
    if style.get("display", "").startswith("none"):
        return "display:none"
    opacity = style.get("opacity")
    if opacity is not None:
        try:
            value = float(opacity[:-1]) / 100 if opacity.endswith("%") else float(opacity)
            if value <= 0.05:
                return "opacity:0"
        except ValueError:
            pass
    overflow = style.get("overflow", "")
    for prop in ("width", "height"):
        size = _length(style.get(prop))
        if size is not None and size <= 1 and ("hidden" in overflow or "clip" in overflow):
            return f"{prop}:0"
    max_height = _length(style.get("max-height"))
    if max_height is not None and max_height <= 0 and ("hidden" in overflow or "clip" in overflow):
        return "max-height:0"
    clip = style.get("clip", "").replace(" ", "")
    if clip.startswith("rect(0") and re.fullmatch(r"rect\((?:0(?:px)?,?){4}\)", clip):
        return "clip:rect(0)"
    clip_path = style.get("clip-path", "")
    if re.search(r"inset\(\s*(?:50|100)%", clip_path) or "circle(0" in clip_path.replace(" ", ""):
        return "clip-path"
    if re.search(r"scale[xy]?\(\s*0(?:\.0+)?\s*[,)]", style.get("transform", "")):
        return "transform:scale(0)"
    if style.get("position", "") in ("absolute", "fixed"):
        for prop in ("left", "top"):
            offset = _length(style.get(prop))
            if offset is not None and offset <= -_OFFSCREEN_PX:
                return "positioned off-screen"
    indent = _length(style.get("text-indent"))
    if indent is not None and indent <= -_OFFSCREEN_PX:
        return "text-indent off-screen"
    return None


class _Pruner:
    def __init__(self, document: Any) -> None:
        self.document = document
        self.findings: list[Finding] = []
        self.rules = _stylesheet(document)
        self.sheet: dict[Any, dict[str, str]] = {}
        for selector, declarations, _source in self.rules:
            try:
                matched = selector(document)
            except Exception:
                continue
            for element in matched:
                self.sheet.setdefault(element, {}).update(declarations)

    def style(self, element: Any) -> dict[str, str]:
        computed = dict(self.sheet.get(element, {}))
        computed.update(parse_declarations(element.get("style") or ""))
        return computed

    def record(self, kind: str, element: Any, reason: str, text: str) -> None:
        text = " ".join(text.split())
        if not text:
            return
        if kind == "html_comment":
            self.findings.append(
                Finding(
                    kind="html_comment",
                    original=visible_repr(text),
                    detail="Removed an HTML comment with readable text.",
                )
            )
        else:
            self.findings.append(
                Finding(
                    kind="hidden_html",
                    element=_element_label(element),
                    original=visible_repr(text),
                    detail=f"Removed text a browser doesn't show ({reason}).",
                )
            )

    def prune(self, element: Any, context: _Context) -> None:
        for child in list(element):
            if child.getparent() is None:
                continue
            if child.tag is etree.Comment:
                text = child.text or ""
                if sum(
                    char.isalpha() for char in text
                ) >= MIN_COMMENT_LETTERS and not text.lstrip().startswith(("[if", "<![endif]", "[endif]")):
                    self.record("html_comment", child, "comment", text)
                self._drop(child)
                continue
            if not isinstance(child.tag, str):
                self._drop(child)
                continue
            tag = child.tag.lower()
            if tag in REMOVED_TAGS:
                self._drop(child)
                continue
            style = self.style(child)
            reason = _subtree_hidden(child, style)
            if reason is not None:
                self.record("hidden_html", child, reason, child.text_content())
                self._drop(child)
                continue
            self.prune(child, self._child_context(child, style, context))
        self._text_hidden(element, context)

    def _child_context(self, element: Any, style: dict[str, str], context: _Context) -> _Context:
        visible = context.visible
        visibility = style.get("visibility")
        if visibility in ("hidden", "collapse"):
            visible = False
        elif visibility == "visible":
            visible = True
        font_zero = context.font_zero
        size = style.get("font-size")
        if size is not None:
            length = _length(size)
            font_zero = length is not None and length <= 0
        background, known = context.background, context.background_known
        for prop in ("background-color", "background"):
            value = style.get(prop)
            if not value:
                continue
            if "url(" in value or "gradient" in value:
                known = False  # an image behind the text: its colour is unknown
                break
            parsed = parse_color(value.split()[0])
            if parsed is not None and parsed[3] > 0:
                background, known = _blend(parsed, context.background), True
                break
        color, inline = context.color, context.color_inline
        parsed_color = parse_color(style.get("color"))
        if parsed_color is not None:
            color = parsed_color
            inline = "color" in parse_declarations(element.get("style") or "")
        return _Context(color, background, visible, font_zero, known, inline)

    def _text_reason(self, context: _Context) -> str | None:
        if not context.visible:
            return "visibility:hidden"
        if context.font_zero:
            return "font-size:0"
        if context.color[3] <= 0.05:
            return "transparent text"
        # Against an assumed white page only an inline colour counts: a site stylesheet that sets
        # light text usually pairs it with a dark background SKAZ can't see (external CSS).
        if not (context.background_known or context.color_inline):
            return None
        if _distance(_blend(context.color, context.background), context.background) < _COLOR_DISTANCE:
            return "text coloured like its background"
        return None

    def _text_hidden(self, element: Any, context: _Context) -> None:
        """Own text and the tails of children belong to ``element``'s context."""
        reason = self._text_reason(context)
        if reason is None:
            return
        if element.text and element.text.strip():
            self.record("hidden_html", element, reason, element.text)
            element.text = None
        for child in element:
            if child.tail and child.tail.strip():
                self.record("hidden_html", element, reason, child.tail)
                child.tail = None

    @staticmethod
    def _drop(node: Any) -> None:
        parent = node.getparent()
        if parent is None:
            return
        tail = node.tail
        previous = node.getprevious()
        parent.remove(node)
        if tail:
            if previous is not None:
                previous.tail = (previous.tail or "") + tail
            else:
                parent.text = (parent.text or "") + tail


# -- text out of the article HTML ----------------------------------------------


_HEADINGS = {f"h{level}": level for level in range(1, 7)}
#: The tags that give the text inside them a display role (user bug 1016-5); the innermost one wins.
_ROLE_TAGS: dict[str, FragmentRole] = {
    **dict.fromkeys(_HEADINGS, "heading"),
    "li": "list_item",
    "blockquote": "quote",
    "pre": "code",
}


@dataclass(frozen=True)
class Block:
    """A piece of article text and how it is shown; the role never changes the text."""

    text: str
    role: FragmentRole = "paragraph"
    level: int | None = None


def code_text(text: str) -> str:
    """Code keeps its lines and indentation (trailing spaces and blank edges go)."""
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return "\n".join(lines).strip("\n")


def _block_texts(root: Any) -> list[Block]:
    paragraphs: list[Block] = []
    buffer: list[str] = []
    roles: list[tuple[FragmentRole, int | None]] = []

    def flush() -> None:
        text = " ".join("".join(buffer).split())
        if text:
            role, level = roles[-1] if roles else ("paragraph", None)
            paragraphs.append(Block(text, role, level))
        buffer.clear()

    def walk(node: Any) -> None:
        if not isinstance(node.tag, str):
            if node.tail:
                buffer.append(node.tail)
            return
        tag = node.tag.lower()
        if tag in REMOVED_TAGS:
            if node.tail:
                buffer.append(node.tail)
            return
        block = tag in BLOCK_TAGS
        if block:
            flush()
        if tag in _ROLE_TAGS:
            roles.append((_ROLE_TAGS[tag], _HEADINGS.get(tag)))
        if tag == "br":
            buffer.append(" ")
        if tag == "pre":
            flush()
            for part in re.split(r"\n\s*\n", node.text_content()):
                if part.strip():
                    paragraphs.append(Block(code_text(part), "code"))
        else:
            if node.text:
                buffer.append(node.text)
            for child in node:
                walk(child)
        if block:
            flush()
        if tag in _ROLE_TAGS:
            roles.pop()
        if node.tail:
            buffer.append(node.tail)

    walk(root)
    flush()
    return paragraphs


def _meta(document: Any, *names: str) -> str | None:
    for name in names:
        for element in document.iter("meta"):
            if (element.get("property") or element.get("name") or "").lower() == name:
                content = (element.get("content") or "").strip()
                if content:
                    return content
    return None


def decode_html(body: bytes, charset: str | None) -> str:
    candidates = [charset] if charset else []
    head = body[:4096].decode("ascii", errors="ignore")
    declared = re.search(r"<meta[^>]+charset=[\"']?([\w-]+)", head, re.IGNORECASE)
    if declared:
        candidates.append(declared.group(1))
    candidates += ["utf-8", "cp1251"]
    for encoding in candidates:
        try:
            return body.decode(encoding or "utf-8")
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", errors="replace")


@dataclass(frozen=True)
class _Pruned:
    """A parsed page with hidden content, scripts and styles removed (layer 2)."""

    document: Any
    body: Any
    findings: list[Finding]
    page_title: str | None
    og_title: str | None
    site_name: str | None
    h1: str | None
    scripts: int
    password_fields: int


def _pruned(html: str) -> _Pruned:
    if not html.strip():
        raise ArticleRejected("The page is empty.")
    try:
        document = lxml.html.document_fromstring(html)
    except (etree.ParserError, ValueError) as error:
        raise ArticleRejected("SKAZ can't read this page.") from error
    title_tag = document.find(".//title")
    page_title = title_tag.text_content() if title_tag is not None else None
    og_title = _meta(document, "og:title", "twitter:title")
    site_name = _meta(document, "og:site_name")
    scripts = sum(1 for _ in document.iter("script"))
    password_fields = sum(
        1 for item in document.iter("input") if (item.get("type") or "").lower() == "password"
    )
    pruner = _Pruner(document)
    body = document.find("body")
    pruner.prune(document, _Context())
    for element in document.iter():
        if isinstance(element.tag, str) and "style" in element.attrib:
            del element.attrib["style"]  # judged already; readability must not re-judge a visible child
    h1 = document.find(".//h1")  # after pruning: a hidden heading never names the material
    return _Pruned(document, body, list(pruner.findings), page_title, og_title, site_name,
                   h1.text_content() if h1 is not None else None, scripts, password_fields)


def _extraction(pruned: _Pruned, texts: list[Block], short_title: str | None = None) -> ArticleExtraction:
    paragraphs: list[Paragraph] = []
    findings = list(pruned.findings)
    for block in texts:
        cleaned = clean_invisible(block.text, index=len(paragraphs))
        findings.extend(cleaned.findings)
        if cleaned.text.strip():
            text = code_text(cleaned.text) if block.role == "code" else " ".join(cleaned.text.split())
            paragraphs.append(Paragraph(text, index=len(paragraphs), role=block.role, level=block.level))
    title = (
        sanitize_title(pruned.og_title)
        or sanitize_title(short_title)
        or sanitize_title(pruned.page_title)
        or (sanitize_title(pruned.h1) if pruned.h1 is not None else None)
    )
    site_name = sanitize_title(pruned.site_name) if pruned.site_name else None
    return ArticleExtraction(title, paragraphs, findings, site_name, pruned.scripts, pruned.password_fields)


def extract_article(html: str) -> ArticleExtraction:
    pruned = _pruned(html)
    document, body = pruned.document, pruned.body
    cleaned_html = lxml.html.tostring(body if body is not None else document, encoding="unicode")
    readable = Document(
        f"<html><head><title>{_escape(pruned.page_title or '')}</title></head>{cleaned_html}</html>"
    )
    try:
        summary = readable.summary(html_partial=True)
        short_title = readable.short_title()
    except Exception as error:
        raise ArticleRejected("SKAZ couldn't find the article text on this page.") from error
    texts = (
        _block_texts(lxml.html.fragment_fromstring(summary, create_parent="div")) if summary.strip() else []
    )
    if not texts and body is not None:
        texts = _block_texts(body)
    return _extraction(pruned, texts, short_title)


#: Site menus: part of every page of the site, not of this page's text (W-3 snapshot).
_MENUS = "//nav | //*[@role='navigation']"


def extract_page(html: str) -> ArticleExtraction:
    """The whole visible page as text (W-3 "Add to wiki" snapshot), not readability's article guess.

    Same layer 2 as articles (hidden content, scripts, styles, comments and
    attributes never become text); site menus (``nav``) are left out.
    """
    pruned = _pruned(html)
    root = pruned.body if pruned.body is not None else pruned.document
    for menu in root.xpath(_MENUS):
        _Pruner._drop(menu)
    return _extraction(pruned, _block_texts(root))


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
