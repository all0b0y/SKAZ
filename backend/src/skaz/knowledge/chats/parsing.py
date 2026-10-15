"""Streaming parser of the agent's link syntax (pure; no library access).

The agent writes plain Markdown plus:

* ``⟦m:<material_id>:<seg>⟧`` (``<seg>`` may be ``seg-12``), optionally with the
  verbatim words it relied on: ``⟦m:<material_id>:<seg>|<exact words>⟧``;
* ``⟦p:<page_id>⟧`` or ``⟦p:<page_id>#<block_id>⟧``;
* a fenced block ```` ```skaz-connection ```` holding JSON.

Text arrives in arbitrary deltas, so the parser holds back only what could
still become a token or a fence opener, and releases everything else at once.
Tokens are returned unchecked; ``chats.resolve`` checks their ids.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

OPEN, CLOSE = "⟦", "⟧"
FENCE_INFO = "skaz-connection"
FENCE_OPENER = "```" + FENCE_INFO
MAX_TOKEN_CHARS = 1200
MAX_FENCE_CHARS = 20_000
_FENCE_OPEN = re.compile(r"^[ \t]{0,3}```skaz-connection[ \t]*\n", re.MULTILINE)
_FENCE_CLOSE = re.compile(r"^[ \t]{0,3}```[ \t]*$", re.MULTILINE)
_MATERIAL = re.compile(r"(mat-[A-Za-z0-9-]{1,80}):(?:seg-)?([1-9]\d{0,8})(?:\|(.*))?", re.DOTALL)
_PAGE = re.compile(r"(pg-[A-Za-z0-9-]{1,80})(?:#(c-[A-Za-z0-9-]{1,120}))?")
TOKEN_PATTERN = re.compile(r"⟦[^⟦⟧]*⟧")


@dataclass(frozen=True)
class TextOut:
    text: str


@dataclass(frozen=True)
class CiteToken:
    material_id: str
    seg: int
    quote: str | None


@dataclass(frozen=True)
class PageToken:
    page_id: str
    block_id: str | None


@dataclass(frozen=True)
class ConnectionOut:
    payload: str


Output = TextOut | CiteToken | PageToken | ConnectionOut


def parse_token(body: str) -> CiteToken | PageToken | None:
    """``m:…`` / ``p:…`` without the brackets; ``None`` when it is not a well-formed reference."""
    kind, sep, rest = body.partition(":")
    if not sep:
        return None
    rest = rest.strip()
    if kind == "m":
        match = _MATERIAL.fullmatch(rest)
        if match is None:
            return None
        quote = match.group(3)
        quote = quote.strip().strip("\"“”«»'").strip() if quote is not None else None
        return CiteToken(match.group(1), int(match.group(2)), quote or None)
    if kind == "p":
        match = _PAGE.fullmatch(rest)
        return PageToken(match.group(1), match.group(2)) if match else None
    return None


def strip_tokens(text: str) -> str:
    """Model text with every bracket token removed (used for text inside connection blocks)."""
    return TOKEN_PATTERN.sub("", text).replace(OPEN, "").replace(CLOSE, "")


class StreamParser:
    def __init__(self) -> None:
        self._buffer = ""
        #: Whether ``_buffer`` starts at the beginning of a line (fences open only there).
        self._line_start = True
        self._in_fence = False

    def feed(self, text: str) -> list[Output]:
        self._buffer += text
        out: list[Output] = []
        while True:
            produced = self._step(final=False)
            if produced is None:
                return [item for item in out if not (isinstance(item, TextOut) and not item.text)]
            out.extend(produced)

    def finish(self) -> list[Output]:
        out: list[Output] = []
        while True:
            produced = self._step(final=True)
            if produced is None:
                break
            out.extend(produced)
        if self._in_fence:
            out.append(ConnectionOut(self._buffer))  # unterminated: resolved as a failed connection
        elif self._buffer:
            out.append(TextOut(self._buffer.replace(OPEN, "")))
        self._buffer, self._in_fence = "", False
        return [item for item in out if not (isinstance(item, TextOut) and not item.text)]

    # -- one step ---------------------------------------------------------------

    def _emit_text(self, text: str) -> list[Output]:
        if not text:
            return []
        self._line_start = text.endswith("\n")
        return [TextOut(text)]

    def _consume(self, length: int) -> str:
        taken, self._buffer = self._buffer[:length], self._buffer[length:]
        return taken

    def _step(self, *, final: bool) -> list[Output] | None:
        if not self._buffer:
            return None
        if self._in_fence:
            return self._fence_step(final=final)
        fence = self._fence_start()
        token_at = self._buffer.find(OPEN)
        if fence is not None and (token_at < 0 or fence.start() <= token_at):
            before = self._consume(fence.start())
            self._consume(fence.end() - fence.start())
            self._in_fence = True
            self._line_start = True
            return self._emit_text(before) or [TextOut("")]
        if token_at >= 0:
            if token_at > 0:
                return self._emit_text(self._consume(token_at))
            close = self._buffer.find(CLOSE)
            newline = self._buffer.find("\n")
            reopened = self._buffer.find(OPEN, 1)
            if reopened >= 0 and (close < 0 or reopened < close) and (newline < 0 or reopened < newline):
                return self._orphan(reopened)  # another "⟦" before any "⟧": the first one is no token
            if close >= 0 and (newline < 0 or close < newline):
                body = self._consume(close + 1)[1:-1]
                self._line_start = False
                token = parse_token(body)
                return [token] if token is not None else [TextOut("")]
            if newline >= 0:
                return self._orphan(newline)
            if len(self._buffer) > MAX_TOKEN_CHARS or final:
                return self._orphan(len(self._buffer))
            return None
        # Plain text: keep back a trailing partial line that may still become a fence opener.
        held = self._partial_fence_tail()
        if held == len(self._buffer) and not final:
            return None
        if final:
            held = 0
        return self._emit_text(self._consume(len(self._buffer) - held)) or None

    def _orphan(self, boundary: int) -> list[Output]:
        """A "⟦" that never closes: a half-written reference (``m:``/``p:``…) is dropped up to
        ``boundary`` so no unchecked id reaches the text; any other bracket alone is dropped."""
        if self._buffer[1:3] in ("m:", "p:"):
            self._consume(boundary)
        else:
            self._consume(1)
        return [TextOut("")]

    def _fence_start(self) -> re.Match[str] | None:
        for match in _FENCE_OPEN.finditer(self._buffer):
            if match.start() > 0 or self._line_start:
                return match
        return None

    def _partial_fence_tail(self) -> int:
        """Length of the trailing text to hold: an unfinished line that could open a fence."""
        newline = self._buffer.rfind("\n")
        if newline < 0 and not self._line_start:
            return 0
        tail = self._buffer[newline + 1:]
        stripped = tail.lstrip(" \t")
        if len(tail) - len(stripped) > 3:
            return 0
        if FENCE_OPENER.startswith(stripped) or stripped.startswith(FENCE_OPENER):
            return len(tail)
        return 0

    def _fence_step(self, *, final: bool) -> list[Output] | None:
        close = _FENCE_CLOSE.search(self._buffer)
        if close is None or (close.end() == len(self._buffer) and not final):
            if len(self._buffer) > MAX_FENCE_CHARS:
                payload, self._buffer = self._buffer, ""
                self._in_fence = False
                return [ConnectionOut(payload)]  # far too long: resolved as a failed connection
            return None  # wait for the closing fence; ``finish`` reports an unterminated block
        payload = self._consume(close.start())
        self._consume(close.end() - close.start())
        if self._buffer.startswith("\n"):
            self._consume(1)
        self._in_fence = False
        self._line_start = True
        return [ConnectionOut(payload)]
