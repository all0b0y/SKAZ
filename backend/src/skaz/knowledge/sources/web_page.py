"""W-3 "Add to wiki" for a web page: SKAZ's own single request, a whole-page text snapshot.

Only on the user's click and only to that URL (plus its redirects, at most
``fetch.MAX_REDIRECTS``): no agent, no model, no other request. Every hop is
checked for a public address and the connection goes to the checked address
(``SafeFetcher.fetch(pin_address=True)``). Scripts never run; scripts, styles,
hidden content and site menus never become text (``html.extract_page``). The
snapshot's text is untrusted like any material: it goes through the same
instruction detector when it is published.

A page SKAZ can't save this way (sign-in, paywall, JavaScript-only, not HTML,
too large, too slow, an error answer, a blocked address) is refused with
``WebPageUnavailable`` (422, ``error_code`` ``web_page_unavailable``) and the
advice to save it as PDF and import that instead.
"""

from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit

from ..errors import KnowledgeError
from ..markdown.source import Origin
from .fetch import Fetched
from .fragments import to_fragments
from .html import ArticleRejected, decode_html, extract_page
from .intake import Original, Prepared, flag_instructions
from .links import domain_of

ERROR_CODE = "web_page_unavailable"
SAVE_AS_PDF = "Save the page as PDF and import it."
#: The page as sent (decompressed). Real article pages are well under 1–2 MB of HTML; 5 MB leaves
#: room for heavy inline markup while keeping one click from pulling a download.
MAX_PAGE_BYTES = 5 * 1024 * 1024
#: The whole request with redirects. The user waits for this click (Electron gives a request 120 s).
TOTAL_SECONDS = 30.0
ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1"
HTML_TYPES = frozenset({"text/html", "application/xhtml+xml"})
#: Fewer letters than this and ``<script>`` on the page: its text comes from JavaScript.
JS_ONLY_LETTERS = 200
#: Fewer letters than this and a password field: a sign-in form, not the page.
SIGN_IN_LETTERS = 1000
EXTRACTOR = "html_page"


class WebPageUnavailable(KnowledgeError):
    """SKAZ couldn't save this page itself; the message says why and suggests the PDF route."""

    status_code = 422
    error_code = ERROR_CODE

    def __init__(self, reason: str) -> None:
        super().__init__(f"{reason.rstrip()} {SAVE_AS_PDF}")


def page_key(url: str | None) -> str | None:
    """The same page whatever the case of the host, a default port or a ``#fragment``."""
    if not url:
        return None
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower().rstrip(".")
    if ":" in host:
        host = f"[{host}]"
    if port is not None and (scheme, port) not in (("http", 80), ("https", 443)):
        host = f"{host}:{port}"
    return urlunsplit((scheme, host, parts.path or "/", parts.query, ""))


def _letters(texts: list[str]) -> int:
    return sum(char.isalpha() for text in texts for char in text)


def prepare_web_page(fetched: Fetched, url: str, *, fetched_at: str) -> Prepared:
    """The fetched page as a ``web`` material: whole visible text, link, final address and date."""
    content_type = fetched.content_type
    sniffed = content_type in ("", "application/octet-stream") and b"<html" in fetched.body[:2048].lower()
    if content_type not in HTML_TYPES and not sniffed:
        kind = "a PDF" if content_type == "application/pdf" else content_type or "an unknown type"
        raise WebPageUnavailable(f"This link isn't a web page ({kind}).")
    try:
        extraction = extract_page(decode_html(fetched.body, fetched.charset))
    except ArticleRejected as error:
        raise WebPageUnavailable(error.message) from error
    letters = _letters([paragraph.text for paragraph in extraction.paragraphs])
    if extraction.password_fields and letters < SIGN_IN_LETTERS:
        raise WebPageUnavailable("This page asks you to sign in before it shows its text.")
    if extraction.scripts and letters < JS_ONLY_LETTERS:
        raise WebPageUnavailable("This page shows its text only with JavaScript, which SKAZ doesn't run.")
    if not extraction.paragraphs:
        raise WebPageUnavailable("SKAZ couldn't find any text on this page.")
    origin = Origin.model_validate({
        "type": "url",
        "url": url,
        "final_url": fetched.url,
        "content_type": content_type or "text/html",
        "fetched_at": fetched_at,
        "snapshot": "page",
    })
    extra: dict[str, object] = {"fetched_at": fetched_at, "url": url, "final_url": fetched.url}
    if extraction.site_name:
        extra["site_name"] = extraction.site_name
    return Prepared(
        kind="web",
        title=extraction.title,
        fallback_title=domain_of(url) or "Web page",
        fragments=to_fragments(extraction.paragraphs),
        findings=flag_instructions(extraction.findings),
        origin=origin,
        extractor=EXTRACTOR,
        original=Original("original.html", data=fetched.body),
        extra=extra,
    )
