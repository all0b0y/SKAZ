"""A record of something removed from a source before any model saw it (layer 2)."""

from __future__ import annotations

import unicodedata
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

FindingKind = Literal[
    "unicode_tags",  # U+E0000–E007F: invisible ASCII ("ASCII smuggling")
    "bidi_control",  # embedding/override/isolate controls that reorder what is shown
    "zero_width_run",  # a run of zero-width characters (can encode hidden data)
    "variation_selector_run",  # several variation selectors in a row (can encode hidden data)
    "interlinear_annotation",  # U+FFF9–FFFB annotation controls
    "hidden_html",  # an element a browser would not show
    "html_comment",  # a comment with readable text
    "hidden_pdf_text",  # PDF text drawn invisibly (Tr 3, white, off-page, zero size, hidden layer)
]

#: How much of the removed content a finding keeps (enough to show the user).
MAX_ORIGINAL = 400


class Finding(BaseModel):
    """``where`` uses the fragment location keys (``index``/``page``/``start_ms``) plus ``element``."""

    model_config = ConfigDict(frozen=True)
    kind: FindingKind
    #: Plain-English description for the UI.
    detail: str
    #: The removed content as it was, with invisible characters spelled out (``<U+200B>``).
    original: str
    index: int | None = None
    page: int | None = None
    element: str | None = None
    #: Offset in the text the finding was made in (before splitting into fragments).
    offset: int | None = Field(default=None, exclude=True)
    #: True when the hidden content itself reads like an instruction to an AI (layer 3 on it).
    instruction: bool = False

    def at(self, **where: int | str | None) -> Finding:
        return self.model_copy(update=where)


def visible_repr(text: str, *, limit: int = MAX_ORIGINAL) -> str:
    """Spell out characters a reader cannot see, so the evidence is readable."""
    out: list[str] = []
    for char in text:
        category = unicodedata.category(char)
        if char in "\n\t" or (category[0] != "C" and category not in ("Zl", "Zp")):
            out.append(char)
        else:
            out.append(f"<U+{ord(char):04X}>")
        if sum(len(part) for part in out) >= limit:
            break
    rendered = "".join(out)
    return rendered if len(rendered) <= limit else rendered[: limit - 1] + "…"
