"""Plain Markdown of a drawn block (decision 11): tables, lists and paragraphs — never HTML.

One serializer per block lives in its module (``BlockSpec.markdown``); they all write an item's
sources through ``Refs``, so the same serializer serves the in-app Copy (labels and web links), the
chat export (labels) and saved analysis pages (slots that become wiki links).
"""
from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Protocol

#: Private-use characters the analysis page uses to mark where a source sat (never model text).
_PRIVATE = re.compile("[\ue000\ue001]")
#: What would start another Markdown block at the start of a line.
_LEADING = re.compile(r"^(#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s|`{3,}|~{3,}|={3,}|-{3,})")
AGENT_LABEL = "[Agent’s knowledge]"


class Sourced(Protocol):
    @property
    def src(self) -> list[int]: ...

    @property
    def agent(self) -> bool: ...


class Refs:
    """How an item's sources follow it: ``labels[i]`` for source ``i`` (``""`` drops it).

    ``times[i]`` is the recording time of source ``i`` (a timeline moment without a date);
    ``agent`` marks the agent's own items; ``cells``: references may go inside table cells (labels
    without ``|``), else they follow the row (wiki links carry a ``|``).
    """

    def __init__(self, labels: Sequence[str], times: Sequence[str | None] = (), *,
                 agent: str = AGENT_LABEL, cells: bool = True) -> None:
        self.labels = list(labels)
        self.times = list(times)
        self.agent = agent
        self.cells = cells

    def of(self, item: Sourced) -> str:
        """The references after an item, with a leading space (``""`` when there are none)."""
        if item.agent:
            return f" {self.agent}" if self.agent else ""
        out: list[str] = []
        for index in item.src:
            label = self.labels[index] if 0 <= index < len(self.labels) else ""
            if label and label not in out:
                out.append(label)
        return " " + " ".join(out) if out else ""

    def time(self, item: Sourced) -> str | None:
        index = item.src[0] if item.src else -1
        return self.times[index] if 0 <= index < len(self.times) else None


def text(value: str) -> str:
    """Model text as one inert Markdown line."""
    return " ".join(_PRIVATE.sub("", value).split())


def label(value: str) -> str:
    """Text inside a reference's ``[…]`` (a source label, a link title): it can't close the brackets."""
    return text(value).replace("[", "(").replace("]", ")")


def link(title: str, url: str) -> str:
    """A web link as Markdown — the one writer for Copy, the chat export and saved pages: the title
    can't close its brackets, the URL can't close its parentheses (or break on a space)."""
    safe = (_PRIVATE.sub("", url).strip().replace(" ", "%20").replace("(", "%28").replace(")", "%29")
            .replace("<", "%3C").replace(">", "%3E"))
    return f"[{label(title) or safe}]({safe})"


def line(value: str) -> str:
    """Text that starts a line: what would open another block (a heading, a list) is escaped."""
    value = text(value)
    return "\\" + value if _LEADING.match(value) else value


def cell(value: str) -> str:
    return text(value).replace("|", "\\|")


def title(value: str | None) -> list[str]:
    return [f"**{text(value)}**", ""] if value else []


def row(cells: Sequence[str], after: str = "") -> str:
    """One table row; ``after``: references past the last cell (where a link's ``|`` splits nothing)."""
    return "| " + " | ".join(cells) + " |" + after


def table(header: Sequence[str], rows: Sequence[str]) -> list[str]:
    return [row(header), row(["---"] * len(header)), *rows]
